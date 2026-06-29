/**
 * Purge tickets, codes, raffles, balance actions and frozen balances on or before a cutoff day.
 * Keeps data from the first Amsterdam calendar day AFTER the cutoff (default: from 27 juni 2026).
 *
 * Usage:
 *   # Preview counts only
 *   CUTOFF_YMD=2026-06-26 npx ts-node -r tsconfig-paths/register src/scripts/purge-data-before-date.ts
 *
 *   # Execute (requires CONFIRM=YES)
 *   CUTOFF_YMD=2026-06-26 CONFIRM=YES npx ts-node -r tsconfig-paths/register src/scripts/purge-data-before-date.ts
 *
 * CUTOFF_YMD=2026-06-26 means: delete everything on 26 juni and earlier; keep from 27 juni.
 */

import "reflect-metadata";
import { DateTime } from "luxon";
import { Prisma } from "@prisma/client";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const CUTOFF_YMD = process.env.CUTOFF_YMD ?? "2026-06-26";
const CONFIRM = process.env.CONFIRM === "YES";
const KEEP_FROM_YMD = DateTime.fromFormat(CUTOFF_YMD, "yyyy-MM-dd", { zone: "Europe/Amsterdam" })
    .plus({ days: 1 })
    .toFormat("yyyy-MM-dd");

function cutoffUtc(): Date {
    return DateTime.fromFormat(CUTOFF_YMD, "yyyy-MM-dd", { zone: "Europe/Amsterdam" })
        .endOf("day")
        .toUTC()
        .toJSDate();
}

function keepFromUtc(): Date {
    return DateTime.fromFormat(KEEP_FROM_YMD, "yyyy-MM-dd", { zone: "Europe/Amsterdam" })
        .startOf("day")
        .toUTC()
        .toJSDate();
}

async function countPreview(cutoff: Date, keepFrom: Date) {
    const ticketDateFilter = Prisma.sql`
        (timezone('Europe/Amsterdam', t.created))::date <= CAST(${CUTOFF_YMD} AS DATE)
    `;
    const raffleDateFilter = Prisma.sql`
        (timezone('Europe/Amsterdam', r.created))::date <= CAST(${CUTOFF_YMD} AS DATE)
    `;

    const [tickets] = await prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint as count FROM tickets t WHERE ${ticketDateFilter}
    `);
    const [codesOnTickets] = await prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint as count FROM codes c
        JOIN tickets t ON t.id = c."ticketID"
        WHERE ${ticketDateFilter}
    `);
    const [raffles] = await prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint as count FROM raffles r WHERE ${raffleDateFilter}
    `);
    const [codesOnRaffles] = await prisma.$queryRaw<[{ count: bigint }]>(Prisma.sql`
        SELECT COUNT(*)::bigint as count FROM codes c
        JOIN raffles r ON r.id = c."raffleID"
        WHERE c."ticketID" IS NULL AND ${raffleDateFilter}
    `);
    const balanceActions = await prisma.balanceAction.count({
        where: { created: { lte: cutoff } },
    });
    const prizes = await prisma.balanceAction.count({
        where: { created: { lte: cutoff }, type: "PRIZE" },
    });
    const frozen = await prisma.frozenBalance.count({
        where: { date: { lt: keepFrom } },
    });
    const relayBatches = await prisma.relayBatch.count({
        where: { end: { lte: cutoff } },
    });

    return {
        tickets: Number(tickets.count),
        codesOnTickets: Number(codesOnTickets.count),
        raffles: Number(raffles.count),
        codesOnRaffles: Number(codesOnRaffles.count),
        balanceActions,
        prizes,
        frozen,
        relayBatches,
    };
}

async function purge(cutoff: Date, keepFrom: Date) {
    const ticketDateFilter = Prisma.sql`
        (timezone('Europe/Amsterdam', t.created))::date <= CAST(${CUTOFF_YMD} AS DATE)
    `;
    const raffleDateFilter = Prisma.sql`
        (timezone('Europe/Amsterdam', r.created))::date <= CAST(${CUTOFF_YMD} AS DATE)
    `;

    // 1. Balance ledger rows (includes PRIZE, TICKET_SALE, PROVISION, CORRECTION, PAYOUT)
    const deletedActions = await prisma.balanceAction.deleteMany({
        where: { created: { lte: cutoff } },
    });
    console.log(`  balance_actions deleted: ${deletedActions.count} (incl. prizes)`);

    // 2. Frozen snapshots on or before cutoff day
    const deletedFrozen = await prisma.frozenBalance.deleteMany({
        where: { date: { lt: keepFrom } },
    });
    console.log(`  frozen_balances deleted: ${deletedFrozen.count}`);

    // 3. Ticket games for old tickets
    const deletedTicketGames = await prisma.$executeRaw(Prisma.sql`
        DELETE FROM ticket_games tg
        USING tickets t
        WHERE tg."ticketID" = t.id AND ${ticketDateFilter}
    `);
    console.log(`  ticket_games deleted: ${deletedTicketGames}`);

    // 4. Codes on old tickets
    const deletedTicketCodes = await prisma.$executeRaw(Prisma.sql`
        DELETE FROM codes c
        USING tickets t
        WHERE c."ticketID" = t.id AND ${ticketDateFilter}
    `);
    console.log(`  ticket codes deleted: ${deletedTicketCodes}`);

    // 5. Old tickets
    const deletedTickets = await prisma.$executeRaw(Prisma.sql`
        DELETE FROM tickets t WHERE ${ticketDateFilter}
    `);
    console.log(`  tickets deleted: ${deletedTickets}`);

    // 6. Raffle-only codes (winning numbers)
    const deletedRaffleCodes = await prisma.$executeRaw(Prisma.sql`
        DELETE FROM codes c
        USING raffles r
        WHERE c."raffleID" = r.id AND c."ticketID" IS NULL AND ${raffleDateFilter}
    `);
    console.log(`  raffle codes deleted: ${deletedRaffleCodes}`);

    // 7. Old raffles
    const deletedRaffles = await prisma.$executeRaw(Prisma.sql`
        DELETE FROM raffles r WHERE ${raffleDateFilter}
    `);
    console.log(`  raffles deleted: ${deletedRaffles}`);

    // 8. Old relay batches (and any remaining codes pointing at them)
    await prisma.code.updateMany({
        where: { relayBatch: { end: { lte: cutoff } } },
        data: { relayBatchID: null, relayed: null },
    });
    const deletedRelayBatches = await prisma.relayBatch.deleteMany({
        where: { end: { lte: cutoff } },
    });
    console.log(`  relay_batches deleted: ${deletedRelayBatches.count}`);

    // 9. Recalculate balances.balance from remaining ledger
    const sums = await prisma.balanceAction.groupBy({
        by: ["balanceID"],
        _sum: { amount: true },
    });
    const balanceIds = await prisma.balance.findMany({ select: { id: true, userID: true } });
    const sumByBalance = new Map(sums.map((s) => [s.balanceID, s._sum.amount ?? 0]));

    let balancesReset = 0;
    for (const b of balanceIds) {
        const total = sumByBalance.get(b.id) ?? 0;
        await prisma.balance.update({
            where: { id: b.id },
            data: { balance: total },
        });
        balancesReset++;
    }
    console.log(`  balances.balance reset for ${balancesReset} user(s)`);

    // 10. Rebuild frozen chain from first kept day through today
    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);
    const users = await prisma.balance.findMany({ select: { userID: true } });
    for (const { userID } of users) {
        await balanceService.refreshFrozenBalanceChainFromDay(userID, KEEP_FROM_YMD);
    }
    console.log(`  frozen_balances rebuilt from ${KEEP_FROM_YMD} for ${users.length} user(s)`);
}

async function main() {
    const cutoff = cutoffUtc();
    const keepFrom = keepFromUtc();

    console.log("=== Purge data on or before cutoff ===\n");
    console.log(`Cutoff (delete through): ${CUTOFF_YMD} (Amsterdam, end of day)`);
    console.log(`Keep from:               ${KEEP_FROM_YMD} 00:00 Amsterdam`);
    console.log(`Cutoff UTC:              ${cutoff.toISOString()}`);
    console.log(`Mode:                    ${CONFIRM ? "EXECUTE" : "DRY RUN"}\n`);

    const counts = await countPreview(cutoff, keepFrom);
    console.log("Rows to delete:");
    console.log(`  tickets:              ${counts.tickets}`);
    console.log(`  codes (on tickets):   ${counts.codesOnTickets}`);
    console.log(`  raffles:              ${counts.raffles}`);
    console.log(`  codes (on raffles):   ${counts.codesOnRaffles}`);
    console.log(`  balance_actions:      ${counts.balanceActions} (prizes: ${counts.prizes})`);
    console.log(`  frozen_balances:      ${counts.frozen}`);
    console.log(`  relay_batches:        ${counts.relayBatches}`);

    if (!CONFIRM) {
        console.log("\nDry run only. Set CONFIRM=YES to execute.");
        return;
    }

    console.log("\nExecuting purge...\n");
    await purge(cutoff, keepFrom);
    console.log("\nDone.");
}

main()
    .catch((e) => {
        console.error("Fatal error:", e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
