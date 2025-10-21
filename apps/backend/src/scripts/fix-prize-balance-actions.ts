/**
 * Migration Script: Fix Prize Balance Actions
 * 
 * This script corrects PRIZE balance actions that were created with incorrect amounts
 * (stake values instead of actual prize amounts calculated with multipliers).
 * 
 * Run with: npx ts-node src/scripts/fix-prize-balance-actions.ts
 */

import { PrismaClient, BalanceActionType } from '@prisma/client';

const prisma = new PrismaClient();

// Multiplier matrix (same as PrizeService and updated prisma.ts)
const MULTIPLIERS = {
    DEFAULT: {
        1: { 4: 3000, 3: 400, 2: 40 },
        2: { 4: 1500, 3: 200, 2: 20 },
        3: { 4: 750, 3: 100, 2: 10 },
    },
    SUPER4: { 4: 5250, 3: 700, 2: 70 }
} as const;

function calculatePrizeAmount(
    playedCode: string,
    stakeValue: number,
    gameID: number,
    winningCodesWithOrder: Array<{ code: string; order: number }>
): number {
    const codeLength = playedCode.length;
    const isSuper4 = gameID === 7;
    let total = 0;

    for (const { code: winningCode, order } of winningCodesWithOrder) {
        if (!winningCode.endsWith(playedCode)) continue;

        const multiplier = isSuper4
            ? (MULTIPLIERS.SUPER4 as any)[codeLength] ?? 0
            : ((MULTIPLIERS.DEFAULT as any)[order]?.[codeLength] ?? 0);

        if (multiplier > 0) {
            total += stakeValue * multiplier;
        }
    }

    return total;
}

async function main() {
    console.log('Starting prize balance actions migration...\n');

    // Find all PRIZE balance actions
    const prizeActions = await prisma.balanceAction.findMany({
        where: { type: BalanceActionType.PRIZE },
        include: {
            balance: {
                select: { userID: true, balance: true }
            }
        },
        orderBy: { created: 'asc' }
    });

    console.log(`Found ${prizeActions.length} PRIZE balance actions to process.\n`);

    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const action of prizeActions) {
        try {
            // Parse reference: PRIZE:raffleID:ticketID:code
            const refParts = action.reference?.split(':');
            if (!refParts || refParts.length !== 4 || refParts[0] !== 'PRIZE') {
                console.log(`⚠️  Skipping action ${action.id}: invalid reference format`);
                skippedCount++;
                continue;
            }

            const [, raffleIDStr, ticketIDStr, playedCode] = refParts;
            const raffleID = parseInt(raffleIDStr, 10);
            const ticketID = parseInt(ticketIDStr, 10);

            // Get raffle with winning codes and created date
            const raffle = await prisma.raffle.findUnique({
                where: { id: raffleID },
                select: {
                    id: true,
                    gameID: true,
                    created: true,
                    codes: { select: { code: true } }
                }
            });

            if (!raffle) {
                console.log(`⚠️  Skipping action ${action.id}: raffle ${raffleID} not found`);
                skippedCount++;
                continue;
            }

            // Get the ticket with creation date and stake value
            const ticket = await prisma.ticket.findUnique({
                where: { id: ticketID },
                select: {
                    created: true,
                    codes: {
                        where: { code: playedCode },
                        select: { value: true }
                    }
                }
            });

            if (!ticket || ticket.codes.length === 0) {
                console.log(`⚠️  Skipping action ${action.id}: ticket ${ticketID} or code ${playedCode} not found`);
                skippedCount++;
                continue;
            }

            const ticketCode = ticket.codes[0];

            // Build winning codes with order
            const winningCodesWithOrder: Array<{ code: string; order: number }> = [];
            const codeToOrder = new Map<string, number>();
            for (const c of raffle.codes) {
                if (!codeToOrder.has(c.code)) {
                    codeToOrder.set(c.code, codeToOrder.size + 1);
                }
                winningCodesWithOrder.push({ code: c.code, order: codeToOrder.get(c.code)! });
            }

            // Calculate correct prize amount
            const stakeValue = ticketCode.value;
            const correctPrizeAmount = calculatePrizeAmount(
                playedCode,
                stakeValue,
                raffle.gameID,
                winningCodesWithOrder
            );

            // Current amount is negative (outflow)
            const currentAmount = action.amount;
            const correctAmount = -correctPrizeAmount;

            // Check if both amount and date need correction
            const amountNeedsUpdate = currentAmount !== correctAmount;
            const dateNeedsUpdate = action.created.getTime() !== ticket.created.getTime();

            if (!amountNeedsUpdate && !dateNeedsUpdate) {
                // Already correct
                continue;
            }

            // Calculate the adjustment needed
            const adjustment = correctAmount - currentAmount;

            console.log(`Fixing action ${action.id} for user ${action.balance.userID}:`);
            console.log(`  Raffle: ${raffleID}, Ticket: ${ticketID} (created ${ticket.created.toISOString().split('T')[0]}), Code: ${playedCode}`);
            console.log(`  Stake: ${stakeValue} cents`);
            if (amountNeedsUpdate) {
                console.log(`  Current prize amount: ${Math.abs(currentAmount)} cents (INCORRECT)`);
                console.log(`  Correct prize amount: ${correctPrizeAmount} cents`);
                console.log(`  Balance adjustment: ${adjustment} cents`);
            }
            if (dateNeedsUpdate) {
                console.log(`  Current date: ${action.created.toISOString()}`);
                console.log(`  Correct date: ${ticket.created.toISOString()} (backdated to ticket creation date)`);
            }
            console.log('');

            // Update within a transaction
            await prisma.$transaction(async (tx) => {
                // Update the balance action
                await tx.balanceAction.update({
                    where: { id: action.id },
                    data: {
                        amount: correctAmount,
                        created: ticket.created // Backdate to match ticket creation date
                    }
                });

                // Adjust the user's balance if amount changed
                if (amountNeedsUpdate) {
                    await tx.balance.update({
                        where: { id: action.balanceID },
                        data: { balance: { increment: adjustment } }
                    });
                }
            });

            updatedCount++;
        } catch (error) {
            console.error(`❌ Error processing action ${action.id}:`, error);
            errorCount++;
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log('Migration complete!');
    console.log(`✅ Updated: ${updatedCount}`);
    console.log(`⏭️  Skipped: ${skippedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log('='.repeat(50));
}

main()
    .catch((e) => {
        console.error('Fatal error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

