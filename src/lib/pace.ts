/**
 * Request pacing and risk cooldown, shared by every redbook process of one account.
 *
 * Each CLI command is a separate process, so the time of the last request lives
 * in state/<account>.json instead of memory. When XHS answers with a captcha or
 * an IP block, the account goes into cooldown and later commands fail fast with
 * RiskCooldownError rather than digging the hole deeper.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkAccountName, redbookHome } from "./accounts.js";
import { RiskCooldownError } from "./errors.js";

export const MIN_GAP_MS = 1000;
export const COOLDOWN_MS = 30 * 60_000;

interface PaceState {
  lastRequestAt?: number;
  cooldownUntil?: number;
  cooldownReason?: string;
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
export function pace(account: string, gapMs: number = MIN_GAP_MS): Promise<void> {
  const turn = (queues.get(account) ?? Promise.resolve()).then(() => waitTurn(account, gapMs));
  queues.set(account, turn.catch(() => {}));
  return turn;
}

async function waitTurn(account: string, gapMs: number): Promise<void> {
  const state = readState(account);
  if (state.cooldownUntil && state.cooldownUntil > Date.now()) {
    throw new RiskCooldownError(state.cooldownUntil, state.cooldownReason ?? "risk control", account);
  }
  const wait = (state.lastRequestAt ?? 0) + gapMs + jitterMs() - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  writeState(account, { ...readState(account), lastRequestAt: Date.now() });
}

export function startCooldown(account: string, reason: string, ms: number = COOLDOWN_MS): void {
  writeState(account, { ...readState(account), cooldownUntil: Date.now() + ms, cooldownReason: reason });
}

export function cooldownStatus(account: string): { until: number; reason: string } | null {
  const state = readState(account);
  if (!state.cooldownUntil || state.cooldownUntil <= Date.now()) return null;
  return { until: state.cooldownUntil, reason: state.cooldownReason ?? "risk control" };
}

export function clearCooldown(account: string): void {
  const { cooldownUntil, cooldownReason, ...rest } = readState(account);
  writeState(account, rest);
}
