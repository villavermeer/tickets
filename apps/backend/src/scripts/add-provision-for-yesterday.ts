import "reflect-metadata";
import { container } from "tsyringe";
import { PrismaClient, BalanceActionType } from "@prisma/client";
import { DateTime } from 'luxon';

const prisma = new PrismaClient();

async function addProvisionForYesterday() {
    console.log('Starting provision creation for yesterday...');
    
    // Get yesterday's date in Amsterdam timezone
    const yesterday = DateTime.now().setZone('Europe/Amsterdam').minus({ days: 1 });
    const startOfDay = yesterday.startOf('day').toUTC().toJSDate();
    const endOfDay = yesterday.endOf('day').toUTC().toJSDate();
    
    console.log(`Date range: ${startOfDay.toISOString()} to ${endOfDay.toISOString()}`);
    console.log(`Amsterdam date: ${yesterday.toFormat('dd-MM-yyyy')}`);

    // Get all users with their commission percentage
    const users = await prisma.user.findMany({
        select: {
            id: true,
            name: true,
            commission: true,
            balance: {
                select: {
                    id: true
                }
            }
        },
        where: {
            commission: {
                gt: 0 // Only users with commission > 0
            }
        }
    });

    console.log(`Found ${users.length} users with commission > 0`);

    let provisionsCreated = 0;
    let provisionsSkipped = 0;

    // For each user, calculate their ticket sales and create provision balance action
    for (const user of users) {
        // Get all tickets created by this user on yesterday
        const tickets = await prisma.ticket.findMany({
            where: {
                creatorID: user.id,
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

        if (tickets.length === 0) {
            console.log(`User ${user.name} (${user.id}) has no tickets for this date, skipping provision`);
            provisionsSkipped++;
            continue;
        }

        // Calculate total ticket sales (Inleg) for this user
        // Each code value * number of games the ticket is entered in
        let totalTicketSales = 0;
        for (const ticket of tickets) {
            const gameCount = ticket.games.length;
            const ticketValue = ticket.codes.reduce((sum, code) => sum + (code.value * gameCount), 0);
            totalTicketSales += ticketValue;
        }

        if (totalTicketSales === 0) {
            console.log(`User ${user.name} (${user.id}) has zero ticket sales, skipping provision`);
            provisionsSkipped++;
            continue;
        }

        // Calculate provision (in cents)
        const provisionAmount = Math.round((totalTicketSales * user.commission) / 100);

        if (provisionAmount === 0) {
            console.log(`User ${user.name} (${user.id}) provision is zero, skipping`);
            provisionsSkipped++;
            continue;
        }

        console.log(`User ${user.name} (${user.id}): ticket sales=${totalTicketSales / 100}€, commission=${user.commission}%, provision=${provisionAmount / 100}€`);

        // Check if provision action already exists for this user and date
        const existingProvision = await prisma.balanceAction.findFirst({
            where: {
                balance: {
                    userID: user.id
                },
                type: BalanceActionType.PROVISION,
                created: {
                    gte: startOfDay,
                    lte: endOfDay
                }
            }
        });

        if (existingProvision) {
            console.log(`Provision already exists for user ${user.name} (${user.id}) on this date, skipping`);
            provisionsSkipped++;
            continue;
        }

        // Get or create balance for the user
        let balance = user.balance;
        if (!balance) {
            const createdBalance = await prisma.balance.create({
                data: {
                    userID: user.id,
                    balance: 0
                }
            });
            balance = { id: createdBalance.id };
            console.log(`Created balance record for user ${user.name} (${user.id})`);
        }

        // Create provision balance action (negative amount to deduct from balance)
        await prisma.balanceAction.create({
            data: {
                balanceID: balance.id,
                type: BalanceActionType.PROVISION,
                amount: -provisionAmount, // Negative to deduct from balance
                reference: `Provisie ${yesterday.toFormat('dd-MM-yyyy')}`,
                created: endOfDay // Set to end of day so it's the last action of the day
            }
        });

        // Update balance
        await prisma.balance.update({
            where: { id: balance.id },
            data: {
                balance: { decrement: provisionAmount }
            }
        });

        console.log(`✓ Created provision balance action for user ${user.name} (${user.id}): -${provisionAmount / 100}€`);
        provisionsCreated++;
    }

    console.log('\n=== Summary ===');
    console.log(`Provisions created: ${provisionsCreated}`);
    console.log(`Provisions skipped: ${provisionsSkipped}`);
    console.log('Completed provision creation for yesterday');
}

addProvisionForYesterday()
    .then(() => {
        console.log('\nScript completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Error running script:', error);
        process.exit(1);
    });

