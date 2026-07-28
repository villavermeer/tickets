/**
 * Validate Jul 26 closings against Standen 26-7.xlsx
 */
import "reflect-metadata";
import ExcelJS from "exceljs";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const XLSX_PATH =
    process.env.XLSX_PATH ?? "/Users/remynijsten/Downloads/Standen 26-7.xlsx";

const NAME_TO_USERNAME: Record<string, string> = {
    Eva: "eva",
    "Shushu*": "shushu",
    "Fara*": "fara",
    "Josh*": "viva",
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
    "Suvienne*": "suvienne",
    "Shurenska*": "shurenska",
    Milouska: "milouska",
    Natasha: "natasha",
    Nela: "nela",
    Nuni: "nuni",
    "Xiomara*": "xiomara",
    "Neska*": "neska",
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
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw * 100);
    if (raw && typeof raw === "object" && "result" in raw) {
        const n = Number((raw as { result?: number }).result);
        return Number.isFinite(n) ? Math.round(n * 100) : null;
    }
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    if (s.includes(",") && s.includes(".")) {
        if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
        else s = s.replace(/,/g, "");
    } else if (s.includes(",")) s = s.replace(",", ".");
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
}

async function main() {
    container.registerInstance("Database", prisma);
    const svc = container.resolve(BalanceService);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(XLSX_PATH);
    const sheet = wb.worksheets[0];
    if (!sheet) throw new Error("No sheet");

    let match = 0;
    let mismatch = 0;
    let skip = 0;

    const rows: Array<{ name: string; cents: number }> = [];
    sheet.eachRow((row, idx) => {
        if (idx === 1) return;
        const name = String(row.getCell(1).value ?? "").trim();
        const cents = parseEuros(row.getCell(2).value);
        if (!name || cents == null) return;
        rows.push({ name, cents });
    });

    for (const row of rows) {
        const username = NAME_TO_USERNAME[row.name];
        if (!username) {
            console.log(`SKIP ${row.name}`);
            skip++;
            continue;
        }
        const user = await prisma.user.findFirst({
            where: { username },
            select: { id: true },
        });
        if (!user) {
            console.log(`MISSING ${row.name}`);
            skip++;
            continue;
        }

        const t = await svc.getBalanceDayTotals(user.id, "2026-07-26");
        if (t.closing === row.cents) {
            match++;
            console.log(`OK ${row.name} €${(row.cents / 100).toFixed(2)}`);
        } else {
            mismatch++;
            console.log(
                `MISMATCH ${row.name} exp €${(row.cents / 100).toFixed(2)} act €${(t.closing / 100).toFixed(2)} open €${(t.opening / 100).toFixed(2)} net €${(t.dayNet / 100).toFixed(2)}`
            );
        }
    }

    console.log(`\nSUMMARY match=${match} mismatch=${mismatch} skip=${skip}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
