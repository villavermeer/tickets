import assert from 'node:assert/strict';
import { createPrizeReference } from './prizeReference';

function testDeterministicReference() {
    const refA = createPrizeReference(1, 42, '1234');
    const refB = createPrizeReference(1, 42, '1234');
    assert.equal(refA, refB, 'References should match for identical input');
}

function testIgnoresWhitespace() {
    const refA = createPrizeReference(10, 15, '5678');
    const refB = createPrizeReference(10, 15, ' 5678 ');
    assert.equal(refA, refB, 'References should trim whitespace');
}

function run() {
    testDeterministicReference();
    testIgnoresWhitespace();
    console.log('prizeReference tests passed');
}

run();


