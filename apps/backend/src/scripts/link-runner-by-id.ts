/**
 * Koppel één loper aan één manager op ID en herbereken managerprovisie
 * voor alle kalenderdagen waar die loper tickets heeft.
 *
 *   cd apps/backend && npx ts-node -r tsconfig-paths/register src/scripts/link-runner-by-id.ts 91 89
 */

import "reflect-metadata";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { RaffleService } from "../features/raffle/services/RaffleService";
import { DateTime } from "luxon";

async function main() {
    const managerID = Number(process.argv[2]);
    const runnerID = Number(process.argv[3]);

    if (!Number.isFinite(managerID) || !Number.isFinite(runnerID)) {
        throw new Error("Gebruik: link-runner-by-id.ts <managerID> <runnerID>");
    }

    container.registerInstance("Database", prisma);
    RaffleService.register();
    const raffleService = container.resolve(RaffleService);

    const [manager, runner] = await Promise.all([
        prisma.user.findUnique({ where: { id: managerID }, select: { id: true, name: true, role: true } }),
        prisma.user.findUnique({ where: { id: runnerID }, select: { id: true, name: true, role: true, commission: true } }),
    ]);

    if (!manager || manager.role !== "MANAGER") {
        throw new Error(`Manager ${managerID} niet gevonden`);
    }
    if (!runner || runner.role !== "RUNNER") {
        throw new Error(`Loper ${runnerID} niet gevonden`);
    }

    await prisma.managerRunner.deleteMany({ where: { runnerID } });
    await prisma.managerRunner.create({
        data: { managerID, runnerID },
    });

    const managerSlice = Math.max(0, 25 - runner.commission);
    console.log(`Gekoppeld: ${runner.name} (${runnerID}) -> ${manager.name} (${managerID}); managerprovisie ${managerSlice}%`);

    const tickets = await prisma.ticket.findMany({
        where: { creatorID: runnerID },
        select: { created: true },
    });

    const dayKeys = new Set<string>();
    for (const t of tickets) {
        const key = DateTime.fromJSDate(t.created).setZone("Europe/Amsterdam").toISODate();
        if (key) {
            dayKeys.add(key);
        }
    }

    for (const key of dayKeys) {
        const day = DateTime.fromISO(key, { zone: "Europe/Amsterdam" }).startOf("day").toJSDate();
        await raffleService.updateManagerProvision(managerID, day);
    }

    console.log(`Klaar. Managerprovisie herberekend over ${dayKeys.size} kalenderdag(en).`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
