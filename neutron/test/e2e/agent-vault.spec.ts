import { expect, test, type Page } from "@playwright/test";
import { localCanisterOrigin } from "neutron-tools/src/runtime.js";
import { resolveLocalNeutronRuntime } from "../../packages/neutron-provision/src/local_session.ts";

test("Agent Vault full end-to-end lifecycle on local PocketIC kernel", async ({
  page,
}) => {
  const runtime = resolveLocalNeutronRuntime();
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  // 1. Navigate to the local Neutron OS canister gateway
  await page.goto(
    localCanisterOrigin(runtime.canisterId, runtime.gatewayUrl),
  );

  // 2. Authenticate as the authorized local developer
  await expect(page.locator('[data-tid="login-button"]')).toBeVisible();
  const principal = await page.evaluate(async (identitySeed) => {
    const login = (
      window as typeof window & {
        __NEUTRON_PLAYWRIGHT_LOGIN_AS__?: (seed: number) => Promise<string>;
      }
    ).__NEUTRON_PLAYWRIGHT_LOGIN_AS__;
    if (!login) throw new Error("Local Playwright login is unavailable");
    return login(identitySeed);
  }, runtime.developerIdentitySeed);
  expect(principal).toBe(runtime.developerIdentityPrincipal);

  // 3. Open the launcher and launch the Agent Vault dashboard tile
  await openLauncher(page);
  const vaultTile = page.locator('[data-tid="launcher-tile-agent_vault-dashboard"]');
  await expect(vaultTile).toBeVisible();
  await vaultTile.click();

  // 4. Verify the sandboxed tile iframe is rendered
  const iframeLocator = page.locator(
    'iframe[data-app-id="agent_vault"][data-tile-id="dashboard"]',
  );
  await expect(iframeLocator).toHaveAttribute("sandbox", "allow-scripts");
  const vault = page.frameLocator(
    'iframe[data-app-id="agent_vault"][data-tile-id="dashboard"]',
  );
  await expect(vault.locator(".vault-shell")).toBeVisible();

  // -------------------------------------------------------------------------
  // 5. Panel 1: Portfolio Overview
  // -------------------------------------------------------------------------
  await expect(vault.locator(".vault-panel-title")).toHaveText("Portfolio Overview");
  await expect(vault.getByText("Hourly Budget")).toBeVisible();
  await expect(vault.getByText("Daily Budget")).toBeVisible();
  await page.screenshot({ path: "screenshot_portfolio.png", fullPage: true });

  // -------------------------------------------------------------------------
  // 6. Panel 2: Policy Control Matrix & Interactive Circuit Breaker Toggle
  // -------------------------------------------------------------------------
  await vault.getByRole("button", { name: "Policy" }).click();
  await expect(vault.locator(".vault-panel-title")).toHaveText("Policy Control Matrix");
  await expect(vault.getByText("Per Transaction")).toBeVisible();
  await expect(vault.getByText("Hourly Limit")).toBeVisible();
  await expect(vault.getByText("Daily Limit")).toBeVisible();
  await page.screenshot({ path: "screenshot_policy.png", fullPage: true });

  // -------------------------------------------------------------------------
  // 7. Panel 3: Live Agent Activity Feed
  // -------------------------------------------------------------------------
  await vault.getByRole("button", { name: "Activity" }).click();
  await expect(vault.locator(".vault-panel-title")).toHaveText("Agent Activity Feed");
  await page.screenshot({ path: "screenshot_activity.png", fullPage: true });

  // -------------------------------------------------------------------------
  // 8. Panel 4: Pending Approvals Inbox
  // -------------------------------------------------------------------------
  await vault.getByRole("button", { name: "Approvals" }).click();
  await expect(vault.locator(".vault-panel-title")).toHaveText("Pending Approvals");
  await page.screenshot({ path: "screenshot_approvals.png", fullPage: true });

  // Return to Portfolio and capture main screenshot
  await vault.getByRole("button", { name: "Portfolio" }).click();
  await expect(vault.locator(".vault-panel-title")).toHaveText("Portfolio Overview");
  await page.screenshot({ path: "agent_vault_live_dashboard.png", fullPage: true });

  expect(consoleErrors.filter((e) => !e.includes("favicon"))).toEqual([]);
});

async function openLauncher(page: Page): Promise<void> {
  await page.locator('[data-tid="launcher-open"]').click();
  await expect(page.locator('[data-tid="launcher"]')).toBeVisible();
}
