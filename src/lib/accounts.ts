/**
 * Saved accounts under ~/.redbook (or $REDBOOK_HOME):
 *
 *   cookies.json           the default account
 *   accounts/<name>.json   named accounts, for running several XHS accounts side by side
 *   state/<name>.json      request pacing and risk cooldown (see pace.ts)
 *   audit.jsonl            one line per write action
 *
 * Cookie files are plaintext login credentials, written with mode 0600.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseCookieString, type XhsCookies } from "./cookies.js";
import { NotLoggedInError } from "./errors.js";
import type { PlatformId } from "./platform.js";

export const DEFAULT_ACCOUNT = "default";

export interface SavedAccount {
  account: string;
  path: string;
  cookies: XhsCookies;
  platform?: PlatformId;
  createdAt?: string;
  user?: { id: string; nickname: string };
}

export function redbookHome(): string {
  return process.env.REDBOOK_HOME || join(homedir(), ".redbook");
}

export function checkAccountName(name: string): string {
  if (!/^[\w-]+$/.test(name)) {
    throw new Error(`Invalid account name "${name}". Use letters, digits, "_" or "-".`);
  }
  return name;
}

export function accountFile(account: string): string {
  return account === DEFAULT_ACCOUNT
    ? join(redbookHome(), "cookies.json")
    : join(redbookHome(), "accounts", `${checkAccountName(account)}.json`);
}

/** Cookie file for an explicit path, a named account, or the default chain. */
export function cookieFilePath(opts: { file?: string; account?: string } = {}): string {
  if (opts.file) return expandPath(opts.file);
  if (opts.account) return accountFile(opts.account);
  if (process.env.REDBOOK_COOKIE_FILE) return expandPath(process.env.REDBOOK_COOKIE_FILE);
  return accountFile(DEFAULT_ACCOUNT);
}

function expandPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

export function parseManualCookies(cookieString: string, source: string): XhsCookies {
  return requireLoginCookies(parseCookieString(cookieString), source);
}

function requireLoginCookies(cookies: XhsCookies, source: string): XhsCookies {
  if (!cookies.a1 || !cookies.web_session) {
    throw new NotLoggedInError(
      `${source} must contain at least 'a1' and 'web_session'. ` +
      "Copy them from Chrome DevTools > Application > Cookies."
    );
  }
  return cookies;
}

function stringEntries(record: Record<string, unknown>): XhsCookies {
  const cookies: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") cookies[key] = value;
  }
  return cookies as XhsCookies;
}

function parsePlatform(value: unknown): PlatformId | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.toLowerCase();
  if (raw === "xhs" || raw === "xiaohongshu" || raw === "mainland") return "xhs";
  if (raw === "rednote" || raw === "global") return "rednote";
  return undefined;
}

function accountNameOf(path: string): string {
  if (path === accountFile(DEFAULT_ACCOUNT)) return DEFAULT_ACCOUNT;
  const match = /[\\/]accounts[\\/]([\w-]+)\.json$/.exec(path);
  return match ? match[1] : DEFAULT_ACCOUNT;
}

/**
 * Accepts the current format ({version, platform, cookies, user}) as well as a
 * bare cookie string, {cookieString}, or a flat {name: value} map.
 */
export function loadCookieFile(path: string): SavedAccount {
  const raw = readFileSync(path, "utf-8").trim();
  if (!raw) throw new Error(`Cookie file is empty: ${path}`);

  const source = `Cookie file ${path}`;
  const account = accountNameOf(path);
  if (!raw.startsWith("{")) {
    return { account, path, cookies: parseManualCookies(raw, source) };
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const user = parsed.user as SavedAccount["user"] | undefined;
  const cookies = typeof parsed.cookieString === "string"
    ? parseManualCookies(parsed.cookieString, source)
    : requireLoginCookies(stringEntries((parsed.cookies ?? parsed) as Record<string, unknown>), source);

  return {
    account,
    path,
    cookies,
    platform: parsePlatform(parsed.platform),
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
    user: user?.id ? user : undefined,
  };
}

export function saveCookieFile(
  path: string,
  cookies: XhsCookies,
  platform: PlatformId,
  user?: SavedAccount["user"]
): SavedAccount {
  requireLoginCookies(cookies, "Cookie data");
  mkdirSync(dirname(path), { recursive: true });
  const createdAt = new Date().toISOString();
  const sorted = Object.fromEntries(Object.entries(cookies).sort(([a], [b]) => a.localeCompare(b)));
  const body = { version: 1, platform, createdAt, ...(user ? { user } : {}), cookies: sorted };
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // filesystems without POSIX modes
  }
  return { account: accountNameOf(path), path, cookies, platform, createdAt, user };
}

export function listAccounts(): SavedAccount[] {
  const paths = [accountFile(DEFAULT_ACCOUNT)];
  const dir = join(redbookHome(), "accounts");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".json")) paths.push(join(dir, name));
    }
  }
  return paths.filter((p) => existsSync(p)).map(loadCookieFile);
}

export function appendAudit(entry: Record<string, unknown>): void {
  mkdirSync(redbookHome(), { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  appendFileSync(join(redbookHome(), "audit.jsonl"), line + "\n", { mode: 0o600 });
}
