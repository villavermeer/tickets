import { DateTime } from 'luxon';

export const AMS = 'Europe/Amsterdam';

/** Tickets for the new calendar day only after this hour (Jade). */
export const BUSINESS_DAY_START_HOUR = 3;

/**
 * Amsterdam business day start (00:00 wall of the business calendar date).
 * Before 03:00 Amsterdam, the previous calendar date is still the business day
 * so late cutoffs (e.g. 02:00) stay attributed to the evening being closed.
 */
export function toAmsterdamBusinessDay(dt: DateTime = DateTime.now()): DateTime {
    const ams = dt.setZone(AMS);
    if (ams.hour < BUSINESS_DAY_START_HOUR) {
        return ams.minus({ days: 1 }).startOf('day');
    }
    return ams.startOf('day');
}

export function amsterdamBusinessDayYmd(dt: DateTime | Date = DateTime.now()): string {
    const luxon = DateTime.isDateTime(dt) ? dt : DateTime.fromJSDate(dt);
    return toAmsterdamBusinessDay(luxon).toFormat('yyyy-MM-dd');
}

/** Inclusive start / exclusive end UTC for the business day window [03:00, next 03:00). */
export function amsterdamBusinessDayUtcWindow(dt: DateTime = DateTime.now()): {
    startUtc: Date;
    endUtc: Date;
} {
    const day = toAmsterdamBusinessDay(dt);
    const start = day.set({ hour: BUSINESS_DAY_START_HOUR, minute: 0, second: 0, millisecond: 0 });
    const end = start.plus({ days: 1 });
    return {
        startUtc: start.toUTC().toJSDate(),
        endUtc: end.toUTC().toJSDate(),
    };
}

/**
 * Postgres expression: Amsterdam business date for a timestamp column
 * (03:00 rollover).
 */
export function amsterdamBusinessDateSql(column: string): string {
    return `(CASE
        WHEN EXTRACT(HOUR FROM timezone('Europe/Amsterdam', ${column})) < ${BUSINESS_DAY_START_HOUR}
        THEN (timezone('Europe/Amsterdam', ${column}))::date - 1
        ELSE (timezone('Europe/Amsterdam', ${column}))::date
    END)`;
}
