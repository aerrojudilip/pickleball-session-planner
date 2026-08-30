// portability.js — export / import of the database and individual sessions.
//
// DOM-free and deterministic so it can be unit-tested in Node. The UI layer
// handles file download, clipboard, and file input.

import { SCHEMA_VERSION, checkSchemaVersion, normalizeDatabase, nowIso } from "./schema.js";

const APP_TAG = "pickleball-session-planner";

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Full database export wrapped with metadata. Returns a pretty JSON string. */
export function exportDatabase(db) {
  const payload = {
    app: APP_TAG,
    kind: "database",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(),
    database: db,
  };
  return JSON.stringify(payload, null, 2);
}

/** Single-session export including the players it references. */
export function exportSessionJson(db, sessionId) {
  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error("Session not found");
  const ids = referencedPlayerIds(session);
  const players = db.players.filter((p) => ids.has(p.id));
  const payload = {
    app: APP_TAG,
    kind: "session",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowIso(),
    session,
    players,
  };
  return JSON.stringify(payload, null, 2);
}

/** CSV of every game (court) in a session. */
export function exportSessionCsv(db, sessionId) {
  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error("Session not found");
  const nameById = new Map(db.players.map((p) => [p.id, p.name]));
  const name = (id) => nameById.get(id) || id;
  const rows = [["Round", "Court", "Team A", "Team B", "Score A", "Score B", "Status", "Winner"]];
  for (const round of session.rounds) {
    for (const court of round.courts) {
      const teamA = court.teamA.map(name).join(" & ");
      const teamB = court.teamB.map(name).join(" & ");
      const sa = court.score ? court.score.a : "";
      const sb = court.score ? court.score.b : "";
      let winner = "";
      if (court.status === "completed" && court.score) {
        winner = court.score.a > court.score.b ? teamA : court.score.b > court.score.a ? teamB : "Tie";
      }
      rows.push([round.roundNumber, court.courtNumber, teamA, teamB, sa, sb, court.status, winner]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** Plain-text human summary of a session for sharing (clipboard). */
export function sessionSummaryText(db, sessionId) {
  const session = db.sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error("Session not found");
  const nameById = new Map(db.players.map((p) => [p.id, p.name]));
  const name = (id) => nameById.get(id) || id;
  const lines = [];
  lines.push(session.name ? `${session.name} — ${session.date}` : session.date);
  if (session.location) lines.push(session.location);
  lines.push("");
  for (const round of session.rounds) {
    lines.push(`Round ${round.roundNumber}`);
    for (const court of round.courts) {
      const teamA = court.teamA.map(name).join(" & ");
      const teamB = court.teamB.map(name).join(" & ");
      const score = court.score ? `  ${court.score.a}–${court.score.b}` : court.status === "abandoned" ? "  (skipped)" : "";
      lines.push(`  Court ${court.courtNumber}: ${teamA} vs ${teamB}${score}`);
    }
    if (round.sitOutIds && round.sitOutIds.length) {
      lines.push(`  Sitting out: ${round.sitOutIds.map(name).join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Parse an import payload. Returns a discriminated result:
 *  { ok:true, kind:"database", database } | { ok:true, kind:"session", session, players }
 *  | { ok:false, error }
 */
export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "That doesn't look like valid JSON." };
  }
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Unrecognized file contents." };
  }
  const versionDocuments = [];
  if (data.schemaVersion !== undefined) versionDocuments.push(data);
  if (data.database && data.database.schemaVersion !== undefined) versionDocuments.push(data.database);
  if (versionDocuments.length === 0) versionDocuments.push(data);
  for (const document of versionDocuments) {
    const version = checkSchemaVersion(document);
    if (!version.ok) return { ok: false, error: version.reason };
  }
  // Full database (wrapped or bare)
  if (data.kind === "database" && data.database) {
    return { ok: true, kind: "database", database: normalizeDatabase(data.database) };
  }
  if (Array.isArray(data.players) && Array.isArray(data.sessions) && !data.session) {
    // bare database document
    return { ok: true, kind: "database", database: normalizeDatabase(data) };
  }
  // Single session
  if ((data.kind === "session" || data.session) && data.session) {
    const players = Array.isArray(data.players) ? data.players : [];
    if (!data.session.id || !Array.isArray(data.session.rounds)) {
      return { ok: false, error: "Session data is incomplete." };
    }
    return { ok: true, kind: "session", session: data.session, players };
  }
  return { ok: false, error: "Unrecognized file: not a database or session export." };
}

/** Replace the entire database with an imported one (already normalized). */
export function replaceWith(incomingDb) {
  return normalizeDatabase(incomingDb);
}

/**
 * Deterministically merge an imported database into the current one.
 * Players/sessions/bookings de-duplicate by id (incoming wins on conflict).
 * Constraints union by unordered pair. Current settings are preserved.
 */
export function mergeDatabase(currentDb, incomingDb) {
  const current = normalizeDatabase(currentDb);
  const incoming = normalizeDatabase(incomingDb);

  const players = mergeById(current.players, incoming.players);
  const sessions = mergeById(current.sessions, incoming.sessions);
  const bookings = mergeById(current.bookings, incoming.bookings);

  const constraints = {
    mustPair: unionPairs(current.constraints.mustPair, incoming.constraints.mustPair),
    mustNotPair: unionPairs(current.constraints.mustNotPair, incoming.constraints.mustNotPair),
  };

  return normalizeDatabase({
    ...current,
    players,
    sessions,
    bookings,
    constraints,
    settings: current.settings,
  });
}

/**
 * Merge a single imported session (and its players) into the current database.
 */
export function mergeSession(currentDb, session, players) {
  const current = normalizeDatabase(currentDb);
  const mergedPlayers = mergeById(current.players, players || []);
  const mergedSessions = mergeById(current.sessions, [session]);
  return normalizeDatabase({
    ...current,
    players: mergedPlayers,
    sessions: mergedSessions,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function referencedPlayerIds(session) {
  const ids = new Set(session.playerIds || []);
  for (const round of session.rounds) {
    for (const id of round.sitOutIds || []) ids.add(id);
    for (const court of round.courts) {
      for (const id of court.teamA) ids.add(id);
      for (const id of court.teamB) ids.add(id);
    }
  }
  return ids;
}

function mergeById(currentList, incomingList) {
  const map = new Map();
  for (const item of currentList) map.set(item.id, item);
  for (const item of incomingList) map.set(item.id, item); // incoming wins
  return [...map.values()];
}

function pairKey(pair) {
  return [...pair].sort().join("|");
}

function unionPairs(a, b) {
  const seen = new Map();
  for (const p of [...a, ...b]) {
    if (Array.isArray(p) && p.length === 2) seen.set(pairKey(p), p);
  }
  return [...seen.values()];
}

function csvCell(value) {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
