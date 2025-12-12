import "reflect-metadata";
import { PrismaClient, BalanceActionType, Role } from "@prisma/client";
import { DateTime } from 'luxon';

const prisma = new PrismaClient();

const MANAGER_PROVISION_PERCENTAGE = 25; // All managers get 25% total provision

interface TestResult {
    managerID: number;
    managerName: string;
    managerCommission: number;
    ownTicketSales: number;
    ownProvision: number;
    runners: Array<{
        runnerID: number;
        runnerName: string;
        runnerCommission: number;
        ticketSales: number;
        managerProvisionPercentage: number;
        managerProvisionAmount: number;
    }>;
    totalProvisionFromRunners: number;
    totalProvision: number; // own + from runners
    existingProvisionActions: Array<{
        id: number;
        amount: number;
        reference: string | null;
        created: Date;
    }>;
}

async function testManagerProvision(
    managerID: number,
    date: Date
): Promise<TestResult | null> {
    console.log(`\n=== Testing Manager Provision ===`);
    console.log(`Manager ID: ${managerID}`);
    console.log(`Date: ${date.toISOString()}\n`);

    // Build day boundaries in Amsterdam timezone
    const amsterdamDate = DateTime.fromJSDate(date).setZone('Europe/Amsterdam');
    const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
    const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();
    const dateStr = amsterdamDate.toFormat('dd-MM-yyyy');

    console.log(`Date range: ${startOfDay.toISOString()} to ${endOfDay.toISOString()}`);
    console.log(`Amsterdam date: ${dateStr}\n`);

    // Get manager info
    const manager = await prisma.user.findUnique({
        where: { id: managerID },
        select: {
            id: true,
            name: true,
            commission: true,
            role: true
        }
    });

    if (!manager) {
        console.error(`Manager with ID ${managerID} not found`);
        return null;
    }

    if (manager.role !== Role.MANAGER) {
        console.error(`User ${manager.name} (ID: ${managerID}) is not a manager (role: ${manager.role})`);
        return null;
    }

    console.log(`Manager: ${manager.name} (ID: ${manager.id})`);
    console.log(`Manager Commission: ${manager.commission}%\n`);

    // Get manager's own tickets
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

    // Calculate manager's own ticket sales
    let ownTicketSales = 0;
    for (const ticket of managerTickets) {
        const gameCount = ticket.games.length;
        const ticketValue = ticket.codes.reduce((sum, code) => sum + (code.value * gameCount), 0);
        ownTicketSales += ticketValue;
    }

    const ownProvision = Math.round((ownTicketSales * manager.commission) / 100);

    console.log(`Manager's own ticket sales: €${(ownTicketSales / 100).toFixed(2)}`);
    console.log(`Manager's own provision (${manager.commission}%): €${(ownProvision / 100).toFixed(2)}\n`);

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

    console.log(`Found ${managerRunners.length} runners under this manager\n`);

    const runners: TestResult['runners'] = [];
    let totalProvisionFromRunners = 0;

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

        // Calculate total ticket sales for this runner
        let runnerTicketSales = 0;
        for (const ticket of runnerTickets) {
            const gameCount = ticket.games.length;
            const ticketValue = ticket.codes.reduce((sum, code) => sum + (code.value * gameCount), 0);
            runnerTicketSales += ticketValue;
        }

        // Calculate manager's provision from this runner
        const managerProvisionPercentage = MANAGER_PROVISION_PERCENTAGE - runner.commission;
        const managerProvisionFromRunner = managerProvisionPercentage > 0 
            ? Math.round((runnerTicketSales * managerProvisionPercentage) / 100)
            : 0;

        runners.push({
            runnerID: runner.id,
            runnerName: runner.name,
            runnerCommission: runner.commission,
            ticketSales: runnerTicketSales,
            managerProvisionPercentage: managerProvisionPercentage > 0 ? managerProvisionPercentage : 0,
            managerProvisionAmount: managerProvisionFromRunner
        });

        if (managerProvisionFromRunner > 0) {
            totalProvisionFromRunners += managerProvisionFromRunner;
            console.log(`  Runner: ${runner.name} (ID: ${runner.id})`);
            console.log(`    Commission: ${runner.commission}%`);
            console.log(`    Ticket Sales: €${(runnerTicketSales / 100).toFixed(2)}`);
            console.log(`    Manager gets: ${managerProvisionPercentage}% (25% - ${runner.commission}%)`);
            console.log(`    Manager Provision: €${(managerProvisionFromRunner / 100).toFixed(2)}\n`);
        } else {
            console.log(`  Runner: ${runner.name} (ID: ${runner.id})`);
            console.log(`    Commission: ${runner.commission}%`);
            console.log(`    Ticket Sales: €${(runnerTicketSales / 100).toFixed(2)}`);
            console.log(`    Manager gets: 0% (runner commission >= 25%)\n`);
        }
    }

    const totalProvision = ownProvision + totalProvisionFromRunners;

    console.log(`=== Summary ===`);
    console.log(`Manager's own provision: €${(ownProvision / 100).toFixed(2)}`);
    console.log(`Total provision from runners: €${(totalProvisionFromRunners / 100).toFixed(2)}`);
    console.log(`Total provision: €${(totalProvision / 100).toFixed(2)}\n`);

    // Get existing provision actions for this manager and date
    const existingProvisionActions = await prisma.balanceAction.findMany({
        where: {
            balance: {
                userID: manager.id
            },
            type: BalanceActionType.PROVISION,
            created: {
                gte: startOfDay,
                lte: endOfDay
            }
        },
        select: {
            id: true,
            amount: true,
            reference: true,
            created: true
        },
        orderBy: {
            created: 'asc'
        }
    });

    console.log(`=== Existing Provision Actions ===`);
    if (existingProvisionActions.length === 0) {
        console.log(`No provision actions found for this date\n`);
    } else {
        let totalExisting = 0;
        for (const action of existingProvisionActions) {
            const amount = Math.abs(action.amount);
            totalExisting += amount;
            console.log(`  ID: ${action.id}, Amount: -€${(amount / 100).toFixed(2)}, Reference: ${action.reference}, Created: ${action.created.toISOString()}`);
        }
        console.log(`  Total existing provision: €${(totalExisting / 100).toFixed(2)}\n`);
        console.log(`  Expected total: €${(totalProvision / 100).toFixed(2)}`);
        console.log(`  Difference: €${((totalExisting - totalProvision) / 100).toFixed(2)}\n`);
    }

    return {
        managerID: manager.id,
        managerName: manager.name,
        managerCommission: manager.commission,
        ownTicketSales,
        ownProvision,
        runners,
        totalProvisionFromRunners,
        totalProvision,
        existingProvisionActions: existingProvisionActions.map(a => ({
            id: a.id,
            amount: a.amount,
            reference: a.reference || '',
            created: a.created
        }))
    };
}

async function testAllManagers(date: Date): Promise<void> {
    console.log(`\n=== Testing All Managers ===`);
    console.log(`Date: ${date.toISOString()}\n`);

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

    for (const manager of managers) {
        await testManagerProvision(manager.id, date);
        console.log('\n' + '='.repeat(80) + '\n');
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('Usage:');
        console.log('  Test specific manager: ts-node test-manager-provision.ts <managerID> [date]');
        console.log('  Test all managers: ts-node test-manager-provision.ts --all [date]');
        console.log('\nDate format: YYYY-MM-DD (default: yesterday)');
        process.exit(1);
    }

    let date: Date;
    if (args.length > 1 && args[1] !== '--all') {
        // Date provided
        date = DateTime.fromFormat(args[1], 'yyyy-MM-dd', { zone: 'Europe/Amsterdam' }).toJSDate();
    } else if (args[0] === '--all' && args.length > 1) {
        date = DateTime.fromFormat(args[1], 'yyyy-MM-dd', { zone: 'Europe/Amsterdam' }).toJSDate();
    } else {
        // Default to yesterday
        date = DateTime.now().setZone('Europe/Amsterdam').minus({ days: 1 }).toJSDate();
    }

    if (args[0] === '--all') {
        await testAllManagers(date);
    } else {
        const managerID = parseInt(args[0]);
        if (isNaN(managerID)) {
            console.error(`Invalid manager ID: ${args[0]}`);
            process.exit(1);
        }
        await testManagerProvision(managerID, date);
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
