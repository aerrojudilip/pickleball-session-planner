import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createEmptyDatabase } from "../../js/schema.js";
import { createStore } from "../../js/state.js";
import {
  createCloudPersister,
  createSupabaseBackend,
  SupabaseConflictError,
  SupabaseError,
  SUPABASE_SESSION_KEY,
} from "../../js/supabase.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Supabase authenticates the administrator and loads the database document", async () => {
  const calls = [];
  const database = createEmptyDatabase();
  const storage = memoryStorage();
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/auth/v1/token")) {
      return jsonResponse({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        user: { email: "admin@pickleball-planner.app" },
      });
    }
    return jsonResponse([{ document: database, version: 4, updated_at: "2026-08-30T22:00:00.000Z" }]);
  };
  const backend = createSupabaseBackend({
    url: "https://fixture.supabase.co",
    anonKey: "public-anon-key",
    adminEmail: "admin@pickleball-planner.app",
    stateId: "primary",
  }, { fetchImpl, storage, now: () => 1_788_127_200_000 });

  assert.equal(backend.isConfigured(), true);
  assert.equal(await backend.signIn("admin", "fixture-password"), true);
  assert.ok(storage.getItem(SUPABASE_SESSION_KEY));
  const authCall = calls[0];
  assert.equal(JSON.parse(authCall.init.body).email, "admin@pickleball-planner.app");
  assert.equal(authCall.init.headers.apikey, "public-anon-key");
  assert.ok(!authCall.url.includes("fixture-password"));

  const loaded = await backend.loadDatabase();
  assert.deepEqual(loaded.database, database);
  assert.equal(loaded.version, 4);
  assert.equal(calls[1].init.headers.Authorization, "Bearer access-token");
});

test("Supabase configuration is optional but rejects unsafe project URLs", () => {
  const backend = createSupabaseBackend({}, { fetchImpl: async () => jsonResponse({}), storage: memoryStorage() });
  assert.equal(backend.isConfigured(), false);
  assert.throws(
    () => createSupabaseBackend({ url: "http://fixture.supabase.co", anonKey: "key", adminEmail: "admin@example.com" }),
    /Supabase URL/,
  );
  assert.throws(
    () => createSupabaseBackend({ url: "https://fixture.supabase.co", anonKey: "key" }),
    /administrator email/,
  );
});

test("public cloud reads use the publishable key and an empty table is not seeded implicitly", async () => {
  const calls = [];
  const backend = createSupabaseBackend({
    url: "https://fixture.supabase.co",
    anonKey: "public-anon-key",
    adminEmail: "admin@pickleball-planner.app",
  }, {
    storage: memoryStorage(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse([]);
    },
  });

  assert.deepEqual(await backend.loadDatabase(), { database: null, version: null, updatedAt: null });
  assert.equal(calls[0].init.headers.apikey, "public-anon-key");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.method, "GET");
});

test("cloud reads reject unsupported future schema versions before normalization", async () => {
  const futureDatabase = { ...createEmptyDatabase(), schemaVersion: 2 };
  const backend = createSupabaseBackend({
    url: "https://fixture.supabase.co",
    anonKey: "public-anon-key",
    adminEmail: "admin@pickleball-planner.app",
  }, {
    storage: memoryStorage(),
    fetchImpl: async () => jsonResponse([{ document: futureDatabase, version: 9, updated_at: null }]),
  });

  await assert.rejects(backend.loadDatabase(), /supports up to 1/i);
});

test("cloud writes require authentication and increment the loaded version", async () => {
  const calls = [];
  const database = createEmptyDatabase();
  const backend = createSupabaseBackend({
    url: "https://fixture.supabase.co",
    anonKey: "public-anon-key",
    adminEmail: "admin@pickleball-planner.app",
    stateId: "shared",
  }, {
    storage: memoryStorage(),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/auth/v1/token")) {
        return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
      }
      if (init.method === "GET") return jsonResponse([{ document: database, version: 7, updated_at: null }]);
      return jsonResponse([{ version: 8, updated_at: "2026-08-30T22:10:00.000Z" }]);
    },
  });

  await assert.rejects(backend.saveDatabase(database), (error) => error instanceof SupabaseError && error.status === 401);
  assert.equal(await backend.signIn("admin", "fixture-password"), true);
  await backend.loadDatabase();
  const saved = await backend.saveDatabase(database);
  const patch = calls.find((call) => call.init.method === "PATCH");
  assert.match(patch.url, /id=eq.shared&version=eq.7/);
  assert.equal(patch.init.headers.Authorization, "Bearer access");
  assert.equal(JSON.parse(patch.init.body).version, 8);
  assert.equal(saved.version, 8);
});

test("expired administrator sessions refresh before writing", async () => {
  const storage = memoryStorage();
  storage.setItem(SUPABASE_SESSION_KEY, JSON.stringify({
    projectUrl: "https://fixture.supabase.co",
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    expiresAt: 100,
  }));
  const calls = [];
  const backend = createSupabaseBackend({
    url: "https://fixture.supabase.co",
    anonKey: "public-anon-key",
    adminEmail: "admin@pickleball-planner.app",
  }, {
    storage,
    now: () => 1_000_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("grant_type=refresh_token")) {
        return jsonResponse({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 });
      }
      return jsonResponse([{ version: 1, updated_at: null }], 201);
    },
  });

  await backend.saveDatabase(createEmptyDatabase());
  assert.match(calls[0].url, /grant_type=refresh_token/);
  assert.equal(calls[1].init.headers.Authorization, "Bearer fresh-access");
  assert.match(storage.getItem(SUPABASE_SESSION_KEY), /fresh-refresh/);
});

test("transient refresh failures preserve the administrator session", async () => {
  const storage = memoryStorage();
  storage.setItem(SUPABASE_SESSION_KEY, JSON.stringify({
    projectUrl: "https://fixture.supabase.co",
    accessToken: "expired-access",
    refreshToken: "recoverable-refresh",
    expiresAt: 100,
  }));
  const backend = createSupabaseBackend({
    url: "https://fixture.supabase.co",
    anonKey: "public-anon-key",
    adminEmail: "admin@pickleball-planner.app",
  }, {
    storage,
    now: () => 1_000_000,
    fetchImpl: async () => jsonResponse({ message: "temporarily unavailable" }, 503),
  });

  await assert.rejects(backend.loadDatabase(), /Could not refresh the administrator session/i);
  assert.match(storage.getItem(SUPABASE_SESSION_KEY), /recoverable-refresh/);
  assert.equal(backend.isAuthenticated(), true);
});

test("rejected refresh credentials clear the administrator session", async () => {
  const storage = memoryStorage();
  storage.setItem(SUPABASE_SESSION_KEY, JSON.stringify({
    projectUrl: "https://fixture.supabase.co",
    accessToken: "expired-access",
    refreshToken: "invalid-refresh",
    expiresAt: 100,
  }));
  const backend = createSupabaseBackend({
    url: "https://fixture.supabase.co",
    anonKey: "public-anon-key",
    adminEmail: "admin@pickleball-planner.app",
  }, {
    storage,
    now: () => 1_000_000,
    fetchImpl: async () => jsonResponse({ error: "invalid_grant" }, 400),
  });

  await assert.rejects(backend.saveDatabase(createEmptyDatabase()), /session expired/i);
  assert.equal(storage.getItem(SUPABASE_SESSION_KEY), null);
  assert.equal(backend.isAuthenticated(), false);
});

test("legacy browser sync metadata cannot choose the cloud write version", async () => {
  const sessionStorage = memoryStorage();
  const legacyStorage = memoryStorage();
  sessionStorage.setItem(SUPABASE_SESSION_KEY, JSON.stringify({
    projectUrl: "https://fixture.supabase.co",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600000,
  }));
  legacyStorage.setItem("pickleball.supabase.sync.v1", JSON.stringify({
    projectUrl: "https://fixture.supabase.co",
    stateId: "primary",
    pending: true,
    version: 6,
    updatedAt: null,
  }));
  const requests = [];
  const database = createEmptyDatabase();
  const backend = createSupabaseBackend({
    url: "https://fixture.supabase.co",
    anonKey: "public-anon-key",
    adminEmail: "admin@pickleball-planner.app",
  }, {
    storage: sessionStorage,
    syncStorage: legacyStorage,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (init.method === "GET") {
        return jsonResponse([{ document: database, version: 4, updated_at: "2026-08-30T22:39:00.000Z" }]);
      }
      return jsonResponse([{ version: 5, updated_at: "2026-08-30T22:40:00.000Z" }]);
    },
  });

  assert.deepEqual(backend.getSyncState(), {
    projectUrl: "https://fixture.supabase.co",
    stateId: "primary",
    pending: false,
    version: null,
    updatedAt: null,
  });
  await backend.loadDatabase();
  await backend.saveDatabase(database);
  assert.equal(requests[1].init.method, "PATCH");
  assert.match(requests[1].url, /version=eq.4/);
  assert.doesNotMatch(requests[1].url, /version=eq.6/);
  assert.deepEqual(backend.getSyncState(), {
    projectUrl: "https://fixture.supabase.co",
    stateId: "primary",
    pending: false,
    version: 5,
    updatedAt: "2026-08-30T22:40:00.000Z",
  });
});

test("loading newer cloud data does not rebase a pending in-memory document", async () => {
  const sessionStorage = memoryStorage();
  sessionStorage.setItem(SUPABASE_SESSION_KEY, JSON.stringify({
    projectUrl: "https://fixture.supabase.co",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600000,
  }));
  const requests = [];
  const backend = createSupabaseBackend({
    url: "https://fixture.supabase.co",
    anonKey: "public-anon-key",
    adminEmail: "admin@pickleball-planner.app",
  }, {
    storage: sessionStorage,
    syncState: {
      projectUrl: "https://fixture.supabase.co",
      stateId: "primary",
      pending: true,
      version: 3,
      updatedAt: null,
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (init.method === "GET") {
        return jsonResponse([{ document: createEmptyDatabase(), version: 4, updated_at: null }]);
      }
      return jsonResponse([]);
    },
  });

  await assert.rejects(backend.loadDatabase(), SupabaseConflictError);
  assert.equal((await backend.loadDatabase({ allowConflict: true })).version, 4);
  await assert.rejects(backend.saveDatabase(createEmptyDatabase()), SupabaseConflictError);
  assert.match(requests[2].url, /version=eq.3/);
  assert.equal(backend.getSyncState().pending, true);
  assert.equal(backend.getSyncState().version, 3);
});

test("Supabase serializes writes and rejects a stale version", async () => {
  const database = createEmptyDatabase();
  const storage = memoryStorage();
  storage.setItem(SUPABASE_SESSION_KEY, JSON.stringify({
    projectUrl: "https://fixture.supabase.co",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600000,
  }));
  const methods = [];
  let releaseFirst;
  const firstWrite = new Promise((resolve) => { releaseFirst = resolve; });
  let writeCount = 0;
  const backend = createSupabaseBackend({
    url: "https://fixture.supabase.co",
    anonKey: "public-anon-key",
    adminEmail: "admin@pickleball-planner.app",
  }, {
    storage,
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      writeCount += 1;
      if (writeCount === 1) await firstWrite;
      return writeCount === 2 ? jsonResponse([], 200) : jsonResponse([{ version: 1, updated_at: null }], 201);
    },
  });

  const first = backend.saveDatabase(database);
  const second = backend.saveDatabase(database);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(methods, ["POST"]);
  releaseFirst();
  await first;
  await assert.rejects(second, (error) => error instanceof SupabaseConflictError);
  assert.deepEqual(methods, ["POST", "PATCH"]);
});

test("cloud persistence ignores UI state and flushes the latest durable mutation", async () => {
  const store = createStore(createEmptyDatabase());
  const saved = [];
  const states = [];
  let pendingMarks = 0;
  const backend = {
    isConfigured: () => true,
    isAuthenticated: () => true,
    markPending: () => { pendingMarks += 1; },
    saveDatabase: async (database) => {
      saved.push(structuredClone(database));
      return { version: saved.length, updatedAt: "2026-08-30T22:20:00.000Z" };
    },
  };
  const persister = createCloudPersister(store, backend, {
    delay: 10000,
    onStatus: (status) => states.push(status.state),
  });

  store.setUi({ route: "stats" });
  await persister.flush();
  assert.equal(saved.length, 0);

  store.commit("change theme", (draft) => { draft.settings.theme = "dark"; });
  assert.equal(pendingMarks, 1);
  await persister.flush();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].settings.theme, "dark");
  assert.deepEqual(states, ["pending", "syncing", "synced"]);
  assert.equal(persister.hasPending(), false);
  persister.unsubscribe();
});

test("Supabase schema enables RLS without granting anonymous writes", async () => {
  const sql = await readFile(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /grant select[^;]+to anon, authenticated/i);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete)[^;]+to anon/i);
  assert.match(sql, /for insert\s+to authenticated/i);
  assert.match(sql, /for update\s+to authenticated/i);
  assert.match(sql, /auth\.jwt\(\)[^;]+admin@pickleball-planner\.app/i);
  assert.match(sql, /new\.version <> old\.version \+ 1/i);
});

test("cloud reads do not access browser sync storage", async () => {
  const cloudDatabase = createEmptyDatabase();
  cloudDatabase.players.push({ id: "p-cloud", name: "Cloud Current" });
  const forbiddenStorage = {
    getItem() { throw new Error("browser sync storage was read"); },
    setItem() { throw new Error("browser sync storage was written"); },
    removeItem() { throw new Error("browser sync storage was changed"); },
  };
  const backend = createSupabaseBackend({
    url: "https://fixture.supabase.co",
    anonKey: "public-anon-key",
    adminEmail: "admin@pickleball-planner.app",
  }, {
    storage: memoryStorage(),
    syncStorage: forbiddenStorage,
    fetchImpl: async () => jsonResponse([{ document: cloudDatabase, version: 4, updated_at: null }]),
  });

  const loaded = await backend.loadDatabase();
  assert.equal(loaded.database.players[0].name, "Cloud Current");
  assert.equal(backend.getRemoteVersion(), 4);
});