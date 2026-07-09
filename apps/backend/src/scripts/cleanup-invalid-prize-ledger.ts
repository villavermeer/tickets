/**
 * Remove invalid PRIZE ledger rows (no longer valid under current winning numbers)
 * and recalculate affected balances + frozen chains.
 *
 * Usage:
 *   DATABASE_URL=... CONFIRM=YES npx ts-node -r tsconfig-paths/register src/scripts/cleanup-invalid-prize-ledger.ts
 */

import "reflect-metadata";
import { container } from "tsyringe";
import { DateTime } from "luxon";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";
import { RaffleService } from "../features/raffle/services/RaffleService";

const CONFIRM = process.env.CONFIRM === "YES";
const REBUILD_FROM = process.env.REBUILD_FROM ?? "2026-07-06";

container.registerInstance("Database", prisma);

async function main() {
    const raffleService = container.resolve(RaffleService);
    const balanceService = container.resolve(BalanceService);

    const prizes = await prisma.balanceAction.findMany({
        where: { type: "PRIZE", reference: { startsWith: "PRIZE:" } },
        orderBy: { id: "asc" },
    });

    const toDelete: number[] = [];

    for (const prize of prizes) {
        const refParts = prize.reference?.split(":");
        if (!refParts || refParts.length !== 4) continue;

        const raffleId = Number(refParts[1]);
        if (!Number.isFinite(raffleId)) continue;

        const raffle = await prisma.raffle.findUnique({
            where: { id: raffleId },
            include: { codes: true },
        });
        if (!raffle) {
            toDelete.push(prize.id);
            continue;
        }

        const amsterdamDate = DateTime.fromJSDate(raffle.created).setZone("Europe/Amsterdam");
        const dayRaffles = await prisma.raffle.findMany({
            where: {
                created: {
                    gte: amsterdamDate.startOf("day").toUTC().toJSDate(),
                    lte: amsterdamDate.endOf("day").toUTC().toJSDate(),
                },
                gameID: raffle.gameID,
            },
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

        if (!stillValid) {
            toDelete.push(prize.id);
            console.log(`INVALID prize ${prize.id} ${prize.reference} €${(prize.amount / 100).toFixed(2)}`);
        }
    }

    console.log(`\nInvalid prizes to remove: ${toDelete.length}`);

    if (!CONFIRM) {
        console.log("Dry run. Set CONFIRM=YES to delete.");
        return;
    }

    if (toDelete.length === 0) return;

    const affected = await prisma.balanceAction.findMany({
        where: { id: { in: toDelete } },
        select: { balanceID: true },
    });
    const balanceIds = [...new Set(affected.map((a) => a.balanceID))];

    await prisma.balanceAction.deleteMany({ where: { id: { in: toDelete } } });

    for (const balanceID of balanceIds) {
        const sum = await prisma.balanceAction.aggregate({
            where: { balanceID },
            _sum: { amount: true },
        });
        await prisma.balance.update({
            where: { id: balanceID },
            data: { balance: sum._sum.amount ?? 0 },
        });
        const bal = await prisma.balance.findUnique({ where: { id: balanceID } });
        if (bal) {
            await balanceService.refreshFrozenBalanceChainFromDay(bal.userID, REBUILD_FROM);
        }
    }

    console.log(`Deleted ${toDelete.length} invalid prize(s), rebuilt ${balanceIds.length} balance chain(s).`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
