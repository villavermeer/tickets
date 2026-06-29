/**
 * Verify day-to-day continuity and flag outliers.
 *
 * Usage:
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register src/scripts/verify-day-continuity.ts
 */

import "reflect-metadata";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const DAY1 = process.env.DAY1 ?? "2026-06-28";
const DAY2 = process.env.DAY2 ?? "2026-06-29";
const OUTLIER_CENTS = Number(process.env.OUTLIER_CENTS ?? "1000000"); // €10k default

async function main() {
    container.registerInstance("Database", prisma);
    const service = container.resolve(BalanceService);

    const balances = await prisma.balance.findMany({
        select: { userID: true },
        orderBy: { userID: "asc" },
    });

    const broken: string[] = [];
    const outliers: string[] = [];
    let ok = 0;

    console.log(`=== Continuity ${DAY1} close -> ${DAY2} open ===\n`);

    for (const { userID } of balances) {
        const user = await prisma.user.findUnique({
            where: { id: userID },
            select: { name: true, role: true },
        });

        const t1 = await service.getBalanceDayTotals(userID, DAY1);
        const t2 = await service.getBalanceDayTotals(userID, DAY2);

        const continuous = t1.closing === t2.opening;
        if (continuous) {
            ok++;
        } else {
            const diff = (t2.opening - t1.closing) / 100;
            broken.push(
                `${userID}\t${user?.name ?? "?"}\t${user?.role ?? "?"}\t` +
                    `${DAY1}_close=${(t1.closing / 100).toFixed(2)}\t` +
                    `${DAY2}_open=${(t2.opening / 100).toFixed(2)}\t` +
                    `diff=${diff.toFixed(2)}`
            );
        }

        const maxAbs = Math.max(
            Math.abs(t1.closing),
            Math.abs(t2.opening),
            Math.abs(t2.closing),
            Math.abs(t1.dayNet),
            Math.abs(t2.dayNet)
        );
        if (maxAbs > OUTLIER_CENTS) {
            outliers.push(
                `${userID}\t${user?.name ?? "?"}\t` +
                    `${DAY1}_close=${(t1.closing / 100).toFixed(2)}\t` +
                    `${DAY2}_open=${(t2.opening / 100).toFixed(2)}\t` +
                    `${DAY2}_close=${(t2.closing / 100).toFixed(2)}\t` +
                    `${DAY2}_dayNet=${(t2.dayNet / 100).toFixed(2)}`
            );
        }
    }

    console.log(`Users checked: ${balances.length}`);
    console.log(`Continuity OK: ${ok}`);
    console.log(`Continuity BROKEN: ${broken.length}`);
    console.log(`Outliers (>|${OUTLIER_CENTS / 100}| EUR): ${outliers.length}\n`);

    if (broken.length > 0) {
        console.log("--- BROKEN ---");
        broken.forEach((l) => console.log(l));
        console.log("");
    }

    if (outliers.length > 0) {
        console.log("--- OUTLIERS ---");
        outliers.forEach((l) => console.log(l));
        console.log("");
    }

    // Sample key users
    const sample = [21, 22, 13, 52, 33, 9];
    console.log("--- SAMPLE USERS ---");
    for (const userID of sample) {
        const user = await prisma.user.findUnique({
            where: { id: userID },
            select: { name: true },
        });
        const t28 = await service.getBalanceDayTotals(userID, DAY1);
        const t29 = await service.getBalanceDayTotals(userID, DAY2);
        const cont = t28.closing === t29.opening ? "OK" : "BROKEN";
        console.log(
            `${userID}\t${user?.name ?? "?"}\t` +
                `28: open=${(t28.opening / 100).toFixed(2)} close=${(t28.closing / 100).toFixed(2)} ` +
                `inleg=${(t28.ticketSale / 100).toFixed(2)} prijs=${(t28.prize / 100).toFixed(2)} prov=${(t28.provision / 100).toFixed(2)} | ` +
                `29: open=${(t29.opening / 100).toFixed(2)} close=${(t29.closing / 100).toFixed(2)} ` +
                `dayNet=${(t29.dayNet / 100).toFixed(2)} [${cont}]`
        );
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
