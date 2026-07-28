/**
 * Overwrite frozen EOD balances from Standen 26-7.xlsx so Jul 26 closings match PO.
 *
 * - frozen 2026-07-26 = Excel end balance
 * - frozen 2026-07-25 = Excel end − Jul26 dayNet (so app closing for Jul26 matches)
 *
 * Usage:
 *   CONFIRM=YES XLSX_PATH="..." npx ts-node -r tsconfig-paths/register \
 *     src/scripts/overwrite-frozen-balances-from-standen-26-7.ts
 */

import "reflect-metadata";
import ExcelJS from "exceljs";
import { DateTime } from "luxon";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const XLSX_PATH =
    process.env.XLSX_PATH ?? "/Users/remynijsten/Downloads/Standen 26-7.xlsx";
const FROZEN_DAY = "2026-07-26";
const CONFIRM = process.env.CONFIRM === "YES";

/** Excel display name -> database username */
const NAME_TO_USERNAME: Record<string, string> = {
    Eva: "eva",
    "Shushu*": "shushu",
    Shushu: "shushu",
    "Fara*": "fara",
    Fara: "fara",
    "Josh*": "viva",
    Josh: "viva",
    // Junior is NOT juni (Junnir) — different expected balances in the sheet
    Celis: "celies",
    Celies: "celies",
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
    Mina: "mina",
    "Suvienne*": "suvienne",
    Suvienne: "suvienne",
    "Shurenska*": "shurenska",
    Shurenska: "shurenska",
    Milouska: "milouska",
    Natasha: "natasha",
    Nela: "nela",
    Nuni: "nuni",
    "Xiomara*": "xiomara",
    Xiomara: "xiomara",
    "Neska*": "neska",
    Neska: "neska",
    Otty: "otty",
    Reggy: "reggy",
    Ruthline: "ruthline",
    Shera: "chera",
    Soraya: "soraya",
    Ted: "joseph",
    Vincent: "vincent",
    Violeta: "violeta",
};

type BalanceRow = { displayName: string; cents: number };

function parseEuros(raw: unknown): number | null {
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return Math.round(raw * 100);
    }
    if (raw && typeof raw === "object" && "result" in raw) {
        const n = Number((raw as { result?: number }).result);
        return Number.isFinite(n) ? Math.round(n * 100) : null;
    }
    if (raw == null) return null;

    let s = String(raw).trim();
    if (!s) return null;

    if (s.includes(",") && s.includes(".")) {
        if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
            s = s.replace(/\./g, "").replace(",", ".");
        } else {
            s = s.replace(/,/g, "");
        }
    } else if (s.includes(",")) {
        s = s.replace(",", ".");
    }

    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function formatEuros(cents: number): string {
    return (cents / 100).toFixed(2);
}

async function parseXlsx(xlsxPath: string): Promise<BalanceRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxPath);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error(`No worksheet in ${xlsxPath}`);

    const rows: BalanceRow[] = [];
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const displayName = String(row.getCell(1).value ?? "").trim();
        const cents = parseEuros(row.getCell(2).value);
        if (!displayName || cents == null) return;
        rows.push({ displayName, cents });
    });
    return rows;
}

async function main() {
    const parsed = DateTime.fromFormat(FROZEN_DAY, "yyyy-MM-dd", { zone: "Europe/Amsterdam" });
    const frozenDateUtc = parsed.startOf("day").toUTC().toJSDate();
    const prevDateUtc = parsed.minus({ days: 1 }).startOf("day").toUTC().toJSDate();

    const rows = await parseXlsx(XLSX_PATH);
    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    console.log("=== Overwrite frozen Jul 26 from Standen ===");
    console.log(`File: ${XLSX_PATH}`);
    console.log(`Rows parsed: ${rows.length}`);
    console.log(`Mode: ${CONFIRM ? "WRITE" : "DRY RUN"}\n`);

    let updated = 0;
    const unmapped: string[] = [];
    const missing: string[] = [];
    const alreadyOk: string[] = [];

    for (const row of rows) {
        const username = NAME_TO_USERNAME[row.displayName];
        if (!username) {
            unmapped.push(`${row.displayName} (€${formatEuros(row.cents)})`);
            continue;
        }

        const user = await prisma.user.findFirst({
            where: { username },
            select: { id: true, username: true },
        });
        if (!user) {
            missing.push(`${row.displayName} -> ${username}`);
            continue;
        }

        const dayTotals = await balanceService.getBalanceDayTotals(user.id, FROZEN_DAY);
        const openingCents = row.cents - dayTotals.dayNet;

        if (dayTotals.closing === row.cents) {
            alreadyOk.push(row.displayName);
            console.log(`${row.displayName.padEnd(12)} (${user.username}) already OK €${formatEuros(row.cents)}`);
            // still ensure frozen snapshot equals excel
            if (CONFIRM) {
                await prisma.frozenBalance.upsert({
                    where: { userID_date: { userID: user.id, date: prevDateUtc } },
                    update: { balance: openingCents },
                    create: { userID: user.id, date: prevDateUtc, balance: openingCents },
                });
                await prisma.frozenBalance.upsert({
                    where: { userID_date: { userID: user.id, date: frozenDateUtc } },
                    update: { balance: row.cents },
                    create: { userID: user.id, date: frozenDateUtc, balance: row.cents },
                });
            }
            continue;
        }

        console.log(
            `${row.displayName.padEnd(12)} (${user.username})`,
            `close €${formatEuros(dayTotals.closing)} -> €${formatEuros(row.cents)}`,
            `| jul25 opening €${formatEuros(openingCents)}`,
            `| dayNet €${formatEuros(dayTotals.dayNet)}`
        );

        if (CONFIRM) {
            await prisma.frozenBalance.upsert({
                where: { userID_date: { userID: user.id, date: prevDateUtc } },
                update: { balance: openingCents },
                create: { userID: user.id, date: prevDateUtc, balance: openingCents },
            });
            await prisma.frozenBalance.upsert({
                where: { userID_date: { userID: user.id, date: frozenDateUtc } },
                update: { balance: row.cents },
                create: { userID: user.id, date: frozenDateUtc, balance: row.cents },
            });
            // Invalidate day-totals cache by touching through a fresh resolve after upsert:
            // BalanceService cache is process-local; this script exits after.
            updated++;
        }
    }

    console.log(`\nAlready OK: ${alreadyOk.length}`);
    console.log(`Updated: ${updated}`);
    if (unmapped.length) console.log(`Unmapped:\n  ${unmapped.join("\n  ")}`);
    if (missing.length) console.log(`Missing DB users:\n  ${missing.join("\n  ")}`);
    if (!CONFIRM) console.log("\nDry run. Set CONFIRM=YES to apply.");
}

main()
    .catch((e) => {
        console.error("Fatal:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
