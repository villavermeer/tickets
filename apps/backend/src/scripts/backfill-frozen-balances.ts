/**
 * Rebuild frozen_balances EOD snapshots using the same chain logic as the balance day view:
 * opening = previous day's frozen snapshot, closing = opening + day activity.
 *
 * Run with:
 *   cd apps/backend && npx ts-node -r tsconfig-paths/register src/scripts/backfill-frozen-balances.ts
 *
 * After a PO correction on a specific day, prefer re-saving that correction (or run
 * refreshFrozenBalanceChainFromDay for that user) so later days inherit the fixed closing.
 */

import "reflect-metadata";
import { container } from "tsyringe";
import { DateTime } from "luxon";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

async function main() {
    console.log("=== Rebuild Frozen Balance Chains ===\n");

    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    const earliest = await prisma.balanceAction.findFirst({
        orderBy: { created: "asc" },
        select: { created: true },
    });

    if (!earliest) {
        console.log("No balance actions found. Nothing to backfill.");
        return;
    }

    const startYmd = DateTime.fromJSDate(earliest.created)
        .setZone("Europe/Amsterdam")
        .toFormat("yyyy-MM-dd");

    const users = await prisma.balance.findMany({
        select: { userID: true },
        orderBy: { userID: "asc" },
    });

    console.log(`Rebuilding chains from ${startYmd} for ${users.length} user(s)...\n`);

    for (const { userID } of users) {
        await balanceService.refreshFrozenBalanceChainFromDay(userID, startYmd);
        console.log(`  user ${userID}: done`);
    }

    console.log(`\nDone. Rebuilt frozen chains for ${users.length} user(s).`);
}

main()
    .catch((e) => {
        console.error("Fatal error:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
