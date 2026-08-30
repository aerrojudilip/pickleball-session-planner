import test from "node:test";
import assert from "node:assert/strict";

import { createGitHubClient, databaseFiles, GitHubApiError, hashContent, utf8ToBase64 } from "../../js/github.js";
import { createEmptyDatabase, DB_STORAGE_KEY } from "../../js/schema.js";
import { createStore } from "../../js/state.js";
import { CLOUD_SYNC_FIELD, clearDatabase, createPersister, loadDatabase, overwriteDatabase } from "../../js/storage.js";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values,
  };
}

test("GitHub client validates configuration and safe paths", async () => {
  assert.throws(() => createGitHubClient({ repo: "data", token: "fake" }), /owner/);
  assert.throws(() => createGitHubClient({ owner: "owner", token: "fake" }), /repository/);
  assert.throws(() => createGitHubClient({ owner: "owner", repo: "data" }), /token/);

  const client = createGitHubClient({
    owner: "owner",
    repo: "data",
    token: "fake",
    fetchImpl: async () => jsonResponse({}, 404),
  });
  await assert.rejects(client.getFile("../secret"), /safe repository-relative/);
  await assert.rejects(client.getFile("data//players.json"), /safe repository-relative/);
});

test("UTF-8 encoding and content hashes are deterministic", () => {
  const value = `Jos${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f3be)}`;
  assert.equal(Buffer.from(utf8ToBase64(value), "base64").toString("utf8"), value);
  assert.equal(hashContent(value), hashContent(value));
  assert.notEqual(hashContent(value), hashContent(`${value}!`));
  assert.match(hashContent(value), /^[0-9a-f]{8}$/);
});

test("backup file mapping uses safe deterministic paths", () => {
  const db = {
    schemaVersion: 1,
    players: [{ id: "p1", name: "Alex" }],
    sessions: [
      { id: "s/unsafe", date: "2026/08/30", rounds: [] },
      { id: "s2", date: "2026-08-31", rounds: [] },
    ],
  };
  const files = databaseFiles(db);
  assert.deepEqual(files.map((file) => file.path), [
    "data/players.json",
    "data/sessions/2026-08-30-s-unsafe.json",
    "data/sessions/2026-08-31-s2.json",
  ]);
  assert.equal(JSON.parse(files[0].content).players[0].name, "Alex");
  assert.ok(files.every((file) => file.content.endsWith("\n")));
});

test("GitHub token is sent only in headers and UTF-8 content is encoded", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "GET") return jsonResponse({}, 404);
    return jsonResponse({ content: { sha: "new" }, commit: { sha: "commit" } }, 201);
  };
  const client = createGitHubClient({ owner: "owner name", repo: "data repo", branch: "main", token: "fake-secret", fetchImpl });
  const value = `Jos${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f3be)}`;
  const result = await client.putFile(`data/${value}.json`, value, "backup");

  assert.equal(result.created, true);
  assert.equal(result.sha, "new");
  assert.ok(calls.every((call) => !call.url.includes("fake-secret")));
  assert.ok(calls.every((call) => call.init.headers.Authorization === "Bearer fake-secret"));
  assert.match(calls[0].url, /owner%20name\/data%20repo/);
  const body = JSON.parse(calls.find((call) => call.init.method === "PUT").init.body);
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), value);
  assert.equal(body.sha, undefined);
});

test("a 409 conflict re-fetches the SHA and retries exactly once", async () => {
  const calls = [];
  const responses = [
    jsonResponse({ sha: "old" }),
    jsonResponse({ message: "conflict" }, 409),
    jsonResponse({ sha: "fresh" }),
    jsonResponse({ content: { sha: "done" }, commit: { sha: "commit" } }),
  ];
  const client = createGitHubClient({
    owner: "owner",
    repo: "data",
    token: "fake",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
  });
  const result = await client.putFile("data/players.json", "{}", "backup");
  const puts = calls.filter((call) => call.init.method === "PUT").map((call) => JSON.parse(call.init.body));
  assert.equal(calls.length, 4);
  assert.equal(puts.length, 2);
  assert.equal(puts[0].sha, "old");
  assert.equal(puts[1].sha, "fresh");
  assert.equal(result.sha, "done");
});

test("a second 409 is surfaced without a third write", async () => {
  let callCount = 0;
  const responses = [
    jsonResponse({ sha: "old" }),
    jsonResponse({ message: "conflict one" }, 409),
    jsonResponse({ sha: "fresh" }),
    jsonResponse({ message: "conflict two" }, 409),
  ];
  const client = createGitHubClient({
    owner: "owner",
    repo: "data",
    token: "fake",
    fetchImpl: async () => {
      callCount += 1;
      return responses.shift();
    },
  });
  await assert.rejects(
    client.putFile("data/players.json", "{}", "backup"),
    (error) => error instanceof GitHubApiError && error.status === 409 && /after one retry/.test(error.message),
  );
  assert.equal(callCount, 4);
});

test("database sync skips unchanged files and reports progress", async () => {
  const db = { schemaVersion: 1, players: [], sessions: [{ id: "s1", date: "2026-08-30", rounds: [] }] };
  const files = databaseFiles(db);
  const previousHashes = { [files[0].path]: hashContent(files[0].content) };
  const events = [];
  const methods = [];
  const client = createGitHubClient({
    owner: "owner",
    repo: "data",
    token: "fake",
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      return init.method === "GET"
        ? jsonResponse({}, 404)
        : jsonResponse({ content: { sha: "new" }, commit: { sha: "commit" } }, 201);
    },
  });
  const result = await client.syncDatabase(db, {
    previousHashes,
    onProgress: (event) => events.push([event.type, event.path]),
  });
  assert.deepEqual(result.skipped, ["data/players.json"]);
  assert.deepEqual(result.written, ["data/sessions/2026-08-30-s1.json"]);
  assert.deepEqual(methods, ["GET", "PUT"]);
  assert.deepEqual(events, [
    ["skipped", "data/players.json"],
    ["written", "data/sessions/2026-08-30-s1.json"],
  ]);
  assert.match(result.lastSyncAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("concurrent writes are serialized", async () => {
  let active = 0;
  let maximumActive = 0;
  const fetchImpl = async (_url, init) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return init.method === "GET"
      ? jsonResponse({}, 404)
      : jsonResponse({ content: { sha: "new" }, commit: { sha: "commit" } }, 201);
  };
  const client = createGitHubClient({ owner: "owner", repo: "data", token: "fake", fetchImpl });
  await Promise.all([
    client.putFile("data/one.json", "1", "one"),
    client.putFile("data/two.json", "2", "two"),
  ]);
  assert.equal(maximumActive, 1);
});

test("GitHub errors are clear and preserve status", async () => {
  const client = createGitHubClient({
    owner: "owner",
    repo: "data",
    token: "fake",
    fetchImpl: async () => jsonResponse({ message: "Bad credentials" }, 401),
  });
  await assert.rejects(
    client.testConnection(),
    (error) => error instanceof GitHubApiError && error.status === 401 && /rejected the token/.test(error.message),
  );

  const offline = createGitHubClient({
    owner: "owner",
    repo: "data",
    token: "fake",
    fetchImpl: async () => { throw new Error("offline"); },
  });
  await assert.rejects(offline.testConnection(), /Could not reach GitHub/);
});

test("local storage loads, overwrites, clears, and preserves corrupt input", () => {
  const originalStorage = globalThis.localStorage;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  try {
    assert.deepEqual(loadDatabase(), { db: null, corrupt: false });
    const db = createEmptyDatabase();
    db.settings.theme = "dark";
    overwriteDatabase(db);
    assert.equal(loadDatabase().db.settings.theme, "dark");
    clearDatabase();
    assert.deepEqual(loadDatabase(), { db: null, corrupt: false });

    storage.setItem(DB_STORAGE_KEY, "{broken");
    assert.deepEqual(loadDatabase(), { db: null, corrupt: true, raw: "{broken" });
    assert.equal(storage.getItem(DB_STORAGE_KEY), "{broken");
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test("the persister ignores UI-only updates and flushes durable mutations", () => {
  const originalStorage = globalThis.localStorage;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  try {
    const store = createStore(createEmptyDatabase());
    const persister = createPersister(store);
    store.setUi({ route: "schedule" });
    persister.flush();
    assert.equal(storage.getItem(DB_STORAGE_KEY), null);

    store.commit("dark theme", (draft) => { draft.settings.theme = "dark"; });
    persister.flush();
    assert.equal(JSON.parse(storage.getItem(DB_STORAGE_KEY)).settings.theme, "dark");
    persister.unsubscribe();
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test("the persister atomically stores a mutation with pending cloud metadata", () => {
  const originalStorage = globalThis.localStorage;
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  try {
    const store = createStore(createEmptyDatabase());
    const syncState = {
      projectUrl: "https://fixture.supabase.co",
      stateId: "primary",
      pending: false,
      version: 4,
      updatedAt: null,
    };
    const persister = createPersister(store, null, {
      onMutation: () => { syncState.pending = true; },
      getSyncState: () => syncState,
    });

    store.commit("dark theme", (draft) => { draft.settings.theme = "dark"; });
    const cached = JSON.parse(storage.getItem(DB_STORAGE_KEY));
    assert.equal(cached.settings.theme, "dark");
    assert.equal(cached[CLOUD_SYNC_FIELD].pending, true);
    assert.equal(cached[CLOUD_SYNC_FIELD].version, 4);
    persister.unsubscribe();
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test("a failed local write remains pending and flush retries it", () => {
  const originalStorage = globalThis.localStorage;
  const values = new Map();
  let failWrite = true;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrite) throw new DOMException("Storage full", "QuotaExceededError");
      values.set(key, String(value));
    },
    removeItem: (key) => values.delete(key),
  };
  try {
    const errors = [];
    const store = createStore(createEmptyDatabase());
    const persister = createPersister(store, (error) => errors.push(error));
    store.commit("dark theme", (draft) => { draft.settings.theme = "dark"; });
    assert.equal(values.has(DB_STORAGE_KEY), false);
    assert.equal(errors.length, 1);

    failWrite = false;
    persister.flush();
    assert.equal(JSON.parse(values.get(DB_STORAGE_KEY)).settings.theme, "dark");
    persister.unsubscribe();
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test("the persister retries a local write after storage recovers", () => {
  const originalStorage = globalThis.localStorage;
  const storage = memoryStorage();
  const setItem = storage.setItem;
  let attempts = 0;
  storage.setItem = (key, value) => {
    attempts += 1;
    if (attempts === 1) throw new DOMException("Storage is full", "QuotaExceededError");
    setItem(key, value);
  };
  globalThis.localStorage = storage;
  try {
    const store = createStore(createEmptyDatabase());
    const persister = createPersister(store);
    store.commit("dark theme", (draft) => { draft.settings.theme = "dark"; });
    assert.equal(storage.getItem(DB_STORAGE_KEY), null);
    persister.flush();
    assert.equal(JSON.parse(storage.getItem(DB_STORAGE_KEY)).settings.theme, "dark");
    assert.equal(attempts, 2);
    persister.unsubscribe();
  } finally {
    globalThis.localStorage = originalStorage;
  }
});