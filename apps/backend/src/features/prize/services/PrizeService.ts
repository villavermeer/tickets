import { inject, injectable } from "tsyringe";
import Service from "../../../common/services/Service";
import { ExtendedPrismaClient } from "../../../common/utils/prisma";
import { Context } from "../../../common/utils/context";
import { Prisma, Role } from "@prisma/client";
import { DateTime } from "luxon";

// Multiplier matrix provided by PO
// Amount won = stake (inleg) x multiplier
// For DEFAULT games, multiplier depends on raffle order (1..3) and code length (2,3,4)
// For SUPER4 game, multiplier depends only on code length
const MULTIPLIERS = {
    DEFAULT: {
        1: { 4: 3000, 3: 400, 2: 40 },
        2: { 4: 1500, 3: 200, 2: 20 },
        3: { 4: 750, 3: 100, 2: 10 },
    },
    SUPER4: { 4: 5250, 3: 700, 2: 70 }
} as const;

export interface PrizeCode {
    code: string;
    value: number;
    raffleOrder?: number;
    stake: number;
}

export interface PrizeTicket {
    id: number;
    name: string;
    creatorID: number;
    runnerID?: number;
    managerID?: number;
    runnerName?: string;
    managerName?: string;
    codes: PrizeCode[];
    totalPrize: number;
}

export interface PrizeGroup {
    game: { id: number; name: string };
    tickets: PrizeTicket[];
}

export interface PrizeRunnerAggregate {
    id: number;
    name: string;
    managerName?: string;
    totalPrize: number;
    ticketCount: number;
}

export interface PrizeManagerAggregate {
    id: number;
    name: string;
    totalPrize: number;
    ticketCount: number;
}

export interface IPrizeService {
    getPrizesByDate(date: Date, scopeUserID?: number, page?: number, pageSize?: number): Promise<{
        groups: PrizeGroup[];
        page: number;
        pageSize: number;
        hasMore: boolean;
        totalTickets: number;
        runnerTotals: PrizeRunnerAggregate[];
        managerTotals: PrizeManagerAggregate[];
    }>;
}

@injectable()
export class PrizeService extends Service implements IPrizeService {
    constructor(@inject("Database") protected db: ExtendedPrismaClient) {
        super();
    }

    /**
     * Calculate winnings for a played code against all winning codes for a game/day.
     * - Matches on suffix: a 2-digit play wins when it matches the last 2 of a winning 4-digit code, etc.
     * - DEFAULT games: multiplier depends on raffle order (1..3) and code length
     * - SUPER4: multiplier depends only on code length
     */
    private calculateWinningsForCode(
        playedCode: string,
        stakeValue: number,
        gameID: number,
        winningCodesWithOrder: Array<{ code: string; order: number }>
    ): { total: number; perOccurrence: Array<{ order: number; value: number }> } {
        const codeLength = playedCode.length;
        const isSuper4 = gameID === 7;

        let total = 0;
        const perOccurrence: Array<{ order: number; value: number }> = [];

        for (const { code: winningCode, order } of winningCodesWithOrder) {
            if (!winningCode.endsWith(playedCode)) continue;

            const multiplier = isSuper4
                ? (MULTIPLIERS.SUPER4 as any)[codeLength] ?? 0
                : ((MULTIPLIERS.DEFAULT as any)[order]?.[codeLength] ?? 0);

            if (multiplier > 0) {
                const value = stakeValue * multiplier;
                total += value;
                perOccurrence.push({ order, value });
            }
        }

        return { total, perOccurrence };
    }

    /**
     * Returns prize results grouped by game for the provided calendar date.
     * Access scope is applied based on the current user role:
     * - ADMIN: all users
     * - MANAGER: self + runners under the manager, or a specific runner when provided
     * - RUNNER: only self regardless of the provided scopeUserID
     */
    public async getPrizesByDate(date: Date, scopeUserID?: number, page: number = 1, pageSize: number = 50): Promise<{
        groups: PrizeGroup[];
        page: number;
        pageSize: number;
        hasMore: boolean;
        totalTickets: number;
        runnerTotals: PrizeRunnerAggregate[];
        managerTotals: PrizeManagerAggregate[];
    }> {
        const currentUser = Context.get("user");

        // Compute date ranges in Amsterdam timezone
        const amsterdamDate = DateTime.fromJSDate(date).setZone('Europe/Amsterdam');
        const raffleDayStartUTC = amsterdamDate.startOf('day').toUTC().toJSDate();
        const raffleDayEndUTC = amsterdamDate.endOf('day').toUTC().toJSDate();
        const ticketDayStartUTC = amsterdamDate.minus({ days: 1 }).startOf('day').toUTC().toJSDate();
        const ticketDayEndUTC = amsterdamDate.minus({ days: 1 }).endOf('day').toUTC().toJSDate();

        // Determine user scope for filtering tickets
        let scopedUserIDs: number[] | undefined;

        if (currentUser.role === Role.RUNNER) {
            scopedUserIDs = [currentUser.id];
        } else if (currentUser.role === Role.MANAGER) {
            if (scopeUserID && scopeUserID !== currentUser.id) {
                const isUnderManager = await this.db.managerRunner.findFirst({
                    where: { managerID: currentUser.id, runnerID: scopeUserID },
                    select: { id: true }
                });
                if (!isUnderManager) {
                    // If not managed, limit to manager self
                    scopedUserIDs = [currentUser.id];
                } else {
                    scopedUserIDs = [scopeUserID];
                }
            } else {
                // Manager without specific runner -> self + all runners
                const relations = await this.db.managerRunner.findMany({
                    where: { managerID: currentUser.id },
                    select: { runnerID: true }
                });
                scopedUserIDs = [currentUser.id, ...relations.map(r => r.runnerID)];
            }
        } else {
            // ADMIN: optionally narrow to a requested user
            if (scopeUserID) scopedUserIDs = [scopeUserID];
        }

        // Find raffles created on the provided day and collect winning values by game
        const raffleWhere: Prisma.RaffleWhereInput = {
            OR: [
                { created: { gte: raffleDayStartUTC, lte: raffleDayEndUTC } },
                { updated: { gte: raffleDayStartUTC, lte: raffleDayEndUTC } }
            ]
        };

        const raffles = await this.db.raffle.findMany({
            where: raffleWhere,
            distinct: ['id'],
            orderBy: [
                { created: 'asc' },
                { id: 'asc' }
            ],
            select: {
                id: true,
                created: true,
                gameID: true,
                game: { select: { id: true, name: true } },
                codes: { select: { code: true } }
            }
        });

        if (raffles.length === 0) return {
            groups: [],
            page,
            pageSize,
            hasMore: false,
            totalTickets: 0,
            runnerTotals: [],
            managerTotals: []
        };

        const byGame = new Map<
            number,
            { game: { id: number; name: string }; winningCodes: string[]; codeToOrder: Map<string, number> }
        >();
        for (const r of raffles) {
            const entry = byGame.get(r.gameID) ?? { game: r.game, winningCodes: [] as string[], codeToOrder: new Map<string, number>() };
            // push winning codes for this raffle
            for (const c of r.codes) {
                if (!entry.codeToOrder.has(c.code)) {
                    entry.codeToOrder.set(c.code, entry.codeToOrder.size + 1);
                }
                entry.winningCodes.push(c.code);
            }
            // order mapping (1-based) for codes as they appear across raffles in the day
            byGame.set(r.gameID, entry);
        }

        const result: PrizeGroup[] = [];
        let totalTickets = 0;
        const runnerTotalsMap = new Map<number, PrizeRunnerAggregate>();
        const managerTotalsMap = new Map<number, PrizeManagerAggregate>();

        for (const [gameID, { game, winningCodes }] of byGame) {
            const uniqueWinningCodes = Array.from(new Set(winningCodes));
            if (uniqueWinningCodes.length === 0) {
                result.push({ game, tickets: [] });
                continue;
            }

            // Build suffix sets (2, 3, 4) for efficient filtering
            const suffix2 = new Set(uniqueWinningCodes.map(c => c.slice(-2)));
            const suffix3 = new Set(uniqueWinningCodes.map(c => c.slice(-3)));
            const suffix4 = new Set(uniqueWinningCodes.map(c => c.slice(-4)));

            const whereTickets: Prisma.TicketWhereInput = {
                creatorID: scopedUserIDs ? { in: scopedUserIDs } : undefined,
                games: { some: { gameID } },
                // Any code that equals any of the winning suffixes for 2, 3 or 4 digits
                codes: {
                    some: {
                        AND: [
                            { created: { gte: ticketDayStartUTC, lte: ticketDayEndUTC } },
                            {
                                OR: [
                                    { code: { in: Array.from(suffix2) } },
                                    { code: { in: Array.from(suffix3) } },
                                    { code: { in: Array.from(suffix4) } }
                                ]
                            }
                        ]
                    }
                }
            };

            const count = await this.db.ticket.count({ where: whereTickets });
            totalTickets += count;

            const tickets = await this.db.ticket.findMany({
                where: whereTickets,
                select: {
                    id: true,
                    name: true,
                    creatorID: true,
                    creator: {
                        select: {
                            id: true,
                            name: true,
                            role: true,
                            manager: {
                                select: {
                                    managerID: true,
                                    manager: {
                                        select: {
                                            id: true,
                                            name: true
                                        }
                                    }
                                }
                            }
                        }
                    },
                    codes: {
                        // Keep all played codes that can potentially win (2/3/4 length)
                        where: {
                            AND: [
                                { created: { gte: ticketDayStartUTC, lte: ticketDayEndUTC } },
                                {
                                    OR: [
                                        { code: { in: Array.from(suffix2) } },
                                        { code: { in: Array.from(suffix3) } },
                                        { code: { in: Array.from(suffix4) } }
                                    ]
                                }
                            ]
                        },
                        select: { code: true, value: true }
                    }
                },
                orderBy: { id: 'asc' },
                skip: (page - 1) * pageSize,
                take: pageSize
            });

            const codeToOrder = byGame.get(gameID)?.codeToOrder ?? new Map();
            const winningWithOrder = Array.from(uniqueWinningCodes).map(code => ({ code, order: codeToOrder.get(code) ?? 1 }));

            const formatted: PrizeTicket[] = [];

            for (const t of tickets as Array<typeof tickets[number] & {
                creator?: {
                    id: number;
                    name: string;
                    role: Role;
                    manager?: Array<{ managerID: number; manager?: { id: number; name: string } }>;
                } | null;
            }>) {
                const creator = t.creator ?? null;
                let runnerID: number | undefined;
                let runnerName: string | undefined;
                let managerID: number | undefined;
                let managerName: string | undefined;

                if (creator) {
                    if (creator.role === Role.RUNNER) {
                        runnerID = creator.id;
                        runnerName = creator.name;
                        const relation = creator.manager?.[0];
                        if (relation?.manager) {
                            managerID = relation.manager.id;
                            managerName = relation.manager.name;
                        }
                    } else if (creator.role === Role.MANAGER) {
                        managerID = creator.id;
                        managerName = creator.name;
                    }
                }

                const perCodeOccurrences: PrizeCode[] = [];

                for (const played of t.codes as unknown as Array<{ code: string; value: number }>) {
                    const { perOccurrence } = this.calculateWinningsForCode(played.code, played.value, gameID, winningWithOrder);

                    // Duplicate code entry per occurrence so UI can show multiple trek orders
                    for (const occ of perOccurrence) {
                        perCodeOccurrences.push({ code: played.code, value: occ.value, raffleOrder: occ.order, stake: played.value });
                    }
                }

                const totalPrize = perCodeOccurrences.reduce((acc, c) => acc + c.value, 0);

                if (perCodeOccurrences.length === 0 || totalPrize <= 0) continue;

                if (runnerID) {
                    const existing = runnerTotalsMap.get(runnerID) ?? {
                        id: runnerID,
                        name: runnerName ?? '-',
                        managerName: managerName,
                        totalPrize: 0,
                        ticketCount: 0
                    };
                    existing.totalPrize += totalPrize;
                    existing.ticketCount += 1;
                    if (!existing.managerName && managerName) existing.managerName = managerName;
                    runnerTotalsMap.set(runnerID, existing);
                }

                if (managerID) {
                    const existing = managerTotalsMap.get(managerID) ?? {
                        id: managerID,
                        name: managerName ?? '-',
                        totalPrize: 0,
                        ticketCount: 0
                    };
                    existing.totalPrize += totalPrize;
                    existing.ticketCount += 1;
                    managerTotalsMap.set(managerID, existing);
                }

                formatted.push({
                    id: t.id,
                    name: t.name,
                    creatorID: t.creatorID,
                    runnerID,
                    managerID,
                    runnerName,
                    managerName,
                    codes: perCodeOccurrences,
                    totalPrize
                });
            }

            result.push({ game, tickets: formatted });
        }

        const runnerTotals = Array
            .from(runnerTotalsMap.values())
            .sort((a, b) => b.totalPrize - a.totalPrize);

        const managerTotals = Array
            .from(managerTotalsMap.values())
            .sort((a, b) => b.totalPrize - a.totalPrize);

        const hasMore = page * pageSize < totalTickets;
        return { groups: result, page, pageSize, hasMore, totalTickets, runnerTotals, managerTotals };
    }
}

PrizeService.register("PrizeService");
