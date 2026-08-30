import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ADMIN_SESSION_KEY, createAdminAuth } from "../../js/auth.js";

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test("the static app does not ship a local administrator password verifier", async () => {
  const source = await readFile(new URL("../../js/auth.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /PBKDF2|PASSWORD_(?:HASH|SALT|ITERATIONS)/);

  const auth = createAdminAuth({ storage: createMemoryStorage() });
  assert.equal(await auth.signIn("admin", "any-local-password"), false);
});

test("administrator authentication lasts for one browser session and supports logout", async () => {
  const storage = createMemoryStorage();
  const verify = async (username, password) => username === "admin" && password === "fixture password";
  const auth = createAdminAuth({ storage, verify });

  assert.equal(auth.isAuthenticated(), false);
  assert.equal(await auth.signIn("admin", "wrong"), false);
  assert.equal(storage.getItem(ADMIN_SESSION_KEY), null);

  assert.equal(await auth.signIn("admin", "fixture password"), true);
  assert.equal(auth.isAuthenticated(), true);
  assert.equal(storage.getItem(ADMIN_SESSION_KEY), "authenticated");
  assert.equal(createAdminAuth({ storage, verify }).isAuthenticated(), true);

  auth.signOut();
  assert.equal(auth.isAuthenticated(), false);
  assert.equal(storage.getItem(ADMIN_SESSION_KEY), null);
});

test("administrator authentication delegates to a configured cloud backend", async () => {
  const calls = [];
  let authenticated = false;
  const backend = {
    isConfigured: () => true,
    isAuthenticated: () => authenticated,
    signIn: async (username, password) => {
      calls.push(["signIn", username, password]);
      authenticated = username === "admin" && password === "cloud-password";
      return authenticated;
    },
    signOut: async () => {
      calls.push(["signOut"]);
      authenticated = false;
    },
  };
  const auth = createAdminAuth({ backend });

  assert.equal(auth.isAuthenticated(), false);
  assert.equal(await auth.signIn("admin", "cloud-password"), true);
  assert.equal(auth.isAuthenticated(), true);
  await auth.signOut();
  assert.equal(auth.isAuthenticated(), false);
  assert.deepEqual(calls, [["signIn", "admin", "cloud-password"], ["signOut"]]);
});