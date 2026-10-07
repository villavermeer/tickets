/**
 * Remove Milouska (user 33) Oct 6 phantom €186 correctie caused by deleting
 * correction 460079 ("Extra inleg min provisie") twice, then deleting one reversal.
 *
 * Rows to remove:
 *   460080  +186  REVERSAL:460079:…  (1st delete)
 *   460081  +186  REVERSAL:460079:…  (2nd delete of same action)
 *   460082  -186  REVERSAL:460081:…  (delete of the 2nd reversal)
 *
 * Net of those three = +186 on 6 Oct. After removal, Oct 5 keeps the original
 * -186 correction and live balance is recalculated from the ledger.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/cleanup-milouska-oct6-double-reversal.ts
 *   CONFIRM=YES npx ts-node -r tsconfig-paths/register src/scripts/cleanup-milouska-oct6-double-reversal.ts
 */

import "reflect-metadata";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const CONFIRM = process.env.CONFIRM === "YES";
const USER_ID = 33;
const DELETE_IDS = [460080, 460081, 460082];
const REBUILD_FROM = "2026-10-05";

async function main() {
    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    const rows = await prisma.balanceAction.findMany({
        where: { id: { in: DELETE_IDS } },
        include: { balance: { select: { userID: true, id: true, balance: true } } },
        orderBy: { id: "asc" },
    });

    console.log("Rows to delete:");
    for (const r of rows) {
        console.log(
            `  id=${r.id} amount=${r.amount} ref=${r.reference} user=${r.balance.userID} created=${r.created.toISOString()}`
        );
    }

    if (rows.length !== DELETE_IDS.length) {
        const found = new Set(rows.map((r) => r.id));
        const missing = DELETE_IDS.filter((id) => !found.has(id));
        throw new Error(`Expected ${DELETE_IDS.length} rows, missing: ${missing.join(", ")}`);
    }

    if (rows.some((r) => r.balance.userID !== USER_ID)) {
        throw new Error("Safety: not all rows belong to Milouska (user 33)");
    }

    const net = rows.reduce((s, r) => s + r.amount, 0);
    console.log(`Net amount of rows (expected 18600): ${net}`);
    console.log(`Live balance before: ${rows[0].balance.balance}`);

    if (!CONFIRM) {
        console.log("\nDry run only. Re-run with CONFIRM=YES to apply.");
        await prisma.$disconnect();
        return;
    }

    const balanceID = rows[0].balance.id;

    // Live balance is maintained incrementally and may not equal SUM(actions)
    // (baseline / standen history). Only reverse the net of the deleted rows.
    const liveBefore = rows[0].balance.balance;
    const liveAfter = liveBefore - net;

    await prisma.$transaction(async (tx) => {
        await tx.balanceAction.deleteMany({ where: { id: { in: DELETE_IDS } } });
        await tx.balance.update({
            where: { id: balanceID },
            data: { balance: liveAfter },
        });
    });

    const after = await prisma.balance.findUnique({ where: { id: balanceID } });
    console.log(`Deleted ${DELETE_IDS.length} rows. Live balance ${liveBefore} → ${after?.balance}`);

    console.log(`Rebuilding frozen chain from ${REBUILD_FROM}...`);
    await balanceService.refreshFrozenBalanceChainFromDay(USER_ID, REBUILD_FROM, {
        overwriteSealed: true,
    });

    const day6 = await balanceService.getBalanceDayTotals(USER_ID, "2026-10-06");
    const day5 = await balanceService.getBalanceDayTotals(USER_ID, "2026-10-05");
    console.log("Oct 5 day totals:", JSON.stringify(day5));
    console.log("Oct 6 day totals:", JSON.stringify(day6));
    console.log("Done.");
    await prisma.$disconnect();
    process.exit(0);
}

main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
});
