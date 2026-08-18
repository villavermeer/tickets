/**
 * Remove ledger noise from deleted tickets:
 * - REVERSAL_TICKET_SALE corrections (shown as "Ticket verwijderd")
 * - matching TICKET_SALE rows for tickets that no longer exist
 * - related TICKET_SALE_ADJUST rows for those tickets
 *
 * Then recalculate balances.balance and rebuild frozen chains for affected users.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/cleanup-ticket-sale-reversals.ts
 *   CONFIRM=YES npx ts-node -r tsconfig-paths/register src/scripts/cleanup-ticket-sale-reversals.ts
 */

import "reflect-metadata";
import { DateTime } from "luxon";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const CONFIRM = process.env.CONFIRM === "YES";
const REBUILD_FROM = process.env.REBUILD_FROM ?? "2026-06-27";

function saleActionIdFromReversalRef(reference: string | null): number | null {
    if (!reference?.startsWith("REVERSAL_TICKET_SALE:")) return null;
    const id = Number(reference.split(":")[1]);
    return Number.isFinite(id) ? id : null;
}

function ticketIdFromSaleRef(reference: string | null): number | null {
    if (!reference?.startsWith("TICKET_SALE:")) return null;
    const id = Number(reference.split(":")[1]);
    return Number.isFinite(id) ? id : null;
}

async function main() {
    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    const reversals = await prisma.balanceAction.findMany({
        where: {
            type: "CORRECTION",
            reference: { startsWith: "REVERSAL_TICKET_SALE:" },
        },
        orderBy: { id: "asc" },
        include: { balance: { select: { userID: true } } },
    });

    console.log(`Found ${reversals.length} REVERSAL_TICKET_SALE row(s)`);
    if (reversals.length === 0) {
        await prisma.$disconnect();
        return;
    }

    const saleIds = reversals
        .map((r) => saleActionIdFromReversalRef(r.reference))
        .filter((id): id is number => id !== null);

    const sales = await prisma.balanceAction.findMany({
        where: { id: { in: saleIds } },
    });
    const saleById = new Map(sales.map((s) => [s.id, s]));

    const ticketIds: number[] = [];
    const idsToDelete = new Set<number>();
    const affectedUserIDs = new Set<number>();
    let skippedTicketStillExists = 0;
    let missingSale = 0;

    for (const rev of reversals) {
        const saleId = saleActionIdFromReversalRef(rev.reference);
        if (!saleId) continue;

        const sale = saleById.get(saleId);
        if (!sale) {
            // Orphan reversal — still remove it
            idsToDelete.add(rev.id);
            affectedUserIDs.add(rev.balance.userID);
            missingSale++;
            continue;
        }

        const ticketId = ticketIdFromSaleRef(sale.reference);
        if (ticketId !== null) {
            const ticket = await prisma.ticket.findUnique({
                where: { id: ticketId },
                select: { id: true },
            });
            if (ticket) {
                skippedTicketStillExists++;
                continue;
            }
            ticketIds.push(ticketId);
        }

        idsToDelete.add(rev.id);
        idsToDelete.add(sale.id);
        affectedUserIDs.add(rev.balance.userID);
    }

    const uniqueTicketIds = [...new Set(ticketIds)];
    const adjusts =
        uniqueTicketIds.length === 0
            ? []
            : await prisma.balanceAction.findMany({
                  where: {
                      OR: uniqueTicketIds.map((id) => ({
                          reference: { startsWith: `TICKET_SALE_ADJUST:${id}:` },
                      })),
                  },
                  include: { balance: { select: { userID: true } } },
              });

    for (const adj of adjusts) {
        idsToDelete.add(adj.id);
        affectedUserIDs.add(adj.balance.userID);
    }

    const deleteIds = [...idsToDelete];
    const preview = await prisma.balanceAction.findMany({
        where: { id: { in: deleteIds } },
        select: { id: true, type: true, amount: true, reference: true, balanceID: true },
    });
    const netAmount = preview.reduce((s, a) => s + a.amount, 0);

    console.log(`Will delete ${deleteIds.length} balance_action row(s)`);
    console.log(`  reversals+sales for deleted tickets`);
    console.log(`  TICKET_SALE_ADJUST rows: ${adjusts.length}`);
    console.log(`  skipped (ticket still exists): ${skippedTicketStillExists}`);
    console.log(`  orphan reversals (sale missing): ${missingSale}`);
    console.log(`  affected users: ${affectedUserIDs.size}`);
    console.log(`  net amount of rows to delete (should be ~adjust leftovers): ${netAmount}`);

    if (!CONFIRM) {
        console.log("\nDry run only. Re-run with CONFIRM=YES to apply.");
        await prisma.$disconnect();
        return;
    }

    const deleted = await prisma.balanceAction.deleteMany({
        where: { id: { in: deleteIds } },
    });
    console.log(`Deleted ${deleted.count} row(s)`);

    // Recalculate balances.balance from remaining ledger for affected users
    const balances = await prisma.balance.findMany({
        where: { userID: { in: [...affectedUserIDs] } },
        select: { id: true, userID: true },
    });

    for (const b of balances) {
        const sum = await prisma.balanceAction.aggregate({
            where: { balanceID: b.id },
            _sum: { amount: true },
        });
        await prisma.balance.update({
            where: { id: b.id },
            data: { balance: sum._sum.amount ?? 0 },
        });
    }
    console.log(`Recalculated balances.balance for ${balances.length} user(s)`);

    const from = DateTime.fromFormat(REBUILD_FROM, "yyyy-MM-dd", { zone: "Europe/Amsterdam" });
    if (!from.isValid) {
        throw new Error(`Invalid REBUILD_FROM: ${REBUILD_FROM}`);
    }

    console.log(`Rebuilding frozen chains from ${REBUILD_FROM} for ${affectedUserIDs.size} user(s)...`);
    for (const userID of affectedUserIDs) {
        await balanceService.refreshFrozenBalanceChainFromDay(userID, REBUILD_FROM, { overwriteSealed: true });
        console.log(`  user ${userID} done`);
    }

    console.log("Done.");
    await prisma.$disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
});
