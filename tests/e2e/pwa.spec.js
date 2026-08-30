import { test, expect } from "@playwright/test";

import { collectBrowserErrors, createTestDatabase, seedDatabase } from "./fixtures.js";

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
    const cache = await caches.open("pickleball-v3");
    const requests = await cache.keys();
    return {
      names,
      paths: requests.map((request) => new URL(request.url).pathname),
    };
  });
  expect(cacheState.names).toContain("pickleball-v3");
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
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes("pickleball-v3"))).toBe(true);
});