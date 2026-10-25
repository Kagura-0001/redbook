/**
 * redbook's own Chrome window: a separate profile under ~/.redbook/chrome/<account>,
 * started with a DevTools port so commands can drive it. The window stays open
 * after a command exits, so you can look over what was filled in and press
 * publish yourself.
 *
 * Xiaohongshu keeps one web session per account. Copying the login cookies from
 * your everyday browser shares that session instead of starting a new one, so
 * neither browser gets logged out.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "puppeteer-core";
import { checkAccountName, redbookHome } from "./accounts.js";
import { findChrome, loadPuppeteer } from "./chrome.js";

export interface WindowCookie {
  name: string;
  value: string;
  domain: string;
}

export async function openWindow(account: string): Promise<Browser> {
  const dir = join(redbookHome(), "chrome", checkAccountName(account));
  const running = await connect(dir);
  if (running) return running;

  mkdirSync(dir, { recursive: true });
  spawn(findChrome(), [
    `--user-data-dir=${dir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
  ], { detached: true, stdio: "ignore" }).unref();

  // Chrome writes the port it picked to DevToolsActivePort once it is up.
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const browser = await connect(dir);
    if (browser) return browser;
  }
  throw new Error(`Chrome didn't start with profile ${dir}`);
}

async function connect(dir: string): Promise<Browser | null> {
  const file = join(dir, "DevToolsActivePort");
  if (!existsSync(file)) return null;
  const port = readFileSync(file, "utf-8").split("\n")[0];
  const puppeteer = await loadPuppeteer();
  try {
    return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  } catch {
    return null;
  }
}

export async function setCookies(browser: Browser, cookies: WindowCookie[]): Promise<void> {
  const session = await browser.target().createCDPSession();
  await session.send("Storage.setCookies", {
    cookies: cookies.map((c) => ({ ...c, path: "/", secure: true })),
  });
  await session.detach();
}
