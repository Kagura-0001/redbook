/**
 * The local Chrome install, driven through puppeteer-core (no bundled browser).
 */

import { existsSync } from "node:fs";

export function findChrome(): string {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    win32: [
      `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
    linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  }[process.platform as "darwin" | "win32" | "linux"] ?? [];

  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome not found. Install Google Chrome or set CHROME_PATH.");
  return found;
}

export function loadPuppeteer() {
  return import("puppeteer-core");
}
