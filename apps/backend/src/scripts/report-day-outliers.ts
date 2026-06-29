import "reflect-metadata";
import { container } from "tsyringe";
import prisma from "../common/utils/prisma";
import { BalanceService } from "../features/balance/services/BalanceService";

async function main() {
    const day = process.env.DAY ?? "2026-06-27";
    const thresholdCents = Number(process.env.THRESHOLD_CENTS ?? "500000"); // default €5k

    container.registerInstance("Database", prisma);
    const service = container.resolve(BalanceService);
    const balances = await prisma.balance.findMany({ select: { userID: true } });

    let outliers = 0;
    for (const b of balances) {
        const t = await service.getBalanceDayTotals(b.userID, day);
        if (Math.abs(t.closing) > thresholdCents || Math.abs(t.dayNet) > thresholdCents) {
            const u = await prisma.user.findUnique({
                where: { id: b.userID },
                select: { name: true, role: true },
            });
            console.log(
                `${b.userID}\t${u?.name ?? "?"}\t${u?.role ?? "?"}\t` +
                    `open=${(t.opening / 100).toFixed(2)}\t` +
                    `corr=${(t.correction / 100).toFixed(2)}\t` +
                    `prize=${(t.prize / 100).toFixed(2)}\t` +
                    `prov=${(t.provision / 100).toFixed(2)}\t` +
                    `close=${(t.closing / 100).toFixed(2)}`
            );
            outliers++;
        }
    }
    console.log(`outlier_users=${outliers}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
