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

        // After all raffles are saved, create provision balance actions for the raffle date
        await this.createProvisionBalanceActions(raffleDate);
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
}

RaffleService.register()