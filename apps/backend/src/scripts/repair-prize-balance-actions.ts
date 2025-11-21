/**
 * Repairs PRIZE balance actions by normalizing references, removing duplicates,
 * and creating missing actions for a date or date range.
 *
 * Usage:
 *   npx ts-node src/scripts/repair-prize-balance-actions.ts 2025-11-20 [2025-11-21] [--dry-run]
 */

import { PrismaClient, BalanceActionType } from '@prisma/client';
import { DateTime } from 'luxon';
import { createPrizeReference } from '../features/raffle/utils/prizeReference';

const prisma = new PrismaClient();

type PrizeExpectation = {
    reference: string;
    prizeAmount: number; // positive cents
    userID: number;
    ticketID: number;
    raffleID: number;
    code: string;
    created: Date;
};

type RepairStats = {
    normalized: number;
    created: number;
    amountAdjusted: number;
    duplicatesRemoved: number;
};

function parseArgs() {
    const [, , startArg, endArg, maybeFlag] = process.argv;
    if (!startArg) {
        throw new Error('Start date (YYYY-MM-DD) is required');
    }

    const dryRun = maybeFlag === '--dry-run' || endArg === '--dry-run';
    const effectiveEnd = dryRun && !endArg
        ? startArg
        : (endArg && endArg !== '--dry-run' ? endArg : startArg);

    return {
        start: new Date(startArg),
        end: new Date(effectiveEnd),
        dryRun
    };
}

async function buildExpectations(date: Date): Promise<PrizeExpectation[]> {
    const amsterdamDate = DateTime.fromJSDate(date).setZone('Europe/Amsterdam');
    const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
    const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();

    const raffles = await prisma.raffle.findMany({
        where: {
            created: { gte: startOfDay, lte: endOfDay }
        },
        include: {
            codes: true
        }
    });

    if (!raffles.length) {
        return [];
    }

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
            if (!gameData.winningCodes.some(wc => wc.code === code.code)) {
                gameData.winningCodes.push({
                    code: code.code,
                    order: codeToOrder.get(code.code)!
                });
            }
        }
    }

    const expectations: PrizeExpectation[] = [];

    for (const [gameID, { winningCodes, raffleIDs }] of winningCodesByGame) {
        if (!winningCodes.length) continue;

        const tickets = await prisma.ticket.findMany({
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

        for (const ticket of tickets) {
            const codesByString = new Map<string, Array<{ id: number; code: string; value: number }>>();
            for (const ticketCode of ticket.codes) {
                const codeStr = ticketCode.code;
                if (!codesByString.has(codeStr)) {
                    codesByString.set(codeStr, []);
                }
                codesByString.get(codeStr)!.push(ticketCode);
            }

            for (const [codeStr, codeInstances] of codesByString) {
                const orderedInstances = [...codeInstances].sort((a, b) => a.id - b.id);
                const totalStake = orderedInstances.reduce((sum, instance) => sum + instance.value, 0);
                const firstInstance = orderedInstances[0];
                const prizeAmount = calculatePrizeAmount(
                    firstInstance.code,
                    totalStake,
                    gameID,
                    winningCodes
                );

                if (prizeAmount <= 0) continue;

                const raffleID = raffleIDs[0];
                const reference = createPrizeReference(raffleID, ticket.id, codeStr);

                expectations.push({
                    reference,
                    prizeAmount,
                    userID: ticket.creator.id,
                    ticketID: ticket.id,
                    raffleID,
                    code: codeStr,
                    created: endOfDay
                });
            }
        }
    }

    return expectations;
}

function calculatePrizeAmount(
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
        }
    }

    return total;
}

function getReferencePrefix(reference: string): string {
    const parts = reference.split(':');
    return parts.slice(0, 3).join(':') + ':';
}

async function repairExpectations(date: Date, expectations: PrizeExpectation[], dryRun: boolean): Promise<RepairStats> {
    const stats: RepairStats = {
        normalized: 0,
        created: 0,
        amountAdjusted: 0,
        duplicatesRemoved: 0
    };

    const processedActionIds = new Set<number>();

    for (const expectation of expectations) {
        const prefix = getReferencePrefix(expectation.reference);
        const matchingActions = await prisma.balanceAction.findMany({
            where: {
                type: BalanceActionType.PRIZE,
                reference: {
                    startsWith: prefix
                }
            },
            orderBy: { created: 'asc' }
        });

        const available = matchingActions.filter(action => !processedActionIds.has(action.id));
        let canonical = available.find(action => action.reference === expectation.reference);
        const remainder = available.filter(action => !canonical || action.id !== canonical.id);

        if (!canonical && remainder.length) {
            canonical = remainder.shift();
        }

        if (!canonical) {
            if (dryRun) {
                console.log(`[DRY-RUN] Would create prize action ${expectation.reference} for user ${expectation.userID} (${expectation.prizeAmount/100} EUR)`);
            } else {
                await prisma.$transaction(async (tx) => {
                    const balance = await tx.balance.upsert({
                        where: { userID: expectation.userID },
                        update: {},
                        create: { userID: expectation.userID, balance: 0 },
                        select: { id: true }
                    });

                    await tx.balanceAction.create({
                        data: {
                            balanceID: balance.id,
                            type: BalanceActionType.PRIZE,
                            amount: -expectation.prizeAmount,
                            reference: expectation.reference,
                            created: expectation.created
                        }
                    });

                    await tx.balance.update({
                        where: { id: balance.id },
                        data: {
                            balance: { increment: expectation.prizeAmount }
                        }
                    });
                });
            }

            stats.created++;
            continue;
        }

        processedActionIds.add(canonical.id);

        const desiredAmount = -expectation.prizeAmount;
        const updates: Array<Promise<unknown>> = [];
        let referenceChanged = false;
        let amountChanged = false;

        if (canonical.reference !== expectation.reference) {
            referenceChanged = true;
            if (dryRun) {
                console.log(`[DRY-RUN] Would update reference of action ${canonical.id} to ${expectation.reference}`);
            } else {
                updates.push(prisma.balanceAction.update({
                    where: { id: canonical.id },
                    data: { reference: expectation.reference }
                }));
            }
        }

        if (canonical.amount !== desiredAmount) {
            amountChanged = true;
            const previousPrize = -canonical.amount;
            const delta = expectation.prizeAmount - previousPrize;

            if (dryRun) {
                console.log(`[DRY-RUN] Would update amount of action ${canonical.id} from ${previousPrize/100} to ${expectation.prizeAmount/100} EUR`);
            } else {
                await prisma.$transaction(async (tx) => {
                    await tx.balanceAction.update({
                        where: { id: canonical!.id },
                        data: { amount: desiredAmount }
                    });

                    await tx.balance.update({
                        where: { id: canonical!.balanceID },
                        data: { balance: { increment: delta } }
                    });
                });
            }

            stats.amountAdjusted++;
        }

        if (!dryRun && updates.length) {
            await Promise.all(updates);
        }

        if (referenceChanged) {
            stats.normalized++;
        }

        for (const duplicate of remainder) {
            processedActionIds.add(duplicate.id);
            const duplicatePrize = -duplicate.amount;

            if (dryRun) {
                console.log(`[DRY-RUN] Would delete duplicate action ${duplicate.id} for ${expectation.reference} (${duplicatePrize/100} EUR)`);
            } else {
                await prisma.$transaction(async (tx) => {
                    await tx.balanceAction.delete({
                        where: { id: duplicate.id }
                    });

                    await tx.balance.update({
                        where: { id: duplicate.balanceID },
                        data: {
                            balance: { decrement: duplicatePrize }
                        }
                    });
                });
            }

            stats.duplicatesRemoved++;
        }
    }

    console.log(`Processed ${expectations.length} expected prizes for ${date.toISOString().split('T')[0]}`);
    console.log(`  Normalized references: ${stats.normalized}`);
    console.log(`  Amount adjustments: ${stats.amountAdjusted}`);
    console.log(`  Created actions: ${stats.created}`);
    console.log(`  Removed duplicates: ${stats.duplicatesRemoved}`);

    return stats;
}

async function main() {
    const { start, end, dryRun } = parseArgs();

    const startDate = DateTime.fromJSDate(start);
    const endDate = DateTime.fromJSDate(end);

    if (endDate < startDate) {
        throw new Error('End date cannot be before start date');
    }

    let cursor = startDate;
    const aggregate: RepairStats = { normalized: 0, created: 0, amountAdjusted: 0, duplicatesRemoved: 0 };

    while (cursor <= endDate) {
        const expectations = await buildExpectations(cursor.toJSDate());
        if (!expectations.length) {
            console.log(`No raffles found for ${cursor.toISODate()}`);
            cursor = cursor.plus({ days: 1 });
            continue;
        }

        const stats = await repairExpectations(cursor.toJSDate(), expectations, dryRun);
        aggregate.normalized += stats.normalized;
        aggregate.created += stats.created;
        aggregate.amountAdjusted += stats.amountAdjusted;
        aggregate.duplicatesRemoved += stats.duplicatesRemoved;

        cursor = cursor.plus({ days: 1 });
    }

    console.log('\n=== Repair summary ===');
    console.log(`Normalize reference updates: ${aggregate.normalized}`);
    console.log(`Amount adjustments: ${aggregate.amountAdjusted}`);
    console.log(`New prize actions: ${aggregate.created}`);
    console.log(`Duplicates removed: ${aggregate.duplicatesRemoved}`);
    console.log(dryRun ? 'Completed in dry-run mode.' : 'Repairs applied.');
}

main()
    .catch((error) => {
        console.error('Repair script failed:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

