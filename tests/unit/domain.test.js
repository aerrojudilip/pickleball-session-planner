import test from "node:test";
import assert from "node:assert/strict";

import {
  checkSchemaVersion,
  createBooking,
  createEmptyDatabase,
  createPlayer,
  createSession,
  normalizeDatabase,
} from "../../js/schema.js";
import {
  addDays,
  blockPlacement,
  bookingEndTime,
  bookingStatus,
  bookingsOverlap,
  startOfWeek,
  timeToMinutes,
  validateBooking,
  weekDays,
} from "../../js/bookings.js";
import { defaultHardCap, effectiveRules, validateScore } from "../../js/scoring.js";
import { createStore } from "../../js/state.js";
import { restoreTimerState, timerEndIso } from "../../js/ui/display.js";
import { bootstrapSamples } from "../../js/samples.js";

test("new and legacy databases normalize to schema v1 with booking defaults", () => {
  const empty = createEmptyDatabase();
  assert.equal(empty.schemaVersion, 1);
  assert.deepEqual(empty.bookings, []);

  const normalized = normalizeDatabase({ schemaVersion: 1, players: [], sessions: [] });
  assert.deepEqual(normalized.bookings, []);
  assert.deepEqual(normalized.settings.weights, {
    partnerRepeat: 10,
    opponentRepeat: 4,
    skillBalance: 3,
    courtRepeat: 2,
    crossCourtSpread: 1,
  });
});

test("first-run samples preserve custom seeds and fill the roster to twelve", async () => {
  const originalFetch = globalThis.fetch;
  const customPlayers = Array.from({ length: 9 }, (_, index) => ({ name: `Custom ${index + 1}`, rating: 3 }));
  globalThis.fetch = async () => new Response(JSON.stringify({ players: customPlayers }), { status: 200 });
  try {
    const db = await bootstrapSamples();
    assert.equal(db.players.length, 12);
    assert.deepEqual(db.players.slice(0, 9).map((player) => player.name), customPlayers.map((player) => player.name));
    assert.ok(db.players.every((player) => player.isSample));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("first-run samples do not truncate custom rosters larger than twelve", async () => {
  const originalFetch = globalThis.fetch;
  const customPlayers = Array.from({ length: 13 }, (_, index) => ({ name: `Custom ${index + 1}`, rating: 3 }));
  globalThis.fetch = async () => new Response(JSON.stringify({ players: customPlayers }), { status: 200 });
  try {
    const db = await bootstrapSamples();
    assert.equal(db.players.length, 13);
    assert.deepEqual(db.players.map((player) => player.name), customPlayers.map((player) => player.name));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalization clamps values, removes duplicates, and is idempotent", () => {
  const raw = {
    schemaVersion: 1,
    settings: { targetScore: 99, restartCount: 1, weights: { partnerRepeat: -5, skillBalance: 2 } },
    players: [
      { id: "p1", name: " Alice ", rating: 9, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "p1", name: "Duplicate", rating: 2 },
      { id: "p2", name: "Bob", rating: 1, active: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    constraints: { mustPair: [["p1", "p2"], ["p2", "p1"]], mustNotPair: [["p1", "missing"]] },
    sessions: [],
    bookings: [],
  };
  const once = normalizeDatabase(raw);
  const twice = normalizeDatabase(structuredClone(once));
  assert.deepEqual(twice, once);
  assert.equal(once.players.length, 2);
  assert.equal(once.players[0].name, "Alice");
  assert.equal(once.players[0].rating, 5.5);
  assert.equal(once.players[1].rating, 2);
  assert.equal(once.players[1].active, false);
  assert.deepEqual(once.constraints.mustPair, [["p1", "p2"]]);
  assert.deepEqual(once.constraints.mustNotPair, []);
  assert.equal(once.settings.targetScore, 11);
  assert.equal(once.settings.restartCount, 50);
  assert.equal(once.settings.weights.partnerRepeat, 0);
});

test("booking and session back-links survive while dangling links are cleared", () => {
  const db = createEmptyDatabase();
  const players = Array.from({ length: 4 }, (_, index) => createPlayer({ name: `P${index}` }));
  const booking = createBooking({ date: "2026-08-30", sessionId: "s1" });
  booking.id = "b1";
  const session = createSession({ date: "2026-08-30", playerIds: players.map((player) => player.id), bookingId: "b1" });
  session.id = "s1";
  db.players = players;
  db.sessions = [session];
  db.bookings = [booking, { ...booking, id: "b2", sessionId: "missing" }];

  const normalized = normalizeDatabase(db);
  assert.equal(normalized.sessions[0].bookingId, "b1");
  assert.equal(normalized.bookings[0].sessionId, "s1");
  assert.equal(normalized.bookings[1].sessionId, null);

  normalized.bookings = [];
  assert.equal(normalizeDatabase(normalized).sessions[0].bookingId, null);
});

test("schema version validation rejects missing and future versions", () => {
  assert.equal(checkSchemaVersion({ schemaVersion: 1 }).ok, true);
  assert.equal(checkSchemaVersion({}).ok, false);
  const future = checkSchemaVersion({ schemaVersion: 2 });
  assert.equal(future.ok, false);
  assert.match(future.reason, /Update the app/);
});

test("booking time helpers and week geometry use local calendar math", () => {
  assert.equal(timeToMinutes("18:30"), 1110);
  assert.equal(bookingEndTime({ startTime: "18:00", durationMinutes: 90 }), "19:30");
  assert.equal(startOfWeek("2026-09-02"), "2026-08-30");
  assert.deepEqual(weekDays("2026-08-30"), [
    "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05",
  ]);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.deepEqual(blockPlacement({ startTime: "07:30", durationMinutes: 90 }, 6, 48), { top: 72, height: 72 });
});

test("booking overlaps warn but adjacent or different-day bookings do not", () => {
  const existing = { id: "b1", date: "2026-08-30", startTime: "18:00", durationMinutes: 90, name: "Open play" };
  const overlap = { date: "2026-08-30", startTime: "19:00", durationMinutes: 60, courtCount: 2 };
  const adjacent = { ...overlap, startTime: "19:30" };
  assert.equal(bookingsOverlap(existing, overlap), true);
  assert.equal(bookingsOverlap(existing, adjacent), false);
  assert.equal(bookingsOverlap(existing, { ...overlap, date: "2026-08-31" }), false);

  const result = validateBooking(overlap, [existing]);
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Open play/);
  assert.equal(validateBooking({ ...overlap, durationMinutes: 5 }, []).ok, false);
  assert.equal(validateBooking({ ...overlap, courtCount: 13 }, []).ok, false);
});

test("booking status follows linked score progress", () => {
  const booking = { sessionId: "s1" };
  const session = { rounds: [] };
  assert.equal(bookingStatus(booking, null), "upcoming");
  assert.equal(bookingStatus(booking, session), "upcoming");
  session.rounds = [{ courts: [{ status: "pending", score: null }] }];
  assert.equal(bookingStatus(booking, session), "upcoming");
  session.rounds[0].courts.push({ status: "completed", score: { a: 11, b: 7 } });
  assert.equal(bookingStatus(booking, session), "progress");
  session.rounds[0].courts[0].status = "abandoned";
  assert.equal(bookingStatus(booking, session), "completed");
});

test("score validation blocks malformed scores and warns on unusual valid scores", () => {
  const rules = { targetScore: 11, winByTwo: true, hardCap: null };
  assert.deepEqual(validateScore({ a: 11, b: 9 }, rules).warnings, []);
  assert.equal(validateScore({ a: 11, b: 9 }, rules).winner, "a");
  assert.equal(validateScore({ a: -1, b: 9 }, rules).ok, false);
  assert.match(validateScore({ a: 11, b: 10 }, rules).warnings[0], /Win-by-two/);
  assert.match(validateScore({ a: 9, b: 7 }, rules).warnings[0], /below the target/);
  assert.match(validateScore({ a: 8, b: 8 }, rules).warnings[0], /tie/);
  assert.match(validateScore({ a: 16, b: 14 }, { ...rules, hardCap: 15 }).warnings[0], /hard cap/);
  assert.equal(defaultHardCap(11), 15);
});

test("session score-rule snapshots override changed global defaults", () => {
  const settings = { targetScore: 21, winByTwo: false, hardCap: 25 };
  assert.deepEqual(effectiveRules({}, settings), settings);
  const snapshot = { targetScore: 11, winByTwo: true, hardCap: null };
  assert.deepEqual(effectiveRules({ rules: snapshot }, settings), snapshot);
});

test("display timers restore running and expired endpoints", () => {
  const now = Date.parse("2026-08-30T18:00:00.000Z");
  const running = restoreTimerState("2026-08-30T18:01:05.000Z", now);
  assert.equal(running.running, true);
  assert.equal(running.expired, false);
  assert.equal(running.remainingSeconds, 65);

  const expired = restoreTimerState("2026-08-30T17:59:59.000Z", now);
  assert.equal(expired.running, false);
  assert.equal(expired.expired, true);
  assert.equal(expired.remainingSeconds, 0);

  const idle = restoreTimerState(null, now);
  assert.equal(idle.running, false);
  assert.equal(idle.expired, false);
  assert.equal(idle.remainingSeconds, 15 * 60);
  assert.equal(timerEndIso(65, now), "2026-08-30T18:01:05.000Z");
});

test("undo history is capped at 20 entries and a new branch clears redo", () => {
  const store = createStore(createEmptyDatabase());
  for (let index = 1; index <= 25; index += 1) {
    store.commit(`set ${index}`, (draft) => { draft.settings.restartCount = 500 + index; });
  }
  let undoCount = 0;
  while (store.undo()) undoCount += 1;
  assert.equal(undoCount, 20);
  assert.equal(store.getDb().settings.restartCount, 505);

  assert.equal(store.redo(), "set 6");
  assert.equal(store.canRedo(), true);
  store.commit("new branch", (draft) => { draft.settings.mode = "balanced"; });
  assert.equal(store.canRedo(), false);
  assert.equal(store.getDb().settings.mode, "balanced");
});