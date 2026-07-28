/**
 * Diagnose whether Jul 7 corrected end balances are still the app baseline,
 * and where the chain drifts toward Jul 26.
 *
 * Usage:
 *   cd apps/backend && \
 *   CSV_PATH="/Users/remynijsten/Downloads/eindsaldos-2026-07-07-corrected.csv" \
 *   npx ts-node -r tsconfig-paths/register src/scripts/diagnose-jul7-baseline-drift.ts
 */

import "reflect-metadata";
import fs from "node:fs";
import { DateTime } from "luxon";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const CSV_PATH =
    process.env.CSV_PATH ??
    "/Users/remynijsten/Downloads/eindsaldos-2026-07-07-corrected.csv";
const BASELINE_DAY = "2026-07-07";
const TARGET_DAY = process.env.TARGET_DAY ?? "2026-07-26";
const DRIFT_USERS = (process.env.DRIFT_USERS ?? "ruthline,mina,juni,celies,eva").split(",");

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
    if (!Number.isFinite(euros)) throw new Error(`invalid balance: ${raw}`);
    return Math.round(euros * 100);
}

function formatEuros(cents: number): string {
    return (cents / 100).toFixed(2);
}

function parseCsv(csvPath: string): CsvRow[] {
    const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
    const rows: CsvRow[] = [];
    for (const line of lines.slice(1)) {
        const [displayName, username, balanceRaw] = line.split(";");
        if (!username || !balanceRaw) continue;
        rows.push({
            displayName: displayName.trim(),
            username: username.trim().toLowerCase(),
            cents: parseEuros(balanceRaw),
        });
    }
    return rows;
}

async function main() {
    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    const rows = parseCsv(CSV_PATH);
    const baselineUtc = DateTime.fromFormat(BASELINE_DAY, "yyyy-MM-dd", {
        zone: "Europe/Amsterdam",
    })
        .startOf("day")
        .toUTC()
        .toJSDate();

    console.log(`=== Jul 7 baseline check (${rows.length} CSV rows) ===\n`);

    let jul7Match = 0;
    let jul7Mismatch = 0;
    let jul8OpenMatch = 0;
    let jul8OpenMismatch = 0;
    const mismatchedUsers: string[] = [];

    for (const row of rows) {
        const user = await prisma.user.findFirst({
            where: { username: row.username },
            select: { id: true, username: true, name: true },
        });
        if (!user) {
            console.log(`MISSING user ${row.username}`);
            continue;
        }

        const totals7 = await balanceService.getBalanceDayTotals(user.id, BASELINE_DAY);
        const frozen7 = await prisma.frozenBalance.findUnique({
            where: { userID_date: { userID: user.id, date: baselineUtc } },
        });
        const totals8 = await balanceService.getBalanceDayTotals(user.id, "2026-07-08");

        const closeDelta = totals7.closing - row.cents;
        const frozenDelta = (frozen7?.balance ?? Number.NaN) - row.cents;
        const open8Delta = totals8.opening - row.cents;

        const closeOk = closeDelta === 0;
        const openOk = open8Delta === 0;
        if (closeOk) jul7Match++;
        else {
            jul7Mismatch++;
            mismatchedUsers.push(user.username);
        }
        if (openOk) jul8OpenMatch++;
        else jul8OpenMismatch++;

        if (!closeOk || !openOk || (frozen7 && frozenDelta !== 0)) {
            console.log(
                `${row.displayName.padEnd(12)} (${user.username})`,
                `csv=€${formatEuros(row.cents)}`,
                `| app close7=€${formatEuros(totals7.closing)} (Δ€${formatEuros(closeDelta)})`,
                `| frozen7=${frozen7 ? `€${formatEuros(frozen7.balance)}` : "MISSING"}`,
                `| open8=€${formatEuros(totals8.opening)} (Δ€${formatEuros(open8Delta)})`
            );
        } else {
            console.log(`${row.displayName.padEnd(12)} (${user.username}) OK`);
        }
    }

    console.log("\n=== Summary Jul7/Jul8 ===");
    console.log(`Jul7 closing matches CSV: ${jul7Match}`);
    console.log(`Jul7 closing mismatches: ${jul7Mismatch}`);
    console.log(`Jul8 opening matches CSV: ${jul8OpenMatch}`);
    console.log(`Jul8 opening mismatches: ${jul8OpenMismatch}`);

    console.log(`\n=== Day-by-day drift to ${TARGET_DAY} ===`);
    for (const username of DRIFT_USERS) {
        const user = await prisma.user.findFirst({
            where: { username: username.trim() },
            select: { id: true, username: true, name: true },
        });
        if (!user) {
            console.log(`\n${username}: missing`);
            continue;
        }

        const csv = rows.find((r) => r.username === user.username);
        console.log(
            `\n--- ${user.name} (${user.username}) csvJul7=€${csv ? formatEuros(csv.cents) : "n/a"} ---`
        );

        let cursor = DateTime.fromFormat(BASELINE_DAY, "yyyy-MM-dd", {
            zone: "Europe/Amsterdam",
        });
        const end = DateTime.fromFormat(TARGET_DAY, "yyyy-MM-dd", {
            zone: "Europe/Amsterdam",
        });

        while (cursor <= end) {
            const ymd = cursor.toFormat("yyyy-MM-dd");
            const t = await balanceService.getBalanceDayTotals(user.id, ymd);
            const frozen = await prisma.frozenBalance.findUnique({
                where: {
                    userID_date: {
                        userID: user.id,
                        date: cursor.startOf("day").toUTC().toJSDate(),
                    },
                },
            });
            const frozenMismatch =
                frozen && frozen.balance !== t.closing
                    ? ` FROZEN_DIFF(€${formatEuros(frozen.balance - t.closing)})`
                    : "";
            console.log(
                `${ymd}`,
                `open=€${formatEuros(t.opening)}`,
                `sale=€${formatEuros(t.ticketSale)}`,
                `corr=€${formatEuros(t.correction)}`,
                `prize=€${formatEuros(t.prize)}`,
                `prov=€${formatEuros(t.provision)}`,
                `pay=€${formatEuros(t.payout)}`,
                `net=€${formatEuros(t.dayNet)}`,
                `close=€${formatEuros(t.closing)}`,
                `frozen=${frozen ? `€${formatEuros(frozen.balance)}` : "—"}` +
                    frozenMismatch
            );
            cursor = cursor.plus({ days: 1 });
        }
    }
}

main()
    .catch((e) => {
        console.error("Fatal:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
