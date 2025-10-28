import { PrismaClient, BalanceActionType } from '@prisma/client';
import { DateTime } from 'luxon';

const db = new PrismaClient();

/**
 * Check existing balance actions for October 27, 2025
 * This script helps debug why prizes might not be visible on the balance page
 */

async function main() {
    console.log('🔍 Checking existing balance actions for October 27, 2025...');
    
    // Set the target date (October 27, 2025)
    const targetDate = new Date('2025-10-27');
    
    // Build day boundaries in Amsterdam timezone
    const amsterdamDate = DateTime.fromJSDate(targetDate).setZone('Europe/Amsterdam');
    const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
    const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();
    
    console.log(`📅 Target date: ${targetDate.toDateString()}`);
    console.log(`🕐 Start of day (UTC): ${startOfDay.toISOString()}`);
    console.log(`🕑 End of day (UTC): ${endOfDay.toISOString()}`);
    
    // Get all balance actions for this date
    const actions = await db.balanceAction.findMany({
        where: {
            created: {
                gte: startOfDay,
                lte: endOfDay
            }
        },
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
        },
        orderBy: [
            { type: 'asc' },
            { created: 'asc' }
        ]
    });
    
    console.log(`\n📊 Found ${actions.length} balance actions for October 27, 2025\n`);
    
    // Group by type
    const actionsByType = actions.reduce((acc, action) => {
        if (!acc[action.type]) {
            acc[action.type] = [];
        }
        acc[action.type].push(action);
        return acc;
    }, {} as Record<string, typeof actions>);
    
    // Display summary by type
    for (const [type, typeActions] of Object.entries(actionsByType)) {
        console.log(`\n🏷️  ${type} actions (${typeActions.length}):`);
        
        let totalAmount = 0;
        const userTotals = new Map<number, { name: string, amount: number, count: number }>();
        
        for (const action of typeActions) {
            totalAmount += action.amount;
            
            const userId = action.balance.user.id;
            const userName = action.balance.user.name;
            
            if (!userTotals.has(userId)) {
                userTotals.set(userId, { name: userName, amount: 0, count: 0 });
            }
            
            const userTotal = userTotals.get(userId)!;
            userTotal.amount += action.amount;
            userTotal.count += 1;
            
            // Show first few actions of each type as examples
            if (typeActions.indexOf(action) < 5) {
                console.log(`   - ${userName}: ${action.amount/100}€ (ref: ${action.reference || 'none'}) at ${action.created.toISOString()}`);
            }
        }
        
        if (typeActions.length > 5) {
            console.log(`   ... and ${typeActions.length - 5} more`);
        }
        
        console.log(`   💰 Total amount: ${totalAmount/100}€`);
        console.log(`   👥 Users affected: ${userTotals.size}`);
        
        // Show top users for this action type
        const sortedUsers = Array.from(userTotals.entries())
            .sort((a, b) => Math.abs(b[1].amount) - Math.abs(a[1].amount))
            .slice(0, 3);
            
        console.log(`   🏆 Top users:`);
        for (const [userId, data] of sortedUsers) {
            console.log(`      ${data.name}: ${data.amount/100}€ (${data.count} actions)`);
        }
    }
    
    // Check specific date ranges that mobile app might be querying
    console.log(`\n🕐 Checking actions by different time boundaries...`);
    
    // Check actions in the previous 24 hours (what mobile might consider "yesterday")
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    
    const recentActions = await db.balanceAction.findMany({
        where: {
            created: {
                gte: yesterday
            },
            type: BalanceActionType.PRIZE
        },
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
    
    console.log(`   📱 Prize actions in last 24h: ${recentActions.length}`);
    
    // Check if actions exist but with different dates
    const allPrizeActions = await db.balanceAction.findMany({
        where: {
            type: BalanceActionType.PRIZE,
            created: {
                gte: new Date('2025-10-26'),
                lte: new Date('2025-10-28')
            }
        },
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
        },
        orderBy: { created: 'asc' }
    });
    
    console.log(`   📅 Prize actions Oct 26-28: ${allPrizeActions.length}`);
    
    if (allPrizeActions.length > 0) {
        console.log(`   📊 Prize action date distribution:`);
        const dateGroups = allPrizeActions.reduce((acc, action) => {
            const dateKey = action.created.toISOString().split('T')[0];
            if (!acc[dateKey]) {
                acc[dateKey] = [];
            }
            acc[dateKey].push(action);
            return acc;
        }, {} as Record<string, typeof allPrizeActions>);
        
        for (const [date, actions] of Object.entries(dateGroups)) {
            const totalAmount = actions.reduce((sum, a) => sum + a.amount, 0);
            console.log(`      ${date}: ${actions.length} actions, ${totalAmount/100}€ total`);
        }
        
        // Show some example prize actions with their exact timestamps
        console.log(`\n   🎯 Example prize actions:`);
        for (const action of allPrizeActions.slice(0, 5)) {
            console.log(`      ${action.balance.user.name}: ${action.amount/100}€ at ${action.created.toISOString()} (ref: ${action.reference})`);
        }
    }
    
    console.log('\n✅ Completed checking balance actions for October 27, 2025');
}

main()
    .catch((e) => {
        console.error('❌ Error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await db.$disconnect();
    });
