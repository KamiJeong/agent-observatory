import { expect, test } from "@playwright/test";

test("mock runtime updates the agent graph through completion and waiting", async ({ page }) => {
  const bootstrapUrl = process.env.OBSERVATORY_E2E_BOOTSTRAP_URL;
  expect(bootstrapUrl).toBeTruthy();
  await page.goto(bootstrapUrl ?? "/");
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/);
  await expect(page.getByRole("heading", { name: "Agent Observatory" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Dashboard transport: Connected" })).toContainText("Connected");
  await expect(page.getByText("Select an agent to view its run history.")).toBeVisible();
  await page.locator(".agent-row", { hasText: "Main" }).click();
  await expect(page.getByRole("tab", { name: "Inspector" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "History" }).click();
  await expect.poll(() => page.evaluate(() => {
    const size = (selector: string) => getComputedStyle(document.querySelector(selector)!).fontSize;
    return {
      body: getComputedStyle(document.body).fontSize,
      historyTime: size(".history-event > time"),
      historyRoute: size(".history-event__route"),
      historySummary: size(".history-event__summary"),
      historyContent: size(".history-event p"),
    };
  })).toEqual({
    body: "14px",
    historyTime: "12px",
    historyRoute: "13px",
    historySummary: "14px",
    historyContent: "12px",
  });

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
  const selectedNode = page.locator(".agent-node[data-selected]");
  await expect(selectedNode).toHaveCount(1);
  await expect.poll(() => selectedNode.evaluate((node) => {
    const nodeBounds = node.getBoundingClientRect();
    const activityBounds = node.querySelector(".agent-node__activity")!.getBoundingClientRect();
    const runtimeBounds = node.querySelector(".agent-node__runtime")?.getBoundingClientRect();
    const selectionShadow = getComputedStyle(node).boxShadow;
    return {
      activityInsideNode: activityBounds.bottom <= nodeBounds.bottom,
      contentDoesNotOverlap: !runtimeBounds || runtimeBounds.bottom <= activityBounds.top,
      activityPosition: getComputedStyle(node.querySelector(".agent-node__activity")!).position,
      hasInnerSelectionRing: selectionShadow.includes("0px 0px 0px 2px"),
      hasOuterSelectionRing: selectionShadow.includes("0px 0px 0px 5px"),
    };
  })).toEqual({
    activityInsideNode: true,
    contentDoesNotOverlap: true,
    activityPosition: "absolute",
    hasInnerSelectionRing: true,
    hasOuterSelectionRing: true,
  });

  await page.getByRole("button", { name: "Close inspector" }).click();
  await expect(page.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Inspector" })).toHaveAttribute("aria-selected", "false");
  await expect(page.locator(".agent-node[data-selected]")).toHaveCount(0);

  // A 720px CSS viewport is the layout equivalent of 200% browser zoom on a
  // 1440px desktop viewport. The responsive layout must not lose content or
  // introduce horizontal page scrolling at that size.
  await page.setViewportSize({ width: 720, height: 450 });
  await expect(page.getByRole("heading", { name: "Agent Observatory" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: 720, scrollWidth: 720 });

  await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.getByRole("heading", { name: "Agent Observatory" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Provider" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: 320, scrollWidth: 320 });
});
