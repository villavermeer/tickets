/**
 * Fix TICKET_SALE balance action amounts
 * 
 * Corrects TICKET_SALE balance actions where the amount doesn't match the actual ticket total.
 * 
 * Run with: npx ts-node src/scripts/fix-ticket-sale-amounts.ts
 */

import prisma from '../common/utils/prisma';

async function main() {
    console.log('Checking TICKET_SALE balance actions...\n');

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

    let fixed = 0;
    let skipped = 0;
    let errors = 0;

    for (const action of ticketSaleActions) {
        try {
            const ticketIDStr = action.reference?.replace('TICKET_SALE:', '');
            if (!ticketIDStr) continue;

            const ticketID = parseInt(ticketIDStr, 10);
            if (isNaN(ticketID)) continue;

            // Get ticket with games and codes
            const ticket = await prisma.ticket.findUnique({
                where: { id: ticketID },
                select: {
                    id: true,
                    codes: { select: { value: true } },
                    games: { select: { gameID: true } }
                }
            });

            if (!ticket) {
                // Ticket deleted - should have been handled by cleanup script
                skipped++;
                continue;
            }

            // Calculate correct amount
            const gameCount = ticket.games.length;
            const codeSum = ticket.codes.reduce((sum, code) => sum + code.value, 0);
            const correctAmount = codeSum * gameCount;

            if (action.amount === correctAmount) {
                skipped++;
                continue;
            }

            const difference = correctAmount - action.amount;
            
            console.log(`Fixing ticket ${ticketID} for user ${action.balance.userID}:`);
            console.log(`  Current: ${action.amount/100} EUR`);
            console.log(`  Correct: ${correctAmount/100} EUR`);
            console.log(`  Difference: ${difference/100} EUR\n`);

            // Update balance action and adjust user balance
            await prisma.$transaction(async (tx) => {
                await tx.balanceAction.update({
                    where: { id: action.id },
                    data: { amount: correctAmount }
                });

                await tx.balance.update({
                    where: { id: action.balanceID },
                    data: { balance: { increment: difference } }
                });
            });

            fixed++;

        } catch (error) {
            console.error(`❌ Error processing action ${action.id}:`, error);
            errors++;
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log('Fix complete!');
    console.log(`✅ Fixed: ${fixed}`);
    console.log(`⏭️  Skipped (correct): ${skipped}`);
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

