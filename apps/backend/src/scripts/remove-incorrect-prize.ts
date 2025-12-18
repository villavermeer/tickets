/**
 * Remove the incorrect prize awarded to ticket 80749 for raffle 1101
 * The prize should not have been awarded because code "126" doesn't match
 * any of raffle 1101's winning codes ("1088", "2855", "6641")
 */

import 'reflect-metadata';
import prisma from '../common/utils/prisma';

async function removeIncorrectPrize() {
    console.log('=== Removing Incorrect Prize ===\n');

    // Find the incorrect prize
    const incorrectPrize = await prisma.balanceAction.findFirst({
        where: {
            reference: 'PRIZE:1101:80749:126',
            type: 'PRIZE'
        }
    });

    if (!incorrectPrize) {
        console.log('Incorrect prize not found - may have already been removed');
        return;
    }

    console.log('Found incorrect prize:');
    console.log(`  ID: ${incorrectPrize.id}`);
    console.log(`  Reference: ${incorrectPrize.reference}`);
    console.log(`  Amount: ${incorrectPrize.amount} cents (${incorrectPrize.amount/100} EUR)`);
    console.log(`  Created: ${incorrectPrize.created.toISOString()}`);
    console.log(`  Updated: ${incorrectPrize.updated.toISOString()}\n`);

    // Verify the prize should not exist
    const ticket80749 = await prisma.ticket.findUnique({
        where: { id: 80749 },
        include: { codes: true }
    });

    const raffle1101 = await prisma.raffle.findUnique({
        where: { id: 1101 },
        include: { codes: true }
    });

    if (!ticket80749 || !raffle1101) {
        console.log('Ticket or raffle not found');
        return;
    }

    console.log('Verification:');
    console.log(`  Ticket 80749 has code "126": ${ticket80749.codes.some(c => c.code === '126')}`);
    console.log(`  Raffle 1101 winning codes: ${raffle1101.codes.map(c => c.code).join(', ')}`);

    const shouldHavePrize = ticket80749.codes.some(ticketCode =>
        raffle1101.codes.some(raffleCode => raffleCode.code.endsWith(ticketCode.code))
    );

    console.log(`  Should ticket have prize: ${shouldHavePrize}\n`);

    if (!shouldHavePrize) {
        console.log('✅ Confirmed: Prize should not exist. Removing...\n');

        // Remove the prize and adjust balance
        await prisma.$transaction(async (tx) => {
            // Reverse the balance adjustment
            await tx.balance.update({
                where: { id: incorrectPrize.balanceID },
                data: { balance: { increment: incorrectPrize.amount } } // Add back the negative amount
            });

            // Delete the prize action
            await tx.balanceAction.delete({
                where: { id: incorrectPrize.id }
            });
        });

        console.log('✅ Incorrect prize removed and balance corrected');
    } else {
        console.log('❌ Verification failed: Prize might be legitimate. Not removing.');
    }
}

// Run the script
removeIncorrectPrize()
    .then(() => {
        console.log('\n=== Script Complete ===');
        process.exit(0);
    })
    .catch(error => {
        console.error('Script failed:', error);
        process.exit(1);
    });
