import { expect, test } from "@playwright/test";

test.describe("Patterns access", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("signed-out visitor is sent to sign in", async ({ page }) => {
    await page.goto("/dashboard/patterns");
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    await expect(page.getByRole("button", { name: "Sign in with Lichess" })).toBeVisible();
  });
});

test.describe("Patterns drill-downs", () => {
  test.skip(!process.env.E2E_STORAGE_STATE, "Set E2E_STORAGE_STATE to a local Auth.js browser storage-state file.");

  test("heatmap cells open correctly filtered Games views", async ({ page }) => {
    await page.goto("/dashboard/patterns");
    await expect(page.getByRole("heading", { name: "Patterns" })).toBeVisible();

    await page.getByRole("link", { name: /^Middlegame, high: .*Filter games$/ }).click();
    await expect(page).toHaveURL(/\/dashboard\/games\?/);
    expect(new URL(page.url()).searchParams.get("phase")).toBe("middlegame");
    expect(new URL(page.url()).searchParams.get("severity")).toBe("high");
  });

  test("weakness tags retain exact pattern occurrences", async ({ page }) => {
    await page.goto("/dashboard/patterns");
    const tagLink = page.getByRole("link", { name: /^Filter this pattern's games by / }).first();
    test.skip((await tagLink.count()) === 0, "This account has no weakness-pattern tags to drill into.");
    await tagLink.click();
    const url = new URL(page.url());
    expect(url.pathname).toBe("/dashboard/games");
    expect(url.searchParams.get("phase")).toMatch(/^(opening|middlegame|endgame)$/);
    expect(url.searchParams.get("gameIds")).toBeTruthy();
    expect(url.searchParams.get("occurrences")).toBeTruthy();
  });
});
