/**
 * Rebuild frozen_balances for one user (or all) from a start date through today.
 *
 * Usage:
 *   USER_ID=21 START=2026-06-25 npx ts-node -r tsconfig-paths/register src/scripts/rebuild-frozen-user.ts
 *   USER_ID=all START=2026-06-01 npx ts-node -r tsconfig-paths/register src/scripts/rebuild-frozen-user.ts
 */

import "reflect-metadata";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

async function main() {
    const userIdArg = process.env.USER_ID ?? "21";
    const startYmd = process.env.START ?? "2026-06-01";

    container.registerInstance("Database", prisma);
    const balanceService = container.resolve(BalanceService);

    const userIds =
        userIdArg === "all"
            ? (await prisma.balance.findMany({ select: { userID: true } })).map((b) => b.userID)
            : [Number(userIdArg)];

    console.log(`Rebuilding frozen chain from ${startYmd} for ${userIds.length} user(s)...\n`);

    for (const userID of userIds) {
        const user = await prisma.user.findUnique({
            where: { id: userID },
            select: { name: true },
        });
        await balanceService.refreshFrozenBalanceChainFromDay(userID, startYmd);
        console.log(`  ${user?.name ?? "user"} (${userID}): done`);
    }

    console.log("\nDone.");
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
