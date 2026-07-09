/**
 * Compare and overwrite frozen EOD balances from filleddatabase_users.csv.
 *
 * CSV format example:
 *   28,Jenny,jenny,RUNNER;1,275.21
 *
 * For each user with a balance in the CSV:
 * - frozen jul6 = CSV end balance (opening for jul7)
 * - frozen jul5 = CSV end − jul6 day activity (so jul6 view matches CSV)
 *
 * Usage:
 *   cd apps/backend && \
 *   DATABASE_URL="postgresql://..." \
 *   CSV_PATH="/Users/remynijsten/Downloads/filleddatabase_users.csv" \
 *   FROZEN_DAY=2026-07-06 \
 *   npx ts-node -r tsconfig-paths/register src/scripts/overwrite-frozen-balances-from-csv.ts
 */

import "reflect-metadata";
import fs from "node:fs";
import { DateTime } from "luxon";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const CSV_PATH =
    process.env.CSV_PATH ?? "/Users/remynijsten/Downloads/filleddatabase_users.csv";
const FROZEN_DAY = process.env.FROZEN_DAY ?? "2026-07-06";
const DRY_RUN = process.env.DRY_RUN === "1";

type CsvRow = {
    userID: number;
    name: string;
    username: string;
    cents: number;
};

function parseEuros(raw: string): number {
    const value = raw.trim();
    if (!value) throw new Error("empty balance");

    let normalized = value;
    if (value.includes(",") && value.includes(".")) {
        normalized = value.replace(/,/g, "");
    } else if (value.includes(",")) {
        normalized = value.replace(",", ".");
    }

    const euros = Number(normalized);
    if (!Number.isFinite(euros)) {
        throw new Error(`invalid balance: ${raw}`);
    }

    return Math.round(euros * 100);
}

function parseCsv(csvPath: string): CsvRow[] {
    const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
    const rows: CsvRow[] = [];

    for (const line of lines) {
        if (line.startsWith("id,")) continue;
        if (!line.includes(";")) continue;

        const [left, balancePart] = line.split(";");
        const balanceRaw = balancePart?.trim();
        if (!balanceRaw) continue;

        const parts = left.split(",");
        if (parts.length < 4) continue;

        const userID = Number(parts[0]);
        const username = parts[parts.length - 2];
        const name = parts.slice(1, parts.length - 2).join(",");

        if (!Number.isFinite(userID) || !username) continue;

        rows.push({
            userID,
            name,
            username,
            cents: parseEuros(balanceRaw),
        });
    }

    return rows;
}

function formatEuros(cents: number): string {
    return (cents / 100).toFixed(2);
}

async function ensureFrozenBalanceSequence(): Promise<void> {
    await prisma.$executeRawUnsafe(
        "SELECT setval('frozen_balances_id_seq', COALESCE((SELECT MAX(id) FROM frozen_balances), 1))"
    );
}

async function upsertFrozen(userID: number, dateUtc: Date, cents: number): Promise<void> {
    await prisma.frozenBalance.upsert({
        where: { userID_date: { userID, date: dateUtc } },
        update: { balance: cents },
        create: { userID, date: dateUtc, balance: cents },
    });
}

async function main() {
    const parsed = DateTime.fromFormat(FROZEN_DAY, "yyyy-MM-dd", { zone: "Europe/Amsterdam" });
    if (!parsed.isValid) {
        throw new Error(`Invalid FROZEN_DAY: ${FROZEN_DAY}`);
    }

    const frozenDateUtc = parsed.startOf("day").toUTC().toJSDate();
    const prevDateUtc = parsed.minus({ days: 1 }).startOf("day").toUTC().toJSDate();
    const rows = parseCsv(CSV_PATH);

    if (rows.length === 0) {
        throw new Error(`No balance rows parsed from ${CSV_PATH}`);
    }

    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    const dbHost = (process.env.DATABASE_URL ?? "").match(/@([^/:]+)/)?.[1] ?? "unknown";

    console.log("=== Compare / overwrite frozen balances from CSV ===");
    console.log(`DB host: ${dbHost}`);
    console.log(`CSV: ${CSV_PATH}`);
    console.log(`Frozen day: ${FROZEN_DAY}`);
    console.log(`Rows parsed: ${rows.length}`);
    console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "WRITE"}\n`);

    if (!DRY_RUN) {
        await ensureFrozenBalanceSequence();
    }

    let matched = 0;
    let updated = 0;
    let missingUsers = 0;

    for (const row of rows) {
        const user = await prisma.user.findFirst({
            where: { id: row.userID },
            select: { id: true, username: true, name: true },
        });

        if (!user) {
            missingUsers++;
            console.log(
                `MISSING ${row.userID} ${row.username}: csv=€${formatEuros(row.cents)}`
            );
            continue;
        }

        const existing6 = await prisma.frozenBalance.findUnique({
            where: { userID_date: { userID: user.id, date: frozenDateUtc } },
        });
        const dayTotals = await balanceService.getBalanceDayTotals(user.id, FROZEN_DAY);
        const openingCents = row.cents - dayTotals.dayNet;

        const currentClosing = existing6?.balance ?? null;
        const computedClosing = dayTotals.closing;
        const needsUpdate =
            currentClosing === null ||
            currentClosing !== row.cents ||
            computedClosing !== row.cents;

        if (!needsUpdate) {
            matched++;
            console.log(
                `OK   ${user.name} (${user.username}) jul6=€${formatEuros(row.cents)}`
            );
            continue;
        }

        console.log(
            `FIX  ${user.name} (${user.username})`,
            `frozen jul6: €${currentClosing === null ? "—" : formatEuros(currentClosing)} -> €${formatEuros(row.cents)}`,
            `| computed jul6: €${formatEuros(computedClosing)}`,
            `| jul5 -> €${formatEuros(openingCents)}`,
            `| activity: €${formatEuros(dayTotals.dayNet)}`
        );

        if (!DRY_RUN) {
            await upsertFrozen(user.id, prevDateUtc, openingCents);
            await upsertFrozen(user.id, frozenDateUtc, row.cents);
            updated++;
        }
    }

    console.log(`\nDone.`);
    console.log(`Already correct: ${matched}`);
    console.log(`Updated: ${updated}`);
    console.log(`Missing users: ${missingUsers}`);
}

main()
    .catch((e) => {
        console.error("Fatal:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
