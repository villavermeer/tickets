import { injectable, inject } from "tsyringe";
import Service from "../../../common/services/Service";
import { ExtendedPrismaClient } from "../../../common/utils/prisma";
import { TicketMapper } from "../../ticket/mappers/TicketMapper";
import { Context } from "../../../common/utils/context";
import { Role, User, Ticket as PrismaTicket, Raffle } from "@prisma/client";
import { DateTime } from "luxon";

export interface IRevenueService {
    getRevenueByDate(date: Date): Promise<RevenueResult>;
    getRevenueByTicket(ticketID: number): Promise<RevenueResult>;
    getRevenueByRaffle(raffleID: number): Promise<RevenueResult>;
    getRevenueByRunner(runnerID: number, date?: Date): Promise<RevenueResult>;
    getRevenueByManager(managerID: number, date?: Date, includeRunners?: boolean): Promise<RevenueResult>;
}

export interface RevenueResult {
    grossIncome: number;
    totalCommission: number;
    netIncome: number;
}

interface TicketCode {
    value: number;
}

interface TicketWithRelations {
    id: number;
    created: Date;
    creator: Pick<User, "id" | "commission">;
    codes: TicketCode[];
    games: { gameID: number }[];
}

interface ManagerRelation {
    runnerID: number;
    manager: Pick<User, "commission">;
}

@injectable()
export class RevenueService extends Service implements IRevenueService {
    constructor(@inject("Database") protected db: ExtendedPrismaClient) {
        super();
    }

    public async getRevenueByDate(date: Date): Promise<RevenueResult> {
        const { startOfDay, endOfDay } = this.getDateRange(date);
        const requestUser = Context.get("user");

        let tickets = await this.db.ticket.findMany({
            where: {
                created: {
                    gte: startOfDay,
                    lte: endOfDay
                }
            },
            select: {
                ...TicketMapper.getSelectableFields(),
                games: { select: { gameID: true } }
            },
        }) as TicketWithRelations[];

        if (requestUser?.role === Role.RUNNER) {
            return this.calculateRevenueFromTickets(
                tickets.filter(t => t.creator.id === requestUser.id)
            );
        }

        if (requestUser?.role === Role.MANAGER) {
            const runnerIDs = await this.getRunnersUnderManager(requestUser.id);
            return this.calculateRevenueFromTickets(
                tickets.filter(t => t.creator.id === requestUser.id || runnerIDs.includes(t.creator.id))
            );
        }

        return this.calculateRevenueFromTickets(tickets);
    }

    public async getRevenueByTicket(ticketID: number): Promise<RevenueResult> {
        const ticket = await this.db.ticket.findUnique({
            where: { id: ticketID },
            select: {
                ...TicketMapper.getSelectableFields(),
                games: { select: { gameID: true } }
            },
        }) as TicketWithRelations | null;

        if (!ticket) {
            return { grossIncome: 0, totalCommission: 0, netIncome: 0 };
        }

        return this.calculateRevenueFromTickets([ticket]);
    }

    public async getRevenueByRaffle(raffleID: number): Promise<RevenueResult> {
        const tickets = await this.db.ticket.findMany({
            where: {
                games: { some: { game: { raffles: { some: { id: raffleID } } } } },
            },
            select: {
                ...TicketMapper.getSelectableFields(),
                games: { select: { gameID: true } }
            },
        }) as TicketWithRelations[];

        console.log(tickets);
        
        return this.calculateRevenueFromTickets(tickets);
    }

    public async getRevenueByRunner(runnerID: number, date?: Date): Promise<RevenueResult> {
        let tickets = await this.db.ticket.findMany({
            where: { creatorID: runnerID },
            select: {
                ...TicketMapper.getSelectableFields(),
                games: { select: { gameID: true } }
            },
        }) as TicketWithRelations[];

        if (date) {
            const { startOfDay, endOfDay } = this.getDateRange(date);
            tickets = tickets.filter(t => t.created >= startOfDay && t.created <= endOfDay);
        }

        return this.calculateRevenueFromTickets(tickets, false);
    }

    public async getRevenueByManager(managerID: number, date?: Date, includeRunners?: boolean): Promise<RevenueResult> {
        const { startOfDay, endOfDay } = date ? this.getDateRange(date) : { startOfDay: undefined, endOfDay: undefined };

        const tickets = await this.db.ticket.findMany({
            where: {
                created: date ? { gte: startOfDay, lte: endOfDay } : undefined
            },
            select: {
                ...TicketMapper.getSelectableFields(),
                games: { select: { gameID: true } }
            },
        }) as TicketWithRelations[];

        const filterIDs = includeRunners ? await this.getRunnersUnderManager(managerID) : [managerID];

        const filtered = tickets.filter(t => filterIDs.includes(t.creator.id));

        return this.calculateRevenueFromTickets(filtered);
    }

    private getDateRange(date: Date) {
        // Convert to Amsterdam timezone and get day boundaries
        const amsterdamDate = DateTime.fromJSDate(date).setZone('Europe/Amsterdam');
        const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
        const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();
        return { startOfDay, endOfDay };
    }

    private async getRunnersUnderManager(managerID: number): Promise<number[]> {
        const relations = await this.db.managerRunner.findMany({
            where: { managerID },
            select: { runnerID: true },
        }) as ManagerRelation[];
        return relations.map(r => r.runnerID);
    }

    private async calculateRevenueFromTickets(
        tickets: TicketWithRelations[],
        includeManagerCommission = true
    ): Promise<RevenueResult> {
        if (!tickets.length) {
            return { grossIncome: 0, totalCommission: 0, netIncome: 0 };
        }

        const currentUser = Context.get("user");
        const isAdminOrManager = [Role.ADMIN, Role.MANAGER].includes(currentUser.role);

        const sums = await tickets.reduce(async (accP, t) => {
            const acc = await accP;
            const gameCount = t.games.length;
            const value = t.codes.reduce((sum, c) => sum + (c.value * gameCount), 0);
            let commission = (value * t.creator.commission) / 100;

            if (includeManagerCommission && isAdminOrManager) {
                const mgrRel = await this.db.managerRunner.findFirst({
                    where: { runnerID: t.creator.id },
                    select: { manager: { select: { commission: true } } },
                }) as ManagerRelation | null;

                if (mgrRel) {
                    commission += (value * mgrRel.manager.commission) / 100;
                }
            }

            return {
                grossIncome: acc.grossIncome + value,
                totalCommission: acc.totalCommission + commission,
            };
        }, Promise.resolve({ grossIncome: 0, totalCommission: 0 }));

        return {
            grossIncome: sums.grossIncome,
            totalCommission: sums.totalCommission,
            netIncome: sums.grossIncome - sums.totalCommission,
        };
    }
}