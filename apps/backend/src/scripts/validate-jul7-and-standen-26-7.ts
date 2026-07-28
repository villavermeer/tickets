import "reflect-metadata";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const JUL7_CSV =
    process.env.JUL7_CSV ?? "/Users/remynijsten/Downloads/eindsaldos-2026-07-07-corrected.csv";
const JUL26_XLSX =
    process.env.JUL26_XLSX ?? "/Users/remynijsten/Downloads/Standen 26-7.xlsx";

type CsvRow = { displayName: string; username: string; cents: number };
type XlsxRow = { displayName: string; cents: number };

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

function parseJul7Csv(path: string): CsvRow[] {
    return fs
        .readFileSync(path, "utf8")
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

async function parseJul26Xlsx(path: string): Promise<XlsxRow[]> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error(`No sheet in ${path}`);

    const rows: XlsxRow[] = [];
    sheet.eachRow((row, idx) => {
        if (idx === 1) return;
        const displayName = String(row.getCell(1).value ?? "").trim();
        const raw = row.getCell(2).value;
        let euros: number | null = null;
        if (typeof raw === "number") euros = raw;
        else if (raw && typeof raw === "object" && "result" in raw) euros = Number((raw as any).result);
        else if (raw != null) euros = Number(raw);
        if (!displayName || euros == null || !Number.isFinite(euros)) return;
        rows.push({ displayName, cents: Math.round(euros * 100) });
    });
    return rows;
}

async function main() {
    container.registerInstance("Database", prisma);
    const service = container.resolve(BalanceService);

    const jul7Rows = parseJul7Csv(JUL7_CSV);
    let jul7Match = 0;
    let jul7Mismatch = 0;
    console.log("=== Jul 7 CSV vs app closing/opening ===");
    for (const row of jul7Rows) {
        const user = await prisma.user.findFirst({
            where: { username: row.username },
            select: { id: true, username: true },
        });
        if (!user) continue;
        const t7 = await service.getBalanceDayTotals(user.id, "2026-07-07");
        const t8 = await service.getBalanceDayTotals(user.id, "2026-07-08");
        const ok = t7.closing === row.cents && t8.opening === row.cents;
        if (ok) jul7Match++;
        else jul7Mismatch++;
        console.log(
            `${row.username.padEnd(10)} csv7=€${formatEuros(row.cents)} close7=€${formatEuros(t7.closing)} open8=€${formatEuros(t8.opening)} ${ok ? "OK" : "MISMATCH"}`
        );
    }
    console.log(`Jul7 matched: ${jul7Match}, mismatched: ${jul7Mismatch}\n`);

    const jul26Rows = await parseJul26Xlsx(JUL26_XLSX);
    let match = 0;
    let mismatch = 0;
    let unmapped = 0;
    let missing = 0;
    console.log("=== Jul 26 XLSX vs app closing ===");
    for (const row of jul26Rows) {
        const username = NAME_TO_USERNAME[row.displayName];
        if (!username) {
            unmapped++;
            console.log(`${row.displayName.padEnd(12)} unmapped`);
            continue;
        }
        const user = await prisma.user.findFirst({
            where: { username },
            select: { id: true, username: true },
        });
        if (!user) {
            missing++;
            console.log(`${row.displayName.padEnd(12)} (${username}) missing user`);
            continue;
        }
        const t = await service.getBalanceDayTotals(user.id, "2026-07-26");
        const delta = t.closing - row.cents;
        const ok = delta === 0;
        if (ok) match++;
        else mismatch++;
        console.log(
            `${row.displayName.padEnd(12)} (${username}) expected=€${formatEuros(row.cents)} actual=€${formatEuros(t.closing)} delta=€${formatEuros(delta)} ${ok ? "OK" : "MISMATCH"}`
        );
    }
    console.log(`Jul26 matched: ${match}, mismatched: ${mismatch}, unmapped: ${unmapped}, missing: ${missing}`);
}

main()
    .catch((e) => {
        console.error("Fatal:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
