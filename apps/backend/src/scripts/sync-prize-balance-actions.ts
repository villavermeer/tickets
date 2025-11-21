/**
 * Sync Prize Balance Actions
 * 
 * Creates missing PRIZE balance actions by comparing what PrizeService calculates
 * versus what balance actions exist in the database.
 * 
 * Run with: npx ts-node src/scripts/sync-prize-balance-actions.ts [date]
 */

import 'reflect-metadata';
import { PrismaClient, BalanceActionType, Role } from '@prisma/client';
import { container } from 'tsyringe';
import { PrizeService } from '../features/prize/services/PrizeService';
import { Context } from '../common/utils/context';
import prisma from '../common/utils/prisma';
import { createPrizeReference } from '../features/raffle/utils/prizeReference';

// Register PrizeService
container.register("Database", { useValue: prisma });

async function main() {
    return new Promise((resolve, reject) => {
        Context.run(async () => {
            try {
        const dateArg = process.argv[2] || '2025-10-20';
        const date = new Date(dateArg);
        
        console.log(`Syncing prize balance actions for ${date.toISOString().split('T')[0]}...\n`);

        // Mock admin context for PrizeService
        Context.set('user', { id: 1, role: Role.ADMIN });

        const prizeService = container.resolve(PrizeService);
        
        // Get all prizes for the date (no scope, get all users)
        const prizeData = await prizeService.getPrizesByDate(date, undefined, 1, 1000);
    
    console.log(`Found ${prizeData.totalTickets} winning tickets\n`);
    
    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const group of prizeData.groups) {
        for (const ticket of group.tickets) {
            for (const prizeCode of ticket.codes) {
                try {
                    // Get the actual ticket to find the raffle
                    const ticketData = await prisma.ticket.findUnique({
                        where: { id: ticket.id },
                        select: { 
                            created: true,
                            games: {
                                where: { gameID: group.game.id },
                                select: { 
                                    game: { 
                                        select: { 
                                            raffles: {
                                                where: { created: date },
                                                select: { id: true }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    });

                    if (!ticketData) {
                        console.log(`⚠️  Ticket ${ticket.id} not found`);
                        skipped++;
                        continue;
                    }

                    const raffleID = ticketData.games[0]?.game?.raffles[0]?.id;
                    if (!raffleID) {
                        console.log(`⚠️  No raffle found for ticket ${ticket.id}, game ${group.game.id}`);
                        skipped++;
                        continue;
                    }

                    const reference = createPrizeReference(raffleID, ticket.id, prizeCode.code);

                    // Check if balance action already exists
                    const existing = await prisma.balanceAction.findFirst({
                        where: { reference },
                        select: { id: true }
                    });

                    if (existing) {
                        skipped++;
                        continue;
                    }

                    // Get or create balance
                    const balance = await prisma.balance.upsert({
                        where: { userID: ticket.creatorID },
                        update: {},
                        create: { userID: ticket.creatorID, balance: 0 },
                        select: { id: true }
                    });

                    // Create prize balance action
                    await prisma.$transaction(async (tx) => {
                        await tx.balanceAction.create({
                            data: {
                                balanceID: balance.id,
                                type: BalanceActionType.PRIZE,
                                amount: -prizeCode.value,
                                reference,
                                created: ticketData.created, // Date to ticket creation
                            }
                        });

                        await tx.balance.update({
                            where: { id: balance.id },
                            data: { balance: { decrement: prizeCode.value } }
                        });
                    });

                    console.log(`✅ Created prize action for ticket ${ticket.id}, code ${prizeCode.code}: ${prizeCode.value/100} EUR`);
                    created++;

                } catch (error) {
                    console.error(`❌ Error processing ticket ${ticket.id}, code ${prizeCode.code}:`, error);
                    errors++;
                }
            }
        }
    }

                console.log('\n' + '='.repeat(50));
                console.log('Sync complete!');
                console.log(`✅ Created: ${created}`);
                console.log(`⏭️  Skipped (already exist): ${skipped}`);
                console.log(`❌ Errors: ${errors}`);
                console.log('='.repeat(50));
                resolve(undefined);
            } catch (error) {
                reject(error);
            }
        });
    });
}

main()
    .catch((e) => {
        console.error('Fatal error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

