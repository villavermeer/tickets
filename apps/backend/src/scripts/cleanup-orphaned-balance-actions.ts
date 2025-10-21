/**
 * Cleanup Orphaned Balance Actions
 * 
 * Removes balance actions for deleted tickets and adjusts user balances accordingly.
 * 
 * Run with: npx ts-node src/scripts/cleanup-orphaned-balance-actions.ts
 */

import prisma from '../common/utils/prisma';

async function main() {
    console.log('Finding orphaned balance actions...\n');

    // Find all TICKET_SALE balance actions
    const ticketSaleActions = await prisma.balanceAction.findMany({
        where: {
            type: 'TICKET_SALE',
            reference: { startsWith: 'TICKET_SALE:' }
        },
        include: {
            balance: { select: { userID: true } }
        }
    });

    console.log(`Found ${ticketSaleActions.length} TICKET_SALE actions to check\n`);

    let cleaned = 0;
    let errors = 0;

    for (const action of ticketSaleActions) {
        try {
            const ticketIDStr = action.reference?.replace('TICKET_SALE:', '');
            if (!ticketIDStr) continue;

            const ticketID = parseInt(ticketIDStr, 10);
            if (isNaN(ticketID)) continue;

            // Check if ticket exists
            const ticket = await prisma.ticket.findUnique({
                where: { id: ticketID },
                select: { id: true }
            });

            if (!ticket) {
                console.log(`Removing orphaned action for deleted ticket ${ticketID}`);
                console.log(`  User: ${action.balance.userID}, Amount: ${action.amount/100} EUR`);

                await prisma.$transaction(async (tx) => {
                    // Delete the balance action
                    await tx.balanceAction.delete({
                        where: { id: action.id }
                    });

                    // Adjust the user's balance (subtract the ticket sale amount)
                    await tx.balance.update({
                        where: { id: action.balanceID },
                        data: { balance: { decrement: action.amount } }
                    });
                });

                cleaned++;
            }
        } catch (error) {
            console.error(`❌ Error processing action ${action.id}:`, error);
            errors++;
        }
    }

    // Also check PRIZE actions
    const prizeActions = await prisma.balanceAction.findMany({
        where: {
            type: 'PRIZE',
            reference: { startsWith: 'PRIZE:' }
        },
        include: {
            balance: { select: { userID: true } }
        }
    });

    console.log(`\nFound ${prizeActions.length} PRIZE actions to check\n`);

    for (const action of prizeActions) {
        try {
            const parts = action.reference?.split(':');
            if (!parts || parts.length !== 4) continue;

            const ticketID = parseInt(parts[2], 10);
            if (isNaN(ticketID)) continue;

            // Check if ticket exists
            const ticket = await prisma.ticket.findUnique({
                where: { id: ticketID },
                select: { id: true }
            });

            if (!ticket) {
                console.log(`Removing orphaned prize action for deleted ticket ${ticketID}`);
                console.log(`  User: ${action.balance.userID}, Amount: ${Math.abs(action.amount)/100} EUR`);

                await prisma.$transaction(async (tx) => {
                    // Delete the balance action
                    await tx.balanceAction.delete({
                        where: { id: action.id }
                    });

                    // Adjust the user's balance (add back the prize amount since it was negative)
                    await tx.balance.update({
                        where: { id: action.balanceID },
                        data: { balance: { increment: Math.abs(action.amount) } }
                    });
                });

                cleaned++;
            }
        } catch (error) {
            console.error(`❌ Error processing prize action ${action.id}:`, error);
            errors++;
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log('Cleanup complete!');
    console.log(`✅ Cleaned: ${cleaned}`);
    console.log(`❌ Errors: ${errors}`);
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

