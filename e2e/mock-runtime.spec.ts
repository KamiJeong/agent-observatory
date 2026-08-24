import { expect, test } from "@playwright/test";

test("mock runtime updates the agent graph through completion and waiting", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Codex Observatory" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Connected");

  await expect(page.getByRole("button", { name: /Researcher, Working/i })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: /Implementer, Working/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Researcher, Completed/i })).toBeVisible({ timeout: 6_000 });
  await expect(page.getByRole("button", { name: /Tester, Waiting/i })).toBeVisible({ timeout: 6_000 });

  await page.getByRole("button", { name: /Implementer, Working/i }).click();
  await expect(page.getByRole("tab", { name: "Inspector" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".details").getByText("Editing AgentStore.ts")).toBeVisible();
});
