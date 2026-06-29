import "reflect-metadata";
import { container } from "tsyringe";
import { DateTime } from "luxon";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

async function main() {
    container.registerInstance("Database", prisma);
    const service = container.resolve(BalanceService);

    const users = [21, 22, 13, 52];
    for (const userID of users) {
        const user = await prisma.user.findUnique({
            where: { id: userID },
            select: { name: true },
        });

        const d27 = await service.getBalanceDayTotals(userID, "2026-06-27");
        const d28 = await service.getBalanceDayTotals(userID, "2026-06-28");
        const prevDate = DateTime.fromISO("2026-06-27", { zone: "Europe/Amsterdam" })
            .minus({ days: 1 })
            .startOf("day")
            .toUTC()
            .toJSDate();

        const anchor = await prisma.frozenBalance.findUnique({
            where: { userID_date: { userID, date: prevDate } },
        });

        console.log(
            `${userID}\t${user?.name ?? "?"}\tanchor26=${((anchor?.balance ?? 0) / 100).toFixed(2)}\t` +
                `27_open=${(d27.opening / 100).toFixed(2)}\t27_close=${(d27.closing / 100).toFixed(2)}\t` +
                `28_open=${(d28.opening / 100).toFixed(2)}`
        );
    }

    const remainingBigManual = await prisma.balanceAction.count({
        where: {
            type: "CORRECTION",
            reference: null,
            created: { gte: new Date("2026-06-26T22:00:00.000Z") },
            OR: [{ amount: { gt: 200000 } }, { amount: { lt: -200000 } }],
        },
    });
    console.log(`remaining_big_null_corrections=${remainingBigManual}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
