/**
 * Focused verification for consecutive-day continuity in BalanceService.getBalanceDayTotals.
 *
 * Run with:
 *   cd apps/backend && npx ts-node -r tsconfig-paths/register src/scripts/test-balance-day-continuity.ts
 */

import "reflect-metadata";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { BalanceActionType, Role } from "@prisma/client";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

const TEST_USERNAME = `__BALANCE_DAY_CONTINUITY__${Date.now()}`;

async function main() {
    console.log("=== Balance Day Continuity Test ===");

    container.registerInstance("Database", prisma);
    const service = new BalanceService(prisma);
    let testUserID: number | null = null;

    try {
        // Pick two consecutive Amsterdam business days in the recent past.
        const day1 = DateTime.now().setZone("Europe/Amsterdam").minus({ days: 3 }).startOf("day");
        const day2 = day1.plus({ days: 1 });
        const day1Key = day1.toFormat("yyyy-MM-dd");
        const day2Key = day2.toFormat("yyyy-MM-dd");

        // Create isolated test user + balance ledger.
        const user = await prisma.user.create({
            data: {
                username: TEST_USERNAME,
                password: "test",
                name: "__BALANCE_DAY_CONTINUITY__",
                role: Role.RUNNER,
                commission: 0,
            },
        });
        testUserID = user.id;

        const balance = await prisma.balance.create({
            data: { userID: user.id, balance: 0 },
        });

        // Ticket belongs to day1 (business attribution source).
        const ticket = await prisma.ticket.create({
            data: {
                name: "continuity-test-ticket",
                creatorID: user.id,
                created: day1.plus({ hours: 12 }).toUTC().toJSDate(),
            },
        });

        // Ledger action is physically created on day2, but references the day1 ticket.
        // This reproduces the historical split where day1 closing could diverge from day2 opening.
        await prisma.balanceAction.create({
            data: {
                balanceID: balance.id,
                type: BalanceActionType.TICKET_SALE,
                amount: 1000,
                reference: `TICKET_SALE:${ticket.id}`,
                created: day2.plus({ hours: 12 }).toUTC().toJSDate(),
            },
        });

        await prisma.balance.update({
            where: { id: balance.id },
            data: { balance: { increment: 1000 } },
        });

        const totalsDay1 = await service.getBalanceDayTotals(user.id, day1Key);
        const totalsDay2 = await service.getBalanceDayTotals(user.id, day2Key);

        assert.equal(
            totalsDay2.opening,
            totalsDay1.closing,
            `Continuity broken: opening(${day2Key})=${totalsDay2.opening} must equal closing(${day1Key})=${totalsDay1.closing}`
        );

        console.log(
            `PASS: opening(${day2Key})=${totalsDay2.opening} equals closing(${day1Key})=${totalsDay1.closing}`
        );
    } finally {
        if (testUserID !== null) {
            await prisma.user.delete({ where: { id: testUserID } });
        }
        await prisma.$disconnect();
    }
}

main().catch((error) => {
    console.error("FAIL:", error);
    process.exit(1);
});

