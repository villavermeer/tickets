import "reflect-metadata";
import { container } from "tsyringe";
import { PrismaClient, BalanceActionType, Role } from "@prisma/client";
import { DateTime } from 'luxon';

const prisma = new PrismaClient();

const MANAGER_PROVISION_PERCENTAGE = 25; // All managers get 25% total provision

async function calculateManagerProvisionFromRunners(
    manager: { id: number; name: string; balance: { id: number } | null },
    startOfDay: Date,
    endOfDay: Date,
    dateStr: string
): Promise<{ provisionAmount: number; created: boolean; skipped: boolean }> {
    // Get all runners under this manager
    const managerRunners = await prisma.managerRunner.findMany({
        where: {
            managerID: manager.id
        },
        include: {
            runner: {
                select: {
                    id: true,
                    name: true,
                    commission: true
                }
            }
        }
    });

    if (managerRunners.length === 0) {
        return { provisionAmount: 0, created: false, skipped: true };
    }

    let totalManagerProvisionFromRunners = 0;

    // For each runner, calculate manager's provision
    for (const managerRunner of managerRunners) {
        const runner = managerRunner.runner;
        
        // Get all tickets created by this runner on the date
        const runnerTickets = await prisma.ticket.findMany({
            where: {
                creatorID: runner.id,
                created: {
                    gte: startOfDay,
                    lte: endOfDay
                }
            },
            include: {
                codes: true,
                games: true
            }
        });

        if (runnerTickets.length === 0) {
            continue;
        }

        // Calculate total ticket sales for this runner
        let runnerTicketSales = 0;
        for (const ticket of runnerTickets) {
            const gameCount = ticket.games.length;
            const ticketValue = ticket.codes.reduce((sum, code) => sum + (code.value * gameCount), 0);
            runnerTicketSales += ticketValue;
        }

        if (runnerTicketSales === 0) {
            continue;
        }

        // Calculate manager's provision from this runner
        // Manager gets: (25% - runner_commission%) of runner's ticket sales
        const managerProvisionPercentage = MANAGER_PROVISION_PERCENTAGE - runner.commission;
        
        if (managerProvisionPercentage <= 0) {
            continue;
        }

        const managerProvisionFromRunner = Math.round((runnerTicketSales * managerProvisionPercentage) / 100);
        
        if (managerProvisionFromRunner > 0) {
            totalManagerProvisionFromRunners += managerProvisionFromRunner;
        }
    }

    if (totalManagerProvisionFromRunners === 0) {
        return { provisionAmount: 0, created: false, skipped: true };
    }

    // Check if manager provision from runners already exists for this date
    const existingManagerProvision = await prisma.balanceAction.findFirst({
        where: {
            balance: {
                userID: manager.id
            },
            type: BalanceActionType.PROVISION,
            reference: {
                contains: `Provisie lopers ${dateStr}`
            },
            created: {
                gte: startOfDay,
                lte: endOfDay
            }
        }
    });

    if (existingManagerProvision) {
        console.log(`  Manager ${manager.name} (${manager.id}): provision already exists, skipping`);
        return { provisionAmount: totalManagerProvisionFromRunners, created: false, skipped: true };
    }

    // Get or create balance for the manager
    let balance = manager.balance;
    if (!balance) {
        const createdBalance = await prisma.balance.create({
            data: {
                userID: manager.id,
                balance: 0
            }
        });
        balance = { id: createdBalance.id };
        console.log(`  Created balance record for manager ${manager.name} (${manager.id})`);
    }

    // Create provision balance action for manager from runners (negative amount to deduct from balance)
    await prisma.balanceAction.create({
        data: {
            balanceID: balance.id,
            type: BalanceActionType.PROVISION,
            amount: -totalManagerProvisionFromRunners, // Negative to deduct from balance
            reference: `Provisie lopers ${dateStr}`,
            created: endOfDay // Set to end of day so it's the last action of the day
        }
    });

    // Update balance
    await prisma.balance.update({
        where: { id: balance.id },
        data: {
            balance: { decrement: totalManagerProvisionFromRunners }
        }
    });

    console.log(`  ✓ Created manager provision from runners for ${manager.name} (${manager.id}): -${totalManagerProvisionFromRunners / 100}€`);
    return { provisionAmount: totalManagerProvisionFromRunners, created: true, skipped: false };
}

async function fixManagerProvisionsLast7Days() {
    console.log('Starting manager provision backfill for last 7 days...');
    
    // Get all managers
    const managers = await prisma.user.findMany({
        where: {
            role: Role.MANAGER
        },
        select: {
            id: true,
            name: true,
            balance: {
                select: {
                    id: true
                }
            }
        }
    });

    console.log(`Found ${managers.length} managers`);

    let totalProvisionsCreated = 0;
    let totalProvisionsSkipped = 0;
    const dayStats: Array<{ date: string; created: number; skipped: number }> = [];

    // Loop through last 7 days (from 7 days ago to yesterday)
    for (let daysAgo = 7; daysAgo >= 1; daysAgo--) {
        const targetDate = DateTime.now().setZone('Europe/Amsterdam').minus({ days: daysAgo });
        const startOfDay = targetDate.startOf('day').toUTC().toJSDate();
        const endOfDay = targetDate.endOf('day').toUTC().toJSDate();
        const dateStr = targetDate.toFormat('dd-MM-yyyy');
        
        console.log(`\n=== Processing date: ${dateStr} (${daysAgo} day(s) ago) ===`);
        console.log(`Date range: ${startOfDay.toISOString()} to ${endOfDay.toISOString()}`);

        let dayProvisionsCreated = 0;
        let dayProvisionsSkipped = 0;

        for (const manager of managers) {
            const result = await calculateManagerProvisionFromRunners(
                manager,
                startOfDay,
                endOfDay,
                dateStr
            );

            if (result.created) {
                dayProvisionsCreated++;
            } else if (result.skipped) {
                dayProvisionsSkipped++;
            }
        }

        totalProvisionsCreated += dayProvisionsCreated;
        totalProvisionsSkipped += dayProvisionsSkipped;
        dayStats.push({ date: dateStr, created: dayProvisionsCreated, skipped: dayProvisionsSkipped });

        console.log(`Date ${dateStr}: ${dayProvisionsCreated} created, ${dayProvisionsSkipped} skipped`);
    }

    console.log('\n=== Summary ===');
    console.log(`Total provisions created: ${totalProvisionsCreated}`);
    console.log(`Total provisions skipped: ${totalProvisionsSkipped}`);
    console.log('\nPer-day breakdown:');
    dayStats.forEach(stat => {
        console.log(`  ${stat.date}: ${stat.created} created, ${stat.skipped} skipped`);
    });
    console.log('\nCompleted manager provision backfill for last 7 days');
}

fixManagerProvisionsLast7Days()
    .then(() => {
        console.log('\nScript completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Error running script:', error);
        process.exit(1);
    });

