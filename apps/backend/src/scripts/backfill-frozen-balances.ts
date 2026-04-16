/**
 * One-off script to backfill the frozen_balances table with historical EOD
 * snapshots for every date that has balance activity.
 *
 * Run with:
 *   cd apps/backend && npx ts-node -r tsconfig-paths/register src/scripts/backfill-frozen-balances.ts
 */

import "reflect-metadata";
import prisma from "../common/utils/prisma";
import { DateTime } from "luxon";

async function main() {
    console.log("=== Backfill Frozen Balances ===\n");

    // 1. Find the earliest and latest balance action dates
    const earliest = await prisma.balanceAction.findFirst({
        orderBy: { created: "asc" },
        select: { created: true },
    });
    const latest = await prisma.balanceAction.findFirst({
        orderBy: { created: "desc" },
        select: { created: true },
    });

    if (!earliest || !latest) {
        console.log("No balance actions found. Nothing to backfill.");
        return;
    }

    console.log(`Action range: ${earliest.created.toISOString()} -> ${latest.created.toISOString()}`);

    // 2. Build a list of Amsterdam calendar days to process
    let cursor = DateTime.fromJSDate(earliest.created).setZone("Europe/Amsterdam").startOf("day");
    const lastDay = DateTime.fromJSDate(latest.created).setZone("Europe/Amsterdam").startOf("day");

    const days: DateTime[] = [];
    while (cursor <= lastDay) {
        days.push(cursor);
        cursor = cursor.plus({ days: 1 });
    }

    console.log(`Processing ${days.length} calendar day(s)...\n`);

    let totalFrozen = 0;

    for (const day of days) {
        const startOfDay = day.toUTC().toJSDate();
        const endOfDay = day.endOf("day").toUTC().toJSDate();

        // Aggregate EOD balances per balanceID for all actions up to this day's end
        const userTotals = await prisma.balanceAction.groupBy({
            by: ["balanceID"],
            where: {
                created: { lte: endOfDay },
            },
            _sum: { amount: true },
        });

        if (userTotals.length === 0) continue;

        // Resolve balanceID -> userID
        const balanceIDs = userTotals.map((t) => t.balanceID);
        const balances = await prisma.balance.findMany({
            where: { id: { in: balanceIDs } },
            select: { id: true, userID: true },
        });
        const balanceToUser = new Map(balances.map((b) => [b.id, b.userID]));

        let dayFrozen = 0;
        for (const row of userTotals) {
            const userID = balanceToUser.get(row.balanceID);
            if (!userID) continue;

            const eodBalance = row._sum.amount ?? 0;

            await prisma.frozenBalance.upsert({
                where: { userID_date: { userID, date: startOfDay } },
                update: { balance: eodBalance },
                create: { userID, date: startOfDay, balance: eodBalance },
            });
            dayFrozen++;
        }

        totalFrozen += dayFrozen;
        const dateStr = day.toFormat("dd-MM-yyyy");
        console.log(`  ${dateStr}: froze ${dayFrozen} user balance(s)`);
    }

    console.log(`\nDone. Created/updated ${totalFrozen} frozen balance row(s) across ${days.length} day(s).`);
}

main()
    .catch((e) => {
        console.error("Fatal error:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
