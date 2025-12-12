import { inject, singleton } from 'tsyringe';
import Service from '../../../common/services/Service';
import { ExtendedPrismaClient } from '../../../common/utils/prisma';
import { CreateRaffleRequest } from '../types/requests';
import { RaffleInterface } from '@tickets/types/dist/raffle';
import EntityNotFoundError from '../../../common/classes/errors/EntityNotFoundError';
import { RaffleMapper } from '../mappers/RaffleMapper';
import { CodeMapper } from '../../code/mappers/CodeMapper';
import { Game, Ticket, BalanceActionType } from '@prisma/client';
import { GameInterface, TicketInterface } from '@tickets/types';
import { DateTime } from 'luxon';
import { createPrizeReference } from '../utils/prizeReference';
import { Role } from '@prisma/client';

export interface IRaffleService {
    save(data: Array<CreateRaffleRequest>): Promise<void>
    today(): Promise<Array<RaffleInterface>>
    all(): Promise<Array<RaffleInterface>>
    find(id: number): Promise<RaffleInterface>
    date(date: Date): Promise<Array<RaffleInterface>>
    getWinningTicketsByDate(date: Date): Promise<Array<{ game: GameInterface, tickets: TicketInterface[] }>>
}

@singleton()
class RaffleService extends Service implements IRaffleService {

    constructor(
        @inject('Database') protected db: ExtendedPrismaClient
    ) { super() }

    public async find(id: number) {
        const raffle = await this.db.raffle.findUnique({
            where: {
                id: id
            },
            select: RaffleMapper.getSelectableFields()
        })

        if (!raffle) throw new EntityNotFoundError("Raffle")

        return RaffleMapper.format(raffle)
    }

    public async save(data: Array<CreateRaffleRequest>) {
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const raffleDate = new Date(today.getTime() - 24 * 60 * 60 * 1000);

        for (const raffle of data) {
            // Check for existing raffle for today and gameID
            const existingRaffle = await this.db.raffle.findFirst({
                where: {
                    gameID: raffle.gameID,
                    created: raffleDate
                }
            });

            let savedRaffle;

            if (existingRaffle) {
                // Raffle exists, update codes by first deleting existing ones
                // Only delete codes that don't belong to tickets
                await this.db.code.deleteMany({
                    where: {
                        raffleID: existingRaffle.id,
                        ticketID: null
                    }
                });

                savedRaffle = existingRaffle;
            } else {
                // Create new raffle
                savedRaffle = await this.db.raffle.create({
                    data: {
                        gameID: raffle.gameID,
                        created: raffleDate
                    }
                });
            }

            // Create codes for the raffle
            await this.db.code.createMany({
                data: raffle.codes.map(code => ({
                    value: 0,
                    raffleID: savedRaffle.id,
                    code: code.toString()
                }))
            });
        }

        // After all raffles are saved, create provision and prize balance actions for the raffle date
        await this.createProvisionBalanceActions(raffleDate);
        await this.createPrizeBalanceActions(raffleDate);
    }

    public async all() {
        const raffles = await this.db.raffle.findMany({
            select: RaffleMapper.getSelectableFields()
        });

        return RaffleMapper.formatMany(raffles);
    }

    public async today() {
        // Get yesterday's start in Amsterdam timezone
        const yesterdayAmsterdam = DateTime.now().setZone('Europe/Amsterdam').minus({ days: 1 });
        const yesterday = yesterdayAmsterdam.startOf('day').toUTC().toJSDate();

        const raffle = await this.db.raffle.findMany({
            select: RaffleMapper.getSelectableFields(),
            where: {
                created: {
                    gte: yesterday
                }
            }
        });

        const codes = await this.db.code.findMany({
            where: {
                raffleID: {
                    in: raffle.map(r => r.id)
                }
            }
        });

        return RaffleMapper.formatMany(raffle.map(r => ({ ...r, codes: codes.filter(c => c.raffleID === r.id) })));
    }

    public async date(date: Date) {
        // Convert to Amsterdam timezone and get day boundaries
        const amsterdamDate = DateTime.fromJSDate(date).setZone('Europe/Amsterdam');
        const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
        const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();

        const raffles = await this.db.raffle.findMany({
            select: RaffleMapper.getSelectableFields(),
            where: {
                created: {
                    gte: startOfDay,
                    lte: endOfDay
                }
            }
        });

        console.log(raffles);

        return await RaffleMapper.formatMany(raffles);
    }

    /**
     * For the given calendar day, return every game that had a raffle
     * and the tickets (if any) whose codes match that game’s raffle codes.
     *
     * [
     *   { game: Game, tickets: Ticket[] },
     *   …
     * ]
     */
    public async getWinningTicketsByDate(date: Date) {
        console.debug(`getWinningTicketsByDate called with date: ${date.toISOString()}`);
        
        // ── 1 ── build immutable day-start / day-end boundaries in Amsterdam timezone
        const amsterdamDate = DateTime.fromJSDate(date).setZone('Europe/Amsterdam');
        const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
        const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();

        console.debug(`Start of day: ${startOfDay.toISOString()}, End of day: ${endOfDay.toISOString()}`);

        // ── 2 ── fetch every raffle created that day, incl. game + codes
        console.debug('Fetching raffles for the day...');
        const raffles = await this.db.raffle.findMany({
            where: {
                created: { gte: startOfDay, lte: endOfDay },
            },
            select: {
                gameID: true,
                game: true,                 // full Game object
                codes: { select: { value: true, code: true } },
            },
        });

        console.debug(`Number of raffles found: ${raffles.length}`);

        if (raffles.length === 0) {
            console.debug('No raffles found for the day.');
            return [];   // no draws that day
        }

        // ── 3 ── group winning code values and strings by game
        console.debug('Grouping winning code values by game...');
        const byGame: Map<
            number,
            { game: typeof raffles[number]["game"]; winningValues: number[]; winningCodes: string[] }
        > = new Map();

        for (const r of raffles) {
            const entry =
                byGame.get(r.gameID) ??
                { game: r.game, winningValues: [], winningCodes: [] };
            entry.winningValues.push(...r.codes.map(c => c.value));
            entry.winningCodes.push(...r.codes.map(c => c.code));
            byGame.set(r.gameID, entry);
        }

        console.debug(`Games with raffles: ${byGame.size}`);

        // ── 4 ── for each game, pull that day’s tickets and then filter those that hit ≥1 winning code
        const result: { game: typeof raffles[number]["game"]; tickets: any[] }[] = [];

        for (const [gameID, { game, winningValues, winningCodes }] of byGame) {
            console.debug(`Processing gameID: ${gameID} with winning values: ${winningValues}`);
            if (winningValues.length === 0) {
                result.push({ game, tickets: [] });
                console.debug(`No winning values for gameID: ${gameID}`);
                continue;
            }

            console.debug(`Fetching tickets for gameID: ${gameID}...`);
            const ticketsAll = await this.db.ticket.findMany({
                where: {
                    created: { gte: startOfDay, lte: endOfDay },
                    // ticket must belong to this game
                    games: { some: { gameID } },
                },
                select: {
                    id: true,
                    name: true,
                    creatorID: true,
                    codes: {
                        select: { code: true, value: true },
                    },
                },
            });

            // Filter to tickets with at least one code that ends with a winning code
            const tickets = ticketsAll
                .map(t => {
                    const matchingCodes = t.codes.filter(c => winningCodes.some((w: string) => w.length > 0 && c.code.endsWith(w)));
                    if (matchingCodes.length === 0) return null;
                    return { ...t, codes: matchingCodes };
                })
                .filter(Boolean) as any[];

            console.debug(`Number of winning tickets found for gameID ${gameID}: ${tickets.length}`);
            result.push({ game, tickets });
        }

        console.debug('Completed processing for getWinningTicketsByDate.');
        return result; // [{ game: { … }, tickets: [...] }, …]
    }

    /**
     * Create provision balance actions for all users based on their ticket sales for the given date
     * Provision = ticket sales * user's commission percentage
     */
    private async createProvisionBalanceActions(date: Date): Promise<void> {
        console.debug(`Creating provision balance actions for date: ${date.toISOString()}`);
        
        // Build day boundaries in Amsterdam timezone
        const amsterdamDate = DateTime.fromJSDate(date).setZone('Europe/Amsterdam');
        const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
        const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();

        console.debug(`Start of day: ${startOfDay.toISOString()}, End of day: ${endOfDay.toISOString()}`);

        const MANAGER_PROVISION_PERCENTAGE = 25; // All managers get 25% total provision

        // Get all users with their commission percentage
        const users = await this.db.user.findMany({
            select: {
                id: true,
                commission: true,
                balance: {
                    select: {
                        id: true
                    }
                }
            },
            where: {
                commission: {
                    gt: 0 // Only users with commission > 0
                }
            }
        });

        console.debug(`Found ${users.length} users with commission > 0`);

        // For each user, calculate their ticket sales and create provision balance action
        for (const user of users) {
            // Get all tickets created by this user on the raffle date
            const tickets = await this.db.ticket.findMany({
                where: {
                    creatorID: user.id,
                    created: {
                        gte: startOfDay,
                        lte: endOfDay
                    }
                },
                include: {
                    codes: true,
                    games: true
                }
            });

            if (tickets.length === 0) {
                console.debug(`User ${user.id} has no tickets for this date, skipping provision`);
                continue;
            }

            // Calculate total ticket sales (Inleg) for this user
            // Each code value * number of games the ticket is entered in
            let totalTicketSales = 0;
            for (const ticket of tickets) {
                const gameCount = ticket.games.length;
                const ticketValue = ticket.codes.reduce((sum, code) => sum + (code.value * gameCount), 0);
                totalTicketSales += ticketValue;
            }

            if (totalTicketSales === 0) {
                console.debug(`User ${user.id} has zero ticket sales, skipping provision`);
                continue;
            }

            // Calculate provision (in cents)
            const provisionAmount = Math.round((totalTicketSales * user.commission) / 100);

            if (provisionAmount === 0) {
                console.debug(`User ${user.id} provision is zero, skipping`);
                continue;
            }

            console.debug(`User ${user.id}: ticket sales=${totalTicketSales}, commission=${user.commission}%, provision=${provisionAmount}`);

            // Check if provision action already exists for this user and date
            const existingProvision = await this.db.balanceAction.findFirst({
                where: {
                    balance: {
                        userID: user.id
                    },
                    type: BalanceActionType.PROVISION,
                    created: {
                        gte: startOfDay,
                        lte: endOfDay
                    }
                }
            });

            if (existingProvision) {
                console.debug(`Provision already exists for user ${user.id} on this date, skipping`);
                continue;
            }

            // Get or create balance for the user
            let balance = user.balance;
            if (!balance) {
                const createdBalance = await this.db.balance.create({
                    data: {
                        userID: user.id,
                        balance: 0
                    }
                });
                balance = { id: createdBalance.id };
            }

            // Create provision balance action (negative amount to deduct from balance)
            await this.db.balanceAction.create({
                data: {
                    balanceID: balance.id,
                    type: BalanceActionType.PROVISION,
                    amount: -provisionAmount, // Negative to deduct from balance
                    reference: `Provisie ${amsterdamDate.toFormat('dd-MM-yyyy')}`,
                    created: endOfDay // Set to end of day so it's the last action of the day
                }
            });

            // Update balance
            await this.db.balance.update({
                where: { id: balance.id },
                data: {
                    balance: { decrement: provisionAmount }
                }
            });

            console.debug(`Created provision balance action for user ${user.id}`);
        }

        // NEW: Process manager provisions from their runners
        console.debug('=== Processing Manager Provisions from Runners ===');
        
        // Get all managers
        const managers = await this.db.user.findMany({
            where: {
                role: Role.MANAGER
            },
            select: {
                id: true,
                name: true,
                balance: {
                    select: {
                        id: true
                    }
                }
            }
        });

        console.debug(`Found ${managers.length} managers`);

        for (const manager of managers) {
            // Get all runners under this manager
            const managerRunners = await this.db.managerRunner.findMany({
                where: {
                    managerID: manager.id
                },
                include: {
                    runner: {
                        select: {
                            id: true,
                            name: true,
                            commission: true
                        }
                    }
                }
            });

            if (managerRunners.length === 0) {
                console.debug(`Manager ${manager.id} has no runners, skipping`);
                continue;
            }

            let totalManagerProvisionFromRunners = 0;

            // For each runner, calculate manager's provision
            for (const managerRunner of managerRunners) {
                const runner = managerRunner.runner;
                
                // Get all tickets created by this runner on the raffle date
                const runnerTickets = await this.db.ticket.findMany({
                    where: {
                        creatorID: runner.id,
                        created: {
                            gte: startOfDay,
                            lte: endOfDay
                        }
                    },
                    include: {
                        codes: true,
                        games: true
                    }
                });

                if (runnerTickets.length === 0) {
                    continue;
                }

                // Calculate total ticket sales for this runner
                let runnerTicketSales = 0;
                for (const ticket of runnerTickets) {
                    const gameCount = ticket.games.length;
                    const ticketValue = ticket.codes.reduce((sum, code) => sum + (code.value * gameCount), 0);
                    runnerTicketSales += ticketValue;
                }

                if (runnerTicketSales === 0) {
                    continue;
                }

                // Calculate manager's provision from this runner
                // Manager gets: (25% - runner_commission%) of runner's ticket sales
                const managerProvisionPercentage = MANAGER_PROVISION_PERCENTAGE - runner.commission;
                
                if (managerProvisionPercentage <= 0) {
                    console.debug(`Manager ${manager.id} gets 0% from runner ${runner.id} because runner commission (${runner.commission}%) >= 25%`);
                    continue;
                }

                const managerProvisionFromRunner = Math.round((runnerTicketSales * managerProvisionPercentage) / 100);
                
                if (managerProvisionFromRunner > 0) {
                    totalManagerProvisionFromRunners += managerProvisionFromRunner;
                    console.debug(`  Runner ${runner.id}: ticket sales=${runnerTicketSales}, runner commission=${runner.commission}%, manager gets ${managerProvisionPercentage}% = ${managerProvisionFromRunner}`);
                }
            }

            if (totalManagerProvisionFromRunners === 0) {
                console.debug(`Manager ${manager.id} has no provision from runners, skipping`);
                continue;
            }

            // Check if manager provision from runners already exists for this date
            const existingManagerProvision = await this.db.balanceAction.findFirst({
                where: {
                    balance: {
                        userID: manager.id
                    },
                    type: BalanceActionType.PROVISION,
                    reference: {
                        contains: `Provisie lopers ${amsterdamDate.toFormat('dd-MM-yyyy')}`
                    },
                    created: {
                        gte: startOfDay,
                        lte: endOfDay
                    }
                }
            });

            if (existingManagerProvision) {
                console.debug(`Manager provision from runners already exists for ${manager.id} on this date, skipping`);
                continue;
            }

            // Get or create balance for the manager
            let balance = manager.balance;
            if (!balance) {
                const createdBalance = await this.db.balance.create({
                    data: {
                        userID: manager.id,
                        balance: 0
                    }
                });
                balance = { id: createdBalance.id };
            }

            // Create provision balance action for manager from runners (negative amount to deduct from balance)
            await this.db.balanceAction.create({
                data: {
                    balanceID: balance.id,
                    type: BalanceActionType.PROVISION,
                    amount: -totalManagerProvisionFromRunners, // Negative to deduct from balance
                    reference: `Provisie lopers ${amsterdamDate.toFormat('dd-MM-yyyy')}`,
                    created: endOfDay // Set to end of day so it's the last action of the day
                }
            });

            // Update balance
            await this.db.balance.update({
                where: { id: balance.id },
                data: {
                    balance: { decrement: totalManagerProvisionFromRunners }
                }
            });

            console.debug(`Created manager provision from runners for ${manager.id}: -${totalManagerProvisionFromRunners}`);
        }

        console.debug('Completed creating provision balance actions');
    }

    /**
     * Create prize balance actions for all winning tickets for the given date
     * This method calculates prizes using the same logic as PrizeService
     */
    private async createPrizeBalanceActions(date: Date): Promise<void> {
        console.debug(`Creating prize balance actions for date: ${date.toISOString()}`);
        
        // Build day boundaries in Amsterdam timezone
        const amsterdamDate = DateTime.fromJSDate(date).setZone('Europe/Amsterdam');
        const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
        const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();

        console.debug(`Start of day: ${startOfDay.toISOString()}, End of day: ${endOfDay.toISOString()}`);

        // Get all raffles for this date
        const raffles = await this.db.raffle.findMany({
            where: {
                created: { gte: startOfDay, lte: endOfDay }
            },
            include: {
                game: true,
                codes: true
            }
        });

        if (raffles.length === 0) {
            console.debug('No raffles found for this date, skipping prize creation');
            return;
        }

        console.debug(`Found ${raffles.length} raffles for this date`);

        // Group winning codes by game, keeping track of raffle IDs
        const winningCodesByGame = new Map<number, { 
            winningCodes: Array<{ code: string; order: number }>;
            raffleIDs: number[];
        }>();
        
        for (const raffle of raffles) {
            if (!winningCodesByGame.has(raffle.gameID)) {
                winningCodesByGame.set(raffle.gameID, {
                    winningCodes: [],
                    raffleIDs: []
                });
            }
            
            const gameData = winningCodesByGame.get(raffle.gameID)!;
            if (!gameData.raffleIDs.includes(raffle.id)) {
                gameData.raffleIDs.push(raffle.id);
            }
            
            const codeToOrder = new Map<string, number>();
            for (const code of raffle.codes) {
                if (!codeToOrder.has(code.code)) {
                    codeToOrder.set(code.code, codeToOrder.size + 1);
                }
                // Only add if not already added (avoid duplicates)
                if (!gameData.winningCodes.some(wc => wc.code === code.code)) {
                    gameData.winningCodes.push({
                        code: code.code,
                        order: codeToOrder.get(code.code)!
                    });
                }
            }
        }

        const processedReferences = new Set<string>();

        // Process each game's winning tickets
        for (const [gameID, { winningCodes, raffleIDs }] of winningCodesByGame) {
            if (winningCodes.length === 0) continue;

            const winningValues = winningCodes.map(wc => parseInt(wc.code, 10));
            
            // Find all tickets for this game on this day
            const allTickets = await this.db.ticket.findMany({
                where: {
                    created: { gte: startOfDay, lte: endOfDay },
                    games: { some: { gameID } }
                },
                include: {
                    codes: {
                        select: { id: true, code: true, value: true }
                    },
                    creator: {
                        select: { id: true }
                    }
                }
            });

            console.debug(`Found ${allTickets.length} tickets for game ${gameID}`);

            // Process each ticket - check each code against winning codes
            // Group by code to sum prizes for duplicate codes in the same ticket
            for (const ticket of allTickets) {
                // Group codes by code string to handle duplicates
                const codesByString = new Map<string, Array<{ id: number; code: string; value: number }>>();
                for (const ticketCode of ticket.codes) {
                    const codeStr = ticketCode.code;
                    if (!codesByString.has(codeStr)) {
                        codesByString.set(codeStr, []);
                    }
                    codesByString.get(codeStr)!.push(ticketCode);
                }

                // Process each unique code (summing prizes for duplicates)
                for (const [codeStr, codeInstances] of codesByString) {
                    // Ensure deterministic ordering for consistent references
                    const orderedInstances = [...codeInstances].sort((a, b) => a.id - b.id);

                    // Sum stake values for all instances of this code
                    const totalStake = orderedInstances.reduce((sum, instance) => sum + instance.value, 0);
                    
                    // Calculate prize for this code using total stake
                    const firstInstance = orderedInstances[0];
                    const prizeAmount = this.calculatePrizeAmount(
                        firstInstance.code,
                        totalStake,
                        gameID,
                        winningCodes
                    );

                    if (prizeAmount <= 0) continue;

                    // Use the first raffle ID for this game
                    const raffleID = raffleIDs[0];
                    // Build stable reference using ticket + literal code
                    const reference = createPrizeReference(raffleID, ticket.id, codeStr);

                    // Check if prize action already exists
                    const existingPrize = await this.db.balanceAction.findFirst({
                        where: {
                            reference,
                            type: BalanceActionType.PRIZE
                        }
                    });

                    if (processedReferences.has(reference)) {
                        console.debug(`Prize action already processed in-memory for ticket ${ticket.id}, code ${firstInstance.code}`);
                        continue;
                    }

                    if (existingPrize) {
                        if (existingPrize.amount !== -prizeAmount) {
                            console.warn(`Prize action ${existingPrize.id} for ticket ${ticket.id}, code ${firstInstance.code} has mismatched amount (${existingPrize.amount/100} vs ${prizeAmount/100})`);
                        } else {
                            console.debug(`Prize action already exists for ticket ${ticket.id}, code ${firstInstance.code}, amount: ${existingPrize.amount/100} EUR`);
                        }
                        continue;
                    }

                    console.debug(`Creating prize action for ticket ${ticket.id}, code ${firstInstance.code} (${codeInstances.length} instances, total stake: ${totalStake/100} EUR), amount: ${prizeAmount/100} EUR, user: ${ticket.creator.id}`);

                    // Get or create balance for the user
                    let balance = await this.db.balance.findUnique({
                        where: { userID: ticket.creator.id }
                    });

                    if (!balance) {
                        balance = await this.db.balance.create({
                            data: {
                                userID: ticket.creator.id,
                                balance: 0
                            }
                        });
                    }

                    // Create prize balance action (negative amount to add to balance)
                    await this.db.balanceAction.create({
                        data: {
                            balanceID: balance.id,
                            type: BalanceActionType.PRIZE,
                            amount: -prizeAmount, // Negative to add to balance
                            reference,
                            created: endOfDay // Use end of day so it appears on the correct date
                        }
                    });

                    processedReferences.add(reference);

                    // Update balance (add the prize amount)
                    await this.db.balance.update({
                        where: { id: balance.id },
                        data: {
                            balance: { increment: prizeAmount }
                        }
                    });

                    console.debug(`Created prize action for ticket ${ticket.id}, code ${firstInstance.code}: ${prizeAmount/100} EUR`);
                }
            }
        }

        console.debug('Completed creating prize balance actions');
    }

    /**
     * Calculate prize amount using the same logic as PrizeService
     */
    private calculatePrizeAmount(
        playedCode: string,
        stakeValue: number,
        gameID: number,
        winningCodesWithOrder: Array<{ code: string; order: number }>
    ): number {
        const MULTIPLIERS = {
            DEFAULT: {
                1: { 4: 3000, 3: 400, 2: 40 },
                2: { 4: 1500, 3: 200, 2: 20 },
                3: { 4: 750, 3: 100, 2: 10 },
            },
            SUPER4: { 4: 5250, 3: 700, 2: 70 }
        } as const;

        const codeLength = playedCode.length;
        const isSuper4 = gameID === 7;
        let total = 0;

        for (const { code: winningCode, order } of winningCodesWithOrder) {
            if (!winningCode.endsWith(playedCode)) continue;

            const multiplier = isSuper4
                ? (MULTIPLIERS.SUPER4 as any)[codeLength] ?? 0
                : ((MULTIPLIERS.DEFAULT as any)[order]?.[codeLength] ?? 0);

            if (multiplier > 0) {
                const prize = stakeValue * multiplier;
                total += prize;
                console.debug(`  Matched winning code ${winningCode} (order ${order}) with played code ${playedCode}: ${prize/100} EUR`);
            }
        }

        if (total > 0) {
            console.debug(`  Total prize for code ${playedCode}: ${total/100} EUR`);
        }
        return total;
    }
}

RaffleService.register()