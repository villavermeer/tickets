import { DateTime } from "luxon";

const AMSTERDAM_ZONE = "Europe/Amsterdam";
const SUBMISSION_CLOSURE_ENABLED = false;
const SUBMISSION_CLOSED_DATE_ISO = "2026-05-24";

export const isTicketSubmissionClosed = (
    date: DateTime = DateTime.now().setZone(AMSTERDAM_ZONE)
): boolean => {
    if (!SUBMISSION_CLOSURE_ENABLED) {
        return false;
    }

    return date.hasSame(
        DateTime.fromISO(SUBMISSION_CLOSED_DATE_ISO, { zone: AMSTERDAM_ZONE }),
        "day"
    );
};

export const ticketSubmissionClosedMessage =
    "Ticket inzendingen zijn tijdelijk gesloten. Probeer het later opnieuw.";
