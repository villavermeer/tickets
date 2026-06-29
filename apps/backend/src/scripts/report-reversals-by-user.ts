import "reflect-metadata";
import { Prisma } from "@prisma/client";
import prisma from "../common/utils/prisma";

async function main() {
    const start = new Date("2026-06-26T22:00:00.000Z");
    const end = new Date("2026-06-27T22:00:00.000Z");

    const rows = await prisma.$queryRaw<
        Array<{ user_id: number; name: string; sum_amount: bigint; cnt: number }>
    >(Prisma.sql`
        SELECT
            b."userID" as user_id,
            u.name,
            SUM(ba.amount)::bigint as sum_amount,
            COUNT(*)::int as cnt
        FROM balance_actions ba
        JOIN balances b ON b.id = ba."balanceID"
        JOIN users u ON u.id = b."userID"
        WHERE ba.type = 'CORRECTION'
          AND ba.created >= ${start}
          AND ba.created < ${end}
          AND ba.reference LIKE 'REVERSAL_PRIZE:%'
        GROUP BY b."userID", u.name
        ORDER BY SUM(ba.amount) ASC
    `);

    for (const r of rows) {
        console.log(`${r.user_id}\t${r.name}\tcount=${r.cnt}\tsum=${(Number(r.sum_amount) / 100).toFixed(2)}`);
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
