/**
 * Backdate pre-fix REVERSAL_PRIZE rows to the raffle business day (endOfDay Amsterdam).
 *
 * Targets reversals created before the Jul 9 2026 fix where `created` was set to the
 * draw-save timestamp instead of the raffle day.
 *
 * Usage:
 *   cd apps/backend && npx ts-node -r tsconfig-paths/register src/scripts/fix-misdated-reversal-prizes.ts
 *   CONFIRM=YES ...  # apply updates and rebuild frozen chains
 */

import "reflect-metadata";
import { container } from "tsyringe";
import { DateTime } from "luxon";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const CONFIRM = process.env.CONFIRM === "YES";
const FROM_DATE = process.env.FROM_DATE ?? "2026-07-06";
// Rebuild from Jul 7 onward so Jul 6 CSV anchor frozen rows stay intact.
const REBUILD_FROM = process.env.REBUILD_FROM ?? "2026-07-07";
const FIX_DEPLOYED = DateTime.fromISO("2026-07-09T11:45:01", {
    zone: "Europe/Amsterdam",
})
    .toUTC()
    .toJSDate();

function endOfAmsterdamDay(date: Date): Date {
    return DateTime.fromJSDate(date).setZone("Europe/Amsterdam").endOf("day").toUTC().toJSDate();
}

function amsterdamYmd(date: Date): string {
    return DateTime.fromJSDate(date).setZone("Europe/Amsterdam").toFormat("yyyy-MM-dd");
}

function prizeActionIdFromReference(reference: string | null): number | null {
    if (!reference?.startsWith("REVERSAL_PRIZE:")) return null;
    const id = Number(reference.split(":")[1]);
    return Number.isFinite(id) ? id : null;
}

async function expectedEndOfDayForReversal(reversalCreated: Date, reference: string | null): Promise<Date> {
    const prizeActionId = prizeActionIdFromReference(reference);
    if (prizeActionId) {
        const prize = await prisma.balanceAction.findUnique({
            where: { id: prizeActionId },
            select: { reference: true, created: true },
        });

        if (prize) {
            const raffleId = Number(prize.reference?.split(":")[1]);
            if (Number.isFinite(raffleId)) {
                const raffle = await prisma.raffle.findUnique({
                    where: { id: raffleId },
                    select: { created: true },
                });
                if (raffle) {
                    return endOfAmsterdamDay(raffle.created);
                }
            }
            return endOfAmsterdamDay(prize.created);
        }
    }

    // Orphan reversal: draw for day D-1 is saved on morning of day D.
    return DateTime.fromJSDate(reversalCreated)
        .setZone("Europe/Amsterdam")
        .minus({ days: 1 })
        .endOf("day")
        .toUTC()
        .toJSDate();
}

async function main() {
    const fromStart = DateTime.fromISO(FROM_DATE, { zone: "Europe/Amsterdam" })
        .startOf("day")
        .toUTC()
        .toJSDate();

    const reversals = await prisma.balanceAction.findMany({
        where: {
            type: "CORRECTION",
            reference: { startsWith: "REVERSAL_PRIZE:" },
            created: { gte: fromStart, lt: FIX_DEPLOYED },
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

    console.log(`Scanning ${reversals.length} pre-fix REVERSAL_PRIZE row(s) from ${FROM_DATE}...\n`);

    const toFix: Array<{
        id: number;
        userID: number;
        userName: string;
        amount: number;
        fromDay: string;
        toDay: string;
        newCreated: Date;
    }> = [];

    for (const rev of reversals) {
        const expectedCreated = await expectedEndOfDayForReversal(rev.created, rev.reference);
        if (Math.abs(rev.created.getTime() - expectedCreated.getTime()) < 1000) {
            continue;
        }

        toFix.push({
            id: rev.id,
            userID: rev.balance.user.id,
            userName: rev.balance.user.name,
            amount: rev.amount,
            fromDay: amsterdamYmd(rev.created),
            toDay: amsterdamYmd(expectedCreated),
            newCreated: expectedCreated,
        });
    }

    if (toFix.length === 0) {
        console.log("No misdated rows to fix.");
        return;
    }

    console.log(`Rows to fix: ${toFix.length}\n`);
    for (const row of toFix) {
        console.log(
            `  id=${row.id} ${row.userName} €${(row.amount / 100).toFixed(2)} ` +
                `${row.fromDay} -> ${row.toDay}`
        );
    }

    const affectedUserIDs = [...new Set(toFix.map((r) => r.userID))];
    console.log(`\nAffected users: ${affectedUserIDs.length}`);
    console.log(`Rebuild frozen chains from: ${REBUILD_FROM}`);

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
    console.log(`\nUpdated ${toFix.length} reversal row(s).`);

    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    for (const userID of affectedUserIDs) {
        await balanceService.refreshFrozenBalanceChainFromDay(userID, REBUILD_FROM);
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
    });
