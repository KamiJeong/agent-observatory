import { expect, test } from "@playwright/test";

test("mock runtime updates the agent graph through completion and waiting", async ({ page }) => {
  const bootstrapUrl = process.env.OBSERVATORY_E2E_BOOTSTRAP_URL;
  expect(bootstrapUrl).toBeTruthy();
  await page.goto(bootstrapUrl ?? "/");
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await expect(page.getByRole("heading", { name: "Codex Observatory" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Connected");

  await expect(page.getByRole("button", { name: /Researcher, (Working|Completed)/i })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("button", { name: /Implementer, Working/i })).toBeVisible();
  await expect(page.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Request received")).toBeVisible();
  await expect(page.getByText("Identify the protocol events needed for agent status projection.")).toBeVisible();
  await page.getByRole("button", { name: "Messages" }).click();
  await expect(page.getByRole("list", { name: /Messages, \d+ events/ })).toBeVisible();
  await expect(page.locator(".history-event__route").filter({ hasText: "Main" }).filter({ hasText: "Researcher" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Trace" }).click();
  await expect(page.getByRole("list", { name: /Recent activity, \d+ events/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Researcher, Completed/i })).toBeVisible({ timeout: 6_000 });
  await expect(page.getByRole("button", { name: /Tester, Waiting/i })).toBeVisible({ timeout: 6_000 });

  await page.getByRole("button", { name: /Implementer, Working/i }).click();
  await expect(page.getByRole("tab", { name: "Inspector" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".details").getByText("Editing AgentStore.ts")).toBeVisible();
});
