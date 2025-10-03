import { BalanceActionType, Prisma, PrismaClient } from '@prisma/client';
import {pagination} from 'prisma-extension-pagination';

// Initialize base Prisma Client
const basePrisma = new PrismaClient();

// Apply middleware to the base client
basePrisma.$use(async (params: Prisma.MiddlewareParams, next: (params: Prisma.MiddlewareParams) => Promise<any>) => {
    const { model, action, args, runInTransaction } = params;

    if (model === 'TicketGame' && action === 'createMany') {
        const result = await next(params);

        try {
            const dataArg = args?.data;
            const entries = Array.isArray(dataArg) ? dataArg : [dataArg];

            const countsByTicket = new Map<number, number>();
            for (const entry of entries) {
                const ticketID = entry?.ticketID;
                if (typeof ticketID !== 'number') continue;
                countsByTicket.set(ticketID, (countsByTicket.get(ticketID) ?? 0) + 1);
            }

            for (const [ticketID, gameCount] of countsByTicket.entries()) {
                const ticket = await next({
                    model: 'Ticket',
                    action: 'findUnique',
                    dataPath: [],
                    runInTransaction,
                    args: {
                        where: { id: ticketID },
                        select: {
                            id: true,
                            creatorID: true,
                            codes: { select: { value: true } },
                        },
                    },
                }) as { id: number; creatorID: number; codes: Array<{ value: number }> } | null;

                if (!ticket) continue;

                const reference = `TICKET_SALE:${ticketID}`;
                const existing = await next({
                    model: 'BalanceAction',
                    action: 'findFirst',
                    dataPath: [],
                    runInTransaction,
                    args: {
                        where: { reference },
                        select: { id: true },
                    },
                }) as { id: number } | null;

                if (existing) continue;

                const baseStake = ticket.codes.reduce((sum, code) => sum + Number(code.value ?? 0), 0);
                const totalStake = baseStake * (gameCount || 1);

                if (totalStake === 0) continue;

                const balance = await next({
                    model: 'Balance',
                    action: 'upsert',
                    dataPath: [],
                    runInTransaction,
                    args: {
                        where: { userID: ticket.creatorID },
                        update: {},
                        create: { userID: ticket.creatorID, balance: 0 },
                    },
                }) as { id: number };

                await next({
                    model: 'BalanceAction',
                    action: 'create',
                    dataPath: [],
                    runInTransaction,
                    args: {
                        data: {
                            balanceID: balance.id,
                            type: BalanceActionType.TICKET_SALE,
                            amount: totalStake,
                            reference,
                        },
                    },
                });

                await next({
                    model: 'Balance',
                    action: 'update',
                    dataPath: [],
                    runInTransaction,
                    args: {
                        where: { id: balance.id },
                        data: { balance: { increment: totalStake } },
                    },
                });
            }
        } catch (error) {
            console.error('Failed to record balance action for ticket sale', error);
        }

        return result;
    }

    if (model === 'Code' && action === 'createMany') {
        const result = await next(params);

        try {
            const dataArg = args?.data;
            const entries = Array.isArray(dataArg) ? dataArg : [dataArg];

            const codesByRaffle = new Map<number, Set<string>>();
            for (const entry of entries) {
                const raffleID = entry?.raffleID;
                const codeValue = entry?.code;
                if (typeof raffleID !== 'number' || !codeValue) continue;
                if (!codesByRaffle.has(raffleID)) {
                    codesByRaffle.set(raffleID, new Set<string>());
                }
                codesByRaffle.get(raffleID)!.add(String(codeValue));
            }

            for (const [raffleID, codes] of codesByRaffle.entries()) {
                if (codes.size === 0) continue;

                const raffle = await next({
                    model: 'Raffle',
                    action: 'findUnique',
                    dataPath: [],
                    runInTransaction,
                    args: {
                        where: { id: raffleID },
                        select: { id: true, gameID: true },
                    },
                }) as { id: number; gameID: number } | null;

                if (!raffle) continue;

                const winningTicketCodes = await next({
                    model: 'Code',
                    action: 'findMany',
                    dataPath: [],
                    runInTransaction,
                    args: {
                        where: {
                            code: { in: Array.from(codes) },
                            raffleID: null,
                            ticketID: { not: null },
                            ticket: { games: { some: { gameID: raffle.gameID } } },
                        },
                        select: {
                            code: true,
                            value: true,
                            ticketID: true,
                            ticket: {
                                select: {
                                    id: true,
                                    creatorID: true,
                                },
                            },
                        },
                    },
                }) as Array<{ code: string; value: number; ticketID: number | null; ticket: { id: number; creatorID: number } | null }>;

                for (const winning of winningTicketCodes) {
                    const ticket = winning.ticket;
                    if (!ticket) continue;

                    const payout = Number(winning.value ?? 0);
                    if (payout === 0) continue;

                    const reference = `PRIZE:${raffleID}:${ticket.id}:${winning.code}`;
                    const existingAction = await next({
                        model: 'BalanceAction',
                        action: 'findFirst',
                        dataPath: [],
                        runInTransaction,
                        args: {
                            where: { reference },
                            select: { id: true },
                        },
                    }) as { id: number } | null;

                    if (existingAction) continue;

                    const balance = await next({
                        model: 'Balance',
                        action: 'upsert',
                        dataPath: [],
                        runInTransaction,
                        args: {
                            where: { userID: ticket.creatorID },
                            update: {},
                            create: { userID: ticket.creatorID, balance: 0 },
                        },
                    }) as { id: number };

                    await next({
                        model: 'BalanceAction',
                        action: 'create',
                        dataPath: [],
                        runInTransaction,
                        args: {
                            data: {
                                balanceID: balance.id,
                                type: BalanceActionType.PAYOUT,
                                amount: -payout,
                                reference,
                            },
                        },
                    });

                    await next({
                        model: 'Balance',
                        action: 'update',
                        dataPath: [],
                        runInTransaction,
                        args: {
                            where: { id: balance.id },
                            data: { balance: { decrement: payout } },
                        },
                    });
                }
            }
        } catch (error) {
            console.error('Failed to create balance actions for prizes', error);
        }

        return result;
    }

    return next(params);
});

// Extend the base client with pagination extension
const prisma = basePrisma.$extends(pagination());

// Export the extended Prisma client
export type ExtendedPrismaClient = typeof prisma;

export interface TransactionRequest {
    db: Prisma.TransactionClient;
}

export default prisma;
