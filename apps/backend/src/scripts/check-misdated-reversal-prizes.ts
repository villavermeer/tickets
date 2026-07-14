/**
 * Find REVERSAL_PRIZE rows from a given date where `created` does not match
 * the raffle business day (endOfDay Amsterdam) of the original prize.
 *
 * Run:
 *   cd apps/backend && npx ts-node -r tsconfig-paths/register src/scripts/check-misdated-reversal-prizes.ts
 */

import "reflect-metadata";
import { DateTime } from "luxon";
import prisma from "../common/utils/prisma";

const FROM_DATE = "2026-07-06"; // Amsterdam calendar date

function endOfAmsterdamDay(date: Date): Date {
    return DateTime.fromJSDate(date).setZone("Europe/Amsterdam").endOf("day").toUTC().toJSDate();
}

function amsterdamYmd(date: Date): string {
    return DateTime.fromJSDate(date).setZone("Europe/Amsterdam").toFormat("yyyy-MM-dd");
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
            OR: [
                { created: { gte: fromStart } },
                { updated: { gte: fromStart } },
            ],
        },
        orderBy: { id: "asc" },
        include: {
            balance: {
                include: {
                    user: { select: { id: true, name: true, username: true } },
                },
            },
        },
    });

    console.log(`Checking ${reversals.length} REVERSAL_PRIZE row(s) from ${FROM_DATE} onwards...\n`);

    const misdated: Array<{
        reversalId: number;
        user: string;
        amount: number;
        reversalCreated: string;
        reversalUpdated: string;
        expectedDay: string;
        actualDay: string;
        prizeActionId: number;
        raffleId: number | null;
        reason: string;
    }> = [];

    for (const rev of reversals) {
        const prizeActionId = Number(rev.reference?.replace("REVERSAL_PRIZE:", ""));
        if (!Number.isFinite(prizeActionId)) {
            misdated.push({
                reversalId: rev.id,
                user: rev.balance.user.name,
                amount: rev.amount,
                reversalCreated: rev.created.toISOString(),
                reversalUpdated: rev.updated.toISOString(),
                expectedDay: "?",
                actualDay: amsterdamYmd(rev.created),
                prizeActionId: -1,
                raffleId: null,
                reason: "invalid reference",
            });
            continue;
        }

        const prize = await prisma.balanceAction.findUnique({
            where: { id: prizeActionId },
            select: { id: true, reference: true, created: true },
        });

        if (!prize) {
            // Orphan: original prize removed — only flag if not backdated to end-of-day.
            const atEndOfDay =
                Math.abs(rev.created.getTime() - endOfAmsterdamDay(rev.created).getTime()) < 1000;
            if (!atEndOfDay) {
                misdated.push({
                    reversalId: rev.id,
                    user: rev.balance.user.name,
                    amount: rev.amount,
                    reversalCreated: rev.created.toISOString(),
                    reversalUpdated: rev.updated.toISOString(),
                    expectedDay: "?",
                    actualDay: amsterdamYmd(rev.created),
                    prizeActionId,
                    raffleId: null,
                    reason: "original prize action not found and not at end-of-day",
                });
            }
            continue;
        }

        const refParts = prize.reference?.split(":");
        const raffleId =
            refParts?.length === 4 && refParts[0] === "PRIZE"
                ? Number(refParts[1])
                : null;

        let expectedEndOfDay: Date | null = null;

        if (raffleId) {
            const raffle = await prisma.raffle.findUnique({
                where: { id: raffleId },
                select: { id: true, created: true },
            });
            if (raffle) {
                expectedEndOfDay = endOfAmsterdamDay(raffle.created);
            }
        }

        if (!expectedEndOfDay) {
            // Fallback: use original prize created date
            expectedEndOfDay = endOfAmsterdamDay(prize.created);
        }

        const expectedDay = amsterdamYmd(expectedEndOfDay);
        const actualDay = amsterdamYmd(rev.created);
        const createdMatches =
            Math.abs(rev.created.getTime() - expectedEndOfDay.getTime()) < 1000;

        if (!createdMatches) {
            misdated.push({
                reversalId: rev.id,
                user: rev.balance.user.name,
                amount: rev.amount,
                reversalCreated: rev.created.toISOString(),
                reversalUpdated: rev.updated.toISOString(),
                expectedDay,
                actualDay,
                prizeActionId,
                raffleId,
                reason:
                    actualDay < expectedDay
                        ? "reversal on earlier day than raffle"
                        : actualDay > expectedDay
                          ? "reversal on later day than raffle (likely saved with current timestamp)"
                          : "timestamp mismatch within same calendar day",
            });
        }
    }

    if (misdated.length === 0) {
        console.log("No misdated REVERSAL_PRIZE rows found.");
        return;
    }

    console.log(`Found ${misdated.length} misdated REVERSAL_PRIZE row(s):\n`);
    console.log(
        [
            "reversal_id",
            "user",
            "amount_eur",
            "expected_day",
            "actual_day",
            "prize_action_id",
            "raffle_id",
            "reason",
            "created_utc",
            "updated_utc",
        ].join("\t")
    );

    for (const row of misdated) {
        console.log(
            [
                row.reversalId,
                row.user,
                (row.amount / 100).toFixed(2),
                row.expectedDay,
                row.actualDay,
                row.prizeActionId,
                row.raffleId ?? "",
                row.reason,
                row.reversalCreated,
                row.reversalUpdated,
            ].join("\t")
        );
    }

    const totalCents = misdated.reduce((s, r) => s + r.amount, 0);
    console.log(`\nTotal misdated reversal amount: €${(totalCents / 100).toFixed(2)}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
