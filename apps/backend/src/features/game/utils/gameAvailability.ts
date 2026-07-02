import { DateTime } from "luxon";

const AMSTERDAM_ZONE = "Europe/Amsterdam";

const GAME_CLOSURES: Array<{ date: string; games: string[] }> = [
    { date: "2026-04-27", games: ["Flamingo", "WNK"] },
    { date: "2026-07-02", games: ["WNK", "WNK napa"] },
];

export const isGameUnavailableForDate = (
    gameName: string,
    date: DateTime = DateTime.now().setZone(AMSTERDAM_ZONE)
): boolean => {
    return GAME_CLOSURES.some((closure) => {
        const isClosedDate = date.hasSame(
            DateTime.fromISO(closure.date, { zone: AMSTERDAM_ZONE }),
            "day"
        );

        return isClosedDate && closure.games.includes(gameName);
    });
};
