/**
 * One-off cleanup for bad REVERSAL_PRIZE rows created by the old orphan logic.
 *
 * 1) Remove duplicate reversals per prize action (keep earliest)
 * 2) Remove reversals where the original prize is still valid under current winning numbers
 * 3) Recalculate balances.balance and rebuild frozen chains from 2026-06-27
 *
 * Usage:
 *   CONFIRM=YES npx ts-node -r tsconfig-paths/register src/scripts/cleanup-false-reversal-prizes.ts
 */

import "reflect-metadata";
import { container } from "tsyringe";
import { DateTime } from "luxon";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";
import { RaffleService } from "../features/raffle/services/RaffleService";
const CONFIRM = process.env.CONFIRM === "YES";
const REBUILD_FROM = process.env.REBUILD_FROM ?? "2026-06-27";

container.registerInstance("Database", prisma);

function prizeActionIdFromReversalRef(reference: string | null): number | null {
    if (!reference?.startsWith("REVERSAL_PRIZE:")) return null;
    const parts = reference.split(":");
    const id = Number(parts[1]);
    return Number.isFinite(id) ? id : null;
}

async function main() {
    const reversals = await prisma.balanceAction.findMany({
        where: {
            type: "CORRECTION",
            reference: { startsWith: "REVERSAL_PRIZE:" },
        },
        orderBy: { id: "asc" },
    });

    console.log(`Found ${reversals.length} REVERSAL_PRIZE rows`);

    const byPrize = new Map<number, typeof reversals>();
    for (const r of reversals) {
        const prizeId = prizeActionIdFromReversalRef(r.reference);
        if (!prizeId) continue;
        if (!byPrize.has(prizeId)) byPrize.set(prizeId, []);
        byPrize.get(prizeId)!.push(r);
    }

    const toDelete: number[] = [];
    let duplicateCount = 0;
    let falsePositiveCount = 0;

    const raffleService = container.resolve(RaffleService);

    for (const [prizeId, rows] of byPrize.entries()) {
        if (rows.length > 1) {
            for (const row of rows.slice(1)) {
                toDelete.push(row.id);
                duplicateCount++;
            }
        }

        const prize = await prisma.balanceAction.findUnique({
            where: { id: prizeId },
            select: { id: true, amount: true, reference: true },
        });
        if (!prize?.reference?.startsWith("PRIZE:")) {
            for (const row of rows) {
                if (!toDelete.includes(row.id)) {
                    toDelete.push(row.id);
                    falsePositiveCount++;
                }
            }
            continue;
        }

        const refParts = prize.reference.split(":");
        const raffleId = Number(refParts[1]);
        if (!Number.isFinite(raffleId)) continue;

        const raffle = await prisma.raffle.findUnique({
            where: { id: raffleId },
            include: { codes: true },
        });
        if (!raffle) continue;

        const amsterdamDate = DateTime.fromJSDate(raffle.created).setZone("Europe/Amsterdam");
        const startOfDay = amsterdamDate.startOf("day").toUTC().toJSDate();
        const endOfDay = amsterdamDate.endOf("day").toUTC().toJSDate();

        const dayRaffles = await prisma.raffle.findMany({
            where: { created: { gte: startOfDay, lte: endOfDay }, gameID: raffle.gameID },
            include: { codes: true },
        });

        const winningCodes: Array<{ code: string; order: number }> = [];
        const codeToOrder = new Map<string, number>();
        for (const r of dayRaffles) {
            for (const code of r.codes) {
                if (!codeToOrder.has(code.code)) {
                    codeToOrder.set(code.code, codeToOrder.size + 1);
                }
                if (!winningCodes.some((wc) => wc.code === code.code)) {
                    winningCodes.push({
                        code: code.code,
                        order: codeToOrder.get(code.code)!,
                    });
                }
            }
        }

        const stillValid = await raffleService.isPrizeActionStillValid(
            prize,
            raffle.gameID,
            winningCodes
        );

        if (stillValid) {
            for (const row of rows) {
                if (!toDelete.includes(row.id)) {
                    toDelete.push(row.id);
                    falsePositiveCount++;
                }
            }
        }
    }

    console.log(`Duplicates to remove: ${duplicateCount}`);
    console.log(`False-positive reversals to remove: ${falsePositiveCount}`);
    console.log(`Total rows to delete: ${toDelete.length}`);

    if (!CONFIRM) {
        console.log("\nDry run. Set CONFIRM=YES to execute.");
        return;
    }

    if (toDelete.length > 0) {
        await prisma.balanceAction.deleteMany({ where: { id: { in: toDelete } } });
        console.log(`Deleted ${toDelete.length} reversal rows`);
    }

    const sums = await prisma.balanceAction.groupBy({
        by: ["balanceID"],
        _sum: { amount: true },
    });
    const sumByBalance = new Map(sums.map((s) => [s.balanceID, s._sum.amount ?? 0]));
    const balances = await prisma.balance.findMany({ select: { id: true, userID: true } });
    for (const b of balances) {
        await prisma.balance.update({
            where: { id: b.id },
            data: { balance: sumByBalance.get(b.id) ?? 0 },
        });
    }
    console.log(`Recalculated balances for ${balances.length} users`);

    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);
    for (const b of balances) {
        await balanceService.refreshFrozenBalanceChainFromDay(b.userID, REBUILD_FROM);
    }
    console.log(`Rebuilt frozen chains from ${REBUILD_FROM}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
