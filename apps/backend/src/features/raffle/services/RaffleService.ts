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
                codes: { select: { value: true } },
            },
        });

        console.debug(`Number of raffles found: ${raffles.length}`);

        if (raffles.length === 0) {
            console.debug('No raffles found for the day.');
            return [];   // no draws that day
        }

        // ── 3 ── group winning code values by game
        console.debug('Grouping winning code values by game...');
        const byGame: Map<
            number,
            { game: typeof raffles[number]["game"]; winningValues: number[] }
        > = new Map();

        for (const r of raffles) {
            const entry =
                byGame.get(r.gameID) ??
                { game: r.game, winningValues: [] };
            entry.winningValues.push(...r.codes.map(c => c.value));
            byGame.set(r.gameID, entry);
        }

        console.debug(`Games with raffles: ${byGame.size}`);

        // ── 4 ── for each game, pull that day’s tickets that hit ≥1 winning code
        const result: { game: typeof raffles[number]["game"]; tickets: any[] }[] = [];

        for (const [gameID, { game, winningValues }] of byGame) {
            console.debug(`Processing gameID: ${gameID} with winning values: ${winningValues}`);
            if (winningValues.length === 0) {
                result.push({ game, tickets: [] });
                console.debug(`No winning values for gameID: ${gameID}`);
                continue;
            }

            console.debug(`Fetching tickets for gameID: ${gameID}...`);
            const tickets = await this.db.ticket.findMany({
                where: {
                    created: { gte: startOfDay, lte: endOfDay },
                    // ticket must belong to this game
                    games: { some: { gameID } },
                    // …and contain at least one winning code
                    codes: { some: { value: { in: winningValues } } },
                },
                select: {
                    id: true,
                    name: true,
                    creatorID: true,
                    codes: {
                        where: { value: { in: winningValues } }, // keep only winning codes
                        select: { code: true, value: true },
                    },
                },
            });

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

        // Group winning codes by game
        const winningCodesByGame = new Map<number, Array<{ code: string; order: number }>>();
        
        for (const raffle of raffles) {
            if (!winningCodesByGame.has(raffle.gameID)) {
                winningCodesByGame.set(raffle.gameID, []);
            }
            
            const codeToOrder = new Map<string, number>();
            for (const code of raffle.codes) {
                if (!codeToOrder.has(code.code)) {
                    codeToOrder.set(code.code, codeToOrder.size + 1);
                }
                winningCodesByGame.get(raffle.gameID)!.push({
                    code: code.code,
                    order: codeToOrder.get(code.code)!
                });
            }
        }

        // Process each game's winning tickets
        for (const [gameID, winningCodes] of winningCodesByGame) {
            if (winningCodes.length === 0) continue;

            const winningValues = winningCodes.map(wc => parseInt(wc.code, 10));
            
            // Find all winning tickets for this game
            const winningTickets = await this.db.ticket.findMany({
                where: {
                    created: { gte: startOfDay, lte: endOfDay },
                    games: { some: { gameID } },
                    codes: { some: { value: { in: winningValues } } }
                },
                include: {
                    codes: {
                        where: { value: { in: winningValues } },
                        select: { code: true, value: true }
                    },
                    creator: {
                        select: { id: true }
                    }
                }
            });

            console.debug(`Found ${winningTickets.length} winning tickets for game ${gameID}`);

            // Process each winning ticket
            for (const ticket of winningTickets) {
                for (const ticketCode of ticket.codes) {
                    const prizeAmount = this.calculatePrizeAmount(
                        ticketCode.code,
                        ticketCode.value,
                        gameID,
                        winningCodes
                    );

                    if (prizeAmount <= 0) continue;

                    const reference = `PRIZE:${raffles.find(r => r.gameID === gameID)?.id}:${ticket.id}:${ticketCode.code}`;

                    // Check if prize action already exists
                    const existingPrize = await this.db.balanceAction.findFirst({
                        where: { reference }
                    });

                    if (existingPrize) {
                        console.debug(`Prize action already exists for ticket ${ticket.id}, code ${ticketCode.code}`);
                        continue;
                    }

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
                            created: date // Use raffle processing date for consistency
                        }
                    });

                    // Update balance (add the prize amount)
                    await this.db.balance.update({
                        where: { id: balance.id },
                        data: {
                            balance: { increment: prizeAmount }
                        }
                    });

                    console.debug(`Created prize action for ticket ${ticket.id}, code ${ticketCode.code}: ${prizeAmount/100} EUR`);
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
                total += stakeValue * multiplier;
            }
        }

        return total;
    }
}

RaffleService.register()