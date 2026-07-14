/**
 * Quick post-repair check for PO cases. Exits immediately when done.
 *
 * Usage:
 *   DATABASE_URL=... npx ts-node -r tsconfig-paths/register src/scripts/verify-po-prize-cases.ts
 */

import "reflect-metadata";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";
import { exitScript } from "./_scriptExit";

container.registerInstance("Database", prisma);

const CASES = [
    { user: "mica", date: "2026-07-08" },
    { user: "iro", date: "2026-07-07" },
    { user: "xiomara", date: "2026-07-08" },
];

async function main() {
    const balanceService = container.resolve(BalanceService);

    for (const c of CASES) {
        const u = await prisma.user.findFirst({ where: { username: c.user } });
        if (!u) {
            console.log(`${c.user} ${c.date}: USER NOT FOUND`);
            continue;
        }

        const totals = await balanceService.getBalanceDayTotals(u.id, c.date);
        console.log(
            `${c.user} ${c.date}: saldo prijzen €${(Math.abs(totals.prize) / 100).toFixed(2)}`
        );
    }
}

main()
    .then(() => exitScript(0))
    .catch(async (e) => {
        console.error(e);
        await exitScript(1);
    });
