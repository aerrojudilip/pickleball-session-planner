// ui/schedule.js — court booking calendar (week grid + day fallback).
//
// Bookings are court reservations (date + start + duration + courts). Each can
// link to a play session so tapping a booked block opens its scores.

import { el, mount } from "./dom.js";
import { showToast, confirmDialog, openDialog } from "./feedback.js";
import { startSetupFromBooking } from "./session.js";
import {
  timeToMinutes,
  minutesToTime,
  bookingEndTime,
  validateBooking,
  makeBooking,
  startOfWeek,
  addDays,
  weekDays,
  blockPlacement,
  bookingStatus,
  parseLocalDate,
} from "../bookings.js";
import { localDateString } from "../schema.js";

const START_HOUR = 6;
const END_HOUR = 23; // last labelled hour
const PX_PER_HOUR = 48;
const TOTAL_HOURS = END_HOUR - START_HOUR + 1;
const GRID_HEIGHT = TOTAL_HOURS * PX_PER_HOUR;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const viewStates = new WeakMap();
function getViewState(container, ctx) {
  if (!viewStates.has(container)) {
    const stored = ctx.store.getUi().calendarWeekStart;
    const today = localDateString();
    viewStates.set(container, {
      weekStart: stored || startOfWeek(today),
      viewMode: window.matchMedia("(max-width: 560px)").matches ? "day" : "week",
      activeDay: today,
    });
  }
  return viewStates.get(container);
}

export function renderSchedule(container, ctx) {
  const { store } = ctx;
  const db = store.getDb();
  const state = getViewState(container, ctx);
  const days = weekDays(state.weekStart);
  const today = localDateString();

  const sessionByBooking = new Map(db.bookings.filter((b) => b.sessionId).map((b) => [b.id, db.sessions.find((s) => s.id === b.sessionId)]));

  mount(
    container,
    el(
      "div",
      { class: "page-header" },
      el("div", {}, el("h1", { class: "page-title" }, "Schedule")),
      el(
        "div",
        { class: "row no-print" },
        el("button", { class: "btn btn--ghost", type: "button", onClick: () => window.print() }, "Print"),
        el("button", { class: "btn btn--primary", type: "button", onClick: () => openBookingForm(container, ctx, null) }, "+ Book court"),
      ),
    ),
    toolbar(container, ctx, state, days),
    state.viewMode === "day"
      ? dayView(container, ctx, state, sessionByBooking, today)
      : weekView(container, ctx, state, days, sessionByBooking, today),
    legend(),
    printSchedule(db, days),
  );
}

function printSchedule(db, days) {
  const sessionsById = new Map(db.sessions.map((session) => [session.id, session]));
  const bookings = db.bookings
    .filter((booking) => booking.date >= days[0] && booking.date <= days[6])
    .slice()
    .sort((left, right) => `${left.date} ${left.startTime}`.localeCompare(`${right.date} ${right.startTime}`));

  return el(
    "section",
    { class: "print-schedule print-only" },
    el("h2", {}, `${fmtShort(days[0])} \u2013 ${fmtShort(days[6])}`),
    bookings.length
      ? el(
          "table",
          { class: "data" },
          el(
            "thead",
            {},
            el("tr", {}, ...["Date", "Time", "Booking", "Courts", "Location", "Status"].map((label) => el("th", {}, label))),
          ),
          el(
            "tbody",
            {},
            ...bookings.map((booking) => {
              const session = booking.sessionId ? sessionsById.get(booking.sessionId) : null;
              const status = bookingStatus(booking, session);
              return el(
                "tr",
                {},
                el("td", {}, fmtLong(booking.date)),
                el("td", {}, `${booking.startTime} \u2013 ${bookingEndTime(booking)}`),
                el("td", {}, booking.name || "Court booking"),
                el("td", {}, String(booking.courtCount)),
                el("td", {}, booking.location || "\u2014"),
                el("td", {}, status === "progress" ? "In progress" : status[0].toUpperCase() + status.slice(1)),
              );
            }),
          ),
        )
      : el("p", {}, "No court bookings this week."),
  );
}

function toolbar(container, ctx, state, days) {
  const rangeLabel = `${fmtShort(days[0])} \u2013 ${fmtShort(days[6])}`;
  return el(
    "div",
    { class: "calendar__toolbar" },
    el("button", { class: "btn btn--sm btn--ghost", type: "button", onClick: () => shiftWeek(container, ctx, state, -1) }, "\u2190"),
    el("button", { class: "btn btn--sm btn--ghost", type: "button", onClick: () => goToday(container, ctx, state) }, "Today"),
    el("button", { class: "btn btn--sm btn--ghost", type: "button", onClick: () => shiftWeek(container, ctx, state, 1) }, "\u2192"),
    el("span", { class: "calendar__range" }, state.viewMode === "day" ? fmtLong(state.activeDay) : rangeLabel),
    el(
      "div",
      { class: "row", style: { marginLeft: "auto", gap: "4px" } },
      el("button", { class: `chip ${state.viewMode === "day" ? "chip--on" : ""}`, type: "button", "aria-pressed": String(state.viewMode === "day"), onClick: () => setMode(container, ctx, state, "day") }, "Day"),
      el("button", { class: `chip ${state.viewMode === "week" ? "chip--on" : ""}`, type: "button", "aria-pressed": String(state.viewMode === "week"), onClick: () => setMode(container, ctx, state, "week") }, "Week"),
    ),
  );
}

function weekView(container, ctx, state, days, sessionByBooking, today) {
  const db = ctx.store.getDb();

  const cells = [];
  // Row 1: corner + day labels
  cells.push(el("div", { class: "week-grid__corner" }));
  for (const day of days) {
    cells.push(
      el(
        "button",
        {
          class: `week-grid__daylabel ${day === today ? "week-grid__daylabel--today" : ""}`,
          type: "button",
          style: { cursor: "pointer", background: "var(--surface-2)" },
          onClick: () => { state.activeDay = day; setMode(container, ctx, state, "day"); },
        },
        el("div", {}, DAY_NAMES[parseLocalDate(day).getDay()]),
        el("div", {}, String(parseLocalDate(day).getDate())),
      ),
    );
  }
  // Row 2: hour rail + day columns
  cells.push(hourRail());
  for (const day of days) {
    cells.push(dayColumn(container, ctx, day, db.bookings, sessionByBooking));
  }

  return el(
    "div",
    { class: "week-grid-scroll" },
    el("div", { class: "week-grid" }, ...cells),
  );
}

function dayView(container, ctx, state, sessionByBooking, today) {
  const db = ctx.store.getDb();
  const day = state.activeDay;
  return el(
    "div",
    { class: "calendar__day-view" },
    el(
      "div",
      { class: "row spread", style: { marginBottom: "8px" } },
      el("button", { class: "btn btn--sm btn--ghost", type: "button", onClick: () => shiftDay(container, ctx, state, -1) }, "\u2190 Prev day"),
      el("strong", { class: day === today ? "" : "" }, fmtLong(day)),
      el("button", { class: "btn btn--sm btn--ghost", type: "button", onClick: () => shiftDay(container, ctx, state, 1) }, "Next day \u2192"),
    ),
    el(
      "div",
      { class: "week-grid", style: { gridTemplateColumns: "56px 1fr" } },
      el("div", { class: "week-grid__corner" }),
      el("div", { class: `week-grid__daylabel ${day === today ? "week-grid__daylabel--today" : ""}` }, DAY_NAMES[parseLocalDate(day).getDay()]),
      hourRail(),
      dayColumn(container, ctx, day, db.bookings, sessionByBooking),
    ),
  );
}

function hourRail() {
  const rail = el("div", { class: "week-grid__col", style: { height: `${GRID_HEIGHT}px` } });
  for (let h = START_HOUR; h <= END_HOUR; h += 1) {
    rail.appendChild(
      el(
        "div",
        { class: "week-grid__hour", style: { position: "absolute", top: `${(h - START_HOUR) * PX_PER_HOUR}px`, right: "4px" } },
        minutesToTime(h * 60),
      ),
    );
  }
  return rail;
}

function dayColumn(container, ctx, day, allBookings, sessionByBooking) {
  const col = el("div", {
    class: "week-grid__col",
    style: {
      height: `${GRID_HEIGHT}px`,
      backgroundImage: `repeating-linear-gradient(var(--border) 0 1px, transparent 1px ${PX_PER_HOUR}px)`,
    },
  });
  // Click empty space to create a booking at that hour.
  col.addEventListener("click", (e) => {
    if (e.target !== col) return;
    const rect = col.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const hour = Math.max(START_HOUR, Math.min(END_HOUR, START_HOUR + Math.floor(y / PX_PER_HOUR)));
    openBookingForm(container, ctx, null, { date: day, startTime: minutesToTime(hour * 60) });
  });

  const dayBookings = allBookings.filter((b) => b.date === day).sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  for (const booking of dayBookings) {
    const session = sessionByBooking.get(booking.id) || null;
    const status = bookingStatus(booking, session);
    const { top, height } = blockPlacement(booking, START_HOUR, PX_PER_HOUR);
    col.appendChild(
      el(
        "button",
        {
          class: `booking-block booking-block--${status}`,
          type: "button",
          style: { top: `${Math.max(0, top)}px`, height: `${height}px` },
          onClick: (e) => { e.stopPropagation(); openBookingActions(container, ctx, booking, session); },
        },
        el("span", { class: "booking-block__title" }, booking.name || "Court time"),
        el("span", {}, `${booking.startTime}\u2013${bookingEndTime(booking)} \u00b7 ${booking.courtCount}c`),
      ),
    );
  }
  return col;
}

function legend() {
  return el(
    "div",
    { class: "calendar__legend row small muted", style: { marginTop: "12px", gap: "12px", flexWrap: "wrap" } },
    legendDot("var(--blue)", "Upcoming"),
    legendDot("#b58a00", "In progress"),
    legendDot("var(--court-green)", "Completed"),
    el("span", {}, "Tap a block for actions \u00b7 tap empty space to book."),
  );
}

function legendDot(color, label) {
  return el("span", { class: "row", style: { gap: "4px", alignItems: "center" } }, el("span", { style: { width: "12px", height: "12px", borderRadius: "3px", background: color, display: "inline-block" } }), label);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function shiftWeek(container, ctx, state, dir) {
  state.weekStart = addDays(state.weekStart, dir * 7);
  ctx.store.setUi({ calendarWeekStart: state.weekStart });
  renderSchedule(container, ctx);
}
function shiftDay(container, ctx, state, dir) {
  state.activeDay = addDays(state.activeDay, dir);
  state.weekStart = startOfWeek(state.activeDay);
  ctx.store.setUi({ calendarWeekStart: state.weekStart });
  renderSchedule(container, ctx);
}
function goToday(container, ctx, state) {
  const today = localDateString();
  state.weekStart = startOfWeek(today);
  state.activeDay = today;
  ctx.store.setUi({ calendarWeekStart: state.weekStart });
  renderSchedule(container, ctx);
}
function setMode(container, ctx, state, mode) {
  state.viewMode = mode;
  renderSchedule(container, ctx);
}

// ---------------------------------------------------------------------------
// Booking form
// ---------------------------------------------------------------------------
function openBookingForm(container, ctx, booking, prefill = {}) {
  if (ctx.cloud.isConfigured() && !ctx.auth.isAuthenticated()) {
    ctx.requireAdmin("booking management", () => openBookingForm(container, ctx, booking, prefill));
    return;
  }

  const { store } = ctx;
  const isEdit = Boolean(booking);
  const draft = {
    date: booking ? booking.date : prefill.date || localDateString(),
    startTime: booking ? booking.startTime : prefill.startTime || "18:00",
    durationMinutes: booking ? booking.durationMinutes : 90,
    courtCount: booking ? booking.courtCount : 3,
    name: booking ? booking.name : "",
    location: booking ? booking.location : "",
    notes: booking ? booking.notes : "",
  };

  const dateInput = el("input", { type: "date", value: draft.date, onChange: (e) => (draft.date = e.target.value) });
  const timeInput = el("input", { type: "time", value: draft.startTime, onChange: (e) => (draft.startTime = e.target.value) });
  const durationInput = el("input", { type: "number", min: "15", step: "15", value: String(draft.durationMinutes), onInput: (e) => { draft.durationMinutes = Number(e.target.value); syncDurationChips(); } });
  const courtsInput = el("input", { type: "number", min: "1", max: "12", value: String(draft.courtCount), onInput: (e) => (draft.courtCount = Number(e.target.value)) });
  const nameInput = el("input", { type: "text", value: draft.name, placeholder: "e.g. Saturday Open Play", onInput: (e) => (draft.name = e.target.value) });
  const locationInput = el("input", { type: "text", value: draft.location, placeholder: "e.g. Community Courts", onInput: (e) => (draft.location = e.target.value) });
  const notesInput = el("textarea", { placeholder: "Optional notes", onInput: (e) => (draft.notes = e.target.value) }, draft.notes);
  const errorBox = el("div", { class: "warnbox hidden" });
  const warnBoxLive = el("div", { class: "infobox hidden" });

  const durationChips = el("div", { class: "chips" });
  function syncDurationChips() {
    durationChips.innerHTML = "";
    for (const mins of [60, 90, 120]) {
      durationChips.appendChild(
        el(
          "button",
          {
            class: `chip ${draft.durationMinutes === mins ? "chip--on" : ""}`,
            type: "button",
            onClick: () => { draft.durationMinutes = mins; durationInput.value = String(mins); syncDurationChips(); },
          },
          `${mins} min`,
        ),
      );
    }
  }
  syncDurationChips();

  const controller = openDialog({
    title: isEdit ? "Edit booking" : "Book court time",
    size: "lg",
    body: el(
      "div",
      { class: "stack" },
      el("div", { class: "field-row" }, field("Date", dateInput), field("Start time", timeInput)),
      field("Duration", el("div", { class: "stack" }, durationChips, durationInput)),
      field("Courts", courtsInput),
      field("Name", nameInput),
      field("Location", locationInput),
      field("Notes", notesInput),
      errorBox,
      warnBoxLive,
    ),
    actions: [
      isEdit ? el("button", { class: "btn btn--danger", type: "button", style: { marginRight: "auto" }, onClick: () => remove() }, "Delete") : null,
      el("button", { class: "btn btn--ghost", type: "button", onClick: () => controller.close() }, "Cancel"),
      el("button", { class: "btn btn--primary", type: "button", onClick: () => save() }, isEdit ? "Save" : "Add booking"),
    ].filter(Boolean),
  });

  function save() {
    const others = store.getDb().bookings;
    const result = validateBooking(draft, others, isEdit ? booking.id : null);
    if (!result.ok) {
      errorBox.textContent = result.errors.join(" ");
      errorBox.classList.remove("hidden");
      return;
    }
    if (result.warnings.length && !errorBox.dataset.warned) {
      warnBoxLive.textContent = `${result.warnings.join(" ")} Tap Add again to keep it anyway.`;
      warnBoxLive.classList.remove("hidden");
      errorBox.dataset.warned = "1";
      return;
    }
    if (isEdit) {
      store.commit("Edit booking", (d) => {
        const b = d.bookings.find((x) => x.id === booking.id);
        if (b) Object.assign(b, { date: draft.date, startTime: draft.startTime, durationMinutes: Number(draft.durationMinutes), courtCount: Number(draft.courtCount), name: draft.name, location: draft.location, notes: draft.notes });
      });
    } else {
      const record = makeBooking(draft);
      store.commit("Add booking", (d) => d.bookings.push(record));
    }
    controller.close();
    renderSchedule(container, ctx);
  }

  function remove() {
    confirmDialog({ title: "Delete booking?", message: "Remove this court booking? A linked session is kept.", confirmLabel: "Delete" }).then((ok) => {
      if (!ok) return;
      const snapshot = booking;
      store.commit("Delete booking", (d) => {
        d.bookings = d.bookings.filter((x) => x.id !== booking.id);
        const s = d.sessions.find((x) => x.id === (snapshot.sessionId || ""));
        if (s) s.bookingId = null;
      });
      controller.close();
      renderSchedule(container, ctx);
      showToast("Booking deleted.", { actionLabel: "Undo", onAction: () => { store.undo(); renderSchedule(container, ctx); } });
    });
  }
}

// ---------------------------------------------------------------------------
// Booking actions (tap a block)
// ---------------------------------------------------------------------------
function openBookingActions(container, ctx, booking, session) {
  const { store } = ctx;
  const status = bookingStatus(booking, session);

  const body = el(
    "div",
    { class: "stack" },
    el("p", { class: "muted small" }, `${fmtLong(booking.date)} \u00b7 ${booking.startTime}\u2013${bookingEndTime(booking)} \u00b7 ${booking.courtCount} court(s)`),
    booking.location ? el("p", {}, booking.location) : null,
    booking.notes ? el("p", { class: "muted small" }, booking.notes) : null,
    session
      ? el("p", {}, el("strong", {}, "Linked session: "), `${session.name || session.date} \u00b7 ${session.rounds.length} round(s) \u00b7 ${status}`)
      : el("p", { class: "muted small" }, "No session linked yet."),
  );

  const actions = [el("button", { class: "btn btn--ghost", type: "button", onClick: () => { controller.close(); openBookingForm(container, ctx, booking); } }, "Edit")];
  if (session) {
    actions.push(el("button", { class: "btn btn--primary", type: "button", onClick: () => { controller.close(); openLinkedSession(ctx, session.id); } }, "Open session & scores"));
  } else {
    actions.push(el("button", { class: "btn btn--primary", type: "button", onClick: () => { controller.close(); startSetupFromBooking(container, ctx, booking); } }, "Start session"));
  }

  const controller = openDialog({ title: booking.name || "Court booking", body, actions });
}

function openLinkedSession(ctx, sessionId) {
  ctx.store.setUi({ currentSessionId: sessionId });
  if (ctx.navigate) ctx.navigate("session");
  else ctx.refresh();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function field(label, control) {
  return el("div", { class: "field" }, el("label", {}, label), control);
}
function fmtShort(dateStr) {
  const d = parseLocalDate(dateStr);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
function fmtLong(dateStr) {
  const d = parseLocalDate(dateStr);
  return `${DAY_NAMES[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
