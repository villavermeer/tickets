/**
 * Koppel genoemde lopers aan een manager (op displaynaam) en herbereken
 * `updateManagerProvision` voor alle dagen waar die lopers tickets hebben.
 *
 * Standaard: manager Eva, lopers Shushu, Juni, Fara, Josh.
 *
 *   cd apps/backend && npx ts-node -r tsconfig-paths/register src/scripts/link-manager-runners.ts
 */

import "reflect-metadata";
import { Role } from "@prisma/client";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { RaffleService } from "../features/raffle/services/RaffleService";
import { DateTime } from "luxon";

const MANAGER_NAME = "Eva";
const RUNNER_NAMES = ["Shushu", "Juni", "Fara", "Josh"];

async function main() {
    container.registerInstance("Database", prisma);
    RaffleService.register();
    const raffleService = container.resolve(RaffleService);

    const manager = await prisma.user.findFirst({
        where: {
            role: Role.MANAGER,
            name: { equals: MANAGER_NAME, mode: "insensitive" },
        },
    });
    if (!manager) {
        throw new Error(`Manager "${MANAGER_NAME}" niet gevonden (rol MANAGER, exacte naam case-insensitive).`);
    }

    const runners: { id: number; name: string; commission: number }[] = [];
    for (const name of RUNNER_NAMES) {
        const r = await prisma.user.findFirst({
            where: {
                role: Role.RUNNER,
                name: { equals: name, mode: "insensitive" },
            },
            select: { id: true, name: true, commission: true },
        });
        if (!r) {
            throw new Error(`Loper "${name}" niet gevonden (rol RUNNER).`);
        }
        runners.push(r);
    }

    for (const r of runners) {
        await prisma.managerRunner.deleteMany({ where: { runnerID: r.id } });
        await prisma.managerRunner.create({
            data: { managerID: manager.id, runnerID: r.id },
        });
        const managerSlice = Math.max(0, 25 - r.commission);
        console.log(`Gekoppeld: ${r.name} -> ${manager.name} (managerprovisie ${managerSlice}% van inleg; 25% − loper ${r.commission}%)`);
    }

    const runnerIds = runners.map((r) => r.id);
    const tickets = await prisma.ticket.findMany({
        where: { creatorID: { in: runnerIds } },
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
        await raffleService.updateManagerProvision(manager.id, day);
    }

    console.log(`Klaar. Managerprovisie voor ${manager.name} herberekend over ${dayKeys.size} kalenderdag(en) (Amsterdam).`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
