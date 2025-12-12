/**
 * Check Actions After Correction
 * 
 * For a specific user, finds the last correction and verifies all actions created after it.
 * Shows if balance calculations are correct from that point forward.
 * 
 * Run with: npx ts-node -r tsconfig-paths/register src/scripts/check-actions-after-correction.ts <userID>
 */

import "reflect-metadata";
import { PrismaClient, BalanceActionType } from "@prisma/client";

const prisma = new PrismaClient();

async function checkActionsAfterCorrection(userID: number) {
    console.log(`Checking actions after correction for user ID: ${userID}\n`);

    const user = await prisma.user.findUnique({
        where: { id: userID },
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

    if (!user || !user.balance) {
        console.log('User not found or has no balance');
        return;
    }

    // Find the last correction
    const lastCorrection = await prisma.balanceAction.findFirst({
        where: {
            balanceID: user.balance.id,
            type: BalanceActionType.CORRECTION
        },
        orderBy: {
            created: 'desc'
        },
        select: {
            id: true,
            amount: true,
            reference: true,
            created: true
        }
    });

    if (!lastCorrection) {
        console.log('No correction found for this user');
        return;
    }

    console.log(`Last correction:`);
    console.log(`  ID: ${lastCorrection.id}`);
    console.log(`  Amount: ${(lastCorrection.amount / 100).toFixed(2)} EUR`);
    console.log(`  Reference: ${lastCorrection.reference || 'N/A'}`);
    console.log(`  Created: ${lastCorrection.created.toISOString()}`);
    console.log('');

    // Get all actions after the correction
    const actionsAfter = await prisma.balanceAction.findMany({
        where: {
            balanceID: user.balance.id,
            created: {
                gt: lastCorrection.created
            }
        },
        select: {
            id: true,
            type: true,
            amount: true,
            reference: true,
            created: true
        },
        orderBy: {
            created: 'asc'
        }
    });

    console.log(`Actions created after correction: ${actionsAfter.length}\n`);

    // Group by type
    const byType = new Map<BalanceActionType, number[]>();
    actionsAfter.forEach(action => {
        if (!byType.has(action.type)) {
            byType.set(action.type, []);
        }
        byType.get(action.type)!.push(action.amount);
    });

    console.log('Breakdown by type:');
    byType.forEach((amounts, type) => {
        const total = amounts.reduce((sum, amt) => sum + amt, 0);
        const count = amounts.length;
        console.log(`  ${type}: ${count} actions, total: ${(total / 100).toFixed(2)} EUR`);
    });
    console.log('');

    // Calculate expected balance after correction
    const sumOfActionsAfter = actionsAfter.reduce((sum, action) => sum + action.amount, 0);
    
    // Get balance at the time of correction (sum all actions up to and including correction)
    const actionsUpToCorrection = await prisma.balanceAction.findMany({
        where: {
            balanceID: user.balance.id,
            created: {
                lte: lastCorrection.created
            }
        },
        select: {
            amount: true
        }
    });
    
    const balanceAtCorrection = actionsUpToCorrection.reduce((sum, action) => sum + action.amount, 0);
    const expectedBalance = balanceAtCorrection + sumOfActionsAfter;
    const actualBalance = user.balance.balance;
    const difference = actualBalance - expectedBalance;

    console.log('Balance calculation:');
    console.log(`  Balance at correction time: ${(balanceAtCorrection / 100).toFixed(2)} EUR`);
    console.log(`  Sum of actions after correction: ${(sumOfActionsAfter / 100).toFixed(2)} EUR`);
    console.log(`  Expected balance: ${(expectedBalance / 100).toFixed(2)} EUR`);
    console.log(`  Actual balance record: ${(actualBalance / 100).toFixed(2)} EUR`);
    console.log(`  Difference: ${(difference / 100).toFixed(2)} EUR`);
    console.log('');

    // Check for duplicate provisions
    const provisions = actionsAfter.filter(a => a.type === BalanceActionType.PROVISION);
    const provisionRefs = new Map<string, number>();
    provisions.forEach(p => {
        const ref = p.reference || 'no-reference';
        if (!provisionRefs.has(ref)) {
            provisionRefs.set(ref, 0);
        }
        provisionRefs.set(ref, provisionRefs.get(ref)! + 1);
    });

    const duplicates = Array.from(provisionRefs.entries()).filter(([_, count]) => count > 1);
    if (duplicates.length > 0) {
        console.log('⚠️  Duplicate provision references found:');
        duplicates.forEach(([ref, count]) => {
            console.log(`  "${ref}": ${count} actions`);
        });
        console.log('');
    }

    // Show all provisions
    if (provisions.length > 0) {
        console.log('All provision actions after correction:');
        provisions.forEach(p => {
            console.log(`  ${p.created.toISOString()}: ${(p.amount / 100).toFixed(2)} EUR - "${p.reference || 'no reference'}"`);
        });
    }
}

const userID = process.argv[2] ? parseInt(process.argv[2], 10) : null;

if (!userID) {
    console.log('Usage: npx ts-node -r tsconfig-paths/register src/scripts/check-actions-after-correction.ts <userID>');
    process.exit(1);
}

checkActionsAfterCorrection(userID)
    .then(() => {
        console.log('\nCheck completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Error:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
