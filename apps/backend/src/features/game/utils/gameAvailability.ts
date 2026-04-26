import { DateTime } from "luxon";

const AMSTERDAM_ZONE = "Europe/Amsterdam";
const CLOSED_DATE_ISO = "2026-04-27";
const CLOSED_GAME_NAMES = new Set(["Flamingo", "WNK"]);

export const isGameUnavailableForDate = (
    gameName: string,
    date: DateTime = DateTime.now().setZone(AMSTERDAM_ZONE)
): boolean => {
    const isClosedDate = date.hasSame(
        DateTime.fromISO(CLOSED_DATE_ISO, { zone: AMSTERDAM_ZONE }),
        "day"
    );

    return isClosedDate && CLOSED_GAME_NAMES.has(gameName);
};
