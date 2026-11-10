/** Asia/Jakarta is a fixed UTC+7 (no DST), so plain offset math is exact. */
const JAKARTA_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 86400000;

const shifted = (date) => new Date(new Date(date).getTime() + JAKARTA_OFFSET_MS);

/** "YYYY-MM-DD" of the given instant in Jakarta. */
const jakartaDay = (date) => shifted(date).toISOString().slice(0, 10);

/** Hour of day (0-23) in Jakarta. */
const jakartaHour = (date) => shifted(date).getUTCHours();

/** Instant of 00:00 Jakarta for a "YYYY-MM-DD" day. */
const startOfJakartaDay = (day) => new Date(`${day}T00:00:00+07:00`);

/** Whole days from a to b (negative when b is earlier). */
const wholeDaysBetween = (a, b) => Math.floor((new Date(b).getTime() - new Date(a).getTime()) / DAY_MS);

module.exports = { JAKARTA_OFFSET_MS, DAY_MS, jakartaDay, jakartaHour, startOfJakartaDay, wholeDaysBetween };
