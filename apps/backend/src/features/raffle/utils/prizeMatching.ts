/**
 * Shared prize suffix matching — must stay aligned with PrizeService ticket filters.
 * A played code only wins when it equals the last N digits of a winning code (N = played length).
 */
export function buildWinningSuffixSets(winningCodes: string[]): {
    suffix2: Set<string>;
    suffix3: Set<string>;
    suffix4: Set<string>;
} {
    const suffix2 = new Set<string>();
    const suffix3 = new Set<string>();
    const suffix4 = new Set<string>();

    for (const code of winningCodes) {
        if (code.length >= 2) suffix2.add(code.slice(-2));
        if (code.length >= 3) suffix3.add(code.slice(-3));
        if (code.length >= 4) suffix4.add(code.slice(-4));
    }

    return { suffix2, suffix3, suffix4 };
}

export function playedCodeMatchesWinningSuffixes(
    playedCode: string,
    winningCodes: string[]
): boolean {
    const trimmed = playedCode.trim();
    if (!trimmed) return false;

    const { suffix2, suffix3, suffix4 } = buildWinningSuffixSets(winningCodes);

    if (trimmed.length === 2) return suffix2.has(trimmed);
    if (trimmed.length === 3) return suffix3.has(trimmed);
    if (trimmed.length === 4) return suffix4.has(trimmed);

    return false;
}

export function winningCodeMatchesPlayedCode(winningCode: string, playedCode: string): boolean {
    const trimmed = playedCode.trim();
    if (!trimmed || winningCode.length < trimmed.length) return false;
    return winningCode.slice(-trimmed.length) === trimmed;
}
