/**
 * Fix Prize Balance Actions for November 2, 2025
 * 
 * Deletes incorrect PRIZE balance actions and recreates them using the correct logic.
 * This fixes the issue where duplicate codes weren't being handled correctly.
 * 
 * Run with: npx ts-node src/scripts/fix-prize-balance-actions-nov2.ts
 */

import 'reflect-metadata';
import { PrismaClient, BalanceActionType, Role } from '@prisma/client';
import { container } from 'tsyringe';
import { PrizeService } from '../features/prize/services/PrizeService';
import { Context } from '../common/utils/context';
import prisma from '../common/utils/prisma';
import { DateTime } from 'luxon';

// Register PrizeService
container.register("Database", { useValue: prisma });

async function main() {
    return new Promise((resolve, reject) => {
        Context.run(async () => {
            try {
                const dateStr = '2025-11-02';
                const date = new Date(dateStr + 'T00:00:00');
                
                console.log(`Fixing prize balance actions for ${dateStr}...\n`);

                // Mock admin context
                Context.set('user', { id: 1, role: Role.ADMIN });

                // Build day boundaries in Amsterdam timezone
                const amsterdamDate = DateTime.fromJSDate(date).setZone('Europe/Amsterdam');
                const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
                const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();

                console.log(`Date range: ${startOfDay.toISOString()} to ${endOfDay.toISOString()}\n`);

                // Find all PRIZE balance actions for this date
                const existingActions = await prisma.balanceAction.findMany({
                    where: {
                        type: BalanceActionType.PRIZE,
                        created: {
                            gte: startOfDay,
                            lte: endOfDay
                        },
                        reference: {
                            startsWith: 'PRIZE:'
                        }
                    },
                    include: {
                        balance: {
                            select: {
                                userID: true
                            }
                        }
                    }
                });

                console.log(`Found ${existingActions.length} existing PRIZE balance actions\n`);

                // Delete all existing prize actions for this date
                let deleted = 0;
                let balanceAdjustments = new Map<number, number>(); // Map<balanceID, totalAmountToReverse>

                for (const action of existingActions) {
                    // Track how much we need to reverse from balances
                    // action.amount is negative (e.g., -75000), meaning balance was incremented by +75000
                    // To reverse: we need to decrement by 75000, so we track the positive amount
                    const currentAmount = balanceAdjustments.get(action.balanceID) || 0;
                    const amountToReverse = Math.abs(action.amount); // Convert negative to positive
                    balanceAdjustments.set(action.balanceID, currentAmount + amountToReverse);
                    
                    await prisma.balanceAction.delete({
                        where: { id: action.id }
                    });
                    deleted++;
                }

                console.log(`Deleted ${deleted} balance actions\n`);

                // Adjust balances back (reverse the prize amounts that were incorrectly added)
                for (const [balanceID, amountToReverse] of balanceAdjustments) {
                    await prisma.balance.update({
                        where: { id: balanceID },
                        data: {
                            balance: { decrement: amountToReverse }
                        }
                    });
                }

                console.log(`Adjusted ${balanceAdjustments.size} balances\n`);

                // Now recreate prize actions using PrizeService logic
                const prizeService = container.resolve(PrizeService);
                const prizeData = await prizeService.getPrizesByDate(date, undefined, 1, 1000);
    
                console.log(`Found ${prizeData.totalTickets} winning tickets\n`);
    
                let created = 0;
                let errors = 0;

                // Group by ticket + code to sum values (PrizeService already expands occurrences)
                const ticketCodeMap = new Map<string, { ticketID: number; code: string; totalValue: number; creatorID: number; raffleID: number }>();

                for (const group of prizeData.groups) {
                    for (const ticket of group.tickets) {
                        // Get raffle ID for this game
                        const ticketData = await prisma.ticket.findUnique({
                            where: { id: ticket.id },
                            select: {
                                games: {
                                    where: { gameID: group.game.id },
                                    select: {
                                        game: {
                                            select: {
                                                raffles: {
                                                    where: {
                                                        created: {
                                                            gte: startOfDay,
                                                            lte: endOfDay
                                                        }
                                                    },
                                                    select: { id: true },
                                                    take: 1
                                                }
                                            }
                                        }
                                    }
                                },
                                codes: {
                                    where: {
                                        code: { in: ticket.codes.map(c => c.code) }
                                    },
                                    select: { id: true, code: true }
                                }
                            }
                        });

                        if (!ticketData) {
                            console.log(`⚠️  Ticket ${ticket.id} not found`);
                            continue;
                        }

                        const raffleID = ticketData.games[0]?.game?.raffles[0]?.id;
                        if (!raffleID) {
                            console.log(`⚠️  No raffle found for ticket ${ticket.id}, game ${group.game.id}`);
                            continue;
                        }

                        // Group codes by code string and sum their values
                        const codeTotals = new Map<string, number>();
                        const codeIds = new Map<string, number>(); // Store first code ID for reference

                        for (const prizeCode of ticket.codes) {
                            const currentTotal = codeTotals.get(prizeCode.code) || 0;
                            codeTotals.set(prizeCode.code, currentTotal + prizeCode.value);

                            // Store first code ID for this code string
                            if (!codeIds.has(prizeCode.code)) {
                                const codeRecord = ticketData.codes.find(c => c.code === prizeCode.code);
                                if (codeRecord) {
                                    codeIds.set(prizeCode.code, codeRecord.id);
                                }
                            }
                        }

                        // Create one balance action per unique code with total value
                        for (const [codeStr, totalValue] of codeTotals) {
                            const codeID = codeIds.get(codeStr);
                            if (!codeID) {
                                console.log(`⚠️  No code ID found for ticket ${ticket.id}, code ${codeStr}`);
                                continue;
                            }

                            const reference = `PRIZE:${raffleID}:${ticket.id}:${codeID}`;

                            try {
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
                                            amount: -totalValue, // Negative to add to balance
                                            reference,
                                            created: endOfDay // Use end of day for consistency
                                        }
                                    });

                                    await tx.balance.update({
                                        where: { id: balance.id },
                                        data: {
                                            balance: { increment: totalValue }
                                        }
                                    });
                                });

                                console.log(`✅ Created prize action for ticket ${ticket.id}, code ${codeStr} (codeID ${codeID}): ${totalValue/100} EUR`);
                                created++;

                            } catch (error) {
                                console.error(`❌ Error processing ticket ${ticket.id}, code ${codeStr}:`, error);
                                errors++;
                            }
                        }
                    }
                }

                console.log('\n' + '='.repeat(50));
                console.log('Fix complete!');
                console.log(`🗑️  Deleted: ${deleted}`);
                console.log(`✅ Created: ${created}`);
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

