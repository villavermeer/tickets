/**
 * Overwrite frozen EOD balances from an Excel file on the target database.
 *
 * For each user:
 * - frozen jul6 = Excel end balance (opening for jul7)
 * - frozen jul5 = Excel end − jul6 day activity (so jul6 "Eind saldo" in the app matches Excel)
 *
 * Usage (production):
 *   cd apps/backend && \
 *   DATABASE_URL="postgresql://..." \
 *   XLSX_PATH="/Users/remynijsten/Downloads/Standen 6-7-2026.xlsx" \
 *   FROZEN_DAY=2026-07-06 \
 *   npx ts-node -r tsconfig-paths/register src/scripts/overwrite-frozen-balances-from-xlsx.ts
 */

import "reflect-metadata";
import ExcelJS from "exceljs";
import { DateTime } from "luxon";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const XLSX_PATH =
    process.env.XLSX_PATH ?? "/Users/remynijsten/Downloads/Standen 6-7-2026.xlsx";
const FROZEN_DAY = process.env.FROZEN_DAY ?? "2026-07-06";

/** Excel display name -> database username */
const NAME_TO_USERNAME: Record<string, string> = {
    Eva: "eva",
    Celis: "celies",
    Hubert: "hubert",
    Iro: "iro",
    Leo: "leo",
    Lollypop: "lollypop",
    Ludwina: "ludwina",
    Janice: "janice",
    Jacqueline: "jacqueline",
    Jenny: "jenny",
    Junnir: "juni",
    Maivy: "maivy",
    Marlly: "marlly",
    Mica: "mica",
    "Mina Delft": "mina",
    Milouska: "milouska",
    Natasha: "natasha",
    Nela: "nela",
    Nuni: "nuni",
    Otty: "otty",
    Reggy: "reggy",
    Ruthline: "ruthline",
    Ruthmila: "ruthmila",
    Shera: "chera",
    Soraya: "soraya",
    Ted: "joseph",
    Vincent: "vincent",
    Violeta: "violeta",
};

type BalanceRow = { displayName: string; cents: number };

function eurosToCents(value: number): number {
    return Math.round(value * 100);
}

function formatEuros(cents: number): string {
    return (cents / 100).toFixed(2);
}

async function parseXlsx(xlsxPath: string): Promise<BalanceRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxPath);

    const sheet = workbook.worksheets[0];
    if (!sheet) {
        throw new Error(`No worksheet found in ${xlsxPath}`);
    }

    const rows: BalanceRow[] = [];

    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        const displayName = String(row.getCell(1).value ?? "").trim();
        const rawBalance = row.getCell(2).value;

        let euros: number | null = null;
        if (typeof rawBalance === "number") {
            euros = rawBalance;
        } else if (rawBalance && typeof rawBalance === "object" && "result" in rawBalance) {
            euros = Number((rawBalance as { result?: number }).result);
        } else if (rawBalance != null) {
            euros = Number(rawBalance);
        }

        if (!displayName || euros == null || !Number.isFinite(euros)) return;

        rows.push({ displayName, cents: eurosToCents(euros) });
    });

    return rows;
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

    const dbHost = (process.env.DATABASE_URL ?? "").match(/@([^/:]+)/)?.[1] ?? "unknown";
    const rows = await parseXlsx(XLSX_PATH);

    if (rows.length === 0) {
        throw new Error(`No balance rows parsed from ${XLSX_PATH}`);
    }

    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    await ensureFrozenBalanceSequence();

    console.log("=== Overwrite frozen balances from Excel ===");
    console.log(`DB host: ${dbHost}`);
    console.log(`File: ${XLSX_PATH}`);
    console.log(`Frozen day (Amsterdam EOD): ${FROZEN_DAY}`);
    console.log(`Rows parsed: ${rows.length}\n`);

    let updated = 0;
    const missingUsers: string[] = [];
    const unmappedNames: string[] = [];

    for (const row of rows) {
        const username = NAME_TO_USERNAME[row.displayName];
        if (!username) {
            unmappedNames.push(row.displayName);
            continue;
        }

        const user = await prisma.user.findFirst({
            where: { username },
            select: { id: true, username: true },
        });

        if (!user) {
            missingUsers.push(`${row.displayName} -> ${username}`);
            continue;
        }

        const dayTotals = await balanceService.getBalanceDayTotals(user.id, FROZEN_DAY);
        const openingCents = row.cents - dayTotals.dayNet;

        const existing6 = await prisma.frozenBalance.findUnique({
            where: { userID_date: { userID: user.id, date: frozenDateUtc } },
        });
        const existing5 = await prisma.frozenBalance.findUnique({
            where: { userID_date: { userID: user.id, date: prevDateUtc } },
        });

        await upsertFrozen(user.id, prevDateUtc, openingCents);
        await upsertFrozen(user.id, frozenDateUtc, row.cents);

        updated++;
        console.log(
            `${row.displayName.padEnd(12)} (${user.username})`,
            `jul5: €${existing5 ? formatEuros(existing5.balance) : "—"} -> €${formatEuros(openingCents)}`,
            `| jul6: €${existing6 ? formatEuros(existing6.balance) : "—"} -> €${formatEuros(row.cents)}`,
            `| activity: €${formatEuros(dayTotals.dayNet)}`
        );
    }

    console.log(`\nDone. Updated ${updated} user(s).`);

    if (unmappedNames.length > 0) {
        console.log(`\nUnmapped Excel names: ${unmappedNames.join(", ")}`);
    }
    if (missingUsers.length > 0) {
        console.log(`\nMissing database users:\n  ${missingUsers.join("\n  ")}`);
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
