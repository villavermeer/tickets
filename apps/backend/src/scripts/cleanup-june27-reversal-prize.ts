import "reflect-metadata";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

async function main() {
    const start = new Date("2026-06-26T22:00:00.000Z");
    const end = new Date("2026-06-27T22:00:00.000Z");

    const deleted = await prisma.balanceAction.deleteMany({
        where: {
            type: "CORRECTION",
            created: { gte: start, lt: end },
            reference: { startsWith: "REVERSAL_PRIZE:" },
        },
    });
    console.log(`deleted_reversal_prize_rows=${deleted.count}`);

    const sums = await prisma.balanceAction.groupBy({
        by: ["balanceID"],
        _sum: { amount: true },
    });
    const sumByBalance = new Map<number, number>(sums.map((s) => [s.balanceID, s._sum.amount ?? 0]));
    const balances = await prisma.balance.findMany({ select: { id: true, userID: true } });

    for (const b of balances) {
        await prisma.balance.update({
            where: { id: b.id },
            data: { balance: sumByBalance.get(b.id) ?? 0 },
        });
    }
    console.log(`recalculated_balances=${balances.length}`);

    container.registerInstance("Database", prisma);
    const service = container.resolve(BalanceService);
    for (const b of balances) {
        await service.refreshFrozenBalanceChainFromDay(b.userID, "2026-06-27");
    }
    console.log(`rebuilt_frozen_chains=${balances.length}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
