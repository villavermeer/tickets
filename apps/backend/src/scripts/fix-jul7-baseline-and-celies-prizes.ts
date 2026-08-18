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
const REBUILD_FROM = "2026-07-08";
const CONFIRM = process.env.CONFIRM === "YES";

type CsvRow = {
    displayName: string;
    username: string;
    cents: number;
};

function parseEuros(raw: string): number {
    const value = raw.trim();
    let normalized = value;
    if (value.includes(",") && value.includes(".")) {
        normalized = value.replace(/\./g, "").replace(",", ".");
    } else if (value.includes(",")) {
        normalized = value.replace(",", ".");
    }
    const euros = Number(normalized);
    if (!Number.isFinite(euros)) {
        throw new Error(`Invalid euro amount: ${raw}`);
    }
    return Math.round(euros * 100);
}

function formatEuros(cents: number): string {
    return (cents / 100).toFixed(2);
}

function parseCsv(csvPath: string): CsvRow[] {
    const rows = fs
        .readFileSync(csvPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const out: CsvRow[] = [];

    for (const row of rows.slice(1)) {
        const [displayName, username, endSaldo] = row.split(";");
        if (!displayName || !username || !endSaldo) continue;
        out.push({
            displayName: displayName.trim(),
            username: username.trim().toLowerCase(),
            cents: parseEuros(endSaldo),
        });
    }

    return out;
}

async function recalcBalanceByBalanceID(balanceID: number): Promise<void> {
    const sum = await prisma.balanceAction.aggregate({
        where: { balanceID },
        _sum: { amount: true },
    });
    await prisma.balance.update({
        where: { id: balanceID },
        data: { balance: sum._sum.amount ?? 0 },
    });
}

async function cleanupCeliesBogusPrizes(balanceService: BalanceService): Promise<number> {
    const celies = await prisma.user.findFirst({
        where: { username: "celies" },
        select: { id: true, username: true, name: true },
    });
    if (!celies) {
        console.log("Celies user not found, skipping bogus-prize cleanup.");
        return 0;
    }

    const balance = await prisma.balance.findUnique({
        where: { userID: celies.id },
        select: { id: true },
    });
    if (!balance) {
        console.log("Celies balance not found, skipping bogus-prize cleanup.");
        return 0;
    }

    const bogus = await prisma.balanceAction.findMany({
        where: {
            balanceID: balance.id,
            type: "PRIZE",
            amount: -1200000, // -€12,000
            reference: { startsWith: "PRIZE:3020:" },
        },
        select: { id: true, reference: true, created: true, amount: true },
        orderBy: { id: "asc" },
    });

    if (bogus.length === 0) {
        console.log("No bogus Celies PRIZE:3020 rows found.");
        return 0;
    }

    const total = bogus.reduce((sum, row) => sum + row.amount, 0);
    console.log(`Found ${bogus.length} bogus Celies prize row(s), total ${formatEuros(total)} EUR.`);
    for (const row of bogus.slice(0, 5)) {
        const dt = DateTime.fromJSDate(row.created).setZone("Europe/Amsterdam").toFormat("yyyy-MM-dd HH:mm");
        console.log(`  - id ${row.id}, ${row.reference}, ${formatEuros(row.amount)} EUR, ${dt}`);
    }
    if (bogus.length > 5) {
        console.log(`  ... and ${bogus.length - 5} more`);
    }

    if (!CONFIRM) {
        console.log("Dry run for bogus-prize cleanup. Set CONFIRM=YES to apply.");
        return 0;
    }

    await prisma.balanceAction.deleteMany({
        where: { id: { in: bogus.map((b) => b.id) } },
    });
    await recalcBalanceByBalanceID(balance.id);
    await balanceService.refreshFrozenBalanceChainFromDay(celies.id, "2026-06-27", { overwriteSealed: true });
    console.log("Deleted bogus Celies prize rows and rebuilt chain from 2026-06-27.");
    return bogus.length;
}

async function applyJul7BaselineAndRebuild(balanceService: BalanceService): Promise<{
    updated: number;
    missing: string[];
}> {
    const rows = parseCsv(CSV_PATH);
    if (rows.length === 0) throw new Error(`No rows parsed from ${CSV_PATH}`);

    const baseline = DateTime.fromFormat(BASELINE_DAY, "yyyy-MM-dd", { zone: "Europe/Amsterdam" });
    const baselineUtc = baseline.startOf("day").toUTC().toJSDate();
    const prevUtc = baseline.minus({ days: 1 }).startOf("day").toUTC().toJSDate();

    const missing: string[] = [];
    let updated = 0;

    console.log(`Applying Jul 7 baseline from ${CSV_PATH} (${rows.length} rows).`);
    for (const row of rows) {
        const user = await prisma.user.findFirst({
            where: { username: row.username },
            select: { id: true, username: true, name: true },
        });

        if (!user) {
            missing.push(`${row.displayName} -> ${row.username}`);
            continue;
        }

        const totals = await balanceService.getBalanceDayTotals(user.id, BASELINE_DAY);
        const openingJul7 = row.cents - totals.dayNet;

        const prevFrozen = await prisma.frozenBalance.findUnique({
            where: { userID_date: { userID: user.id, date: prevUtc } },
        });
        const baseFrozen = await prisma.frozenBalance.findUnique({
            where: { userID_date: { userID: user.id, date: baselineUtc } },
        });

        console.log(
            `${row.displayName.padEnd(12)} (${user.username})`,
            `jul6: €${prevFrozen ? formatEuros(prevFrozen.balance) : "—"} -> €${formatEuros(openingJul7)}`,
            `| jul7: €${baseFrozen ? formatEuros(baseFrozen.balance) : "—"} -> €${formatEuros(row.cents)}`,
            `| activity7: €${formatEuros(totals.dayNet)}`
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

            await balanceService.refreshFrozenBalanceChainFromDay(user.id, REBUILD_FROM, { overwriteSealed: true });
            updated++;
        }
    }

    if (!CONFIRM) {
        console.log("Dry run for baseline apply. Set CONFIRM=YES to apply.");
    }

    return { updated, missing };
}

async function main() {
    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    console.log("=== Fix Jul 7 baseline + bogus Celies prizes ===");
    console.log(`Mode: ${CONFIRM ? "WRITE" : "DRY RUN"}`);

    const removedBogus = await cleanupCeliesBogusPrizes(balanceService);
    const { updated, missing } = await applyJul7BaselineAndRebuild(balanceService);

    console.log("\n=== Done ===");
    console.log(`Bogus Celies prizes removed: ${removedBogus}`);
    console.log(`Users baseline-updated/rebuilt: ${updated}`);
    if (missing.length > 0) {
        console.log(`Missing users (${missing.length}):\n  ${missing.join("\n  ")}`);
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
