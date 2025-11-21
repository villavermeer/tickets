/**
 * Builds a deterministic reference string for prize balance actions.
 * Keeps the format `PRIZE:<raffleID>:<ticketID>:<code>`.
 */
export function createPrizeReference(raffleID: number, ticketID: number, code: string): string {
    const normalizedCode = code.trim();
    return `PRIZE:${raffleID}:${ticketID}:${normalizedCode}`;
}


