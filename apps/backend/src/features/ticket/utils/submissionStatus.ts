import { DateTime } from "luxon";

const AMSTERDAM_ZONE = "Europe/Amsterdam";
const SUBMISSION_CLOSED_DATE_ISO = "2026-05-14";

export const isTicketSubmissionClosed = (
    date: DateTime = DateTime.now().setZone(AMSTERDAM_ZONE)
): boolean => {
    return date.hasSame(
        DateTime.fromISO(SUBMISSION_CLOSED_DATE_ISO, { zone: AMSTERDAM_ZONE }),
        "day"
    );
};

export const ticketSubmissionClosedMessage =
    "Ticket inzendingen zijn tijdelijk gesloten op 14 mei. Vanaf 15 mei kun je weer tickets indienen.";
