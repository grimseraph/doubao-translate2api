import { chromium, expect } from "@playwright/test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/config/env.js";

const dir = await mkdtemp(join(tmpdir(), "doubao-ui-"));
const cookie = "sessionid=fixture; sid_tt=fixture; uid_tt=fixture";
await writeFile(join(dir, "cookie.txt"), cookie);
const app = createApp(loadConfig({
  LOG_LEVEL: "silent", DOUBAO_COOKIE_FILE: join(dir, "cookie.txt"),
}), { fetcher: async (url, init) => {
  if (!String(url).includes("stream_article_translate")) return Response.json({ code: 0 });
  const body = JSON.parse(init.body);
  const items = body.raw_text.map((text, index) => ({ index, res: `译:${text}`, detect_lang: "en" }));
  return new Response(`event: json\ndata: ${JSON.stringify({ code: 0, data: { items } })}\n\nevent: done\ndata: {}\n\n`,
    { headers: { "content-type": "text/event-stream" } });
} });
let browser;
try {
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const password = (await readFile(join(dir, "admin", "initial-password.txt"), "utf8")).trim();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url + "/admin");
  await page.getByLabel("管理密码", { exact: true }).fill("incorrect-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "密码不正确" }).waitFor();
  await page.getByLabel("管理密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "运行概览", exact: true })).toBeVisible();
  await expect(page.locator("#usage-requests")).toHaveText("0");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("tab", { name: "连接", exact: true }).click();
  await expect(page.getByLabel("默认目标语言", { exact: true })).toHaveValue("zh");
  await page.getByLabel("默认目标语言", { exact: true }).selectOption("ja");
  await expect(page.getByLabel("默认目标语言", { exact: true })).toBeEnabled();
  await page.reload();
  await page.getByRole("tab", { name: "连接", exact: true }).click();
  await expect(page.getByLabel("默认目标语言", { exact: true })).toHaveValue("ja");
  await page.getByLabel("默认目标语言", { exact: true }).selectOption("zh");
  await expect(page.getByLabel("默认目标语言", { exact: true })).toBeEnabled();
  const keyPath = join(dir, "admin", "api-key.txt");
  const initialKey = (await readFile(keyPath, "utf8")).trim();
  assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
  await page.getByRole("button", { name: "显示 API Key", exact: true }).click();
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue(initialKey);
  await page.getByRole("button", { name: "隐藏 API Key", exact: true }).click();
  assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
  await page.getByRole("button", { name: "复制 API Key", exact: true }).click();
  await expect(page.getByRole("button", { name: "复制 API Key", exact: true })).toBeEnabled();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), initialKey);
  // Exercise the fallback used on NAS pages served over plain HTTP.
  await page.evaluate(() => navigator.clipboard.writeText("clipboard-fallback-marker"));
  await page.evaluate(() => {
    window.testClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });
  await page.getByRole("button", { name: "复制 API Key", exact: true }).click();
  await expect(page.getByRole("button", { name: "复制 API Key", exact: true })).toBeEnabled();
  assert.equal(await page.evaluate(() => window.testClipboard.readText()), initialKey);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: window.testClipboard, configurable: true }); });
  await page.getByRole("button", { name: "重新生成 API Key", exact: true }).click();
  await page.locator("#api-key-dialog").getByRole("button", { name: "取消", exact: true }).click();
  assert.equal((await readFile(keyPath, "utf8")).trim(), initialKey);
  await page.getByRole("button", { name: "重新生成 API Key", exact: true }).click();
  await page.getByRole("button", { name: "确认重新生成", exact: true }).click();
  await page.locator("#api-key-dialog").waitFor({ state: "hidden" });
  const rotatedKey = (await readFile(keyPath, "utf8")).trim();
  assert.notEqual(rotatedKey, initialKey);
  assert.equal((await fetch(url + "/v1/models", { headers: { "x-api-key": initialKey } })).status, 401);
  assert.equal((await fetch(url + "/v1/models", { headers: { "x-api-key": rotatedKey } })).status, 200);
  assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
  await page.reload();
  await page.getByRole("tab", { name: "连接", exact: true }).click();
  assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
  const screenshots = join(process.cwd(), ".artifacts");
  await mkdir(screenshots, { recursive: true });
  await page.getByLabel("原文", { exact: true }).fill("Hello world");
  await page.getByRole("button", { name: "翻译", exact: true }).click();
  await expect(page.getByLabel("译文", { exact: true })).toHaveValue("译:Hello world");
  await page.screenshot({ path: join(screenshots, "admin-connection.png"), fullPage: true });
  await page.getByRole("tab", { name: "概览", exact: true }).click();
  await expect(page.locator("#usage-requests")).toHaveText("1");
  await page.screenshot({ path: join(screenshots, "admin-overview-dark.png"), fullPage: true });
  await page.getByRole("button", { name: "切换浅色", exact: true }).click();
  await page.screenshot({ path: join(screenshots, "admin-overview-light.png"), fullPage: true });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "切换深色", exact: true }).click();
  await page.getByRole("tab", { name: /Cookie 池/ }).click();
  for (const name of ["备用账号", "工作账号 · 长名称".repeat(4)]) {
    await page.getByRole("button", { name: "导入 Cookie", exact: true }).first().click();
    await page.getByLabel("账号名称", { exact: true }).fill(name);
    await page.getByLabel("Cookie", { exact: true }).fill(cookie);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.locator(".account-name").filter({ hasText: name }).waitFor();
    await page.locator(`[aria-label="检测 ${name}"]`).waitFor();
  }
  await page.locator('input[name="mode"][value="round-robin"]').check();
  await page.waitForFunction(() => document.getElementById("preferred-field").hidden);
  await page.reload();
  await page.getByRole("tab", { name: /Cookie 池/ }).click();
  await page.locator('input[name="mode"][value="round-robin"]:checked').waitFor();
  const toggle = page.getByRole("checkbox", { name: "备用账号：启用", exact: true });
  await toggle.uncheck();
  await page.locator('.disabled-row .account-name').filter({ hasText: "备用账号" }).waitFor();
  await toggle.check();
  await page.locator('.account-row:not(.disabled-row) .account-name').filter({ hasText: "备用账号" }).waitFor();
  await page.getByRole("button", { name: "编辑 备用账号", exact: true }).click();
  await page.getByLabel("账号名称", { exact: true }).fill("已更新账号");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator(".account-name").filter({ hasText: "已更新账号" }).waitFor();
  await page.screenshot({ path: join(screenshots, "admin-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(screenshots, "admin-mobile.png"), fullPage: true });
  for (const [tab, name] of [["概览", "overview"], ["连接", "connection"], ["安全设置", "security"]]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + " overflows");
    await page.screenshot({ path: join(screenshots, `admin-${name}-mobile.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 320, height: 740 });
  for (const tab of ["概览", "连接", "安全设置", /Cookie 池/]) {
    await page.getByRole("tab", { name: tab }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(tab) + " overflows at 320px");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: /Cookie 池/ }).click();
  await page.getByRole("button", { name: "导入 Cookie", exact: true }).first().click();
  await page.locator("#account-dialog").evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  assert.equal(await page.locator("#account-dialog").evaluate(element => getComputedStyle(element).opacity), "1");
  await page.screenshot({ path: join(screenshots, "admin-import-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "关闭", exact: true }).first().click();
  await page.getByRole("button", { name: "删除 已更新账号", exact: true }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".account-list").textContent.includes("已更新账号"));
  await page.getByRole("tab", { name: "安全设置", exact: true }).click();
  await page.getByLabel("当前密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "随机生成", exact: true }).click();
  const nextPassword = await page.getByLabel("新密码", { exact: true }).inputValue();
  assert.ok(nextPassword.length >= 32);
  await page.getByRole("button", { name: "保存密码", exact: true }).click();
  await page.getByRole("heading", { name: "管理登录", exact: true }).waitFor();
  await page.getByLabel("管理密码", { exact: true }).fill(nextPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("tab", { name: /Cookie 池/ }).click();
  await page.locator(".account-name").filter({ hasText: "本地 Cookie 文件" }).waitFor();
  if (process.env.UPDATE_README_IMAGES === "true") {
    const longName = "工作账号 · 长名称".repeat(4);
    await page.getByRole("button", { name: "编辑 " + longName, exact: true }).click();
    await page.getByLabel("账号名称", { exact: true }).fill("备用账号");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.locator(".account-name").filter({ hasText: "备用账号" }).waitFor();
    await page.locator('input[name="mode"][value="failover"]').check();
    await page.getByRole("button", { name: "检测 本地 Cookie 文件", exact: true }).click();
    await expect(page.locator('[data-account="file"] .badge')).toHaveText("登录有效");
    await page.locator("#toast").waitFor({ state: "hidden" });
    assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
    const assets = join(process.cwd(), "assets");
    await mkdir(assets, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: join(assets, "admin-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(assets, "admin-mobile.png"), fullPage: true });
    await page.getByRole("tab", { name: "概览", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: join(assets, "admin-overview.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(assets, "admin-overview-mobile.png"), fullPage: true });
  }
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByRole("heading", { name: "管理登录", exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, "admin-login-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Admin UI desktop/mobile and API key reveal/copy/rotation workflows passed; screenshots in .artifacts.");
} finally {
  await browser?.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
