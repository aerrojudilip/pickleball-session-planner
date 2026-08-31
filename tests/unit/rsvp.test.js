import test from "node:test";
import assert from "node:assert/strict";

import {
  RSVP_IDENTITY_KEY,
  RSVP_RESPONSES,
  createLocalRsvpTransport,
  createRsvpStore,
  goingPlayerIds,
  normalizeResponse,
  normalizeRsvp,
  normalizeRsvpList,
  summarizeRsvps,
} from "../../js/rsvp.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function memoryTransport(initial = []) {
  const rows = [...initial];
  const calls = { load: 0, save: 0, removeBooking: 0 };
  return {
    rows,
    calls,
    async load() {
      calls.load += 1;
      return rows.map((r) => ({ ...r }));
    },
    async save(record) {
      calls.save += 1;
      const index = rows.findIndex((r) => r.booking_id === record.bookingId && r.player_id === record.playerId);
      const row = {
        booking_id: record.bookingId,
        player_id: record.playerId,
        response: record.response,
        updated_at: "2026-08-30T18:00:00.000Z",
      };
      if (index >= 0) rows[index] = row;
      else rows.push(row);
      return row;
    },
    async removeBooking(bookingId) {
      calls.removeBooking += 1;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].booking_id === bookingId) rows.splice(i, 1);
      }
    },
  };
}

const PLAYERS = [
  { id: "p1", name: "Ana" },
  { id: "p2", name: "Ben" },
  { id: "p3", name: "Cy" },
  { id: "p4", name: "Dee" },
];

test("replies normalize from both camelCase and PostgREST rows", () => {
  assert.deepEqual(normalizeResponse("Not Going"), "not_going");
  assert.deepEqual(normalizeResponse("not-going"), "not_going");
  assert.equal(normalizeResponse("perhaps"), null);
  assert.deepEqual(RSVP_RESPONSES, ["going", "maybe", "not_going"]);

  const fromRow = normalizeRsvp({ booking_id: "b1", player_id: "p1", response: "going", updated_at: "2026-08-30T00:00:00.000Z" });
  assert.deepEqual(fromRow, { bookingId: "b1", playerId: "p1", response: "going", updatedAt: "2026-08-30T00:00:00.000Z" });

  assert.equal(normalizeRsvp({ bookingId: "b1", playerId: "p1", response: "nope" }), null);
  assert.equal(normalizeRsvp({ bookingId: "", playerId: "p1", response: "going" }), null);
  assert.equal(normalizeRsvp(null), null);
});

test("duplicate replies collapse to the most recent answer", () => {
  const list = normalizeRsvpList([
    { bookingId: "b1", playerId: "p1", response: "maybe", updatedAt: "2026-08-30T10:00:00.000Z" },
    { bookingId: "b1", playerId: "p1", response: "going", updatedAt: "2026-08-30T12:00:00.000Z" },
    { bookingId: "b1", playerId: "p2", response: "not_going", updatedAt: "2026-08-30T11:00:00.000Z" },
    "not an object",
  ]);
  assert.equal(list.length, 2);
  assert.equal(list.find((r) => r.playerId === "p1").response, "going");
});

test("a roster groups into going, maybe, not going, and no reply", () => {
  const summary = summarizeRsvps(PLAYERS, [
    { bookingId: "b1", playerId: "p1", response: "going" },
    { bookingId: "b1", playerId: "p2", response: "maybe" },
    { bookingId: "b1", playerId: "p3", response: "not_going" },
  ]);
  assert.deepEqual(summary.going.map((p) => p.name), ["Ana"]);
  assert.deepEqual(summary.maybe.map((p) => p.name), ["Ben"]);
  assert.deepEqual(summary.not_going.map((p) => p.name), ["Cy"]);
  assert.deepEqual(summary.pending.map((p) => p.name), ["Dee"]);
  assert.deepEqual(summary.counts, { going: 1, maybe: 1, not_going: 1, pending: 1, replied: 3 });
  assert.deepEqual(goingPlayerIds(summary.going.length ? [{ bookingId: "b1", playerId: "p1", response: "going" }] : []), ["p1"]);
});

test("the store loads replies, records one, and keeps bookings apart", async () => {
  const transport = memoryTransport([
    { booking_id: "b1", player_id: "p1", response: "going", updated_at: "2026-08-30T09:00:00.000Z" },
    { booking_id: "b2", player_id: "p1", response: "not_going", updated_at: "2026-08-30T09:00:00.000Z" },
  ]);
  const notifications = [];
  const store = createRsvpStore(transport, { storage: memoryStorage(), staleAfter: 0 });
  store.subscribe(() => notifications.push(store.list().length));

  assert.equal(await store.refresh(), true);
  assert.equal(store.list().length, 2);
  assert.deepEqual([...store.forBooking("b1").keys()], ["p1"]);
  assert.equal(store.get("b1", "p1").response, "going");
  assert.equal(store.get("b1", "p2"), null);

  await store.setResponse("b1", "p2", "maybe");
  assert.equal(store.get("b1", "p2").response, "maybe");
  assert.equal(transport.rows.length, 3);
  assert.ok(notifications.length >= 2);

  // Changing an answer overwrites rather than appending.
  await store.setResponse("b1", "p2", "going");
  assert.equal(transport.rows.filter((r) => r.player_id === "p2").length, 1);
  assert.equal(store.get("b1", "p2").response, "going");
});

test("a failed save rolls the optimistic reply back", async () => {
  const transport = memoryTransport();
  transport.save = async () => {
    throw new Error("offline");
  };
  const store = createRsvpStore(transport, { storage: memoryStorage() });

  const seen = [];
  store.subscribe(() => seen.push(store.get("b1", "p1")?.response ?? null));

  await assert.rejects(() => store.setResponse("b1", "p1", "going"), /offline/);
  assert.equal(store.get("b1", "p1"), null);
  // Shown immediately, then withdrawn.
  assert.deepEqual(seen, ["going", null]);
});

test("a refresh in flight does not clobber a reply being written", async () => {
  const transport = memoryTransport([
    { booking_id: "b1", player_id: "p1", response: "not_going", updated_at: "2026-08-30T09:00:00.000Z" },
  ]);
  let releaseSave;
  const gate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const inner = transport.save.bind(transport);
  transport.save = async (record) => {
    await gate;
    return inner(record);
  };
  const store = createRsvpStore(transport, { storage: memoryStorage(), staleAfter: 0 });

  const saving = store.setResponse("b1", "p1", "going");
  await store.refresh({ force: true });
  assert.equal(store.get("b1", "p1").response, "going", "the stale row must not win");

  releaseSave();
  await saving;
  assert.equal(store.get("b1", "p1").response, "going");
});

test("deleting a booking forgets its replies locally and remotely", async () => {
  const transport = memoryTransport([
    { booking_id: "b1", player_id: "p1", response: "going", updated_at: "2026-08-30T09:00:00.000Z" },
    { booking_id: "b2", player_id: "p1", response: "going", updated_at: "2026-08-30T09:00:00.000Z" },
  ]);
  const store = createRsvpStore(transport, { storage: memoryStorage(), staleAfter: 0 });
  await store.refresh();

  await store.removeBooking("b1");
  assert.equal(store.forBooking("b1").size, 0);
  assert.equal(store.forBooking("b2").size, 1);
  assert.equal(transport.calls.removeBooking, 1);
  assert.deepEqual(transport.rows.map((r) => r.booking_id), ["b2"]);
});

test("the store remembers which player this device replies as", () => {
  const storage = memoryStorage();
  const store = createRsvpStore(memoryTransport(), { storage });
  assert.equal(store.getIdentity(), null);

  store.setIdentity("p3");
  assert.equal(store.getIdentity(), "p3");
  assert.equal(storage.getItem(RSVP_IDENTITY_KEY), "p3");

  const reopened = createRsvpStore(memoryTransport(), { storage });
  assert.equal(reopened.getIdentity(), "p3");

  reopened.setIdentity("");
  assert.equal(reopened.getIdentity(), null);
  assert.equal(storage.getItem(RSVP_IDENTITY_KEY), null);
});

test("refresh is throttled but forceable, and only notifies on real change", async () => {
  let clock = 0;
  const transport = memoryTransport([
    { booking_id: "b1", player_id: "p1", response: "going", updated_at: "2026-08-30T09:00:00.000Z" },
  ]);
  let notified = 0;
  const store = createRsvpStore(transport, {
    storage: memoryStorage(),
    staleAfter: 1000,
    now: () => clock,
  });
  store.subscribe(() => {
    notified += 1;
  });

  assert.equal(await store.refresh(), true);
  assert.equal(notified, 1);

  clock = 500;
  assert.equal(await store.refresh(), false, "still fresh");
  assert.equal(transport.calls.load, 1);

  // Same data across the wire: fetched again, but no re-render.
  assert.equal(await store.refresh({ force: true }), false);
  assert.equal(transport.calls.load, 2);
  assert.equal(notified, 1);

  clock = 2000;
  transport.rows.push({ booking_id: "b1", player_id: "p2", response: "maybe", updated_at: "2026-08-30T10:00:00.000Z" });
  assert.equal(await store.refresh(), true);
  assert.equal(notified, 2);
});

test("the standalone transport round-trips replies through browser storage", async () => {
  const storage = memoryStorage();
  const transport = createLocalRsvpTransport(storage);
  assert.deepEqual(await transport.load(), []);

  await transport.save({ bookingId: "b1", playerId: "p1", response: "going", updatedAt: "2026-08-30T09:00:00.000Z" });
  await transport.save({ bookingId: "b1", playerId: "p1", response: "maybe", updatedAt: "2026-08-30T10:00:00.000Z" });
  await transport.save({ bookingId: "b2", playerId: "p2", response: "going", updatedAt: "2026-08-30T10:00:00.000Z" });

  const rows = await transport.load();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.bookingId === "b1").response, "maybe");

  await transport.removeBooking("b1");
  assert.deepEqual((await transport.load()).map((r) => r.bookingId), ["b2"]);
});
