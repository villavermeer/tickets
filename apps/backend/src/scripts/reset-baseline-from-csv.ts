/**
 * Apply opening balance baseline from CSV for Amsterdam day 2026-06-27.
 *
 * What it does:
 * 1) Parse CSV userID -> opening balance (euros) for 27-06-2026
 * 2) Cleanup obvious bad corrections / duplicate reversals
 * 3) Recalculate balances.balance from remaining ledger
 * 4) Anchor frozen balance on previous day (26-06-2026) per user
 * 5) Rebuild frozen chain from 27-06-2026 for all users
 *
 * Usage:
 *   DATABASE_URL=... CSV_PATH=/Users/.../userID-username-balance.csv \
 *   npx ts-node -r tsconfig-paths/register src/scripts/reset-baseline-from-csv.ts
 */

import "reflect-metadata";
import fs from "node:fs";
import { DateTime } from "luxon";
import { Prisma } from "@prisma/client";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const BASELINE_DAY = "2026-06-27";
const CSV_PATH =
    process.env.CSV_PATH ?? "/Users/remynijsten/Downloads/userID-username-balance.csv";
const OUTLIER_THRESHOLD_CENTS = Number(process.env.OUTLIER_THRESHOLD_CENTS ?? "200000"); // €2000

type BaselineRow = { userID: number; username: string; cents: number };

function parseCsv(csvPath: string): BaselineRow[] {
    const content = fs.readFileSync(csvPath, "utf8");
    const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

    if (lines.length <= 1) return [];

    const rows: BaselineRow[] = [];
    for (const line of lines.slice(1)) {
        // very small CSV with quoted simple fields
        const parts = line
            .split('","')
            .map((p) => p.replace(/^"/, "").replace(/"$/, ""));
        if (parts.length < 3) continue;

        const userID = Number(parts[0]);
        const username = parts[1];
        const balanceStr = parts[2].replace(/\./g, "").replace(",", "."); // handle NL decimals
        const euros = Number(balanceStr);
        if (!Number.isFinite(userID) || !Number.isFinite(euros)) continue;

        rows.push({
            userID,
            username,
            cents: Math.round(euros * 100),
        });
    }
    return rows;
}

async function cleanupLedgerNoise(startUtc: Date): Promise<void> {
    // Remove oversized manual corrections without reference (the known accidental baseline pushes)
    const removedOutliers = await prisma.balanceAction.deleteMany({
        where: {
            type: "CORRECTION",
            created: { gte: startUtc },
            reference: null,
            OR: [
                { amount: { gt: OUTLIER_THRESHOLD_CENTS } },
                { amount: { lt: -OUTLIER_THRESHOLD_CENTS } },
            ],
        },
    });
    console.log(`  removed manual outlier corrections: ${removedOutliers.count}`);

    // Deduplicate REVERSAL_PRIZE / REVERSAL_TICKET_SALE:
    // keep first row per (balanceID, prefix, targetActionId), remove the rest.
    const dedupDeleted = await prisma.$executeRaw(Prisma.sql`
        WITH ranked AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY
                        "balanceID",
                        split_part(reference, ':', 1),
                        split_part(reference, ':', 2)
                    ORDER BY id ASC
                ) as rn
            FROM balance_actions
            WHERE type = 'CORRECTION'
              AND (
                    reference LIKE 'REVERSAL_PRIZE:%'
                 OR reference LIKE 'REVERSAL_TICKET_SALE:%'
              )
        )
        DELETE FROM balance_actions
        WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    `);
    console.log(`  removed duplicate reversal rows: ${Number(dedupDeleted)}`);
}

async function recalcBalanceColumns(): Promise<void> {
    const sums = await prisma.balanceAction.groupBy({
        by: ["balanceID"],
        _sum: { amount: true },
    });
    const sumByBalance = new Map<number, number>(sums.map((s) => [s.balanceID, s._sum.amount ?? 0]));

    const balances = await prisma.balance.findMany({ select: { id: true } });
    for (const b of balances) {
        await prisma.balance.update({
            where: { id: b.id },
            data: { balance: sumByBalance.get(b.id) ?? 0 },
        });
    }
    console.log(`  recalculated balances.balance for ${balances.length} users`);
}

async function applyBaselineAnchors(rows: BaselineRow[], prevDayUtc: Date): Promise<void> {
    const csvMap = new Map<number, BaselineRow>(rows.map((r) => [r.userID, r]));
    const balances = await prisma.balance.findMany({ select: { userID: true } });

    let anchored = 0;
    let missing = 0;

    for (const { userID } of balances) {
        const csv = csvMap.get(userID);
        const anchor = csv?.cents ?? 0;
        if (!csv) missing++;

        await prisma.frozenBalance.upsert({
            where: { userID_date: { userID, date: prevDayUtc } },
            update: { balance: anchor },
            create: { userID, date: prevDayUtc, balance: anchor },
        });
        anchored++;
    }

    console.log(`  anchored frozen baseline for ${anchored} users on previous day`);
    console.log(`  users missing in CSV (anchored to €0): ${missing}`);
}

async function main() {
    const parsed = DateTime.fromFormat(BASELINE_DAY, "yyyy-MM-dd", { zone: "Europe/Amsterdam" });
    if (!parsed.isValid) throw new Error("Invalid baseline day");

    const startUtc = parsed.startOf("day").toUTC().toJSDate();
    const prevDayUtc = parsed.minus({ days: 1 }).startOf("day").toUTC().toJSDate();

    const rows = parseCsv(CSV_PATH);
    if (rows.length === 0) {
        throw new Error(`No baseline rows parsed from CSV: ${CSV_PATH}`);
    }

    console.log("=== Reset baseline from CSV ===");
    console.log(`CSV rows parsed: ${rows.length}`);
    console.log(`Baseline day: ${BASELINE_DAY} (Amsterdam)`);
    console.log(`Start UTC: ${startUtc.toISOString()}`);
    console.log(`Anchor frozen date UTC (prev day start): ${prevDayUtc.toISOString()}`);

    await cleanupLedgerNoise(startUtc);
    await recalcBalanceColumns();
    await applyBaselineAnchors(rows, prevDayUtc);

    // Rebuild frozen chains from baseline day for all users
    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);
    const users = await prisma.balance.findMany({ select: { userID: true } });
    for (const { userID } of users) {
        await balanceService.refreshFrozenBalanceChainFromDay(userID, BASELINE_DAY);
    }
    console.log(`  rebuilt frozen chain from ${BASELINE_DAY} for ${users.length} users`);

    console.log("\nDone.");
}

main()
    .catch((e) => {
        console.error("Fatal:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
