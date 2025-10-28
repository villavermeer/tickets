import { PrismaClient, BalanceActionType } from '@prisma/client';
import { DateTime } from 'luxon';

const db = new PrismaClient();

/**
 * Fix missing balance actions for October 27, 2025
 * This script will:
 * 1. Check for existing raffles on October 27, 2025
 * 2. Create missing provision balance actions for users with tickets
 * 3. Create missing prize balance actions for winning tickets
 */

async function main() {
    console.log('🔍 Checking for missing balance actions on October 27, 2025...');
    
    // Set the target date (October 27, 2025)
    const targetDate = new Date('2025-10-27');
    
    // Build day boundaries in Amsterdam timezone
    const amsterdamDate = DateTime.fromJSDate(targetDate).setZone('Europe/Amsterdam');
    const startOfDay = amsterdamDate.startOf('day').toUTC().toJSDate();
    const endOfDay = amsterdamDate.endOf('day').toUTC().toJSDate();
    
    console.log(`📅 Target date: ${targetDate.toDateString()}`);
    console.log(`🕐 Start of day (UTC): ${startOfDay.toISOString()}`);
    console.log(`🕑 End of day (UTC): ${endOfDay.toISOString()}`);
    
    // Check for existing raffles on this date
    const raffles = await db.raffle.findMany({
        where: {
            created: { gte: startOfDay, lte: endOfDay }
        },
        include: {
            game: true,
            codes: true
        }
    });
    
    console.log(`🎲 Found ${raffles.length} raffles for October 27, 2025`);
    
    if (raffles.length === 0) {
        console.log('❌ No raffles found for this date. Balance actions cannot be created without raffles.');
        return;
    }
    
    // List the raffles found
    for (const raffle of raffles) {
        console.log(`   - Raffle ID ${raffle.id} for Game "${raffle.game.name}" (ID: ${raffle.gameID}) with ${raffle.codes.length} codes`);
    }
    
    console.log('\n📊 Creating missing provision balance actions...');
    await createProvisionBalanceActions(startOfDay, endOfDay);
    
    console.log('\n🏆 Creating missing prize balance actions...');
    await createPrizeBalanceActions(startOfDay, endOfDay, raffles);
    
    console.log('\n✅ Completed fixing missing balance actions for October 27, 2025');
}

/**
 * Create provision balance actions for all users based on their ticket sales for the given date
 */
async function createProvisionBalanceActions(startOfDay: Date, endOfDay: Date): Promise<void> {
    // Get all users with their commission percentage
    const users = await db.user.findMany({
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
    
    console.log(`   Found ${users.length} users with commission > 0`);
    
    let provisionsCreated = 0;
    let provisionsSkipped = 0;
    
    // For each user, calculate their ticket sales and create provision balance action
    for (const user of users) {
        // Check if provision action already exists for this user and date
        const existingProvision = await db.balanceAction.findFirst({
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
            console.log(`     ⏭️  Provision already exists for user ${user.name} (ID: ${user.id}), skipping`);
            provisionsSkipped++;
            continue;
        }
        
        // Get all tickets created by this user on the target date
        const tickets = await db.ticket.findMany({
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
            console.log(`     ⏭️  User ${user.name} (ID: ${user.id}) has no tickets for this date, skipping provision`);
            continue;
        }
        
        // Calculate total ticket sales (Inleg) for this user
        let totalTicketSales = 0;
        for (const ticket of tickets) {
            const gameCount = ticket.games.length;
            const ticketValue = ticket.codes.reduce((sum, code) => sum + (code.value * gameCount), 0);
            totalTicketSales += ticketValue;
        }
        
        if (totalTicketSales === 0) {
            console.log(`     ⏭️  User ${user.name} (ID: ${user.id}) has zero ticket sales, skipping provision`);
            continue;
        }
        
        // Calculate provision (in cents)
        const provisionAmount = Math.round((totalTicketSales * user.commission) / 100);
        
        if (provisionAmount === 0) {
            console.log(`     ⏭️  User ${user.name} (ID: ${user.id}) provision is zero, skipping`);
            continue;
        }
        
        console.log(`     💰 User ${user.name} (ID: ${user.id}): ticket sales=${totalTicketSales/100}€, commission=${user.commission}%, provision=${provisionAmount/100}€`);
        
        // Get or create balance for the user
        let balance = user.balance;
        if (!balance) {
            const createdBalance = await db.balance.create({
                data: {
                    userID: user.id,
                    balance: 0
                }
            });
            balance = { id: createdBalance.id };
        }
        
        // Create provision balance action (negative amount to deduct from balance)
        await db.balanceAction.create({
            data: {
                balanceID: balance.id,
                type: BalanceActionType.PROVISION,
                amount: -provisionAmount, // Negative to deduct from balance
                reference: `Provisie 27-10-2025`,
                created: endOfDay // Set to end of day so it's the last action of the day
            }
        });
        
        // Update balance
        await db.balance.update({
            where: { id: balance.id },
            data: {
                balance: { decrement: provisionAmount }
            }
        });
        
        console.log(`     ✅ Created provision balance action for user ${user.name} (ID: ${user.id}): -${provisionAmount/100}€`);
        provisionsCreated++;
    }
    
    console.log(`   📈 Provisions summary: ${provisionsCreated} created, ${provisionsSkipped} skipped`);
}

/**
 * Create prize balance actions for all winning tickets for the given date
 */
async function createPrizeBalanceActions(startOfDay: Date, endOfDay: Date, raffles: any[]): Promise<void> {
    // Group winning codes by game
    const winningCodesByGame = new Map<number, Array<{ code: string; order: number }>>();
    
    for (const raffle of raffles) {
        if (!winningCodesByGame.has(raffle.gameID)) {
            winningCodesByGame.set(raffle.gameID, []);
        }
        
        const codeToOrder = new Map<string, number>();
        for (const code of raffle.codes) {
            if (!codeToOrder.has(code.code)) {
                codeToOrder.set(code.code, codeToOrder.size + 1);
            }
            winningCodesByGame.get(raffle.gameID)!.push({
                code: code.code,
                order: codeToOrder.get(code.code)!
            });
        }
    }
    
    let prizesCreated = 0;
    let prizesSkipped = 0;
    
    // Process each game's winning tickets
    for (const [gameID, winningCodes] of winningCodesByGame) {
        if (winningCodes.length === 0) continue;
        
        const game = raffles.find(r => r.gameID === gameID)?.game;
        const uniqueWinningCodes = Array.from(new Set(winningCodes.map(wc => wc.code)));
        
        console.log(`   🎮 Processing Game "${game?.name}" (ID: ${gameID}) with winning codes: [${uniqueWinningCodes.join(', ')}]`);
        
        // Build suffix sets (2, 3, 4) for efficient filtering - same as PrizeService
        const suffix2 = new Set(uniqueWinningCodes.map(c => c.slice(-2)));
        const suffix3 = new Set(uniqueWinningCodes.map(c => c.slice(-3)));
        const suffix4 = new Set(uniqueWinningCodes.map(c => c.slice(-4)));
        
        console.log(`     📊 Suffix2: [${Array.from(suffix2).join(', ')}]`);
        console.log(`     📊 Suffix3: [${Array.from(suffix3).join(', ')}]`);
        console.log(`     📊 Suffix4: [${Array.from(suffix4).join(', ')}]`);
        
        // Find all winning tickets for this game - same logic as PrizeService
        const winningTickets = await db.ticket.findMany({
            where: {
                created: { gte: startOfDay, lte: endOfDay },
                games: { some: { gameID } },
                // Any code that equals any of the winning suffixes for 2, 3 or 4 digits
                codes: {
                    some: {
                        OR: [
                            { code: { in: Array.from(suffix2) } },
                            { code: { in: Array.from(suffix3) } },
                            { code: { in: Array.from(suffix4) } }
                        ]
                    }
                }
            },
            include: {
                codes: {
                    // Keep all played codes that can potentially win (2/3/4 length)
                    where: {
                        OR: [
                            { code: { in: Array.from(suffix2) } },
                            { code: { in: Array.from(suffix3) } },
                            { code: { in: Array.from(suffix4) } }
                        ]
                    },
                    select: { code: true, value: true }
                },
                creator: {
                    select: { id: true, name: true }
                }
            }
        });
        
        console.log(`     🎫 Found ${winningTickets.length} winning tickets for game ${game?.name}`);
        
        // Process each winning ticket
        for (const ticket of winningTickets) {
            for (const ticketCode of ticket.codes) {
                const prizeAmount = calculatePrizeAmount(
                    ticketCode.code,
                    ticketCode.value,
                    gameID,
                    winningCodes
                );
                
                if (prizeAmount <= 0) continue;
                
                const reference = `PRIZE:${raffles.find(r => r.gameID === gameID)?.id}:${ticket.id}:${ticketCode.code}`;
                
                // Check if prize action already exists
                const existingPrize = await db.balanceAction.findFirst({
                    where: { reference }
                });
                
                if (existingPrize) {
                    console.log(`       ⏭️  Prize action already exists for ticket ${ticket.id}, code ${ticketCode.code}, skipping`);
                    prizesSkipped++;
                    continue;
                }
                
                // Get or create balance for the user
                let balance = await db.balance.findUnique({
                    where: { userID: ticket.creator.id }
                });
                
                if (!balance) {
                    balance = await db.balance.create({
                        data: {
                            userID: ticket.creator.id,
                            balance: 0
                        }
                    });
                }
                
                    // Create prize balance action (negative amount - prizes add to user balance)
                    await db.balanceAction.create({
                        data: {
                            balanceID: balance.id,
                            type: BalanceActionType.PRIZE,
                            amount: -prizeAmount, // Negative to add to balance (same as RaffleService)
                            reference,
                            created: ticket.created // Use ticket creation date
                        }
                    });
                    
                    // Update balance (add the prize amount)
                    await db.balance.update({
                        where: { id: balance.id },
                        data: {
                            balance: { increment: prizeAmount }
                        }
                    });
                
                console.log(`       🏆 Created prize action for ${ticket.creator.name} (ticket ${ticket.id}, code ${ticketCode.code}): +${prizeAmount/100}€`);
                prizesCreated++;
            }
        }
    }
    
    console.log(`   🏆 Prizes summary: ${prizesCreated} created, ${prizesSkipped} skipped`);
}

/**
 * Calculate prize amount using the EXACT same logic as PrizeService.calculateWinningsForCode
 */
function calculatePrizeAmount(
    playedCode: string,
    stakeValue: number,
    gameID: number,
    winningCodesWithOrder: Array<{ code: string; order: number }>
): number {
    const MULTIPLIERS = {
        DEFAULT: {
            1: { 4: 3000, 3: 400, 2: 40 },
            2: { 4: 1500, 3: 200, 2: 20 },
            3: { 4: 750, 3: 100, 2: 10 },
        },
        SUPER4: { 4: 5250, 3: 700, 2: 70 }
    } as const;
    
    const codeLength = playedCode.length;
    const isSuper4 = gameID === 7;
    let total = 0;
    
    for (const { code: winningCode, order } of winningCodesWithOrder) {
        if (!winningCode.endsWith(playedCode)) continue;
        
        const multiplier = isSuper4
            ? (MULTIPLIERS.SUPER4 as any)[codeLength] ?? 0
            : ((MULTIPLIERS.DEFAULT as any)[order]?.[codeLength] ?? 0);
        
        if (multiplier > 0) {
            const value = stakeValue * multiplier;
            total += value;
        }
    }
    
    return total;
}

main()
    .catch((e) => {
        console.error('❌ Error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await db.$disconnect();
    });
