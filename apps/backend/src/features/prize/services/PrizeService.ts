import { inject, injectable } from "tsyringe";
import Service from "../../../common/services/Service";
import { ExtendedPrismaClient } from "../../../common/utils/prisma";
import { Context } from "../../../common/utils/context";
import { Prisma, Role } from "@prisma/client";

export interface PrizeCode {
    code: string;
    value: number;
    raffleOrder?: number;
}

export interface PrizeTicket {
    id: number;
    name: string;
    creatorID: number;
    codes: PrizeCode[];
    totalPrize: number;
}

export interface PrizeGroup {
    game: { id: number; name: string };
    tickets: PrizeTicket[];
}

export interface IPrizeService {
    getPrizesByDate(date: Date, scopeUserID?: number): Promise<PrizeGroup[]>;
}

@injectable()
export class PrizeService extends Service implements IPrizeService {
    constructor(@inject("Database") protected db: ExtendedPrismaClient) {
        super();
    }

    /**
     * Returns prize results grouped by game for the provided calendar date.
     * Access scope is applied based on the current user role:
     * - ADMIN: all users
     * - MANAGER: self + runners under the manager, or a specific runner when provided
     * - RUNNER: only self regardless of the provided scopeUserID
     */
    public async getPrizesByDate(date: Date, scopeUserID?: number): Promise<PrizeGroup[]> {
        const currentUser = Context.get("user");

        // Compute date range
        const startOfDay = new Date(Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
            0, 0, 0, 0
        ));
        const endOfDay = new Date(Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate(),
            23, 59, 59, 999
        ));

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
                { created: { gte: startOfDay, lte: endOfDay } },
                { updated: { gte: startOfDay, lte: endOfDay } }
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

        if (raffles.length === 0) return [];

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

        for (const [gameID, { game, winningCodes }] of byGame) {
            const uniqueWinningCodes = Array.from(new Set(winningCodes));
            if (uniqueWinningCodes.length === 0) {
                result.push({ game, tickets: [] });
                continue;
            }

            const tickets = await this.db.ticket.findMany({
                where: {
                    creatorID: scopedUserIDs ? { in: scopedUserIDs } : undefined,
                    games: { some: { gameID } },
                    codes: { some: { code: { in: uniqueWinningCodes } } }
                },
                select: {
                    id: true,
                    name: true,
                    creatorID: true,
                    codes: {
                        where: { code: { in: uniqueWinningCodes } },
                        select: { code: true, value: true }
                    }
                }
            });

            const codeToOrder = byGame.get(gameID)?.codeToOrder ?? new Map();
            const formatted: PrizeTicket[] = tickets.map(t => {
                const codesWithOrder = (t.codes as PrizeCode[]).map(c => ({
                    ...c,
                    raffleOrder: codeToOrder.get(c.code) ?? 1
                }));
                const totalPrize = codesWithOrder.reduce((acc, code) => acc + (code.value ?? 0), 0);
                return {
                    id: t.id,
                    name: t.name,
                    creatorID: t.creatorID,
                    codes: codesWithOrder,
                    totalPrize
                };
            });

            result.push({ game, tickets: formatted });
        }

        return result;
    }
}

PrizeService.register("PrizeService");
