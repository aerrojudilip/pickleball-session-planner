// bookings.js — court booking records and week-calendar math (DOM-free).
//
// A booking is one block: a date + start time + duration + court count that can
// optionally link to a session (so tapping a booked slot opens its scores).
// Overlaps are detected and reported as warnings; they never block a save.

import { createBooking, normalizeTime, clamp } from "./schema.js";

/** Parse "HH:MM" into minutes since midnight. */
export function timeToMinutes(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || "").trim());
  if (!m) return 0;
  return clamp(Number(m[1]), 0, 23) * 60 + clamp(Number(m[2]), 0, 59);
}

/** Convert minutes since midnight into "HH:MM". */
export function minutesToTime(mins) {
  const clamped = clamp(Math.round(mins), 0, 24 * 60 - 1);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Compute a booking's end time as "HH:MM" (clamped to the same day). */
export function bookingEndTime(booking) {
  const end = timeToMinutes(booking.startTime) + Number(booking.durationMinutes || 0);
  return minutesToTime(Math.min(end, 24 * 60 - 1));
}

/**
 * Do two bookings overlap? They overlap when they share a date and their
 * [start, end) time windows intersect. (Court count is not used to disqualify;
 * we surface any same-time same-day clash as a warning.)
 */
export function bookingsOverlap(a, b) {
  if (a.date !== b.date) return false;
  const aStart = timeToMinutes(a.startTime);
  const aEnd = aStart + Number(a.durationMinutes || 0);
  const bStart = timeToMinutes(b.startTime);
  const bEnd = bStart + Number(b.durationMinutes || 0);
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Find bookings (other than `excludeId`) that overlap the given booking.
 * @returns {Array} overlapping bookings
 */
export function findOverlaps(booking, allBookings, excludeId = null) {
  return allBookings.filter((b) => b.id !== excludeId && bookingsOverlap(booking, b));
}

/**
 * Validate a booking draft. Returns { ok, errors:[], warnings:[] }.
 * Errors block a save; warnings (like overlaps) do not.
 */
export function validateBooking(draft, allBookings = [], excludeId = null) {
  const errors = [];
  const warnings = [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(draft.date || ""))) {
    errors.push("A valid date is required.");
  }
  if (!/^\d{1,2}:\d{2}$/.test(String(draft.startTime || ""))) {
    errors.push("A valid start time is required.");
  }
  const duration = Number(draft.durationMinutes);
  if (!Number.isFinite(duration) || duration < 15) {
    errors.push("Duration must be at least 15 minutes.");
  }
  const courts = Number(draft.courtCount);
  if (!Number.isFinite(courts) || courts < 1 || courts > 12) {
    errors.push("Courts must be between 1 and 12.");
  }

  if (errors.length === 0) {
    const overlaps = findOverlaps(draft, allBookings, excludeId);
    if (overlaps.length) {
      const names = overlaps
        .map((o) => o.name || `${o.startTime}\u2013${bookingEndTime(o)}`)
        .join(", ");
      warnings.push(`This time overlaps ${overlaps.length} other booking(s): ${names}.`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Build a validated booking record from a draft (does not enforce warnings).
 */
export function makeBooking(draft) {
  return createBooking({
    date: draft.date,
    startTime: normalizeTime(draft.startTime),
    durationMinutes: draft.durationMinutes,
    courtCount: draft.courtCount,
    name: draft.name,
    location: draft.location,
    notes: draft.notes,
    sessionId: draft.sessionId || null,
  });
}

// ---------------------------------------------------------------------------
// Week calendar helpers
// ---------------------------------------------------------------------------

/** Parse a "YYYY-MM-DD" into a local Date at midnight. */
export function parseLocalDate(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Format a local Date as "YYYY-MM-DD". */
export function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Return the Sunday (week start) for a given date string, as "YYYY-MM-DD". */
export function startOfWeek(dateStr) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() - d.getDay());
  return formatLocalDate(d);
}

/** Add days to a date string. */
export function addDays(dateStr, days) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return formatLocalDate(d);
}

/** Get the 7 date strings of the week beginning at weekStart (a Sunday). */
export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/**
 * Compute the vertical placement of a booking within an hour grid.
 * @param {object} booking
 * @param {number} startHour - first visible hour (e.g. 6)
 * @param {number} pxPerHour
 * @returns {{ top: number, height: number }}
 */
export function blockPlacement(booking, startHour, pxPerHour) {
  const startMin = timeToMinutes(booking.startTime);
  const top = ((startMin - startHour * 60) / 60) * pxPerHour;
  const height = (Number(booking.durationMinutes) / 60) * pxPerHour;
  return { top, height: Math.max(height, 18) };
}

/** Booking status derived from its linked session (if any). */
export function bookingStatus(booking, session) {
  if (!session) return "upcoming";
  const hasRounds = session.rounds && session.rounds.length > 0;
  if (!hasRounds) return "upcoming";
  const anyCompleted = session.rounds.some((r) =>
    r.courts.some((c) => c.status === "completed"),
  );
  // No scores entered yet — still upcoming even if rounds are pre-generated.
  if (!anyCompleted) return "upcoming";
  const allCourtsResolved = session.rounds.every((r) =>
    r.courts.every((c) => c.status !== "pending"),
  );
  if (allCourtsResolved) return "completed";
  return "progress";
}
