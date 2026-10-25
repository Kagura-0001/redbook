/**
 * Request pacing and risk cooldown, shared by every redbook process of one account.
 *
 * Each CLI command is a separate process, so the time of the last request lives
 * in state/<account>.json instead of memory. A captcha on a read or an IP block
 * pauses the whole account. A captcha on a write (publishing draws them often)
 * only pauses writes, so reading keeps working.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkAccountName, redbookHome } from "./accounts.js";
import { RiskCooldownError } from "./errors.js";

export const MIN_GAP_MS = 1000;
export const COOLDOWN_MS = 30 * 60_000;

export type Scope = "read" | "write";

export interface Cooldown {
  until: number;
  reason: string;
}

interface PaceState {
  lastRequestAt?: number;
  cooldown?: Cooldown;
  writeCooldown?: Cooldown;
}

function stateFile(account: string): string {
  return join(redbookHome(), "state", `${checkAccountName(account)}.json`);
}

function readState(account: string): PaceState {
  try {
    return JSON.parse(readFileSync(stateFile(account), "utf-8")) as PaceState;
  } catch {
    return {};
  }
}

function writeState(account: string, state: PaceState): void {
  mkdirSync(join(redbookHome(), "state"), { recursive: true });
  writeFileSync(stateFile(account), JSON.stringify(state) + "\n");
}

function active(c: Cooldown | undefined): Cooldown | null {
  return c && c.until > Date.now() ? c : null;
}

// Humans don't click at a fixed rhythm: a short gaussian jitter, plus the odd
// longer pause.
function jitterMs(): number {
  const u = 1 - Math.random();
  const gauss = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  let ms = Math.max(0, 300 + 150 * gauss);
  if (Math.random() < 0.05) ms += 2000 + Math.random() * 3000;
  return ms;
}

const queues = new Map<string, Promise<void>>();

/** Resolve when it is this account's turn to send a request. */
export function pace(account: string, gapMs: number = MIN_GAP_MS, scope: Scope = "read"): Promise<void> {
  const turn = (queues.get(account) ?? Promise.resolve()).then(() => waitTurn(account, gapMs, scope));
  queues.set(account, turn.catch(() => {}));
  return turn;
}

async function waitTurn(account: string, gapMs: number, scope: Scope): Promise<void> {
  const state = readState(account);
  const all = active(state.cooldown);
  if (all) throw new RiskCooldownError(all.until, all.reason, account, "all");
  const writes = scope === "write" ? active(state.writeCooldown) : null;
  if (writes) throw new RiskCooldownError(writes.until, writes.reason, account, "write");

  const wait = (state.lastRequestAt ?? 0) + gapMs + jitterMs() - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  writeState(account, { ...readState(account), lastRequestAt: Date.now() });
}

export function startCooldown(
  account: string,
  reason: string,
  scope: "all" | "write" = "all",
  ms: number = COOLDOWN_MS
): void {
  const key = scope === "write" ? "writeCooldown" : "cooldown";
  writeState(account, { ...readState(account), [key]: { until: Date.now() + ms, reason } });
}

export function cooldownStatus(account: string): { cooldown: Cooldown | null; writeCooldown: Cooldown | null } {
  const state = readState(account);
  return { cooldown: active(state.cooldown), writeCooldown: active(state.writeCooldown) };
}

export function clearCooldown(account: string): void {
  const { lastRequestAt } = readState(account);
  writeState(account, { lastRequestAt });
}
