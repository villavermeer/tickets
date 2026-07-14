import prisma from "../common/utils/prisma";
import RedisClient from "../common/classes/cache/RedisClient";

/** Tear down open handles and force Node to exit (scripts otherwise hang on Redis/Prisma pools). */
export async function exitScript(code = 0): Promise<never> {
    try {
        await prisma.$disconnect();
    } catch {
        // ignore
    }

    try {
        const redis = (RedisClient as any).instance;
        if (redis && typeof redis.quit === "function") {
            await redis.quit();
        }
    } catch {
        // ignore
    }

    process.exit(code);
}
