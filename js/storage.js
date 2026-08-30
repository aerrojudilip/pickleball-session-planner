// storage.js — Tier 1 persistence: the full JSON document in localStorage.
//
// Writes are debounced on mutation and flushed on page hide. Corrupt JSON is
// preserved (never silently overwritten) so the user can choose to reset or
// import. Quota/write failures are surfaced via a callback.
//
// This module touches localStorage only; it has no other DOM dependencies.

import { DB_STORAGE_KEY, normalizeDatabase } from "./schema.js";

const DEBOUNCE_MS = 400;

/**
 * @typedef {Object} LoadResult
 * @property {object|null} db - normalized database, or null if none stored
 * @property {boolean} corrupt - true if stored data existed but failed to parse
 * @property {string} [raw] - the raw corrupt string, if any
 */

/**
 * Load and normalize the database from localStorage.
 * @returns {LoadResult}
 */
export function loadDatabase() {
  let raw;
  try {
    raw = localStorage.getItem(DB_STORAGE_KEY);
  } catch {
    return { db: null, corrupt: false };
  }
  if (raw == null) return { db: null, corrupt: false };
  try {
    const parsed = JSON.parse(raw);
    return { db: normalizeDatabase(parsed), corrupt: false };
  } catch {
    return { db: null, corrupt: true, raw };
  }
}

/**
 * Create a debounced saver bound to a store.
 * @param {object} store - the app store (from createStore)
 * @param {(err: Error) => void} [onError]
 */
export function createPersister(store, onError) {
  let timer = null;
  let pending = false;

  function writeNow() {
    pending = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      const db = store.getDb();
      localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(db));
    } catch (err) {
      if (onError) onError(err);
    }
  }

  function schedule() {
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(writeNow, DEBOUNCE_MS);
  }

  function flush() {
    if (pending) writeNow();
  }

  // React to store mutations that request persistence.
  const unsubscribe = store.subscribe((_state, meta) => {
    if (meta && meta.type === "ui") return; // UI-only changes are not persisted
    if (meta && meta.persist === false) return;
    schedule();
  });

  return { schedule, flush, writeNow, unsubscribe };
}

/** Overwrite storage with a specific database object immediately. */
export function overwriteDatabase(db) {
  localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(normalizeDatabase(db)));
}

/** Remove the stored database entirely. */
export function clearDatabase() {
  localStorage.removeItem(DB_STORAGE_KEY);
}
