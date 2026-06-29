import "reflect-metadata";
import { DateTime } from "luxon";
import prisma from "../common/utils/prisma";

async function main() {
    const fromYmd = process.env.FROM_YMD ?? "2026-06-27";
    const thresholdCents = Number(process.env.THRESHOLD_CENTS ?? "200000"); // default €2000

    const fromUtc = DateTime.fromFormat(fromYmd, "yyyy-MM-dd", { zone: "Europe/Amsterdam" })
        .startOf("day")
        .toUTC()
        .toJSDate();

    const rows = await prisma.balanceAction.findMany({
        where: {
            type: "CORRECTION",
            created: { gte: fromUtc },
            OR: [{ amount: { gt: thresholdCents } }, { amount: { lt: -thresholdCents } }],
        },
        include: {
            balance: {
                include: {
                    user: {
                        select: { id: true, name: true, role: true },
                    },
                },
            },
        },
        orderBy: [{ amount: "desc" }, { created: "asc" }],
    });

    console.log(`Found ${rows.length} correction(s) beyond ±${thresholdCents / 100} EUR since ${fromYmd}`);
    for (const r of rows) {
        const local = DateTime.fromJSDate(r.created).setZone("Europe/Amsterdam").toFormat("yyyy-MM-dd HH:mm");
        console.log(
            `${r.id}\tuser=${r.balance.user.id}\t${r.balance.user.name}\t${r.balance.user.role}\t` +
                `amount=${(r.amount / 100).toFixed(2)}\tdate=${local}\tref=${r.reference ?? "null"}`
        );
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
