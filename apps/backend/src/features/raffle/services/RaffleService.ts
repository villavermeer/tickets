import { inject, singleton } from 'tsyringe';
import Service from '../../../common/services/Service';
import { ExtendedPrismaClient } from '../../../common/utils/prisma';
import { CreateRaffleRequest } from '../types/requests';
import { RaffleInterface } from '@tickets/types/dist/raffle';
import EntityNotFoundError from '../../../common/classes/errors/EntityNotFoundError';
import { RaffleMapper } from '../mappers/RaffleMapper';
import { CodeMapper } from '../../code/mappers/CodeMapper';
import { Game, Ticket } from '@prisma/client';
import { GameInterface, TicketInterface } from '@tickets/types';

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

        for (const raffle of data) {
            // Check for existing raffle for today and gameID
            const existingRaffle = await this.db.raffle.findFirst({
                where: {
                    gameID: raffle.gameID,
                    created: new Date(today.getTime() - 24 * 60 * 60 * 1000)
                }
            });

            let savedRaffle;

            if (existingRaffle) {
                // Raffle exists, update codes by first deleting existing ones
                await this.db.code.deleteMany({
                    where: {
                        raffleID: existingRaffle.id
                    }
                });

                savedRaffle = existingRaffle;
            } else {
                // Create new raffle
                savedRaffle = await this.db.raffle.create({
                    data: {
                        gameID: raffle.gameID,
                        created: new Date(today.getTime() - 24 * 60 * 60 * 1000)
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
    }

    public async all() {
        const raffles = await this.db.raffle.findMany({
            select: RaffleMapper.getSelectableFields()
        });

        return RaffleMapper.formatMany(raffles);
    }

    public async today() {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);

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
        const raffles = await this.db.raffle.findMany({
            select: RaffleMapper.getSelectableFields(),
            where: {
                created: {
                    gte: new Date(date.setHours(0, 0, 0, 0)),
                    lte: new Date(date.setHours(23, 59, 59, 999))
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
        
        // ── 1 ── build immutable day-start / day-end boundaries
        const startOfDay = new Date(date);
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date(date);
        endOfDay.setHours(23, 59, 59, 999);

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
}

RaffleService.register()