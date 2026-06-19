/**
 * Read-only balance page verification against real production data.
 *
 * Run:
 *   cd apps/backend && npx ts-node -r tsconfig-paths/register src/scripts/test-balance-day-scenarios.ts
 */
import "reflect-metadata";
import { BalanceActionType } from "@prisma/client";
import { DateTime } from "luxon";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService, BalanceDayTotalsResult } from "../features/balance/services/BalanceService";

let passed = 0;
let failed = 0;

function pass(name: string) {
    passed++;
    console.log(`[PASS] ${name}`);
}

function fail(name: string, detail: string) {
    failed++;
    console.log(`[FAIL] ${name}`);
    console.log(`       ${detail}`);
}

function checkTotals(label: string, dayKey: string, t: BalanceDayTotalsResult) {
    const manual = t.opening + t.ticketSale + t.correction + t.payout + t.prize + t.provision;
    if (manual !== t.closing) {
        fail(label, `${dayKey}: rows sum ${manual} != closing ${t.closing}`);
        return false;
    }
    if (t.dayNet !== t.ticketSale + t.correction + t.payout + t.prize + t.provision) {
        fail(label, `${dayKey}: dayNet mismatch`);
        return false;
    }
    pass(label);
    return true;
}

async function main() {
    console.log("=== Balance Day Scenario Tests (read-only) ===\n");

    container.registerInstance("Database", prisma);
    const service = container.resolve(BalanceService);

    // ── 1. All users with activity in last 14 days ───────────────────────────
    const since = DateTime.now().setZone("Europe/Amsterdam").minus({ days: 90 }).startOf("day").toUTC().toJSDate();
    const activeUsers = await prisma.$queryRaw<Array<{ id: number; name: string }>>`
        SELECT DISTINCT u.id, u.name
        FROM users u
        JOIN balances b ON b."userID" = u.id
        JOIN balance_actions ba ON ba."balanceID" = b.id
        WHERE ba.created >= ${since}
        ORDER BY u.name
        LIMIT 5
    `;

    console.log(`Checking ${activeUsers.length} active users (1 day each)...\n`);

    for (const u of activeUsers) {
        const dayKey = DateTime.now().setZone("Europe/Amsterdam").minus({ days: 2 }).toFormat("yyyy-MM-dd");
        const t = await service.getBalanceDayTotals(u.id, dayKey);
        checkTotals(`${u.name} formula ${dayKey}`, dayKey, t);
    }

    // ── 2. Relayed ticket sale (sale created ≠ ticket business day) ───────────
    console.log("\n--- Relayed ticket sales ---");
    const relays = await prisma.$queryRaw<
        Array<{ user_id: number; name: string; ticket_id: number; ticket_day: string; sale_day: string }>
    >`
        SELECT u.id as user_id, u.name, t.id as ticket_id,
            (timezone('Europe/Amsterdam', t.created))::date::text as ticket_day,
            (timezone('Europe/Amsterdam', ba.created))::date::text as sale_day
        FROM balance_actions ba
        JOIN balances b ON ba."balanceID" = b.id
        JOIN users u ON u.id = b."userID"
        JOIN tickets t ON ba.reference = 'TICKET_SALE:' || t.id::text
        WHERE ba.type = 'TICKET_SALE'
        AND (timezone('Europe/Amsterdam', t.created))::date
            <> (timezone('Europe/Amsterdam', ba.created))::date
        ORDER BY ba.created DESC
        LIMIT 15
    `;

    if (relays.length === 0) {
        console.log("(no relayed sales in DB — covered by test-balance-day-continuity.ts)");
    }

    for (const r of relays) {
        const ticketDay = r.ticket_day.slice(0, 10);
        const saleDay = r.sale_day.slice(0, 10);
        const onTicketDay = await service.getBalanceDayTotals(r.user_id, ticketDay);
        const onSaleDay = await service.getBalanceDayTotals(r.user_id, saleDay);

        if (onTicketDay.ticketSale > 0) {
            pass(`relay ${r.name}: inleg on ticket day ${ticketDay}`);
        } else {
            fail(`relay ${r.name}: inleg on ticket day ${ticketDay}`, "ticketSale is 0");
        }
        checkTotals(`relay ${r.name} ticket day ${ticketDay}`, ticketDay, onTicketDay);
        checkTotals(`relay ${r.name} sale day ${saleDay}`, saleDay, onSaleDay);
    }

    // ── 3. Ticket adjustments (TICKET_SALE_ADJUST) ───────────────────────────
    console.log("\n--- Ticket adjustments ---");
    const adjusts = await prisma.$queryRaw<
        Array<{ user_id: number; name: string; ticket_id: number; ticket_day: string; adjust_day: string; amount: number }>
    >`
        SELECT u.id as user_id, u.name,
            CAST(split_part(ba.reference, ':', 2) AS INT) as ticket_id,
            (timezone('Europe/Amsterdam', t.created))::date::text as ticket_day,
            (timezone('Europe/Amsterdam', ba.created))::date::text as adjust_day,
            ba.amount
        FROM balance_actions ba
        JOIN balances b ON ba."balanceID" = b.id
        JOIN users u ON u.id = b."userID"
        JOIN tickets t ON t.id = CAST(split_part(ba.reference, ':', 2) AS INT)
        WHERE ba.reference LIKE 'TICKET_SALE_ADJUST:%'
        ORDER BY ba.created DESC
        LIMIT 8
    `;

    for (const a of adjusts) {
        const ticketDay = a.ticket_day.slice(0, 10);
        const adjustDay = a.adjust_day.slice(0, 10);
        const onTicketDay = await service.getBalanceDayTotals(a.user_id, ticketDay);
        checkTotals(`adjust ${a.name} ticket day ${ticketDay}`, ticketDay, onTicketDay);

        if (ticketDay !== adjustDay) {
            const onAdjustDay = await service.getBalanceDayTotals(a.user_id, adjustDay);
            if (onAdjustDay.ticketSale === 0) {
                pass(`adjust ${a.name}: no inleg on adjust-created day ${adjustDay}`);
            } else {
                fail(
                    `adjust ${a.name}: inleg on adjust day ${adjustDay}`,
                    `ticketSale=${onAdjustDay.ticketSale} (should be 0)`
                );
            }
        }
    }

    // ── 4. Prizes ─────────────────────────────────────────────────────────────
    console.log("\n--- Prizes ---");
    const prizes = await prisma.$queryRaw<
        Array<{ user_id: number; name: string; ticket_id: number; ticket_day: string; prize_day: string; amount: number }>
    >`
        SELECT u.id as user_id, u.name,
            CAST(split_part(ba.reference, ':', 3) AS INT) as ticket_id,
            (timezone('Europe/Amsterdam', t.created))::date::text as ticket_day,
            (timezone('Europe/Amsterdam', ba.created))::date::text as prize_day,
            ba.amount
        FROM balance_actions ba
        JOIN balances b ON ba."balanceID" = b.id
        JOIN users u ON u.id = b."userID"
        JOIN tickets t ON t.id = CAST(split_part(ba.reference, ':', 3) AS INT)
        WHERE ba.type = 'PRIZE' AND ba.reference LIKE 'PRIZE:%'
        ORDER BY ba.created DESC
        LIMIT 8
    `;

    for (const p of prizes) {
        const ticketDay = p.ticket_day.slice(0, 10);
        const onTicketDay = await service.getBalanceDayTotals(p.user_id, ticketDay);
        if (onTicketDay.prize !== 0) {
            pass(`prize ${p.name}: prize on ticket day ${ticketDay}`);
        } else {
            fail(`prize ${p.name}: prize on ticket day ${ticketDay}`, "prize is 0");
        }
        checkTotals(`prize ${p.name} ${ticketDay}`, ticketDay, onTicketDay);
    }

    // ── 5. Provision by reference (created later) ───────────────────────────
    console.log("\n--- Provision reference dating ---");
    const provs = await prisma.$queryRaw<
        Array<{ user_id: number; name: string; ref_day: string; created_day: string; amount: number }>
    >`
        SELECT u.id as user_id, u.name,
            to_char(to_date(substring(ba.reference from 'Provisie (?:lopers )?(\\d{2}-\\d{2}-\\d{4})'), 'DD-MM-YYYY'), 'YYYY-MM-DD') as ref_day,
            (timezone('Europe/Amsterdam', ba.created))::date::text as created_day,
            ba.amount
        FROM balance_actions ba
        JOIN balances b ON ba."balanceID" = b.id
        JOIN users u ON u.id = b."userID"
        WHERE ba.type = 'PROVISION'
        AND ba.reference ~ '^Provisie (lopers )?\\d{2}-\\d{2}-\\d{4}'
        AND (timezone('Europe/Amsterdam', ba.created))::date
            <> to_date(substring(ba.reference from 'Provisie (?:lopers )?(\\d{2}-\\d{2}-\\d{4})'), 'DD-MM-YYYY')
        ORDER BY ba.created DESC
        LIMIT 8
    `;

    for (const p of provs) {
        const refDay = p.ref_day;
        const createdDay = p.created_day.slice(0, 10);
        const onRefDay = await service.getBalanceDayTotals(p.user_id, refDay);
        if (onRefDay.provision !== 0) {
            pass(`provision ${p.name}: on ref day ${refDay}`);
        } else {
            fail(`provision ${p.name}: on ref day ${refDay}`, "provision is 0");
        }
        const onCreatedDay = await service.getBalanceDayTotals(p.user_id, createdDay);
        if (onCreatedDay.provision === 0) {
            pass(`provision ${p.name}: not on created day ${createdDay}`);
        } else {
            fail(`provision ${p.name}: on created day ${createdDay}`, `provision=${onCreatedDay.provision}`);
        }
    }

    // ── 6. Jenny specifically ───────────────────────────────────────────────
    console.log("\n--- Jenny spot check ---");
    const jenny = await prisma.user.findFirst({ where: { username: "jenny" } });
    if (jenny) {
        for (const dayKey of ["2026-06-15", "2026-06-16", "2026-06-17"]) {
            const t = await service.getBalanceDayTotals(jenny.id, dayKey);
            checkTotals(`Jenny ${dayKey}`, dayKey, t);
        }
    }

    console.log("\n" + "─".repeat(50));
    console.log(`${passed + failed} checks: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main()
    .catch((e) => {
        console.error("Fatal:", e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
