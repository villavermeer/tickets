/**
 * Check Correction Details
 * 
 * Shows detailed information about a specific correction action
 */

import "reflect-metadata";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function checkCorrectionDetails(actionID: number) {
    const correction = await prisma.balanceAction.findUnique({
        where: { id: actionID },
        include: {
            balance: {
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true
                        }
                    }
                }
            }
        }
    });

    if (!correction) {
        console.log('Correction not found');
        return;
    }

    console.log('Correction Details:');
    console.log(`  ID: ${correction.id}`);
    console.log(`  User: ${correction.balance.user.name} (${correction.balance.user.id})`);
    console.log(`  Amount (stored in DB): ${correction.amount} cents`);
    console.log(`  Amount (EUR): ${(correction.amount / 100).toFixed(2)} EUR`);
    console.log(`  Reference: ${correction.reference || 'N/A'}`);
    console.log(`  Created: ${correction.created.toISOString()}`);
    console.log('');
    
    // Check balance before and after this correction
    const actionsBefore = await prisma.balanceAction.findMany({
        where: {
            balanceID: correction.balanceID,
            created: {
                lt: correction.created
            }
        },
        select: {
            amount: true
        }
    });
    
    const balanceBefore = actionsBefore.reduce((sum, a) => sum + a.amount, 0);
    const expectedBalanceAfter = balanceBefore + correction.amount;
    const actualBalance = correction.balance.balance;
    
    console.log('Balance impact:');
    console.log(`  Balance before correction: ${(balanceBefore / 100).toFixed(2)} EUR`);
    console.log(`  Correction amount: ${(correction.amount / 100).toFixed(2)} EUR`);
    console.log(`  Expected balance after: ${(expectedBalanceAfter / 100).toFixed(2)} EUR`);
    console.log(`  Actual balance record: ${(actualBalance / 100).toFixed(2)} EUR`);
    console.log(`  Difference: ${((actualBalance - expectedBalanceAfter) / 100).toFixed(2)} EUR`);
}

const actionID = process.argv[2] ? parseInt(process.argv[2], 10) : null;

if (!actionID) {
    console.log('Usage: npx ts-node -r tsconfig-paths/register src/scripts/check-correction-details.ts <actionID>');
    console.log('Example: npx ts-node -r tsconfig-paths/register src/scripts/check-correction-details.ts 106597');
    process.exit(1);
}

checkCorrectionDetails(actionID)
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error('Error:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
