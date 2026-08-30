// state.js — the single application store with subscribe/notify and undo/redo.
//
// The store holds the full database document plus a little transient UI state
// (current route, current session id) that is NOT persisted. Mutations go
// through `commit`, which snapshots the previous database for undo. A bounded
// history (20 entries) supports undo/redo of durable user actions.
//
// Persistence is wired externally: subscribers (e.g. storage) react to changes.

import { createEmptyDatabase, normalizeDatabase } from "./schema.js";

const HISTORY_LIMIT = 20;

export function createStore(initialDb) {
  let db = normalizeDatabase(initialDb || createEmptyDatabase());

  // Transient, non-persisted UI state.
  let ui = {
    route: "roster",
    currentSessionId: null,
    calendarWeekStart: null, // YYYY-MM-DD of the Sunday of the visible week
  };

  /** @type {Array<{ label: string, before: object, after: object }>} */
  const undoStack = [];
  /** @type {Array<{ label: string, before: object, after: object }>} */
  const redoStack = [];

  const listeners = new Set();

  function notify(meta) {
    for (const fn of listeners) fn(getState(), meta);
  }

  function getState() {
    return { db, ui };
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * Apply a mutation to the database as an undoable command.
   * The mutator receives a deep clone of the db and returns the new db
   * (or mutates the clone in place).
   *
   * @param {string} label - human-readable, used in the undo toast
   * @param {(draft: object) => (object|void)} mutator
   * @param {object} [meta] - passed to listeners (e.g. { persist: true })
   */
  function commit(label, mutator, meta = {}) {
    const before = clone(db);
    const draft = clone(db);
    const result = mutator(draft);
    const after = result && typeof result === "object" ? result : draft;
    db = after;

    undoStack.push({ label, before, after: clone(after) });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0; // new branch clears redo

    notify({ ...meta, type: "commit", label });
    return db;
  }

  /**
   * Replace the entire database without creating an undo entry chain issue.
   * Still undoable as a single action (used by import replace).
   */
  function replaceDatabase(label, newDb, meta = {}) {
    return commit(label, () => normalizeDatabase(newDb), meta);
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return false;
    redoStack.push(entry);
    db = clone(entry.before);
    notify({ type: "undo", label: entry.label, persist: true });
    return entry.label;
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) return false;
    undoStack.push(entry);
    db = clone(entry.after);
    notify({ type: "redo", label: entry.label, persist: true });
    return entry.label;
  }

  function canUndo() {
    return undoStack.length > 0;
  }
  function canRedo() {
    return redoStack.length > 0;
  }

  /** Update transient UI state without touching the database or history. */
  function setUi(patch, meta = {}) {
    ui = { ...ui, ...patch };
    notify({ ...meta, type: "ui" });
  }

  return {
    getState,
    getDb: () => db,
    getUi: () => ui,
    subscribe,
    commit,
    replaceDatabase,
    undo,
    redo,
    canUndo,
    canRedo,
    setUi,
  };
}

/** Structured clone with a JSON fallback for older runtimes. */
export function clone(obj) {
  if (typeof structuredClone === "function") return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}
