import "reflect-metadata";
import { PrismaClient, BalanceActionType, Role } from "@prisma/client";
import { DateTime } from 'luxon';

const prisma = new PrismaClient();

const MANAGER_PROVISION_PERCENTAGE = 25; // All managers get 25% total provision

interface CorrectionResult {
    managerID: number;
    managerName: string;
    date: string;
    oldOwnProvision: number;
    newOwnProvision: number;
    oldRunnersProvision: number;
    newRunnersProvision: number;
    totalDifference: number;
    corrected: boolean;
    error?: string;
}

async function fixManagerProvisionForDate(
    managerID: number,
    date: Date,
    dryRun: boolean = true
): Promise<CorrectionResult | null> {
    console.log(`\n=== Fixing Manager Provision ===`);
    console.log(`Manager ID: ${managerID}`);
    console.log(`Date: ${date.toISOString()}`);
    console.log(`Dry run: ${dryRun}\n`);

    // Build day boundaries in Amsterdam timezone
    const amsterdamDate = DateTime.fromJSDate(date).setZone('Europe/Amsterdam');
    const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
    const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();
    const dateStr = amsterdamDate.toFormat('dd-MM-yyyy');

    // Get manager info
    const manager = await prisma.user.findUnique({
        where: { id: managerID },
        select: {
            id: true,
            name: true,
            commission: true,
            role: true,
            balance: {
                select: {
                    id: true,
                    balance: true
                }
            }
        }
    });

    if (!manager) {
        console.error(`Manager with ID ${managerID} not found`);
        return null;
    }

    if (manager.role !== Role.MANAGER) {
        console.error(`User ${manager.name} (ID: ${managerID}) is not a manager`);
        return null;
    }

    console.log(`Manager: ${manager.name} (ID: ${manager.id})`);
    console.log(`Manager Commission: ${manager.commission}%\n`);

    // Get existing provision actions
    const existingOwnProvision = await prisma.balanceAction.findFirst({
        where: {
            balance: {
                userID: manager.id
            },
            type: BalanceActionType.PROVISION,
            reference: `Provisie ${dateStr}`,
            created: {
                gte: startOfDay,
                lte: endOfDay
            }
        }
    });

    const existingRunnersProvision = await prisma.balanceAction.findFirst({
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

    const oldOwnProvision = existingOwnProvision ? Math.abs(existingOwnProvision.amount) : 0;
    const oldRunnersProvision = existingRunnersProvision ? Math.abs(existingRunnersProvision.amount) : 0;

    console.log(`Existing own provision: €${(oldOwnProvision / 100).toFixed(2)}`);
    console.log(`Existing runners provision: €${(oldRunnersProvision / 100).toFixed(2)}\n`);

    // Calculate correct own provision
    const managerTickets = await prisma.ticket.findMany({
        where: {
            creatorID: manager.id,
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

    let ownTicketSales = 0;
    for (const ticket of managerTickets) {
        const gameCount = ticket.games.length;
        const ticketValue = ticket.codes.reduce((sum, code) => sum + (code.value * gameCount), 0);
        ownTicketSales += ticketValue;
    }

    const newOwnProvision = Math.round((ownTicketSales * manager.commission) / 100);

    console.log(`Manager's own ticket sales: €${(ownTicketSales / 100).toFixed(2)}`);
    console.log(`Correct own provision (${manager.commission}%): €${(newOwnProvision / 100).toFixed(2)}\n`);

    // Calculate correct runners provision
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

    let newRunnersProvision = 0;
    for (const managerRunner of managerRunners) {
        const runner = managerRunner.runner;
        
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

        let runnerTicketSales = 0;
        for (const ticket of runnerTickets) {
            const gameCount = ticket.games.length;
            const ticketValue = ticket.codes.reduce((sum, code) => sum + (code.value * gameCount), 0);
            runnerTicketSales += ticketValue;
        }

        const managerProvisionPercentage = MANAGER_PROVISION_PERCENTAGE - runner.commission;
        if (managerProvisionPercentage > 0) {
            const managerProvisionFromRunner = Math.round((runnerTicketSales * managerProvisionPercentage) / 100);
            newRunnersProvision += managerProvisionFromRunner;
            
            if (runnerTicketSales > 0) {
                console.log(`  Runner ${runner.name}: €${(runnerTicketSales / 100).toFixed(2)} → ${managerProvisionPercentage}% = €${(managerProvisionFromRunner / 100).toFixed(2)}`);
            }
        }
    }

    console.log(`\nCorrect runners provision: €${(newRunnersProvision / 100).toFixed(2)}\n`);

    const ownDifference = newOwnProvision - oldOwnProvision;
    const runnersDifference = newRunnersProvision - oldRunnersProvision;
    const totalDifference = ownDifference + runnersDifference;

    console.log(`=== Differences ===`);
    console.log(`Own provision difference: €${(ownDifference / 100).toFixed(2)}`);
    console.log(`Runners provision difference: €${(runnersDifference / 100).toFixed(2)}`);
    console.log(`Total difference: €${(totalDifference / 100).toFixed(2)}\n`);

    if (totalDifference === 0) {
        console.log(`No correction needed - values are already correct\n`);
        return {
            managerID: manager.id,
            managerName: manager.name,
            date: dateStr,
            oldOwnProvision,
            newOwnProvision,
            oldRunnersProvision,
            newRunnersProvision,
            totalDifference: 0,
            corrected: false
        };
    }

    if (dryRun) {
        console.log(`DRY RUN - Would correct provision actions and balance\n`);
        return {
            managerID: manager.id,
            managerName: manager.name,
            date: dateStr,
            oldOwnProvision,
            newOwnProvision,
            oldRunnersProvision,
            newRunnersProvision,
            totalDifference,
            corrected: false
        };
    }

    // Apply corrections
    try {
        const balance = manager.balance;
        if (!balance) {
            throw new Error(`No balance record found for manager ${manager.id}`);
        }

        // Update or create own provision action
        if (existingOwnProvision) {
            if (ownDifference !== 0) {
                // Update existing action
                await prisma.balanceAction.update({
                    where: { id: existingOwnProvision.id },
                    data: {
                        amount: -newOwnProvision
                    }
                });
                console.log(`✓ Updated own provision action ${existingOwnProvision.id}`);
            }
        } else if (newOwnProvision > 0) {
            // Create new action
            await prisma.balanceAction.create({
                data: {
                    balanceID: balance.id,
                    type: BalanceActionType.PROVISION,
                    amount: -newOwnProvision,
                    reference: `Provisie ${dateStr}`,
                    created: endOfDay
                }
            });
            console.log(`✓ Created own provision action`);
        }

        // Update or create runners provision action
        if (existingRunnersProvision) {
            if (runnersDifference !== 0) {
                if (newRunnersProvision > 0) {
                    // Update existing action
                    await prisma.balanceAction.update({
                        where: { id: existingRunnersProvision.id },
                        data: {
                            amount: -newRunnersProvision
                        }
                    });
                    console.log(`✓ Updated runners provision action ${existingRunnersProvision.id}`);
                } else {
                    // Delete if should be zero
                    await prisma.balanceAction.delete({
                        where: { id: existingRunnersProvision.id }
                    });
                    console.log(`✓ Deleted runners provision action ${existingRunnersProvision.id} (should be zero)`);
                }
            }
        } else if (newRunnersProvision > 0) {
            // Create new action
            await prisma.balanceAction.create({
                data: {
                    balanceID: balance.id,
                    type: BalanceActionType.PROVISION,
                    amount: -newRunnersProvision,
                    reference: `Provisie lopers ${dateStr}`,
                    created: endOfDay
                }
            });
            console.log(`✓ Created runners provision action`);
        }

        // Update balance
        if (totalDifference !== 0) {
            await prisma.balance.update({
                where: { id: balance.id },
                data: {
                    balance: {
                        increment: totalDifference // Positive because we're reducing the negative provision
                    }
                }
            });
            console.log(`✓ Updated balance by €${(totalDifference / 100).toFixed(2)}`);
        }

        console.log(`\n✓ Correction completed successfully\n`);

        return {
            managerID: manager.id,
            managerName: manager.name,
            date: dateStr,
            oldOwnProvision,
            newOwnProvision,
            oldRunnersProvision,
            newRunnersProvision,
            totalDifference,
            corrected: true
        };
    } catch (error: any) {
        console.error(`✗ Error correcting provision: ${error.message}\n`);
        return {
            managerID: manager.id,
            managerName: manager.name,
            date: dateStr,
            oldOwnProvision,
            newOwnProvision,
            oldRunnersProvision,
            newRunnersProvision,
            totalDifference,
            corrected: false,
            error: error.message
        };
    }
}

async function fixAllManagersForDate(date: Date, dryRun: boolean = true): Promise<void> {
    console.log(`\n=== Fixing All Managers ===`);
    console.log(`Date: ${date.toISOString()}`);
    console.log(`Dry run: ${dryRun}\n`);

    const managers = await prisma.user.findMany({
        where: {
            role: Role.MANAGER
        },
        select: {
            id: true,
            name: true
        }
    });

    console.log(`Found ${managers.length} managers\n`);

    const results: CorrectionResult[] = [];

    for (const manager of managers) {
        const result = await fixManagerProvisionForDate(manager.id, date, dryRun);
        if (result) {
            results.push(result);
        }
        console.log('\n' + '='.repeat(80) + '\n');
    }

    // Summary
    console.log(`\n=== Summary ===`);
    const corrected = results.filter(r => r.corrected);
    const needsCorrection = results.filter(r => r.totalDifference !== 0 && !r.corrected);
    const alreadyCorrect = results.filter(r => r.totalDifference === 0);

    console.log(`Total managers: ${results.length}`);
    console.log(`Already correct: ${alreadyCorrect.length}`);
    console.log(`Needs correction: ${needsCorrection.length}`);
    console.log(`Corrected: ${corrected.length}\n`);

    if (needsCorrection.length > 0) {
        console.log(`Managers needing correction:`);
        needsCorrection.forEach(r => {
            console.log(`  ${r.managerName} (ID: ${r.managerID}): €${(r.totalDifference / 100).toFixed(2)} difference`);
        });
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage:');
        console.log('  Fix specific manager: ts-node fix-manager-provisions.ts <managerID> <date> [--apply]');
        console.log('  Fix all managers: ts-node fix-manager-provisions.ts --all <date> [--apply]');
        console.log('\nDate format: YYYY-MM-DD');
        console.log('Add --apply flag to actually apply corrections (default is dry run)');
        process.exit(1);
    }

    const dryRun = !args.includes('--apply');
    const dateArg = args.find(arg => /^\d{4}-\d{2}-\d{2}$/.test(arg));
    
    if (!dateArg) {
        console.error('Date is required (format: YYYY-MM-DD)');
        process.exit(1);
    }

    const date = DateTime.fromFormat(dateArg, 'yyyy-MM-dd', { zone: 'Europe/Amsterdam' }).toJSDate();

    if (args[0] === '--all') {
        await fixAllManagersForDate(date, dryRun);
    } else {
        const managerID = parseInt(args[0]);
        if (isNaN(managerID)) {
            console.error(`Invalid manager ID: ${args[0]}`);
            process.exit(1);
        }
        await fixManagerProvisionForDate(managerID, date, dryRun);
    }

    await prisma.$disconnect();
}

main()
    .then(() => {
        console.log('\nScript completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Error running script:', error);
        process.exit(1);
    });

