import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";

test("Agent Vault operator console is responsive and live on local PocketIC", async ({ page }) => {
  const runtime = resolveLocalNeutronRuntime({ configPath: "agent-vault-live.ndeploy.json" });
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("favicon")) consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));

  await page.goto(localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl));
  await expect(page.locator('[data-tid="login-button"]')).toBeVisible();
  const principal = await page.evaluate(async (seed) => {
    const login = (window as typeof window & { __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (value: number) => Promise<string> }).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Playwright login is unavailable");
    return login(seed);
  }, runtime.developerIdentitySeed);
  expect(principal).toBe(runtime.developerIdentityPrincipal);
  await openLauncher(page);
  await page.locator('[data-tid="launcher-tile-agent_vault-dashboard"]').click();
  const frame = page.frameLocator('iframe[data-app-id="agent_vault"][data-tile-id="dashboard"]');
  await expect(frame.locator(".console-app")).toBeVisible();

  for (const viewport of [{ width: 1440, height: 960, name: "desktop" }, { width: 820, height: 900, name: "tablet" }, { width: 390, height: 844, name: "mobile" }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(frame.getByRole("heading", { name: "Daily oversight" })).toBeVisible();
    await assertNoHorizontalOverflow(frame);
    if (viewport.name === "mobile") { await expect(frame.locator(".mobile-nav")).toBeVisible(); await expect(frame.locator(".desktop-nav")).toBeHidden(); }
    else await expect(frame.locator(".desktop-nav")).toBeVisible();
    await page.screenshot({ path: `screenshot_agent_vault_${viewport.name}_command.png`, fullPage: true });
  }

  for (const [label, heading] of [["Policy", "Guardrails"], ["Activity", "Decision log"], ["Approvals", "Decisions waiting"]] as const) {
    await clickWorkspace(frame, label);
    await expect(frame.getByRole("heading", { name: heading })).toBeVisible();
    await assertNoHorizontalOverflow(frame);
    await page.screenshot({ path: `screenshot_agent_vault_${label.toLowerCase()}.png`, fullPage: true });
  }

  await clickWorkspace(frame, "Policy");
  await frame.getByRole("button", { name: "Add token budget" }).click();
  await frame.getByRole("button", { name: "Save policy" }).click();
  await expect(frame.getByRole("alert")).toContainText("valid token principal");
  await clickWorkspace(frame, "Activity");
  await expect(frame.getByText("No activity yet", { exact: true })).toBeVisible();
  await expect(frame.locator(".activity-export button")).toBeVisible();
  await clickWorkspace(frame, "Approvals");
  await expect(frame.getByText("No decisions waiting", { exact: true })).toBeVisible();
  await expect(frame.locator(".status-chip.warning")).toBeVisible();
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

async function assertNoHorizontalOverflow(frame: FrameLocator): Promise<void> {
  const overflow = await frame.locator(".console-app").evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  expect(overflow, "console shell must not overflow horizontally").toBe(false);
}

async function clickWorkspace(frame: FrameLocator, label: string): Promise<void> {
  await frame.locator(".nav-button:visible").filter({ hasText: label }).first().click();
}

async function openLauncher(page: Page): Promise<void> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
}
