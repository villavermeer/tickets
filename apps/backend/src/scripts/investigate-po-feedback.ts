/**
 * Investigate PO feedback: Mica inleg, Violeta prizes/corrections, Juni reversals.
 *
 * Usage:
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register src/scripts/investigate-po-feedback.ts
 *   CONFIRM=YES ... (to remove false-positive reversals)
 */

import "reflect-metadata";
import { DateTime } from "luxon";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";
import { RaffleService } from "../features/raffle/services/RaffleService";

const CONFIRM = process.env.CONFIRM === "YES";

async function checkReversal(
    raffleService: RaffleService,
    prizeActionId: number
): Promise<{ prizeActionId: number; stillValid: boolean; reversalId: number | null }> {
    const prize = await prisma.balanceAction.findUnique({ where: { id: prizeActionId } });
    const rev = await prisma.balanceAction.findFirst({
        where: { reference: `REVERSAL_PRIZE:${prizeActionId}` },
    });

    if (!prize?.reference?.startsWith("PRIZE:")) {
        return { prizeActionId, stillValid: false, reversalId: rev?.id ?? null };
    }

    const raffleId = Number(prize.reference.split(":")[1]);
    const raffle = await prisma.raffle.findUnique({
        where: { id: raffleId },
        include: { codes: true },
    });
    if (!raffle) {
        return { prizeActionId, stillValid: false, reversalId: rev?.id ?? null };
    }

    const amsterdamDate = DateTime.fromJSDate(raffle.created).setZone("Europe/Amsterdam");
    const startOfDay = amsterdamDate.startOf("day").toUTC().toJSDate();
    const endOfDay = amsterdamDate.endOf("day").toUTC().toJSDate();
    const dayRaffles = await prisma.raffle.findMany({
        where: { created: { gte: startOfDay, lte: endOfDay }, gameID: raffle.gameID },
        include: { codes: true },
    });

    const winningCodes: Array<{ code: string; order: number }> = [];
    const codeToOrder = new Map<string, number>();
    for (const r of dayRaffles) {
        for (const code of r.codes) {
            if (!codeToOrder.has(code.code)) {
                codeToOrder.set(code.code, codeToOrder.size + 1);
            }
            if (!winningCodes.some((wc) => wc.code === code.code)) {
                winningCodes.push({ code: code.code, order: codeToOrder.get(code.code)! });
            }
        }
    }

    const stillValid = await raffleService.isPrizeActionStillValid(
        prize,
        raffle.gameID,
        winningCodes
    );

    console.log(
        `  prize ${prizeActionId} €${(prize.amount / 100).toFixed(2)} ${prize.reference}`,
        stillValid ? "=> FALSE REVERSAL (prize still valid)" : "=> reversal OK",
        rev ? `reversal id ${rev.id}` : "no reversal row"
    );

    return { prizeActionId, stillValid, reversalId: rev?.id ?? null };
}

async function main() {
    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);
    const raffleService = container.resolve(RaffleService);

    console.log("=== 1. Mica 8 juli inleg ===");
    const mica = await prisma.user.findFirst({ where: { username: "mica" } });
    if (mica) {
        const totals = await balanceService.getBalanceDayTotals(mica.id, "2026-07-08");
        const start = DateTime.fromFormat("2026-07-08", "yyyy-MM-dd", { zone: "Europe/Amsterdam" })
            .startOf("day")
            .toUTC()
            .toJSDate();
        const end = DateTime.fromFormat("2026-07-08", "yyyy-MM-dd", { zone: "Europe/Amsterdam" })
            .plus({ days: 1 })
            .startOf("day")
            .toUTC()
            .toJSDate();

        const tickets = await prisma.ticket.findMany({
            where: { creatorID: mica.id, created: { gte: start, lt: end } },
            include: { codes: true, games: true },
        });
        let gross = 0;
        for (const t of tickets) {
            gross += t.codes.reduce((s, c) => s + c.value, 0) * Math.max(t.games.length, 1);
        }

        const t540 = await prisma.ticket.findUnique({ where: { id: 169540 } });
        console.log(`  Saldo inleg (ledger):     €${(totals.ticketSale / 100).toFixed(2)}`);
        console.log(`  Loper overzicht (bruto):  €${(gross / 100).toFixed(2)}`);
        console.log(`  Verschil:                 €${((totals.ticketSale - gross) / 100).toFixed(2)}`);
        if (t540) {
            console.log(
                `  Ticket 169540 created: ${DateTime.fromJSDate(t540.created)
                    .setZone("Europe/Amsterdam")
                    .toFormat("yyyy-MM-dd HH:mm")}`
            );
        }
        console.log("  Oorzaak: saldo telt ledger (incl. aanpassingen); loper-overzicht telt ticket-bruto op aanmaakdatum.");
    }

    console.log("\n=== 2. Violeta 7 juli ===");
    const falseReversalIds: number[] = [];
    const violeta = await prisma.user.findFirst({ where: { username: "violeta" } });
    if (violeta) {
        const totals = await balanceService.getBalanceDayTotals(violeta.id, "2026-07-07");
        const dayStart = DateTime.fromFormat("2026-07-07", "yyyy-MM-dd", { zone: "Europe/Amsterdam" })
            .startOf("day")
            .toUTC()
            .toJSDate();
        const dayEnd = DateTime.fromFormat("2026-07-08", "yyyy-MM-dd", { zone: "Europe/Amsterdam" })
            .startOf("day")
            .toUTC()
            .toJSDate();

        const corrections = await prisma.balanceAction.findMany({
            where: {
                balance: { userID: violeta.id },
                type: "CORRECTION",
                created: { gte: dayStart, lt: dayEnd },
            },
        });
        console.log(`  Saldo prijzen:     €${Math.abs(totals.prize / 100).toFixed(2)}`);
        console.log(`  Saldo correcties:  €${(totals.correction / 100).toFixed(2)}`);
        for (const c of corrections) {
            console.log(`    correctie €${(c.amount / 100).toFixed(2)} — ${c.reference}`);
        }
        console.log("  Oorzaak correcties: automatische REVERSAL_* van het systeem, geen handmatige invoer.");

        console.log("\n  Reversal check Violeta:");
        const violetaChecks = await Promise.all([
            checkReversal(raffleService, 360601),
            checkReversal(raffleService, 360604),
        ]);
        for (const result of violetaChecks) {
            if (result.stillValid && result.reversalId) {
                falseReversalIds.push(result.reversalId);
            }
        }
    }

    console.log("\n=== 3. Juni 7+8 juli correcties ===");
    const juni = await prisma.user.findFirst({ where: { username: "juni" } });
    if (juni) {
        for (const prizeId of [360597, 360598, 361940]) {
            const result = await checkReversal(raffleService, prizeId);
            if (result.stillValid && result.reversalId) {
                falseReversalIds.push(result.reversalId);
            }
        }
    }

    console.log(`\n=== False reversals to remove: ${falseReversalIds.length} ===`);
    console.log(falseReversalIds.join(", ") || "(none)");

    if (falseReversalIds.length > 0 && CONFIRM) {
        const affectedRows = await prisma.balanceAction.findMany({
            where: { id: { in: falseReversalIds } },
            select: { balanceID: true },
        });
        const balanceIds = [...new Set(affectedRows.map((b) => b.balanceID))];

        await prisma.balanceAction.deleteMany({ where: { id: { in: falseReversalIds } } });

        for (const balanceID of balanceIds) {
            const sum = await prisma.balanceAction.aggregate({
                where: { balanceID },
                _sum: { amount: true },
            });
            await prisma.balance.update({
                where: { id: balanceID },
                data: { balance: sum._sum.amount ?? 0 },
            });
            const bal = await prisma.balance.findUnique({ where: { id: balanceID } });
            if (bal) {
                await balanceService.refreshFrozenBalanceChainFromDay(bal.userID, "2026-07-06");
            }
        }
        console.log(`Removed ${falseReversalIds.length} false reversal(s) and rebuilt frozen chains.`);
    } else if (falseReversalIds.length > 0) {
        console.log("Dry run. Set CONFIRM=YES to remove false reversals.");
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
