/**
 * Reconcile PRIZE ledger rows with current winning numbers from a start date onward.
 * Fixes stale prize amounts after raffle corrections and reverses orphan prizes.
 *
 * Usage:
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register src/scripts/sync-prize-ledger-from-date.ts
 *   CONFIRM=YES DATABASE_URL=... npx ts-node -r tsconfig-paths/register src/scripts/sync-prize-ledger-from-date.ts
 *
 * Optional env:
 *   FROM_DATE=2026-07-06   (Amsterdam calendar day, inclusive)
 *   TO_DATE=2026-07-14     (inclusive; defaults to today in Amsterdam)
 */

import "reflect-metadata";
import { container } from "tsyringe";
import { DateTime } from "luxon";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";
import { RaffleService } from "../features/raffle/services/RaffleService";
import { createPrizeReference } from "../features/raffle/utils/prizeReference";
import { playedCodeMatchesWinningSuffixes } from "../features/raffle/utils/prizeMatching";
import { exitScript } from "./_scriptExit";

const CONFIRM = process.env.CONFIRM === "YES";
const FROM_DATE = process.env.FROM_DATE ?? "2026-07-06";
const TO_DATE =
    process.env.TO_DATE ??
    DateTime.now().setZone("Europe/Amsterdam").toFormat("yyyy-MM-dd");

container.registerInstance("Database", prisma);

interface MismatchRow {
    date: string;
    username: string;
    userID: number;
    reference: string;
    ledgerCents: number;
    expectedCents: number;
    kind: "amount" | "orphan";
}

async function buildWinningCodesByGame(dateYmd: string) {
    const amsterdamDate = DateTime.fromFormat(dateYmd, "yyyy-MM-dd", { zone: "Europe/Amsterdam" });
    const startOfDay = amsterdamDate.startOf("day").toUTC().toJSDate();
    const endOfDay = amsterdamDate.endOf("day").toUTC().toJSDate();

    const raffles = await prisma.raffle.findMany({
        where: { created: { gte: startOfDay, lte: endOfDay } },
        include: { codes: true },
    });

    const winningCodesByGame = new Map<
        number,
        { winningCodes: Array<{ code: string; order: number }>; raffleIDs: number[] }
    >();

    for (const raffle of raffles) {
        if (!winningCodesByGame.has(raffle.gameID)) {
            winningCodesByGame.set(raffle.gameID, { winningCodes: [], raffleIDs: [] });
        }
        const gameData = winningCodesByGame.get(raffle.gameID)!;
        if (!gameData.raffleIDs.includes(raffle.id)) {
            gameData.raffleIDs.push(raffle.id);
        }

        const codeToOrder = new Map<string, number>();
        for (const code of raffle.codes) {
            if (!codeToOrder.has(code.code)) {
                codeToOrder.set(code.code, codeToOrder.size + 1);
            }
            if (!gameData.winningCodes.some((wc) => wc.code === code.code)) {
                gameData.winningCodes.push({
                    code: code.code,
                    order: codeToOrder.get(code.code)!,
                });
            }
        }
    }

    return { winningCodesByGame, raffles };
}

async function detectMismatchesForDate(
    raffleService: RaffleService,
    dateYmd: string
): Promise<MismatchRow[]> {
    const { winningCodesByGame, raffles } = await buildWinningCodesByGame(dateYmd);
    if (raffles.length === 0) return [];

    const amsterdamDate = DateTime.fromFormat(dateYmd, "yyyy-MM-dd", { zone: "Europe/Amsterdam" });
    const startOfDay = amsterdamDate.startOf("day").toUTC().toJSDate();
    const endOfDay = amsterdamDate.endOf("day").toUTC().toJSDate();
    const raffleIds = raffles.map((r) => r.id);
    const mismatches: MismatchRow[] = [];

    const prizeActions = await prisma.balanceAction.findMany({
        where: {
            type: "PRIZE",
            OR: raffleIds.map((raffleId) => ({
                reference: { startsWith: `PRIZE:${raffleId}:` },
            })),
        },
        include: {
            balance: {
                select: {
                    userID: true,
                    user: { select: { username: true } },
                },
            },
        },
    });

    const ledgerByReference = new Map<string, { amount: number; userID: number; username: string }>();
    for (const action of prizeActions) {
        const ref = action.reference ?? "";
        const existing = ledgerByReference.get(ref);
        const amount = (existing?.amount ?? 0) + action.amount;
        ledgerByReference.set(ref, {
            amount,
            userID: action.balance.userID,
            username: action.balance.user.username,
        });
    }

    for (const [reference, ledger] of ledgerByReference) {
        const refParts = reference.split(":");
        if (refParts.length !== 4 || refParts[0] !== "PRIZE") continue;

        const raffleId = Number(refParts[1]);
        const ticketId = Number(refParts[2]);
        const playedCode = refParts[3];
        const raffle = raffles.find((r) => r.id === raffleId);
        if (!raffle) continue;

        const gameData = winningCodesByGame.get(raffle.gameID);
        if (!gameData) continue;

        const stillValid = await raffleService.isPrizeActionStillValid(
            { amount: ledger.amount, reference },
            raffle.gameID,
            gameData.winningCodes
        );

        if (!stillValid) {
            mismatches.push({
                date: dateYmd,
                username: ledger.username,
                userID: ledger.userID,
                reference,
                ledgerCents: ledger.amount,
                expectedCents: 0,
                kind: "orphan",
            });
            continue;
        }

        const ticket = await prisma.ticket.findUnique({
            where: { id: ticketId },
            include: { codes: { select: { code: true, value: true } } },
        });
        if (!ticket) continue;

        const matchingCodes = ticket.codes.filter((c) => c.code === playedCode);
        const totalStake = matchingCodes.reduce((sum, c) => sum + c.value, 0);
        const winningCodeStrings = gameData.winningCodes.map((wc) => wc.code);
        if (!playedCodeMatchesWinningSuffixes(playedCode, winningCodeStrings)) continue;

        const expectedPrize = raffleService.calculatePrizeAmount(
            playedCode,
            totalStake,
            raffle.gameID,
            gameData.winningCodes
        );
        const expectedCents = -expectedPrize;
        if (ledger.amount !== expectedCents) {
            mismatches.push({
                date: dateYmd,
                username: ledger.username,
                userID: ledger.userID,
                reference,
                ledgerCents: ledger.amount,
                expectedCents,
                kind: "amount",
            });
        }
    }

    // Expected prizes missing from ledger
    for (const [gameID, { winningCodes, raffleIDs }] of winningCodesByGame) {
        if (winningCodes.length === 0 || raffleIDs.length === 0) continue;

        const tickets = await prisma.ticket.findMany({
            where: {
                created: { gte: startOfDay, lte: endOfDay },
                games: { some: { gameID } },
            },
            include: {
                codes: { select: { id: true, code: true, value: true } },
                creator: { select: { id: true, username: true } },
            },
        });

        for (const ticket of tickets) {
            const codesByString = new Map<string, Array<{ id: number; code: string; value: number }>>();
            for (const ticketCode of ticket.codes) {
                const codeStr = ticketCode.code;
                if (!codesByString.has(codeStr)) codesByString.set(codeStr, []);
                codesByString.get(codeStr)!.push(ticketCode);
            }

            for (const [codeStr, codeInstances] of codesByString) {
                const orderedInstances = [...codeInstances].sort((a, b) => a.id - b.id);
                const winningCodeStrings = winningCodes.map((wc) => wc.code);
                if (!playedCodeMatchesWinningSuffixes(codeStr, winningCodeStrings)) continue;

                const totalStake = orderedInstances.reduce((sum, instance) => sum + instance.value, 0);
                const expectedPrize = raffleService.calculatePrizeAmount(
                    codeStr,
                    totalStake,
                    gameID,
                    winningCodes
                );
                if (expectedPrize <= 0) continue;

                const reference = createPrizeReference(raffleIDs[0], ticket.id, codeStr);
                const ledger = ledgerByReference.get(reference);
                const expectedCents = -expectedPrize;
                if (!ledger || ledger.amount !== expectedCents) {
                    mismatches.push({
                        date: dateYmd,
                        username: ticket.creator.username,
                        userID: ticket.creator.id,
                        reference,
                        ledgerCents: ledger?.amount ?? 0,
                        expectedCents,
                        kind: ledger ? "amount" : "amount",
                    });
                }
            }
        }
    }

    const deduped = new Map<string, MismatchRow>();
    for (const row of mismatches) {
        deduped.set(`${row.date}:${row.reference}`, row);
    }
    return [...deduped.values()];
}

function listDates(fromYmd: string, toYmd: string): string[] {
    const from = DateTime.fromFormat(fromYmd, "yyyy-MM-dd", { zone: "Europe/Amsterdam" });
    const to = DateTime.fromFormat(toYmd, "yyyy-MM-dd", { zone: "Europe/Amsterdam" });
    const dates: string[] = [];
    let cursor = from;
    while (cursor <= to) {
        dates.push(cursor.toFormat("yyyy-MM-dd"));
        cursor = cursor.plus({ days: 1 });
    }
    return dates;
}

async function main() {
    const raffleService = container.resolve(RaffleService);
    const balanceService = container.resolve(BalanceService);
    const dates = listDates(FROM_DATE, TO_DATE);

    console.log(`Scanning prize ledger mismatches from ${FROM_DATE} through ${TO_DATE}...`);

    const allMismatches: MismatchRow[] = [];
    for (const dateYmd of dates) {
        const dayMismatches = await detectMismatchesForDate(raffleService, dateYmd);
        if (dayMismatches.length > 0) {
            console.log(`\n${dateYmd}: ${dayMismatches.length} mismatch(es)`);
            for (const row of dayMismatches) {
                console.log(
                    `  [${row.kind}] ${row.username} ${row.reference}: ledger €${(Math.abs(row.ledgerCents) / 100).toFixed(2)} -> expected €${(Math.abs(row.expectedCents) / 100).toFixed(2)}`
                );
            }
            allMismatches.push(...dayMismatches);
        }
    }

    console.log(`\nTotal mismatches: ${allMismatches.length}`);

    if (!CONFIRM) {
        console.log("Dry run only. Set CONFIRM=YES to sync prize ledger and rebuild frozen balances.");
        return;
    }

    if (allMismatches.length === 0) {
        console.log("Nothing to sync.");
        return;
    }

    const affectedDates = [...new Set(allMismatches.map((m) => m.date))].sort();
    const affectedUsers = new Set<number>();

    for (const dateYmd of affectedDates) {
        console.log(`\nSyncing prize ledger for ${dateYmd}...`);
        await raffleService.syncPrizeLedgerForDate(
            DateTime.fromFormat(dateYmd, "yyyy-MM-dd", { zone: "Europe/Amsterdam" })
                .startOf("day")
                .toUTC()
                .toJSDate()
        );
        await balanceService.refreshFrozenBalancesForCalendarDay(dateYmd);

        for (const row of allMismatches.filter((m) => m.date === dateYmd)) {
            affectedUsers.add(row.userID);
        }
    }

    for (const userID of affectedUsers) {
        await balanceService.refreshFrozenBalanceChainFromDay(userID, FROM_DATE);
    }

    console.log(`\nSynced ${affectedDates.length} day(s), refreshed frozen chains for ${affectedUsers.size} user(s).`);

    console.log("\nPost-sync verification:");
    for (const dateYmd of affectedDates) {
        const remaining = await detectMismatchesForDate(raffleService, dateYmd);
        if (remaining.length > 0) {
            console.log(`  ${dateYmd}: ${remaining.length} mismatch(es) still remain`);
        } else {
            console.log(`  ${dateYmd}: OK`);
        }
    }
}

main()
    .then(() => exitScript(0))
    .catch(async (e) => {
        console.error(e);
        await exitScript(1);
    });
