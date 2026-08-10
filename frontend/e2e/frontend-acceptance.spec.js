import { expect, test } from "@playwright/test";
import { installRelayScenario } from "./fixtures/relayScenario.js";

test("pathname routes mount the intended lazy-loaded SPA surface", async ({ page }) => {
  await installRelayScenario(page);
  for (const [pathname, role] of [
    ["/home", "home"],
    ["/family", "family"],
    ["/debug", "debug"],
  ]) {
    await page.goto(pathname);
    await expect(page.locator(`[data-app-role="${role}"]`)).toBeVisible();
  }
});

test("Family renders a validated MoveNet frame into the owned pose canvas", async ({ page }) => {
  await installRelayScenario(page);
  await page.goto("/family");
  const canvas = page.getByTestId("family-pose-canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((node) => {
    const context = node.getContext("2d");
    const pixels = context.getImageData(0, 0, node.width, node.height).data;
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) painted += 1;
    }
    return painted;
  })).toBeGreaterThan(100);
});

test("Family alarm confirmation emits acknowledge_alarm and waits for Relay ACK", async ({ page }) => {
  const relay = await installRelayScenario(page, { sceneId: "fall", variant: "alarm" });
  await page.goto("/family");
  const confirm = page.getByRole("button", { name: "确认并处理" });
  await expect(confirm).toBeVisible();
  await confirm.click();

  await expect.poll(() => relay.sentMessages.find(
    (message) => message.schema_version === "reme-control-command/v1",
  )?.command).toEqual({
    name: "acknowledge_alarm",
    decision_id: "decision-fall",
  });
  await expect(page.getByRole("button", { name: "已确认收到告警" })).toBeDisabled();
});

test("Family action card confirmation emits confirm_action_card, never alarm acknowledgement", async ({ page }) => {
  const relay = await installRelayScenario(page, { sceneId: "living", variant: "action_card" });
  await page.goto("/family");
  await page.getByRole("button", { name: "确认收到并开始处理" }).click();

  await expect.poll(() => relay.sentMessages.find(
    (message) => message.schema_version === "reme-control-command/v1",
  )?.command).toEqual({
    name: "confirm_action_card",
    decision_id: "decision-living",
  });
  expect(relay.sentMessages.some(
    (message) => message.command?.name === "acknowledge_alarm",
  )).toBe(false);
});

test("bathroom privacy fails closed even when Relay publishes an active grant", async ({ page }) => {
  const relay = await installRelayScenario(page, {
    sceneId: "bathroom",
    privacyMode: "visible",
    withGrant: true,
  });
  await page.goto("/family");

  await expect(page.getByText("浴室硬隐私 · 仅同步匿名骨架")).toBeVisible();
  await expect(page.getByTestId("family-pose-canvas")).toBeVisible();
  await expect(page.getByTestId("authorized-event-video")).not.toHaveClass(/is-visible/);
  expect(relay.sentMessages.some(
    (message) => message.schema_version === "reme-media-signal/v1",
  )).toBe(false);
});
