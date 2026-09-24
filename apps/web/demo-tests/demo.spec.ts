import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

declare global {
  interface Window { __publicDemoAccess: string[] }
}

async function step(page: Page, count = 1) {
  for (let index = 0; index < count; index++) await page.getByRole("button", { name: "1マス進める", exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__publicDemoAccess = [];
    const blocked = (name: string): never => {
      window.__publicDemoAccess.push(name);
      throw new Error(`Public demo must not use ${name}`);
    };
    window.fetch = () => blocked("fetch");
    window.WebSocket = new Proxy(window.WebSocket, { construct: () => blocked("WebSocket") });
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct: () => blocked("WebRTC") });
    navigator.mediaDevices.getUserMedia = () => blocked("microphone");
    window.AudioContext = new Proxy(window.AudioContext, { construct: () => blocked("audio") });
  });
  await page.clock.install();
  await page.goto("/voice-action-lab/");
  await expect(page.getByRole("heading", { name: "「待って」のあと、箱は止まる？" })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.__publicDemoAccess)).toEqual([]);
});

test("public boundary: no live controls, recordings, persistence or backend calls", async ({ page }) => {
  await expect(page.getByText("マイク不要 / Azure接続なし / ログイン不要")).toBeVisible();
  await expect(page.getByRole("button", { name: "実音声に接続" })).toHaveCount(0);
  await expect(page.locator('input[type="file"], audio, video')).toHaveCount(0);
  await expect(page.getByText("サーバーの確定状態", { exact: true })).toHaveCount(0);
  await expect(page.getByText("音声の一時字幕", { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => ({
    local: localStorage.length, session: sessionStorage.length,
    requests: performance.getEntriesByType("resource").map(entry => entry.name).filter(name => /\/api\/|azure|openai/i.test(name)),
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
  }))).toEqual({ local: 0, session: 0, requests: [], csp: expect.stringContaining("connect-src 'none'") });
});

test("published directory contains only static UI files and no live-client code", async () => {
  const directory = resolve(import.meta.dirname, "../dist/demo");
  expect((await readdir(directory)).sort()).toEqual(["index.html", "static"]);
  const files = await readdir(resolve(directory, "static"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(file).toMatch(/^index-[\w-]+\.(css|js)$/);
    const content = await readFile(resolve(directory, "static", file), "utf8");
    expect(content).not.toMatch(/getUserMedia|RTCPeerConnection|WebSocket|AudioContext|\/api\/|azurecontainerapps\.io|cognitiveservices\.azure\.com|BEGIN PRIVATE KEY/);
  }
});

test("A records cancellation but the pending red operation continues", async ({ page }) => {
  await page.getByRole("button", { name: "赤を右へ", exact: true }).click();
  await step(page, 2);
  await page.getByRole("button", { name: "待って（取消）", exact: true }).click();
  await step(page);
  await expect(page.getByLabel("赤の箱、位置 3", { exact: true })).toBeVisible();
  await expect(page.locator(".operation-status.running")).toHaveCount(1);
  await expect(page.getByText("cancellation.observed", { exact: true })).toBeVisible();
});

test("B cancels remaining work without rolling back committed steps", async ({ page }) => {
  await page.getByRole("radio", { name: /^B/ }).check();
  await page.getByRole("button", { name: "赤を右へ", exact: true }).click();
  await step(page, 2);
  await page.getByRole("button", { name: "確定", exact: true }).click();
  await expect(page.getByText("operation.step", { exact: true })).toHaveCount(2);
  await expect(page.getByText("operation.queued", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "すべて", exact: true }).click();
  await page.getByRole("button", { name: "待って（取消）", exact: true }).click();
  await expect(page.getByRole("button", { name: "1マス進める", exact: true })).toBeDisabled();
  await page.clock.runFor(30_000);
  await expect(page.getByLabel("赤の箱、位置 2", { exact: true })).toBeVisible();
  await expect(page.locator(".operation-status.cancelled")).toHaveCount(1);
  await expect(page.getByText("cancellation.accepted", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByText("operation.cancelled", { exact: true })).toBeVisible();
});

for (const [mode, finalRed, steps] of [["A", 6, 10], ["B", 2, 6]] as const) {
  test(`${mode} replacement demonstrates the correct red/blue positions`, async ({ page }) => {
    await page.getByRole("radio", { name: new RegExp(`^${mode}`) }).check();
    await page.getByRole("button", { name: "赤を右へ", exact: true }).click();
    await step(page, 2);
    await page.getByRole("button", { name: "赤じゃなく青を右へ", exact: true }).click();
    await step(page, steps);
    await expect(page.getByLabel(`赤の箱、位置 ${finalRed}`, { exact: true })).toBeVisible();
    await expect(page.getByLabel("青の箱、位置 6", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "1マス進める", exact: true })).toBeDisabled();
  });

  test(`${mode} emergency stop is terminal until explicit reset`, async ({ page }) => {
    await page.getByRole("radio", { name: new RegExp(`^${mode}`) }).check();
    await page.getByRole("button", { name: "赤を右へ", exact: true }).click();
    await step(page);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "すべて停止", exact: true }).click();
    await page.clock.runFor(30_000);
    await expect(page.getByLabel("赤の箱、位置 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "赤を右へ", exact: true })).toBeDisabled();
    await expect(page.getByRole("checkbox")).toBeDisabled();
    await page.getByRole("button", { name: "最初から", exact: true }).click();
    await expect(page.getByLabel("赤の箱、位置 0", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "赤を右へ", exact: true })).toBeEnabled();
  });
}

test("automatic progression is paced and mode switching cancels the old timer", async ({ page }) => {
  await page.clock.pauseAt(new Date(Date.now() + 60_000));
  await page.getByRole("button", { name: "赤を右へ", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.clock.runFor(2_999);
  await expect(page.getByLabel("赤の箱、位置 0", { exact: true })).toBeVisible();
  await page.clock.runFor(1);
  await expect(page.getByLabel("赤の箱、位置 1", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: /^B/ }).check();
  await page.clock.runFor(15_000);
  await expect(page.getByLabel("赤の箱、位置 0", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await expect(page.locator(".event-row")).toHaveCount(0);
});

test("loaded demo works offline and reload clears the generated state", async ({ page, context }) => {
  await context.setOffline(true);
  await page.getByRole("button", { name: "赤を右へ", exact: true }).click();
  await step(page, 2);
  await expect(page.getByLabel("赤の箱、位置 2", { exact: true })).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByLabel("赤の箱、位置 0", { exact: true })).toBeVisible();
  await expect(page.locator(".operation-row")).toHaveCount(0);
});

test("mobile and keyboard controls remain usable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("radio", { name: /^B/ }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "赤を右へ", exact: true }).focus();
  await page.keyboard.press("Enter");
  await step(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("radio", { name: /^B/ })).toBeChecked();
  await expect(page.getByLabel("赤の箱、位置 1", { exact: true })).toBeVisible();
});
