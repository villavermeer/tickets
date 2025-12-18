/**
 * Script to trigger prize awarding for a specific date to capture instrumentation logs
 */

import 'reflect-metadata';
import { container } from 'tsyringe';
import { DateTime } from 'luxon';
import { RaffleService } from '../features/raffle/services/RaffleService';

container.register("Database", { useValue: require('../common/utils/prisma').default });

async function triggerPrizeAwarding() {
    console.log('=== Triggering Prize Awarding for Dec 17, 2025 ===\n');

    const raffleService = container.resolve(RaffleService);

    // Trigger prize awarding for December 17, 2025
    const date = new Date('2025-12-17T00:00:00Z');

    console.log(`Triggering prize awarding for date: ${date.toISOString()}\n`);

    try {
        // This will trigger the instrumentation we added
        await raffleService['createPrizeBalanceActions'](date);
        console.log('Prize awarding completed');
    } catch (error) {
        console.error('Error during prize awarding:', error);
    }
}

// Run the trigger script
triggerPrizeAwarding()
    .then(() => {
        console.log('\n=== Trigger Complete ===');
        process.exit(0);
    })
    .catch(error => {
        console.error('Trigger failed:', error);
        process.exit(1);
    });
