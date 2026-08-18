/**
 * Repair opening-balance continuity from the PO-approved 26 Jul freeze, then
 * apply Standen 17-8-2026 as the latest EOD snapshot.
 *
 * 1) Rebuild frozen rows from 2026-07-27 through today using frozen 26 Jul as
 *    the immutable opening (so 28 Jul beginstand = 27 Jul eindsaldo).
 * 2) Add a dated 17 Aug correction per user so that day's closing matches Excel.
 *
 * Usage:
 *   cd apps/backend && \
 *   XLSX_PATH="/Users/remynijsten/Downloads/standen 17-8-2026.xlsx" \
 *   CONFIRM=YES npx ts-node -r tsconfig-paths/register src/scripts/apply-standen-17-8.ts
 */

import "reflect-metadata";
import ExcelJS from "exceljs";
import { DateTime } from "luxon";
import { BalanceActionType } from "@prisma/client";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const XLSX_PATH =
    process.env.XLSX_PATH ?? "/Users/remynijsten/Downloads/standen 17-8-2026.xlsx";
const ANCHOR_DAY = "2026-07-26";
const REBUILD_FROM = "2026-07-27";
const STANDEN_DAY = "2026-08-17";
const CONFIRM = process.env.CONFIRM === "YES";
const SKIP_STANDEN = process.env.SKIP_STANDEN === "YES";
const SKIP_REBUILD = process.env.SKIP_REBUILD === "YES";

const NAME_TO_USERNAME: Record<string, string> = {
    Eva: "eva",
    Shushu: "shushu",
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
    Junnir: "juni",
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
    Ruthline: "ruthline",
    Shera: "chera",
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
    const balances = await prisma.balance.findMany({ select: { userID: true } });

    console.log("=== Apply standen 17-8 and lock opening balances ===");
    console.log(`DB host: ${dbHost}`);
    console.log(`File: ${XLSX_PATH}`);
    console.log(`Anchor EOD: ${ANCHOR_DAY}`);
    console.log(`Rebuild from: ${REBUILD_FROM}`);
    console.log(`Standen day: ${STANDEN_DAY}`);
    console.log(`Users with balance: ${balances.length}`);
    console.log(`Excel rows: ${rows.length}`);
    console.log(`Mode: ${CONFIRM ? "WRITE" : "DRY RUN"}\n`);

    if (!CONFIRM || SKIP_REBUILD) {
        console.log(
            SKIP_REBUILD
                ? "SKIP_REBUILD=YES — using existing frozen chain.\n"
                : "Skipping chain rebuild (dry run).\n"
        );
    } else {
        console.log(`Rebuilding frozen chain from ${REBUILD_FROM} for ${balances.length} user(s)...`);
        for (const { userID } of balances) {
            await balanceService.refreshFrozenBalanceChainFromDay(userID, REBUILD_FROM, {
                overwriteSealed: true,
            });
        }
        console.log("Chain rebuild done.\n");
    }

    const mica = await prisma.user.findFirst({ where: { username: "mica" } });
    if (mica) {
        const t27 = await balanceService.getBalanceDayTotals(mica.id, "2026-07-27");
        const t28 = await balanceService.getBalanceDayTotals(mica.id, "2026-07-28");
        console.log(
            `Mica 27 Jul: open €${formatEuros(t27.opening)} close €${formatEuros(t27.closing)} ` +
                `net €${formatEuros(t27.dayNet)}`
        );
        console.log(
            `Mica 28 Jul: open €${formatEuros(t28.opening)} close €${formatEuros(t28.closing)} ` +
                `[${t28.opening === t27.closing ? "CONTINUOUS" : `BROKEN Δ€${formatEuros(t28.opening - t27.closing)}`}]`
        );
        console.log("");
    }

    if (SKIP_STANDEN) {
        console.log("SKIP_STANDEN=YES — not applying Excel corrections.");
        if (!CONFIRM) console.log("\nDry run. Set CONFIRM=YES to apply.");
        return;
    }

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

        const totals = await balanceService.getBalanceDayTotals(user.id, STANDEN_DAY);
        const delta = row.cents - totals.closing;
        if (Math.abs(delta) <= 1) {
            alreadyOk++;
            console.log(
                `${row.displayName.padEnd(12)} (${user.username}) already €${formatEuros(row.cents)}`
            );
            continue;
        }

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
                reference: "Standen 17-08-2026",
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
    console.log(`Corrections ${CONFIRM ? "applied" : "needed"}: ${corrections || rows.length - alreadyOk - unmapped.length - missing.length}`);
    if (unmapped.length) console.log(`Unmapped (no DB user):\n  ${unmapped.join("\n  ")}`);
    if (missing.length) console.log(`Missing DB users:\n  ${missing.join("\n  ")}`);

    if (mica && CONFIRM) {
        const t27 = await balanceService.getBalanceDayTotals(mica.id, "2026-07-27");
        const t28 = await balanceService.getBalanceDayTotals(mica.id, "2026-07-28");
        const t17 = await balanceService.getBalanceDayTotals(mica.id, STANDEN_DAY);
        console.log("\n--- Mica after write ---");
        console.log(
            `27 Jul close €${formatEuros(t27.closing)} -> 28 Jul open €${formatEuros(t28.opening)} ` +
                `[${t28.opening === t27.closing ? "OK" : "BROKEN"}]`
        );
        console.log(`17 Aug close €${formatEuros(t17.closing)}`);
    }

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
