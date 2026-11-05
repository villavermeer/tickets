/**
 * Backdate PRIZE rows stamped at next-day 03:00 (ticket window end) to raffle EOD.
 *
 * Regression from Nov 3 2026 go-live: middleware reused dayEndUtc (next 03:00) as
 * balance_action.created, so saldo "Prijzen" appeared one calendar day late.
 *
 * Usage:
 *   cd apps/backend && npx ts-node -r tsconfig-paths/register src/scripts/fix-misdated-prize-created.ts
 *   CONFIRM=YES ...  # apply updates and rebuild frozen chains
 */

import "reflect-metadata";
import { container } from "tsyringe";
import { DateTime } from "luxon";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const CONFIRM = process.env.CONFIRM === "YES";
const FROM_DATE = process.env.FROM_DATE ?? "2026-11-03";
const REBUILD_FROM = process.env.REBUILD_FROM ?? FROM_DATE;

function endOfAmsterdamDay(date: Date): Date {
    return DateTime.fromJSDate(date).setZone("Europe/Amsterdam").endOf("day").toUTC().toJSDate();
}

function amsterdamYmd(date: Date): string {
    return DateTime.fromJSDate(date).setZone("Europe/Amsterdam").toFormat("yyyy-MM-dd");
}

function raffleIdFromPrizeReference(reference: string | null): number | null {
    if (!reference?.startsWith("PRIZE:")) return null;
    const id = Number(reference.split(":")[1]);
    return Number.isFinite(id) ? id : null;
}

async function main() {
    const fromStart = DateTime.fromISO(FROM_DATE, { zone: "Europe/Amsterdam" })
        .startOf("day")
        .toUTC()
        .toJSDate();

    const prizes = await prisma.balanceAction.findMany({
        where: {
            type: "PRIZE",
            reference: { startsWith: "PRIZE:" },
            created: { gte: fromStart },
        },
        orderBy: { id: "asc" },
        include: {
            balance: {
                include: {
                    user: { select: { id: true, name: true } },
                },
            },
        },
    });

    console.log(`Scanning ${prizes.length} PRIZE row(s) from ${FROM_DATE}...\n`);

    const raffleCache = new Map<number, Date | null>();
    const toFix: Array<{
        id: number;
        userID: number;
        userName: string;
        amount: number;
        reference: string;
        fromDay: string;
        toDay: string;
        newCreated: Date;
    }> = [];

    for (const prize of prizes) {
        const raffleId = raffleIdFromPrizeReference(prize.reference);
        if (raffleId === null) continue;

        let raffleCreated = raffleCache.get(raffleId);
        if (raffleCreated === undefined) {
            const raffle = await prisma.raffle.findUnique({
                where: { id: raffleId },
                select: { created: true },
            });
            raffleCreated = raffle?.created ?? null;
            raffleCache.set(raffleId, raffleCreated);
        }
        if (!raffleCreated) continue;

        const expectedCreated = endOfAmsterdamDay(raffleCreated);
        const fromDay = amsterdamYmd(prize.created);
        const toDay = amsterdamYmd(expectedCreated);

        // Nov 3 bug: stamp calendar day differs from raffle calendar day (usually +1).
        if (fromDay === toDay) continue;

        toFix.push({
            id: prize.id,
            userID: prize.balance.user.id,
            userName: prize.balance.user.name,
            amount: prize.amount,
            reference: prize.reference ?? "",
            fromDay,
            toDay,
            newCreated: expectedCreated,
        });
    }

    if (toFix.length === 0) {
        console.log("No misdated PRIZE rows to fix.");
        return;
    }

    console.log(`Rows to fix: ${toFix.length}\n`);
    for (const row of toFix) {
        console.log(
            `  id=${row.id} ${row.userName} €${(row.amount / 100).toFixed(2)} ` +
                `${row.fromDay} -> ${row.toDay} (${row.reference})`
        );
    }

    const affectedUserIDs = [...new Set(toFix.map((r) => r.userID))];
    const earliestDay = toFix.map((r) => r.toDay).sort()[0] ?? REBUILD_FROM;
    const rebuildFrom = earliestDay < REBUILD_FROM ? earliestDay : REBUILD_FROM;

    console.log(`\nAffected users: ${affectedUserIDs.length}`);
    console.log(`Rebuild frozen chains from: ${rebuildFrom}`);

    if (!CONFIRM) {
        console.log("\nDry run. Set CONFIRM=YES to apply.");
        return;
    }

    for (const row of toFix) {
        await prisma.balanceAction.update({
            where: { id: row.id },
            data: { created: row.newCreated },
        });
    }
    console.log(`\nUpdated ${toFix.length} PRIZE row(s).`);

    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    for (const userID of affectedUserIDs) {
        await balanceService.refreshFrozenBalanceChainFromDay(userID, rebuildFrom, {
            overwriteSealed: true,
        });
    }
    console.log(`Rebuilt frozen chains for ${affectedUserIDs.length} user(s).`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
        process.exit(0);
    });
