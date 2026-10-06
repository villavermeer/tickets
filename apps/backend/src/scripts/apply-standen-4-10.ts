/**
 * Apply Standen 4-10-2026 as the latest EOD snapshot.
 *
 * For each Excel row: add a dated 4 Oct correction so that day's closing
 * matches Excel, then refresh the frozen chain from that day.
 *
 * Usage:
 *   cd apps/backend && \
 *   XLSX_PATH="/Users/remynijsten/Downloads/Inleg 4-10-2026.xlsx" \
 *   CONFIRM=YES npx ts-node -r tsconfig-paths/register src/scripts/apply-standen-4-10.ts
 */

import "reflect-metadata";
import ExcelJS from "exceljs";
import { DateTime } from "luxon";
import { BalanceActionType } from "@prisma/client";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const XLSX_PATH =
    process.env.XLSX_PATH ?? "/Users/remynijsten/Downloads/Inleg 4-10-2026.xlsx";
const STANDEN_DAY = "2026-10-04";
const CONFIRM = process.env.CONFIRM === "YES";

const NAME_TO_USERNAME: Record<string, string> = {
    Eva: "eva",
    Shushu: "shushu",
    Peepee: "peepee",
    Juni: "juni",
    Junnir: "juni",
    Fara: "fara",
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
    Maivy: "maivy",
    Marlly: "marlly",
    Mica: "mica",
    "Mina Delft": "mina",
    Mina: "mina",
    Suvienne: "suvienne",
    Shurenska: "shurenska",
    Milouska: "milouska",
    Natasha: "natasha",
    Nela: "nela",
    Nuni: "nuni",
    Xiomara: "xiomara",
    Neska: "neska",
    Otty: "otty",
    Reggy: "reggy",
    Roos: "roos",
    Ruthline: "ruthline",
    Shera: "chera",
    Chera: "chera",
    Soraya: "soraya",
    Ted: "joseph",
    Vincent: "vincent",
    Violeta: "violeta",
};

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

async function parseXlsx(xlsxPath: string): Promise<Array<{ displayName: string; cents: number }>> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxPath);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error(`No worksheet in ${xlsxPath}`);

    const rows: Array<{ displayName: string; cents: number }> = [];
    sheet.eachRow((row) => {
        const displayName = String(row.getCell(1).value ?? "").trim();
        const cents = parseEuros(row.getCell(2).value);
        if (!displayName || cents == null) return;
        rows.push({ displayName, cents });
    });
    return rows;
}

async function main() {
    const dbHost = (process.env.DATABASE_URL ?? "").match(/@([^/:]+)/)?.[1] ?? "unknown";
    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    const rows = await parseXlsx(XLSX_PATH);

    console.log("=== Apply standen 4-10-2026 ===");
    console.log(`DB host: ${dbHost}`);
    console.log(`File: ${XLSX_PATH}`);
    console.log(`Standen day: ${STANDEN_DAY}`);
    console.log(`Excel rows: ${rows.length}`);
    console.log(`Mode: ${CONFIRM ? "WRITE" : "DRY RUN"}\n`);

    const standenCreated = DateTime.fromFormat(STANDEN_DAY, "yyyy-MM-dd", {
        zone: "Europe/Amsterdam",
    })
        .plus({ hours: 12 })
        .toUTC()
        .toJSDate();

    const unmapped: string[] = [];
    const missing: string[] = [];
    let alreadyOk = 0;
    let corrections = 0;
    let needed = 0;

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
            missing.push(`${row.displayName} -> ${username} (€${formatEuros(row.cents)})`);
            continue;
        }

        const totals = await balanceService.getBalanceDayTotals(user.id, STANDEN_DAY);
        const delta = row.cents - totals.closing;
        if (Math.abs(delta) <= 1) {
            alreadyOk++;
            console.log(
                `${row.displayName.padEnd(12)} (${user.username}) already €${formatEuros(row.cents)}`
            );
            continue;
        }

        needed++;
        console.log(
            `${row.displayName.padEnd(12)} (${user.username})`,
            `close €${formatEuros(totals.closing)} -> €${formatEuros(row.cents)}`,
            `| correction €${formatEuros(delta)}`
        );

        if (!CONFIRM) continue;

        const balance = await prisma.balance.findUnique({ where: { userID: user.id } });
        if (!balance) continue;

        await prisma.balanceAction.create({
            data: {
                balanceID: balance.id,
                type: BalanceActionType.CORRECTION,
                amount: delta,
                reference: "Standen 04-10-2026",
                created: standenCreated,
            },
        });
        await prisma.balance.update({
            where: { id: balance.id },
            data: { balance: { increment: delta } },
        });
        await balanceService.refreshFrozenBalanceChainFromDay(user.id, STANDEN_DAY, {
            overwriteSealed: true,
        });
        corrections++;
    }

    console.log(`\nAlready matched Excel: ${alreadyOk}`);
    console.log(`Corrections ${CONFIRM ? "applied" : "needed"}: ${CONFIRM ? corrections : needed}`);
    if (unmapped.length) console.log(`Unmapped (no name map):\n  ${unmapped.join("\n  ")}`);
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
        process.exit(0);
    });
