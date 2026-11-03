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
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
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
  if (running && !(await saysAutomated(running))) return running;
  if (running) await restart(running, dir);

  mkdirSync(dir, { recursive: true });
  const args = [
    `--user-data-dir=${dir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    // With a DevTools port open, Chrome tells every page it is automated
    // (navigator.webdriver = true). Sites read that first.
    "--disable-blink-features=AutomationControlled",
    // Pages keep running normally while the window sits behind others.
    "--disable-backgrounding-occluded-windows",
  ];
  // On macOS start it behind the app you're in (open -g), so it doesn't take focus.
  const chrome = findChrome();
  const app = process.platform === "darwin" ? chrome.match(/^(.*?\.app)\//)?.[1] : undefined;
  const [cmd, argv] = app ? ["open", ["-g", "-n", "-a", app, "--args", ...args]] : [chrome, args];
  spawn(cmd, argv, { detached: true, stdio: "ignore" }).unref();

  // Chrome writes the port it picked to DevToolsActivePort once it is up.
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const browser = await connect(dir);
    if (browser) return browser;
  }
  throw new Error(`Chrome didn't start with profile ${dir}`);
}

/** A window started by an older redbook, without --disable-blink-features=AutomationControlled. */
async function saysAutomated(browser: Browser): Promise<boolean> {
  const page = (await browser.pages())[0];
  if (!page) return false;
  return page.evaluate(() => navigator.webdriver === true).catch(() => false);
}

/** Quit that window so it can start again with the right flags, unless a draft is open in it. */
async function restart(browser: Browser, dir: string): Promise<void> {
  const busy = (await browser.pages()).some((p) => p.url().includes("creator."));
  if (busy) {
    await browser.disconnect();
    throw new Error(
      "redbook's window was started by an older redbook and tells pages it is automated. " +
      "It has the creator center open, so redbook won't close it: quit that window (⌘Q in it), then run this again."
    );
  }
  await browser.close();
  // Wait for the old process to let go of the profile.
  for (let i = 0; i < 50; i++) {
    try {
      lstatSync(join(dir, "SingletonLock"));
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
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
    // With an expiry they outlive a restart of the window, like the site's own login cookies.
    cookies: cookies.map((c) => ({ ...c, path: "/", secure: true, expires: Math.floor(Date.now() / 1000) + 30 * 86400 })),
  });
  await session.detach();
}
