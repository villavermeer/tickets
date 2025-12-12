/**
 * Verify Balance Consistency
 * 
 * Checks if balance records match the sum of all balance actions for each user.
 * Reports any discrepancies found.
 * 
 * Run with: npx ts-node -r tsconfig-paths/register src/scripts/verify-balance-consistency.ts
 */

import "reflect-metadata";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function verifyBalanceConsistency() {
    console.log('Verifying balance consistency...\n');

    // Get all users with balances
    const users = await prisma.user.findMany({
        where: {
            balance: {
                isNot: null
            }
        },
        select: {
            id: true,
            name: true,
            balance: {
                select: {
                    id: true,
                    balance: true,
                }
            }
        }
    });

    console.log(`Found ${users.length} users with balances\n`);

    let correct = 0;
    let discrepancies = 0;
    const discrepanciesList: Array<{
        userID: number;
        userName: string;
        balanceRecord: number;
        calculatedFromActions: number;
        difference: number;
    }> = [];

    for (const user of users) {
        if (!user.balance) continue;

        // Get all balance actions for this user
        const actions = await prisma.balanceAction.findMany({
            where: {
                balanceID: user.balance.id
            },
            select: {
                amount: true,
                type: true,
                reference: true,
                created: true
            },
            orderBy: {
                created: 'asc'
            }
        });

        // Calculate balance from actions
        const calculatedBalance = actions.reduce((sum, action) => sum + action.amount, 0);
        const balanceRecord = user.balance.balance;
        const difference = balanceRecord - calculatedBalance;

        if (difference !== 0) {
            discrepancies++;
            discrepanciesList.push({
                userID: user.id,
                userName: user.name,
                balanceRecord,
                calculatedFromActions: calculatedBalance,
                difference
            });

            console.log(`❌ DISCREPANCY found for user ${user.name} (ID: ${user.id}):`);
            console.log(`   Balance record: ${(balanceRecord / 100).toFixed(2)} EUR`);
            console.log(`   Calculated from actions: ${(calculatedBalance / 100).toFixed(2)} EUR`);
            console.log(`   Difference: ${(difference / 100).toFixed(2)} EUR`);
            console.log(`   Number of actions: ${actions.length}`);
            console.log('');
        } else {
            correct++;
        }
    }

    console.log('\n' + '='.repeat(60));
    console.log('Verification Summary:');
    console.log(`✅ Correct balances: ${correct}`);
    console.log(`❌ Discrepancies found: ${discrepancies}`);
    console.log('='.repeat(60));

    if (discrepancies > 0) {
        console.log('\nDiscrepancies breakdown:');
        discrepanciesList.forEach(d => {
            console.log(`  ${d.userName} (${d.userID}): ${(d.difference / 100).toFixed(2)} EUR difference`);
        });
    }

    return { correct, discrepancies, discrepanciesList };
}

verifyBalanceConsistency()
    .then(() => {
        console.log('\nVerification completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Error running verification:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
