/**
 * Remove Duplicate TICKET_SALE Balance Actions
 * 
 * Removes duplicate TICKET_SALE balance actions that were created due to both
 * the Prisma middleware and explicit createTicketSaleBalanceAction calls.
 * Keeps the oldest action for each ticket and removes duplicates.
 * 
 * Run with: npx ts-node src/scripts/remove-duplicate-ticket-sale-actions.ts
 */

import prisma from '../common/utils/prisma';

async function main() {
    console.log('Finding duplicate TICKET_SALE balance actions...\n');

    // Find all TICKET_SALE balance actions
    const ticketSaleActions = await prisma.balanceAction.findMany({
        where: {
            type: 'TICKET_SALE',
            reference: { startsWith: 'TICKET_SALE:' }
        },
        include: {
            balance: { select: { userID: true } }
        },
        orderBy: {
            created: 'asc' // Oldest first
        }
    });

    console.log(`Found ${ticketSaleActions.length} TICKET_SALE actions to check\n`);

    // Group actions by reference (TICKET_SALE:ticketID)
    const actionsByReference = new Map<string, typeof ticketSaleActions>();
    
    for (const action of ticketSaleActions) {
        if (!action.reference) continue;
        
        if (!actionsByReference.has(action.reference)) {
            actionsByReference.set(action.reference, []);
        }
        actionsByReference.get(action.reference)!.push(action);
    }

    let duplicatesFound = 0;
    let duplicatesRemoved = 0;
    let totalAmountRemoved = 0;
    let errors = 0;

    // Process each group
    for (const [reference, actions] of actionsByReference.entries()) {
        if (actions.length <= 1) {
            // No duplicates for this reference
            continue;
        }

        duplicatesFound++;
        const ticketID = reference.replace('TICKET_SALE:', '');
        
        console.log(`\nFound ${actions.length} duplicate actions for ticket ${ticketID}:`);
        
        // Keep the first (oldest) action
        const keepAction = actions[0];
        const duplicateActions = actions.slice(1);
        
        console.log(`  Keeping action ${keepAction.id} (created: ${keepAction.created.toISOString()}, amount: ${keepAction.amount/100} EUR)`);
        
        // Calculate total amount to remove from balance
        let amountToRemove = 0;
        
        for (const duplicate of duplicateActions) {
            console.log(`  Removing action ${duplicate.id} (created: ${duplicate.created.toISOString()}, amount: ${duplicate.amount/100} EUR)`);
            amountToRemove += duplicate.amount;
        }
        
        console.log(`  Total amount to remove from balance: ${amountToRemove/100} EUR`);
        
        // Remove duplicates and adjust balance
        try {
            await prisma.$transaction(async (tx) => {
                // Delete all duplicate actions
                for (const duplicate of duplicateActions) {
                    await tx.balanceAction.delete({
                        where: { id: duplicate.id }
                    });
                }
                
                // Adjust the user's balance (subtract the duplicate amounts)
                if (amountToRemove > 0) {
                    await tx.balance.update({
                        where: { id: keepAction.balanceID },
                        data: { balance: { decrement: amountToRemove } }
                    });
                }
            });
            
            duplicatesRemoved += duplicateActions.length;
            totalAmountRemoved += amountToRemove;
            
        } catch (error) {
            console.error(`  ❌ Error removing duplicates for ticket ${ticketID}:`, error);
            errors++;
        }
    }

    console.log('\n' + '='.repeat(50));
    console.log('Cleanup complete!');
    console.log(`📊 Tickets with duplicates: ${duplicatesFound}`);
    console.log(`✅ Duplicate actions removed: ${duplicatesRemoved}`);
    console.log(`💰 Total amount removed from balances: ${totalAmountRemoved/100} EUR`);
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



