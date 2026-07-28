/**
 * Fix poisoned prize ledger after Code.createMany middleware awarded
 * historical tickets (cross-day prizes), plus wrong-sign REVERSAL_PRIZE rows.
 *
 * Then re-apply Jul 7 corrected baseline and rebuild frozen chains from Jul 8.
 *
 * Usage:
 *   CONFIRM=YES CSV_PATH="..." npx ts-node -r tsconfig-paths/register \
 *     src/scripts/cleanup-cross-day-prizes-and-rebuild.ts
 */

import "reflect-metadata";
import fs from "node:fs";
import { DateTime } from "luxon";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const CONFIRM = process.env.CONFIRM === "YES";
const CSV_PATH =
    process.env.CSV_PATH ??
    "/Users/remynijsten/Downloads/eindsaldos-2026-07-07-corrected.csv";
const BASELINE_DAY = "2026-07-07";
const REBUILD_FROM = "2026-07-08";

type CsvRow = { displayName: string; username: string; cents: number };

function parseEuros(raw: string): number {
    const value = raw.trim();
    let normalized = value;
    if (value.includes(",") && value.includes(".")) {
        normalized = value.replace(/\./g, "").replace(",", ".");
    } else if (value.includes(",")) {
        normalized = value.replace(",", ".");
    }
    const euros = Number(normalized);
    if (!Number.isFinite(euros)) throw new Error(`Invalid euros: ${raw}`);
    return Math.round(euros * 100);
}

function formatEuros(cents: number): string {
    return (cents / 100).toFixed(2);
}

function parseCsv(csvPath: string): CsvRow[] {
    return fs
        .readFileSync(csvPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(1)
        .map((line) => {
            const [displayName, username, balance] = line.split(";");
            return {
                displayName: displayName.trim(),
                username: username.trim().toLowerCase(),
                cents: parseEuros(balance),
            };
        });
}

async function recalcAllBalances(): Promise<void> {
    const sums = await prisma.balanceAction.groupBy({
        by: ["balanceID"],
        _sum: { amount: true },
    });
    const sumByBalance = new Map(sums.map((s) => [s.balanceID, s._sum.amount ?? 0]));
    const balances = await prisma.balance.findMany({ select: { id: true } });
    for (const b of balances) {
        await prisma.balance.update({
            where: { id: b.id },
            data: { balance: sumByBalance.get(b.id) ?? 0 },
        });
    }
    console.log(`Recalculated balances.balance for ${balances.length} user(s)`);
}

async function cleanupCrossDayPrizes(): Promise<{
    prizeRows: number;
    reversalRows: number;
    affectedBalanceIDs: Set<number>;
}> {
    const crossDay = await prisma.$queryRawUnsafe<
        Array<{ reference: string; balanceID: number; c: number; sum_eur: number }>
    >(`
        SELECT
            ba.reference,
            ba."balanceID" as "balanceID",
            count(*)::int as c,
            (sum(ba.amount)/100.0)::float as sum_eur
        FROM balance_actions ba
        JOIN raffles r ON r.id = NULLIF(split_part(ba.reference, ':', 2), '')::int
        JOIN tickets t ON t.id = NULLIF(split_part(ba.reference, ':', 3), '')::int
        WHERE ba.type = 'PRIZE'
          AND ba.reference LIKE 'PRIZE:%'
          AND (timezone('Europe/Amsterdam', t.created))::date
           <> (timezone('Europe/Amsterdam', r.created))::date
        GROUP BY ba.reference, ba."balanceID"
        ORDER BY abs(sum(ba.amount)) DESC
    `);

    console.log(`Cross-day prize references: ${crossDay.length}`);
    for (const row of crossDay.slice(0, 15)) {
        console.log(
            `  ${row.reference} x${row.c} sum=€${Number(row.sum_eur).toFixed(2)} balanceID=${row.balanceID}`
        );
    }
    if (crossDay.length > 15) console.log(`  ... and ${crossDay.length - 15} more`);

    const refs = [...new Set(crossDay.map((r) => r.reference))];
    const affectedBalanceIDs = new Set(crossDay.map((r) => Number(r.balanceID)));

    if (refs.length === 0) {
        return { prizeRows: 0, reversalRows: 0, affectedBalanceIDs };
    }

    const prizeRows = await prisma.balanceAction.findMany({
        where: { type: "PRIZE", reference: { in: refs } },
        select: { id: true, balanceID: true },
    });
    const prizeIds = prizeRows.map((p) => p.id);
    for (const p of prizeRows) affectedBalanceIDs.add(p.balanceID);

    const allReversalCandidates = await prisma.balanceAction.findMany({
        where: {
            type: "CORRECTION",
            reference: { startsWith: "REVERSAL_PRIZE:" },
        },
        select: { id: true, balanceID: true, reference: true },
    });
    const prizeIdSet = new Set(prizeIds);
    const reversals = allReversalCandidates.filter((r) => {
        const parts = (r.reference ?? "").split(":");
        // REVERSAL_PRIZE:<id> or REVERSAL_PRIZE:<id>:<timestamp>
        if (parts[0] !== "REVERSAL_PRIZE" || parts[1] === "REF") return false;
        const prizeId = Number(parts[1]);
        return Number.isFinite(prizeId) && prizeIdSet.has(prizeId);
    });

    const refReversals = await prisma.balanceAction.findMany({
        where: {
            type: "CORRECTION",
            OR: refs.map((ref) => ({ reference: `REVERSAL_PRIZE_REF:${ref}` })),
        },
        select: { id: true, balanceID: true },
    });

    const reversalIds = [...reversals, ...refReversals].map((r) => r.id);
    for (const r of [...reversals, ...refReversals]) affectedBalanceIDs.add(r.balanceID);

    console.log(`Prize rows to delete: ${prizeIds.length}`);
    console.log(`Related reversal rows to delete: ${reversalIds.length}`);

    if (CONFIRM) {
        if (prizeIds.length) {
            await prisma.balanceAction.deleteMany({ where: { id: { in: prizeIds } } });
        }
        if (reversalIds.length) {
            await prisma.balanceAction.deleteMany({ where: { id: { in: reversalIds } } });
        }
    }

    return {
        prizeRows: prizeIds.length,
        reversalRows: reversalIds.length,
        affectedBalanceIDs,
    };
}

async function cleanupWrongSignReversals(): Promise<{
    count: number;
    affectedBalanceIDs: Set<number>;
}> {
    // Support both REVERSAL_PRIZE:<id> and legacy REVERSAL_PRIZE:<id>:<timestamp>
    const rows = await prisma.$queryRawUnsafe<
        Array<{ id: number; balanceID: number; username: string; amount: number; prize_amount: number; reference: string }>
    >(`
        SELECT
            rev.id,
            rev."balanceID" as "balanceID",
            u.username,
            rev.amount,
            prize.amount as prize_amount,
            rev.reference
        FROM balance_actions rev
        JOIN balance_actions prize
          ON prize.id = NULLIF(split_part(rev.reference, ':', 2), '')::int
        JOIN balances b ON b.id = rev."balanceID"
        JOIN users u ON u.id = b."userID"
        WHERE rev.type = 'CORRECTION'
          AND rev.reference LIKE 'REVERSAL_PRIZE:%'
          AND rev.reference NOT LIKE 'REVERSAL_PRIZE_REF:%'
          AND split_part(rev.reference, ':', 2) ~ '^[0-9]+$'
          AND sign(rev.amount) = sign(prize.amount)
          AND prize.amount <> 0
        ORDER BY abs(rev.amount) DESC
    `);

    console.log(`Wrong-sign REVERSAL_PRIZE rows: ${rows.length}`);
    for (const row of rows.slice(0, 15)) {
        console.log(
            `  ${row.username} id=${row.id} rev=€${(Number(row.amount) / 100).toFixed(2)} prize=€${(Number(row.prize_amount) / 100).toFixed(2)} ${row.reference}`
        );
    }
    if (rows.length > 15) console.log(`  ... and ${rows.length - 15} more`);

    const affectedBalanceIDs = new Set(rows.map((r) => Number(r.balanceID)));
    const ids = rows.map((r) => Number(r.id));

    if (CONFIRM && ids.length) {
        await prisma.balanceAction.deleteMany({ where: { id: { in: ids } } });
    }

    return { count: ids.length, affectedBalanceIDs };
}

async function reapplyJul7Baseline(balanceService: BalanceService): Promise<number> {
    const rows = parseCsv(CSV_PATH);
    const baseline = DateTime.fromFormat(BASELINE_DAY, "yyyy-MM-dd", { zone: "Europe/Amsterdam" });
    const baselineUtc = baseline.startOf("day").toUTC().toJSDate();
    const prevUtc = baseline.minus({ days: 1 }).startOf("day").toUTC().toJSDate();

    let updated = 0;
    for (const row of rows) {
        const user = await prisma.user.findFirst({
            where: { username: row.username },
            select: { id: true, username: true },
        });
        if (!user) continue;

        const totals = await balanceService.getBalanceDayTotals(user.id, BASELINE_DAY);
        const openingJul7 = row.cents - totals.dayNet;

        console.log(
            `${row.displayName.padEnd(12)} (${user.username}) jul7 -> €${formatEuros(row.cents)} (activity €${formatEuros(totals.dayNet)})`
        );

        if (CONFIRM) {
            await prisma.frozenBalance.upsert({
                where: { userID_date: { userID: user.id, date: prevUtc } },
                update: { balance: openingJul7 },
                create: { userID: user.id, date: prevUtc, balance: openingJul7 },
            });
            await prisma.frozenBalance.upsert({
                where: { userID_date: { userID: user.id, date: baselineUtc } },
                update: { balance: row.cents },
                create: { userID: user.id, date: baselineUtc, balance: row.cents },
            });
            updated++;
        }
    }
    return updated;
}

async function main() {
    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    console.log("=== Cleanup cross-day prizes + wrong-sign reversals ===");
    console.log(`Mode: ${CONFIRM ? "WRITE" : "DRY RUN"}\n`);

    const cross = await cleanupCrossDayPrizes();
    console.log("");
    const wrong = await cleanupWrongSignReversals();

    if (!CONFIRM) {
        console.log("\nDry run only. Set CONFIRM=YES to apply.");
        return;
    }

    await recalcAllBalances();

    console.log("\n=== Re-apply Jul 7 baseline ===");
    const baselineUpdated = await reapplyJul7Baseline(balanceService);
    console.log(`Baseline users updated: ${baselineUpdated}`);

    console.log(`\n=== Rebuild frozen chains from ${REBUILD_FROM} ===`);
    const balances = await prisma.balance.findMany({ select: { userID: true } });
    for (const { userID } of balances) {
        await balanceService.refreshFrozenBalanceChainFromDay(userID, REBUILD_FROM);
    }
    console.log(`Rebuilt ${balances.length} user chain(s)`);

    console.log("\n=== Done ===");
    console.log(`Deleted cross-day prize rows: ${cross.prizeRows}`);
    console.log(`Deleted related reversals: ${cross.reversalRows}`);
    console.log(`Deleted wrong-sign reversals: ${wrong.count}`);
}

main()
    .catch((e) => {
        console.error("Fatal:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
