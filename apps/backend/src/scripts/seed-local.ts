/**
 * Idempotent local seed: admin, manager, runners + games.
 *
 * Usage (from apps/backend, with local DATABASE_URL):
 *   yarn seed:local
 */
import "reflect-metadata";
import bcrypt from "bcrypt";
import { GameExpiry, PrismaClient, Role } from "@prisma/client";

const prisma = new PrismaClient();

const GAMES: { name: string; expires: GameExpiry }[] = [
    { name: "WNK", expires: GameExpiry.MIDNIGHT },
    { name: "WNK napa", expires: GameExpiry.MIDNIGHT },
    { name: "Flamingo", expires: GameExpiry.MIDNIGHT },
    { name: "Diario", expires: GameExpiry.MIDNIGHT },
    { name: "Philipsburg evening", expires: GameExpiry.MIDNIGHT },
    { name: "Smart evening", expires: GameExpiry.MIDNIGHT },
    { name: "Santo", expires: GameExpiry.MIDNIGHT },
    { name: "Philipsburg noon", expires: GameExpiry.MIDDAY },
    { name: "Smart noon", expires: GameExpiry.MIDDAY },
    { name: "Super 4", expires: GameExpiry.MIDNIGHT },
];

async function upsertUser(input: {
    username: string;
    name: string;
    password: string;
    role: Role;
    commission: number;
}) {
    const passwordHash = await bcrypt.hash(input.password, 10);
    return prisma.user.upsert({
        where: { username: input.username },
        create: {
            username: input.username,
            name: input.name,
            password: passwordHash,
            role: input.role,
            commission: input.commission,
        },
        update: {
            name: input.name,
            password: passwordHash,
            role: input.role,
            commission: input.commission,
        },
    });
}

async function ensureManagerRunner(managerID: number, runnerID: number) {
    const existing = await prisma.managerRunner.findFirst({
        where: { managerID, runnerID },
    });
    if (existing) {
        return existing;
    }
    return prisma.managerRunner.create({
        data: { managerID, runnerID },
    });
}

async function seedGames() {
    for (const game of GAMES) {
        const existing = await prisma.game.findFirst({ where: { name: game.name } });
        if (existing) {
            await prisma.game.update({
                where: { id: existing.id },
                data: { expires: game.expires },
            });
        } else {
            await prisma.game.create({ data: game });
        }
    }
}

async function main() {
    const dbHost = (process.env.DATABASE_URL ?? "").match(/@([^/]+)/)?.[1] ?? "unknown";
    console.log(`Seeding local DB at ${dbHost} ...`);

    if (dbHost.includes("185.28.39.174") || dbHost.includes("supabase")) {
        console.error("Refusing to seed: DATABASE_URL looks like a remote/production host.");
        console.error("Switch to local .env first (see .env.remote backup).");
        process.exit(1);
    }

    await seedGames();
    console.log(`Games: ${GAMES.map((g) => g.name).join(", ")}`);

    const admin = await upsertUser({
        username: "admin",
        name: "Local Admin",
        password: "admin123",
        role: Role.ADMIN,
        commission: 0,
    });

    const manager = await upsertUser({
        username: "manager",
        name: "Local Manager",
        password: "manager123",
        role: Role.MANAGER,
        commission: 25,
    });

    const runner = await upsertUser({
        username: "runner",
        name: "Local Runner",
        password: "runner123",
        role: Role.RUNNER,
        commission: 15,
    });

    const runner2 = await upsertUser({
        username: "runner2",
        name: "Local Runner 2",
        password: "runner123",
        role: Role.RUNNER,
        commission: 15,
    });

    await ensureManagerRunner(manager.id, runner.id);
    await ensureManagerRunner(manager.id, runner2.id);

    console.log("Users ready:");
    console.log(`  admin    / admin123    (id=${admin.id})`);
    console.log(`  manager  / manager123  (id=${manager.id})`);
    console.log(`  runner   / runner123   (id=${runner.id})`);
    console.log(`  runner2  / runner123   (id=${runner2.id})`);
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
