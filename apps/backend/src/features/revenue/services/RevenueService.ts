import { injectable, inject } from "tsyringe";
import Service from "../../../common/services/Service";
import { ExtendedPrismaClient } from "../../../common/utils/prisma";
import { TicketMapper } from "../../ticket/mappers/TicketMapper";
import { Context } from "../../../common/utils/context";

export interface IRevenueService {
    getRevenueByDate(date: Date): Promise<RevenueResult>;
    getRevenueByTicket(ticketID: number): Promise<RevenueResult>;
    getRevenueByRaffle(ticketID: number): Promise<RevenueResult>;
    getRevenueByRunner(runnerID: number, date?: Date): Promise<RevenueResult>;
}

export interface RevenueResult {
    grossIncome: number;
    totalCommission: number;
    netIncome: number;
}

@injectable()
export class RevenueService extends Service implements IRevenueService {
    constructor(
        @inject("Database") protected db: ExtendedPrismaClient
    ) {
        super();
    }

    public getRevenueByDate = async (date: Date): Promise<RevenueResult> => {
        const startOfDay = new Date(date.getTime());
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(date.getTime());
        endOfDay.setHours(23, 59, 59, 999);

        const tickets = await this.db.ticket.findMany({
            where: {
                created: {
                    gte: startOfDay,
                    lte: endOfDay,
                },
            },
            select: TicketMapper.getSelectableFields(),
        });

        return this.calculateRevenueFromTickets(tickets);
    }

    public getRevenueByTicket = async (ticketID: number): Promise<RevenueResult> => {
        const ticket = await this.db.ticket.findUnique({
            where: { id: ticketID },
            select: TicketMapper.getSelectableFields(),
        });

        return ticket ? this.calculateRevenueFromTickets([ticket]) : { grossIncome: 0, totalCommission: 0, netIncome: 0 };
    }

    public getRevenueByRaffle = async (raffleID: number): Promise<RevenueResult> => {
        const tickets = await this.db.ticket.findMany({
            where: {
                games: {
                    some: {
                        game: {
                            raffles: {
                                some: {
                                    id: raffleID
                                }
                            }
                        }
                    }
                }
            },
            select: TicketMapper.getSelectableFields(),
        });
    
        return this.calculateRevenueFromTickets(tickets);
    }

    public getRevenueByRunner = async (runnerID: number, date?: Date): Promise<RevenueResult> => {
        let tickets = await this.db.ticket.findMany({
            where: { creatorID: runnerID },
            select: TicketMapper.getSelectableFields(),
        });

        if (date) { 
            const startOfDay = new Date(date.getTime());
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(date.getTime());
            endOfDay.setHours(23, 59, 59, 999);

            tickets = tickets.filter(ticket => ticket.created >= startOfDay && ticket.created <= endOfDay);
        }

        return this.calculateRevenueFromTickets(tickets, false);
    }

    private async calculateRevenueFromTickets(tickets: any[], includeManagerCommission: boolean = true): Promise<RevenueResult> {
        if (tickets.length === 0) {
            return { grossIncome: 0, totalCommission: 0, netIncome: 0 };
        }

        const currentUser = Context.get('user');

        const isAdminOrManager = currentUser.role === 'ADMIN' || currentUser.role === 'MANAGER';

        const result = await tickets.reduce(
            async (accPromise: Promise<{ grossIncome: number; totalCommission: number }>, ticket) => {
                const acc = await accPromise;
                const ticketValue = ticket.codes.reduce((sum: number, code: { value: number }) => sum + code.value, 0);
                let commission = (ticketValue * ticket.creator.commission) / 100;

                if (includeManagerCommission && isAdminOrManager) {
                    const manager = await this.db.managerRunner.findFirst({
                        where: { runnerID: ticket.runnerID },
                        select: { manager: { select: { commission: true } } }
                    });
                    if (manager) {
                        commission += (ticketValue * manager.manager.commission) / 100;
                    }
                }

                return {
                    grossIncome: acc.grossIncome + ticketValue,
                    totalCommission: acc.totalCommission + commission,
                };
            },
            Promise.resolve({ grossIncome: 0, totalCommission: 0 })
        );

        return {
            grossIncome: result.grossIncome,
            totalCommission: result.totalCommission,
            netIncome: result.grossIncome - result.totalCommission,
        };
    }
}
