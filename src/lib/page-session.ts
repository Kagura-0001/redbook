/**
 * The browser tab a signed request claims to come from.
 *
 * The web SDK writes the page load time, a request counter and the number of
 * window properties into every x-s, and another counter into x-s-common. In a
 * real tab these stay fixed, or count up, until the page reloads. Drawing them
 * fresh for every request makes one device look like a new tab each time, so
 * they live in state/page-<a1 hash>.json and every redbook process shares them.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redbookHome } from "./accounts.js";

// After this long without a request, the next one comes from a freshly loaded page.
export const PAGE_IDLE_MS = 30 * 60_000;

export interface PageSession {
  loadedAt: number;
  seq: number;
  windowProps: number;
  x36: number;
  lastAt: number;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sessionFile(a1: string): string {
  const id = createHash("sha256").update(a1).digest("hex").slice(0, 16);
  return join(redbookHome(), "state", `page-${id}.json`);
}

/** Advance this a1's page by one request sent at `now` (ms). */
export function nextPageRequest(a1: string, now: number = Date.now()): PageSession {
  let page: PageSession | null = null;
  try {
    page = JSON.parse(readFileSync(sessionFile(a1), "utf-8")) as PageSession;
  } catch {}

  if (!page || now - page.lastAt > PAGE_IDLE_MS || page.loadedAt > now) {
    page = {
      loadedAt: now - randomInt(3, 15) * 1000,
      seq: randomInt(15, 30),
      windowProps: randomInt(1000, 1200),
      x36: randomInt(1, 20),
      lastAt: now,
    };
  } else {
    page = { ...page, seq: page.seq + 1, lastAt: now };
  }

  mkdirSync(join(redbookHome(), "state"), { recursive: true });
  writeFileSync(sessionFile(a1), JSON.stringify(page) + "\n");
  return page;
}
