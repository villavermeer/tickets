/**
 * Create missing balance actions for all tickets that don't have them
 * Also fixes incorrect amounts for existing balance actions
 * 
 * Run with: npx ts-node src/scripts/create-missing-balance-actions.ts
 */

import prisma from '../common/utils/prisma';
import { BalanceActionType } from '@prisma/client';

async function main() {
    console.log('🔍 Finding tickets without balance actions from November 1, 2025 onwards...\n');

    // Set the start date (November 1, 2025)
    const startDate = new Date('2025-11-01T00:00:00Z');
    
    // Get tickets from November 1, 2025 onwards
    const tickets = await prisma.ticket.findMany({
        where: {
            created: {
                gte: startDate
            }
        },
        include: {
            codes: { select: { value: true } },
            games: { select: { gameID: true } },
            creator: { select: { id: true } }
        },
        orderBy: {
            created: 'asc'
        }
    });

    console.log(`📊 Found ${tickets.length} tickets from November 1, 2025 onwards\n`);

    let created = 0;
    let fixed = 0;
    let skipped = 0;
    let errors = 0;

    for (const ticket of tickets) {
        try {
            const gameCount = ticket.games.length;
            const correctAmount = ticket.codes.reduce((sum, code) => sum + (code.value * gameCount), 0);

            // Check if balance action exists
            const balance = await prisma.balance.findUnique({
                where: { userID: ticket.creator.id },
                include: {
                    actions: {
                        where: {
                            type: BalanceActionType.TICKET_SALE,
                            reference: `TICKET_SALE:${ticket.id}`
                        }
                    }
                }
            });

            if (!balance) {
                // Create balance first
                await prisma.balance.create({
                    data: {
                        userID: ticket.creator.id,
                        balance: 0
                    }
                });
            }

            const existingAction = balance?.actions?.[0];

            if (!existingAction) {
                // Create missing balance action
                await prisma.$transaction(async (tx) => {
                    let userBalance = await tx.balance.findUnique({
                        where: { userID: ticket.creator.id }
                    });

                    if (!userBalance) {
                        userBalance = await tx.balance.create({
                            data: { userID: ticket.creator.id, balance: 0 }
                        });
                    }

                    await tx.balanceAction.create({
                        data: {
                            balanceID: userBalance.id,
                            type: BalanceActionType.TICKET_SALE,
                            amount: correctAmount,
                            reference: `TICKET_SALE:${ticket.id}`,
                            created: ticket.created
                        }
                    });

                    await tx.balance.update({
                        where: { id: userBalance.id },
                        data: { balance: { increment: correctAmount } }
                    });
                });

                created++;
                if (created % 100 === 0) {
                    console.log(`  ✅ Created ${created} balance actions...`);
                }
            } else if (existingAction.amount !== correctAmount) {
                // Fix incorrect amount
                const difference = correctAmount - existingAction.amount;
                
                await prisma.$transaction(async (tx) => {
                    await tx.balanceAction.update({
                        where: { id: existingAction.id },
                        data: { amount: correctAmount }
                    });

                    await tx.balance.update({
                        where: { id: existingAction.balanceID },
                        data: { balance: { increment: difference } }
                    });
                });

                fixed++;
                if (fixed % 50 === 0) {
                    console.log(`  🔧 Fixed ${fixed} balance actions...`);
                }
            } else {
                skipped++;
            }
        } catch (error) {
            console.error(`❌ Error processing ticket ${ticket.id}:`, error);
            errors++;
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log('Summary:');
    console.log(`✅ Created: ${created}`);
    console.log(`🔧 Fixed: ${fixed}`);
    console.log(`⏭️  Skipped (correct): ${skipped}`);
    console.log(`❌ Errors: ${errors}`);
    console.log('='.repeat(50));
}

main()
    .catch((e) => {
        console.error('❌ Fatal error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

