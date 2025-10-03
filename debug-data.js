const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function debugData() {
    try {
        console.log('=== DEBUGGING DATABASE DATA ===\n');
        
        // Check tickets
        const ticketCount = await prisma.ticket.count();
        console.log(`Total tickets: ${ticketCount}`);
        
        if (ticketCount > 0) {
            const recentTickets = await prisma.ticket.findMany({
                take: 5,
                orderBy: { created: 'desc' },
                include: {
                    codes: true,
                    games: { include: { game: true } },
                    creator: { select: { name: true, role: true } }
                }
            });
            
            console.log('\nRecent tickets:');
            recentTickets.forEach(ticket => {
                console.log(`- Ticket ${ticket.id}: "${ticket.name}" by ${ticket.creator.name} (${ticket.creator.role})`);
                console.log(`  Created: ${ticket.created.toISOString()}`);
                console.log(`  Codes: ${ticket.codes.length} (${ticket.codes.map(c => `${c.code}:€${(c.value/100).toFixed(2)}`).join(', ')})`);
                console.log(`  Games: ${ticket.games.map(g => g.game.name).join(', ')}`);
                console.log(`  Relayed: ${ticket.codes.some(c => c.relayed) ? 'Yes' : 'No'}`);
                console.log('');
            });
        }
        
        // Check codes
        const codeCount = await prisma.code.count();
        console.log(`Total codes: ${codeCount}`);
        
        const unrelayedCodes = await prisma.code.count({
            where: { relayed: null }
        });
        console.log(`Unrelayed codes: ${unrelayedCodes}`);
        
        // Check games
        const games = await prisma.game.findMany();
        console.log(`\nGames available:`);
        games.forEach(game => {
            console.log(`- ${game.id}: ${game.name} (${game.expires})`);
        });
        
        // Check codes by value ranges
        console.log('\nCodes by value ranges:');
        const valueRanges = [
            { min: 0, max: 100, label: '€0.00 - €1.00' },
            { min: 100, max: 200, label: '€1.00 - €2.00' },
            { min: 200, max: 500, label: '€2.00 - €5.00' },
            { min: 500, max: 1000, label: '€5.00 - €10.00' },
            { min: 1000, max: 2500, label: '€10.00 - €25.00' },
            { min: 2500, max: 10000, label: '€25.00+' }
        ];
        
        for (const range of valueRanges) {
            const count = await prisma.code.count({
                where: {
                    value: { gte: range.min, lt: range.max },
                    relayed: null
                }
            });
            console.log(`  ${range.label}: ${count} codes`);
        }
        
        // Check codes by length
        console.log('\nCodes by length (unrelayed):');
        const codeLengths = [2, 3, 4];
        for (const length of codeLengths) {
            const count = await prisma.code.count({
                where: {
                    code: { startsWith: '1'.repeat(length) },
                    relayed: null
                }
            });
            console.log(`  ${length} digits: ${count} codes`);
        }
        
        // Check recent activity
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const todayTickets = await prisma.ticket.count({
            where: {
                created: { gte: today, lt: tomorrow }
            }
        });
        console.log(`\nTickets created today: ${todayTickets}`);
        
        const todayCodes = await prisma.code.count({
            where: {
                created: { gte: today, lt: tomorrow },
                relayed: null
            }
        });
        console.log(`Unrelayed codes created today: ${todayCodes}`);
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

debugData();
