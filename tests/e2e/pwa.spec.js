import { test, expect } from "@playwright/test";

import { collectBrowserErrors, configureCloud, createTestDatabase, isolateCloud, seedDatabase } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await isolateCloud(page);
});

test("service worker caches the full shell and reloads offline", async ({ context, page }) => {
  await seedDatabase(page, createTestDatabase());
  const errors = collectBrowserErrors(page);
  await page.goto("/#roster");

  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return Boolean(registration.active);
  });
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  const cacheState = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open("pickleball-v7");
    const requests = await cache.keys();
    return {
      names,
      paths: requests.map((request) => new URL(request.url).pathname),
    };
  });
  expect(cacheState.names).toContain("pickleball-v7");
  expect(cacheState.paths.some((path) => path.endsWith("/index.html"))).toBe(true);
  expect(cacheState.paths.some((path) => path.endsWith("/assets/icons/icon-maskable.png"))).toBe(true);

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Roster" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  expect(errors).toEqual([]);
});

test("service worker registers when cloud startup finishes after window load", async ({ page }) => {
  await seedDatabase(page, createTestDatabase(), {
    syncState: {
      projectUrl: "https://fixture.supabase.co",
      stateId: "primary",
      pending: false,
      version: 3,
      updatedAt: "2026-08-30T22:30:00.000Z",
    },
  });
  await configureCloud(page);
  let releaseCloud;
  let noteCloudRequest;
  const cloudRelease = new Promise((resolve) => { releaseCloud = resolve; });
  const cloudRequested = new Promise((resolve) => { noteCloudRequest = resolve; });
  await page.route("https://fixture.supabase.co/**", async (route) => {
    noteCloudRequest();
    await cloudRelease;
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/#stats", { waitUntil: "load" });
  await cloudRequested;
  expect(await page.evaluate(() => document.readyState)).toBe("complete");
  releaseCloud();

  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.ready).active));
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes("pickleball-v7"))).toBe(true);
});

test("a fresh worker removes obsolete app-shell caches on activation", async ({ page }) => {
  await seedDatabase(page, createTestDatabase());
  await page.goto("/#roster");
  const registration = await page.evaluateHandle(() => navigator.serviceWorker.ready);
  await page.evaluate(async () => {
    await caches.open("pickleball-obsolete-test");
    const current = await navigator.serviceWorker.getRegistration();
    await current.unregister();
  });
  await registration.dispose();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.ready).active));
  await expect.poll(() => page.evaluate(async () => !(await caches.keys()).includes("pickleball-obsolete-test"))).toBe(true);
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes("pickleball-v7"))).toBe(true);
});