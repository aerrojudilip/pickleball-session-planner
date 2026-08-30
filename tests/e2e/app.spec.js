import { test, expect } from "@playwright/test";

import {
  CREDENTIALS_KEY,
  createTestDatabase,
  DB_KEY,
  collectBrowserErrors,
  localDateString,
  seedDatabase,
} from "./fixtures.js";

test.describe("core browser journeys", () => {
  test("375px roster stays usable and a new player persists after reload", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await seedDatabase(page, createTestDatabase());
    const errors = collectBrowserErrors(page);

    await page.goto("/#roster");
    await expect(page.getByRole("heading", { name: "Roster" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Display mode" })).toBeVisible();

    const overflow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      widestCourt: Math.max(0, ...[...document.querySelectorAll(".court")].map((element) => element.scrollWidth - element.clientWidth)),
    }));
    expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.widestCourt).toBe(0);

    await page.getByRole("button", { name: /Add player/ }).click();
    const dialog = page.getByRole("dialog", { name: "Add player" });
    await dialog.locator("#pf-name").fill("Jordan Lee");
    await dialog.locator("#pf-rating").fill("4.0");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit Jordan Lee" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();

    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).players.some((player) => player.name === "Jordan Lee"), DB_KEY)).toBe(true);
    await page.reload();
    await expect(page.getByRole("button", { name: "Edit Jordan Lee" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("a court booking starts a linked session and opens its scores", async ({ page }) => {
    await seedDatabase(page, createTestDatabase());
    const errors = collectBrowserErrors(page);
    await page.goto("/#schedule");

    await page.getByRole("button", { name: /Book court/ }).click();
    const bookingDialog = page.getByRole("dialog", { name: "Book court time" });
    await bookingDialog.locator('input[type="date"]').fill(localDateString());
    await bookingDialog.locator('input[type="time"]').fill("18:00");
    await bookingDialog.getByPlaceholder("e.g. Saturday Open Play").fill("Tuesday Rally");
    await bookingDialog.getByPlaceholder("e.g. Community Courts").fill("North Courts");
    await bookingDialog.getByRole("button", { name: "Add booking" }).click();

    const booking = page.getByRole("button", { name: /Tuesday Rally/ });
    await expect(booking).toBeVisible();
    await booking.click();
    await page.getByRole("dialog", { name: "Tuesday Rally" }).getByRole("button", { name: "Start session" }).click();

    await expect(page.getByRole("heading", { name: "New session" })).toBeVisible();
    await expect(page.getByPlaceholder("e.g. Saturday Open Play")).toHaveValue("Tuesday Rally");
    await page.getByRole("button", { name: /Generate 1 round/ }).click();
    await expect(page.getByRole("heading", { name: "Tuesday Rally" })).toBeVisible();

    await page.getByRole("button", { name: "Enter score" }).first().click();
    const scoreDialog = page.getByRole("dialog", { name: "Court 1 score" });
    await scoreDialog.getByRole("spinbutton", { name: "Team A score" }).fill("11");
    await scoreDialog.getByRole("spinbutton", { name: "Team B score" }).fill("7");
    await scoreDialog.getByRole("button", { name: "Save score" }).click();
    await expect(page.getByText("Done", { exact: true })).toBeVisible();

    await expect.poll(() => page.evaluate((key) => {
      const db = JSON.parse(localStorage.getItem(key));
      return db.bookings[0].sessionId === db.sessions[0].id && db.sessions[0].bookingId === db.bookings[0].id;
    }, DB_KEY)).toBe(true);

    await page.getByRole("button", { name: "Schedule" }).click();
    await page.getByRole("button", { name: /Tuesday Rally/ }).click();
    await expect(page.getByRole("button", { name: "Open session & scores" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("display mode is keyboard-contained and exposes timer controls", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await seedDatabase(page, createTestDatabase({ withSession: true }));
    const errors = collectBrowserErrors(page);
    await page.goto("/#session");

    const trigger = page.getByRole("button", { name: "Display mode" });
    await trigger.click();
    const display = page.getByRole("dialog", { name: "Court display mode" });
    await expect(display).toBeVisible();
    await expect(display).toBeFocused();
    await expect(display.getByText("15:00").first()).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.querySelector(".display-mode").contains(document.activeElement))).toBe(true);
    await display.getByRole("button", { name: "Add one minute" }).first().click();
    await expect(display.getByText("16:00").first()).toBeVisible();
    await display.getByRole("button", { name: "Start timer" }).first().click();
    await expect(display.getByRole("button", { name: "Pause timer" }).first()).toBeVisible();
    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).sessions[0].rounds[0].courts[0].timerEndsAt, DB_KEY)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const courtOverflow = await display.locator(".display-court").evaluateAll((courts) => courts.map((court) => court.scrollWidth - court.clientWidth));
    expect(courtOverflow.every((value) => value <= 0)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(display).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "Court display mode" }).locator(".display-court__timer").first()).not.toHaveText("15:00");
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });

  test("a player added mid-session joins the very next round", async ({ page }) => {
    await seedDatabase(page, createTestDatabase({ withSession: true }));
    const errors = collectBrowserErrors(page);
    await page.goto("/#session");

    await page.getByRole("button", { name: /Add player/ }).click();
    await page.getByRole("dialog", { name: "Add player to session" }).getByRole("button", { name: /Create new player/ }).click();
    const playerDialog = page.getByRole("dialog", { name: "Add player" });
    await playerDialog.locator("#pf-name").fill("Late Arrival");
    await playerDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Late Arrival joins from the next round.")).toBeVisible();

    const courtCount = await page.locator(".court").count();
    for (let courtIndex = 0; courtIndex < courtCount; courtIndex += 1) {
      await page.locator(".court").nth(courtIndex).getByRole("button", { name: "Enter score" }).click();
      await page.getByRole("dialog", { name: /Court \d+ score/ }).getByRole("button", { name: "Skip game" }).click();
    }
    await page.getByRole("button", { name: /Close scores & next round/ }).click();

    await expect.poll(() => page.evaluate((key) => {
      const db = JSON.parse(localStorage.getItem(key));
      const player = db.players.find((item) => item.name === "Late Arrival");
      const session = db.sessions[0];
      const nextRound = session.rounds[1];
      const assigned = [...nextRound.sitOutIds, ...nextRound.courts.flatMap((court) => [...court.teamA, ...court.teamB])];
      return Boolean(player && session.playerIds.includes(player.id) && assigned.includes(player.id));
    }, DB_KEY)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("manual swaps honor hard constraints and locked courts survive regeneration", async ({ page }) => {
    const database = createTestDatabase({ withSession: true });
    database.constraints.mustNotPair = [["p1", "p5"]];
    await seedDatabase(page, database);
    const errors = collectBrowserErrors(page);
    await page.goto("/#session");

    await page.getByRole("button", { name: "Player 2", exact: true }).click();
    await page.getByRole("button", { name: "Player 5", exact: true }).click();
    await expect(page.getByText(/Swap blocked.*Player 1 and Player 5 must not be partners/)).toBeVisible();
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)).sessions[0].rounds[0].courts[0].teamA, DB_KEY)).toEqual(["p1", "p2"]);

    await page.getByRole("button", { name: "Lock court", exact: true }).first().click();
    await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    await page.getByRole("dialog", { name: "Regenerate round?" }).getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect.poll(() => page.evaluate((key) => {
      const court = JSON.parse(localStorage.getItem(key)).sessions[0].rounds[0].courts[0];
      return court.locked && court.teamA.join(",") === "p1,p2" && court.teamB.join(",") === "p3,p4";
    }, DB_KEY)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("scheduler tuning, mixing matrices, and full session history are exposed", async ({ page }) => {
    const database = createTestDatabase({ withSession: true });
    database.sessions[0].rounds[0].courts[0].score = { a: 11, b: 7 };
    database.sessions[0].rounds[0].courts[0].status = "completed";
    await seedDatabase(page, database);
    const errors = collectBrowserErrors(page);

    await page.goto("/#more");
    const partnerWeight = page.getByRole("spinbutton", { name: "Partner repeat" });
    await partnerWeight.fill("25");
    await partnerWeight.press("Tab");
    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).settings.weights.partnerRepeat, DB_KEY)).toBe(25);
    await expect(page.getByRole("spinbutton", { name: "Search restarts" })).toHaveValue("500");

    await page.getByRole("button", { name: "Stats" }).click();
    await page.getByRole("tab", { name: "Mixing" }).click();
    await expect(page.getByRole("heading", { name: "Partner repeats" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Opponent repeats" })).toBeVisible();

    await page.getByRole("tab", { name: "Sessions" }).click();
    await page.getByRole("button", { name: /Evening Rally/ }).click();
    const history = page.getByRole("dialog", { name: "Evening Rally" });
    await expect(history.getByRole("columnheader", { name: "Win%" })).toBeVisible();
    await expect(history.getByRole("columnheader", { name: "PF" })).toBeVisible();
    await expect(history.getByRole("heading", { name: "Schedule and results" })).toBeVisible();
    await expect(history.getByText("11\u20137", { exact: true })).toBeVisible();
    await expect(history.getByRole("button", { name: "Print" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("theme persists and GitHub connection uses a header-only test token", async ({ page }) => {
    await seedDatabase(page, createTestDatabase());
    const errors = collectBrowserErrors(page);
    let capturedRequest = null;
    await page.route("https://api.github.com/**", async (route) => {
      capturedRequest = {
        url: route.request().url(),
        authorization: route.request().headers().authorization,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ full_name: "test-owner/test-data", private: true, default_branch: "main" }),
      });
    });

    await page.goto("/#more");
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).settings.theme, DB_KEY)).toBe("dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.getByPlaceholder("octocat").fill("test-owner");
    await page.getByPlaceholder("pickleball-data").fill("test-data");
    await page.getByPlaceholder("Fine-grained personal access token").fill("e2e-fake-token");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.locator(".github-sync-status")).toHaveText("Connected to test-owner/test-data.");
    expect(capturedRequest.url).not.toContain("e2e-fake-token");
    expect(capturedRequest.authorization).toBe("Bearer e2e-fake-token");
    const isolated = await page.evaluate(({ credentialsKey, dbKey }) => ({
      credentialKeyHasToken: JSON.parse(localStorage.getItem(credentialsKey)).token.length > 0,
      databaseHasToken: localStorage.getItem(dbKey).includes("e2e-fake-token"),
    }), { credentialsKey: CREDENTIALS_KEY, dbKey: DB_KEY });
    expect(isolated).toEqual({ credentialKeyHasToken: true, databaseHasToken: false });
    expect(errors).toEqual([]);
  });

  test("the visible booking week has a dedicated print layout", async ({ page }) => {
    await seedDatabase(page, createTestDatabase({ withSession: true, withBooking: true }));
    const errors = collectBrowserErrors(page);
    await page.goto("/#schedule");
    const printable = page.locator(".print-schedule");
    await expect(printable).toBeHidden();

    await page.emulateMedia({ media: "print" });
    await expect(printable).toBeVisible();
    await expect(printable.getByText("Evening Rally", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
    expect(errors).toEqual([]);
  });
});