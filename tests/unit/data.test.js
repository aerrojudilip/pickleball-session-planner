import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyDatabase, normalizeDatabase } from "../../js/schema.js";
import {
  buildRepeatMatrix,
  computeLeaderboard,
  computePlayerStats,
  headToHead,
  partnerChemistry,
  sessionSummary,
} from "../../js/stats.js";
import {
  exportDatabase,
  exportSessionCsv,
  exportSessionJson,
  mergeDatabase,
  mergeSession,
  parseImport,
  replaceWith,
  sessionSummaryText,
} from "../../js/portability.js";

function dataFixture() {
  return normalizeDatabase({
    schemaVersion: 1,
    settings: createEmptyDatabase().settings,
    players: [
      { id: "p1", name: "Alex \"Ace\", Jr.", rating: 4, active: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "p2", name: "Beth", rating: 3.5, active: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "p3", name: "Chen", rating: 3, active: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "p4", name: "Drew", rating: null, active: true, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "p5", name: "Extra", rating: 2.5, active: false, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    constraints: { mustPair: [["p1", "p2"]], mustNotPair: [["p3", "p4"]] },
    sessions: [
      {
        id: "s1",
        date: "2026-08-30",
        name: "Sunday Open Play",
        location: "Community Courts",
        courtCount: 1,
        playerIds: ["p1", "p2", "p3", "p4", "p5"],
        seed: 42,
        mode: "random",
        bookingId: "b1",
        rules: { targetScore: 11, winByTwo: true, hardCap: null },
        createdAt: "2026-08-30T17:00:00.000Z",
        rounds: [
          {
            roundNumber: 1,
            startedAt: "2026-08-30T18:00:00.000Z",
            status: "completed",
            sitOutIds: ["p5"],
            warnings: [],
            courts: [
              { courtNumber: 1, teamA: ["p1", "p2"], teamB: ["p3", "p4"], score: { a: 11, b: 7 }, status: "completed", locked: false, timerEndsAt: null },
            ],
          },
          {
            roundNumber: 2,
            startedAt: "2026-08-30T18:20:00.000Z",
            status: "completed",
            sitOutIds: [],
            warnings: [],
            courts: [
              { courtNumber: 1, teamA: ["p1", "p3"], teamB: ["p2", "p4"], score: { a: 9, b: 11 }, status: "completed", locked: false, timerEndsAt: null },
            ],
          },
          {
            roundNumber: 3,
            startedAt: "2026-08-30T18:40:00.000Z",
            status: "draft",
            sitOutIds: [],
            warnings: [],
            courts: [
              { courtNumber: 1, teamA: ["p1", "p4"], teamB: ["p2", "p3"], score: null, status: "pending", locked: false, timerEndsAt: null },
            ],
          },
        ],
      },
    ],
    bookings: [
      { id: "b1", date: "2026-08-30", startTime: "18:00", durationMinutes: 90, courtCount: 1, name: "Sunday", location: "Community Courts", notes: "", sessionId: "s1", createdAt: "2026-08-01T00:00:00.000Z" },
    ],
  });
}

test("player stats count completed courts, points, ties, and sit-outs", () => {
  const stats = computePlayerStats(dataFixture());
  assert.deepEqual(stats.get("p1"), {
    playerId: "p1", games: 2, wins: 1, losses: 1, ties: 0, pointsFor: 20, pointsAgainst: 18, sitOuts: 0, diff: 2, winPct: 0.5,
  });
  assert.equal(stats.get("p2").wins, 2);
  assert.equal(stats.get("p3").losses, 2);
  assert.equal(stats.get("p5").games, 0);
  assert.equal(stats.get("p5").sitOuts, 1);
});

test("leaderboard, partner chemistry, and head-to-head derive from results", () => {
  const db = dataFixture();
  const leaderboard = computeLeaderboard(db);
  assert.equal(leaderboard[0].playerId, "p2");
  assert.equal(leaderboard.find((row) => row.playerId === "p5").sitOuts, 1);

  const partners = partnerChemistry(db, "p1");
  assert.deepEqual(partners.find((row) => row.partnerId === "p2"), { partnerId: "p2", games: 1, wins: 1, winPct: 1 });
  assert.deepEqual(partners.find((row) => row.partnerId === "p3"), { partnerId: "p3", games: 1, wins: 0, winPct: 0 });

  const opponents = headToHead(db, "p1");
  assert.deepEqual(opponents.find((row) => row.opponentId === "p2"), { opponentId: "p2", games: 1, wins: 0, losses: 1, winPct: 0 });
  assert.deepEqual(opponents.find((row) => row.opponentId === "p3"), { opponentId: "p3", games: 1, wins: 1, losses: 0, winPct: 1 });
});

test("repeat matrices count every generated partner and opponent matchup", () => {
  const db = dataFixture();
  const matrix = buildRepeatMatrix(db);
  assert.deepEqual(matrix.playerIds, ["p1", "p2", "p3", "p4", "p5"]);
  assert.equal(matrix.partnerCounts.get("p1|p2"), 1);
  assert.equal(matrix.partnerCounts.get("p1|p3"), 1);
  assert.equal(matrix.partnerCounts.get("p1|p4"), 1);
  assert.equal(matrix.opponentCounts.get("p1|p2"), 2);
  assert.equal(matrix.opponentCounts.get("p1|p3"), 2);
  assert.equal(matrix.opponentCounts.get("p1|p4"), 2);
  assert.equal(matrix.maxPartner, 1);
  assert.equal(matrix.maxOpponent, 2);

  const sessionOnly = buildRepeatMatrix(db, (session) => session.id === "missing");
  assert.deepEqual(sessionOnly.playerIds, []);
  assert.equal(sessionOnly.maxPartner, 0);
  assert.equal(sessionOnly.maxOpponent, 0);
});

test("session summaries ignore pending games", () => {
  const db = dataFixture();
  const summary = sessionSummary(db, "s1");
  assert.equal(summary.rounds, 3);
  assert.equal(summary.gamesPlayed, 2);
  assert.equal(summary.players, 5);
  assert.equal(summary.leaderboard.length, 5);
  assert.equal(sessionSummary(db, "missing"), null);

  for (const round of db.sessions[0].rounds) {
    round.sitOutIds = [];
    for (const court of round.courts) {
      court.status = "pending";
      court.score = null;
    }
  }
  const pending = sessionSummary(db, "s1");
  assert.equal(pending.gamesPlayed, 0);
  assert.equal(pending.leaderboard.length, 5);
  assert.ok(pending.leaderboard.every((row) => row.games === 0 && row.sitOuts === 0));
});

test("database export parses and replaces without changing application state", () => {
  const db = dataFixture();
  db.sessions[0].rounds[0]._regen = 2;
  const exported = JSON.parse(exportDatabase(db));
  assert.equal(exported.app, "pickleball-session-planner");
  assert.equal(exported.kind, "database");
  assert.equal(exported.schemaVersion, 1);

  const parsed = parseImport(JSON.stringify(exported));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.kind, "database");
  assert.deepEqual(replaceWith(parsed.database), db);
});

test("single-session exports include referenced players and quote CSV safely", () => {
  const db = dataFixture();
  const exported = JSON.parse(exportSessionJson(db, "s1"));
  assert.equal(exported.kind, "session");
  assert.equal(exported.players.length, 5);
  assert.equal(exported.players.some((player) => player.id === "p5"), true);

  const csv = exportSessionCsv(db, "s1");
  assert.match(csv, /^Round,Court,Team A,Team B,Score A,Score B,Status,Winner\r\n/);
  assert.match(csv, /"Alex ""Ace"", Jr\. & Beth"/);
  assert.match(csv, /pending/);

  const summary = sessionSummaryText(db, "s1");
  assert.match(summary, /Sunday Open Play/);
  assert.match(summary, /Court 1:/);
  assert.match(summary, /11\u20137/);
});

test("database merge is deterministic, incoming wins, and current settings remain", () => {
  const current = dataFixture();
  const incoming = dataFixture();
  incoming.players.find((player) => player.id === "p1").name = "Renamed";
  incoming.players.push({ id: "p6", name: "Faye", rating: 4.5, active: true, notes: "", isSample: false, createdAt: "2026-01-01T00:00:00.000Z" });
  incoming.constraints.mustNotPair.push(["p1", "p3"]);
  incoming.settings.theme = "dark";

  const merged = mergeDatabase(current, incoming);
  assert.equal(merged.players.find((player) => player.id === "p1").name, "Renamed");
  assert.equal(merged.players.some((player) => player.id === "p6"), true);
  assert.deepEqual(merged.constraints.mustNotPair, [["p3", "p4"], ["p1", "p3"]]);
  assert.equal(merged.settings.theme, current.settings.theme);
  assert.deepEqual(mergeDatabase(merged, incoming), merged);
});

test("session merge adds its players and replaces an id collision", () => {
  const current = createEmptyDatabase();
  const first = mergeSession(current, { ...dataFixture().sessions[0], name: "Imported" }, dataFixture().players);
  assert.equal(first.sessions.length, 1);
  assert.equal(first.players.length, 5);
  const second = mergeSession(first, { ...first.sessions[0], name: "Updated" }, []);
  assert.equal(second.sessions.length, 1);
  assert.equal(second.sessions[0].name, "Updated");
});

test("invalid JSON, unrecognized documents, and future schemas are rejected", () => {
  assert.equal(parseImport("not json").ok, false);
  assert.equal(parseImport("{}").ok, false);

  const future = parseImport(JSON.stringify({
    app: "pickleball-session-planner",
    kind: "database",
    schemaVersion: 2,
    database: { ...dataFixture(), schemaVersion: 2 },
  }));
  assert.equal(future.ok, false);
  assert.match(future.error, /version 2/);
});