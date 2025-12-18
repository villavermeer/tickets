/**
 * Test the prize calculation logic for the specific case
 */

import 'reflect-metadata';
import { RaffleService } from '../features/raffle/services/RaffleService';
import { container } from 'tsyringe';

container.register("Database", { useValue: require('../common/utils/prisma').default });

async function testPrizeCalculation() {
    console.log('=== Testing Prize Calculation Logic ===\n');

    const raffleService = container.resolve(RaffleService);

    // Test the calculatePrizeAmount method directly
    const winningCodes = [
        { code: "1088", order: 1 },
        { code: "2855", order: 2 },
        { code: "6641", order: 3 }
    ];

    const playedCode = "126";
    const stakeValue = 50; // 0.50 EUR
    const gameID = 2; // Game 2 (raffle 1101)

    console.log(`Testing prize calculation:`);
    console.log(`Played code: "${playedCode}"`);
    console.log(`Stake: ${stakeValue} cents (${stakeValue/100} EUR)`);
    console.log(`Game ID: ${gameID}`);
    console.log(`Winning codes: ${winningCodes.map(wc => `"${wc.code}" (order ${wc.order})`).join(', ')}\n`);

    // Call the private method using type assertion
    const prizeAmount = (raffleService as any).calculatePrizeAmount(playedCode, stakeValue, gameID, winningCodes);

    console.log(`Calculated prize amount: ${prizeAmount} cents (${prizeAmount/100} EUR)`);

    if (prizeAmount > 0) {
        console.log('❌ PRIZE WOULD BE AWARDED - THIS IS THE BUG!');
    } else {
        console.log('✅ No prize awarded - this is correct');
    }

    // Test each winning code individually
    console.log('\nDetailed matching check:');
    winningCodes.forEach(winningCode => {
        const matches = winningCode.code.endsWith(playedCode);
        console.log(`"${winningCode.code}".endsWith("${playedCode}") = ${matches}`);
    });
}

// Run the test
testPrizeCalculation()
    .then(() => {
        console.log('\n=== Test Complete ===');
        process.exit(0);
    })
    .catch(error => {
        console.error('Test failed:', error);
        process.exit(1);
    });
