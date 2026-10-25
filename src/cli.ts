#!/usr/bin/env node

/**
 * redbook CLI — Xiaohongshu (Red Note) from the command line.
 *
 *   redbook whoami
 *   redbook search "Claude Code" --json
 *   redbook comment <url> --content "..." --account work --dry-run
 *
 * Commands that talk to XHS get their client from getClient() (which cookies,
 * which account) and run inside run(), which turns errors into a stable code
 * and exit status: 3 means log in again, 4 means risk control, stop.
 */

import { Command } from "commander";
import kleur from "kleur";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractCookies, type CookieSource, type XhsCookies } from "./lib/cookies.js";
import { resolvePlatform, type PlatformConfig } from "./lib/platform.js";
import { detectPlatform, detectPlatformForCookies } from "./lib/detect.js";
import { XhsClient } from "./lib/client.js";
import { NotLoggedInError, XhsApiError, errorInfo } from "./lib/errors.js";
import {
  DEFAULT_ACCOUNT,
  appendAudit,
  cookieFilePath,
  listAccounts,
  loadCookieFile,
  parseManualCookies,
  saveCookieFile,
  type SavedAccount,
} from "./lib/accounts.js";
import { clearCooldown, cooldownStatus } from "./lib/pace.js";
import { analyzeViral, formatViralAnalysis, type ViralAnalysis } from "./lib/analyze.js";
import {
  selectCandidates,
  executeReplies,
  DEFAULT_DELAY_MS,
  MIN_DELAY_MS as MIN_REPLY_DELAY,
  MAX_REPLIES_HARD_CAP,
  type StrategyName,
} from "./lib/reply-strategy.js";
import { extractTemplate, formatTemplate } from "./lib/template.js";
import { buildHealthReport, type NoteDiagnostics } from "./lib/health.js";
import {
  buildWebUrl,
  enrichWithWebUrl,
  parseBoardUrl,
  parseNoteUrl,
  parseUserProfileArg,
  type NoteRef,
  type UserRef,
} from "./lib/url.js";
import {
  buildAccountReport,
  collectAccountInputs,
  formatAccountReport,
  metricNumber,
  parseReportMonth,
  type AccountReportResult,
} from "./lib/report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

// Commander hands options over untyped.
type Opts = Record<string, any>;
type Rec = Record<string, unknown>;
type ApiPage = { notes?: Rec[]; comments?: Rec[]; users?: Rec[]; has_more?: boolean; cursor?: string };
type Topic = { id: string; name: string; view_num?: number };

const program = new Command();

program
  .name("redbook")
  .description("CLI tool for Xiaohongshu (Red Note)")
  .version(pkg.version);

// ─── Command plumbing ───────────────────────────────────────────────────────

function log(msg: string): void {
  console.error(kleur.dim(msg));
}

function addBrowserOptions(cmd: Command): Command {
  return cmd
    .option("--cookie-source <browser>", "Browser to read cookies from (chrome, safari, firefox)", "chrome")
    .option("--chrome-profile <name>", 'Chrome profile directory name (e.g., "Profile 1")')
    .option(
      "--platform <name>",
      "Force backend: 'xhs' (mainland xiaohongshu.com) or 'rednote' (global rednote.com). Default: auto-detect from your login."
    )
    .option("--global", "Force the global RedNote backend (shorthand for --platform rednote)");
}

/** A command that talks to XHS. */
function apiCommand(spec: string, description: string): Command {
  const cmd = program
    .command(spec)
    .description(description)
    .option("--account <name>", "Saved account to act as (see: redbook auth list)")
    .option("--cookie-string <cookies>", 'Manual cookie string: "a1=VALUE; web_session=VALUE" (from Chrome DevTools)');
  return addBrowserOptions(cmd).option("--json", "Output as JSON");
}

/** A command that changes something on XHS. */
function writeCommand(spec: string, description: string): Command {
  return apiCommand(spec, description).option("--dry-run", "Show what would be sent without sending it");
}

function addUserPageOptions(cmd: Command): Command {
  return cmd
    .option("--xsec-token <token>", "xsec_token from a user profile URL or search result")
    .option("--xsec-source <source>", "xsec_source paired with the user profile token");
}

/**
 * Cookies come from --cookie-string / REDBOOK_COOKIE_STRING, then the saved
 * account file, then the local browser. A named --account only ever uses its
 * own file: falling back to the browser could act as whoever is logged in there.
 */
async function getClient(opts: Opts): Promise<XhsClient> {
  const explicit = (opts.global ? "rednote" : opts.platform) || process.env.REDBOOK_PLATFORM;
  const account: string | undefined = opts.account ?? process.env.REDBOOK_ACCOUNT;
  const cookieString = opts.cookieString || process.env.REDBOOK_COOKIE_STRING;

  if (cookieString) {
    const source = opts.cookieString ? "--cookie-string" : "REDBOOK_COOKIE_STRING";
    const cookies = parseManualCookies(cookieString, source);
    log(`Using ${source}.`);
    const platform = explicit ? resolvePlatform(explicit) : await detectPlatformForCookies(cookies);
    return new XhsClient(cookies, platform, account ?? DEFAULT_ACCOUNT);
  }

  const path = cookieFilePath({ account });
  if (account || process.env.REDBOOK_COOKIE_FILE || existsSync(path)) {
    if (!existsSync(path)) {
      throw new NotLoggedInError(
        `No saved cookies at ${path}. Log into the account in Chrome, then run: ` +
        `redbook auth export${account ? ` --account ${account}` : ""}`
      );
    }
    const saved = loadCookieFile(path);
    log(`Using account "${saved.account}" (${saved.path}).`);
    return new XhsClient(saved.cookies, resolvePlatform(explicit || saved.platform), saved.account);
  }

  const source = opts.cookieSource as CookieSource;
  if (explicit) {
    const platform = resolvePlatform(explicit);
    return new XhsClient(await extractCookies(source, opts.chromeProfile, platform.cookieUrl), platform);
  }

  // Use whichever of xiaohongshu.com / rednote.com the browser is logged into.
  const detected = await detectPlatform(source, opts.chromeProfile);
  const cookies = detected.cookies
    ?? await extractCookies(source, opts.chromeProfile, detected.platform.cookieUrl);
  return new XhsClient(cookies, detected.platform);
}

async function run(opts: Opts, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    const { code, exit } = errorInfo(err);
    const message = err instanceof Error ? err.message : String(err);
    if (opts.json) console.log(JSON.stringify({ error: { code, message } }, null, 2));
    else console.error(kleur.red(`Error: ${message}`) + kleur.dim(` [${code}]`));
    // exitCode instead of process.exit(): exiting while fetch sockets are still
    // closing trips a libuv assertion on Windows (UV_HANDLE_CLOSING).
    process.exitCode = exit;
  }
}

function withClient(body: (client: XhsClient, opts: Opts, ...args: any[]) => Promise<void>) {
  // Commander calls actions with (...arguments, options, command).
  return (...args: any[]) => {
    const opts = args[args.length - 2] as Opts;
    return run(opts, async () => body(await getClient(opts), opts, ...args.slice(0, -2)));
  };
}

function output(data: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(data, null, 2) : data);
}

/**
 * Send a write, or with --dry-run only show it. Real writes are appended to
 * ~/.redbook/audit.jsonl, so you can look back at what each account did.
 */
async function write(
  client: XhsClient,
  opts: Opts,
  plan: Rec,
  send: () => Promise<unknown>,
  done: string | ((result: unknown) => void)
): Promise<void> {
  const entry = { account: client.account, ...plan };
  if (opts.dryRun) {
    if (opts.json) return output({ dryRun: true, ...entry }, true);
    console.log(kleur.yellow("Dry run, nothing sent:"));
    for (const [key, value] of Object.entries(entry)) {
      console.log(`  ${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    return;
  }

  let result: unknown;
  try {
    result = await send();
  } catch (err) {
    appendAudit({ ...entry, ok: false, error: errorInfo(err).code });
    throw err;
  }
  appendAudit({ ...entry, ok: true });

  if (typeof done === "function") done(result);
  else if (opts.json) output(result, true);
  else console.log(kleur.green(done));
}

function pageLimit(opts: Opts): number {
  return opts.all ? Infinity : 1;
}

/** Follow cursors until the last page or `maxPages`. Pacing happens in the client. */
async function collectPages<T>(
  fetchPage: (cursor: string) => Promise<{ items: T[]; cursor?: string; hasMore?: boolean }>,
  { cursor = "", maxPages = 1 }: { cursor?: string; maxPages?: number }
): Promise<{ items: T[]; cursor: string; hasMore: boolean; pages: number }> {
  const items: T[] = [];
  let pages = 0;
  let hasMore = true;
  while (hasMore && pages < maxPages) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    pages++;
    hasMore = Boolean(page.hasMore && page.cursor && page.items.length > 0);
    cursor = page.cursor ?? "";
    if (maxPages > 1) log(`Page ${pages}: ${items.length} so far`);
  }
  return { items, cursor, hasMore, pages };
}

function commentPage(client: XhsClient, ref: NoteRef) {
  return async (cursor: string) => {
    const res = (await client.getComments(ref.noteId, cursor, ref.xsecToken ?? "")) as ApiPage;
    return { items: res.comments ?? [], cursor: res.cursor, hasMore: res.has_more };
  };
}

function userNotesPage(client: XhsClient, user: UserRef) {
  return async (cursor: string) => {
    const res = (await client.getUserNotes(user.userId, cursor, user)) as ApiPage;
    return { items: res.notes ?? [], cursor: res.cursor, hasMore: res.has_more };
  };
}

// ─── whoami ─────────────────────────────────────────────────────────────────

apiCommand("whoami", "Check connection and show current user info")
  .action(withClient(async (client, opts) => {
    const info = (await client.getSelfInfo()) as Rec;
    if (opts.json) return output(info, true);
    console.log(kleur.green(`Connected to ${client.platformLabel}`) + kleur.dim(` as account "${client.account}"`));
    console.log(`  User: ${kleur.bold(String(info.nickname ?? info.nick_name ?? "unknown"))}`);
    console.log(`  ID:   ${info.user_id ?? "unknown"}`);
    if (info.red_id) console.log(`  RedID: ${info.red_id}`);
  }));

// ─── auth ──────────────────────────────────────────────────────────────────

const authCmd = program
  .command("auth")
  .description("Manage saved accounts (cookie files) for multiple accounts, cloud and CI");

function accountSummary(a: SavedAccount) {
  return {
    account: a.account,
    path: a.path,
    user: a.user ?? null,
    platform: a.platform ?? null,
    createdAt: a.createdAt ?? null,
    keys: Object.keys(a.cookies).sort(),
  };
}

function printAccount(a: SavedAccount, verb: string): void {
  console.log(kleur.green(`${verb} account "${a.account}": ${a.path}`));
  if (a.user) console.log(`  User: ${a.user.nickname} (${a.user.id})`);
  console.log(`  Platform: ${a.platform ?? "not stored"}`);
  console.log(`  Keys: ${Object.keys(a.cookies).sort().join(", ")}`);
  if (a.createdAt) console.log(`  Saved: ${a.createdAt}`);
}

/** Check the cookies are really logged in, then save them with the account's nickname. */
async function saveAccount(
  path: string,
  cookies: XhsCookies,
  platform: PlatformConfig,
  account: string = DEFAULT_ACCOUNT
): Promise<SavedAccount> {
  const me = (await new XhsClient(cookies, platform, account).getSelfInfo()) as Rec;
  if (me.guest !== false) {
    throw new NotLoggedInError("These cookies are a guest session. Log into the account in the browser first.");
  }
  return saveCookieFile(path, cookies, platform.id, { id: String(me.user_id), nickname: String(me.nickname ?? "") });
}

function cooldownNote(status: ReturnType<typeof cooldownStatus>): string | null {
  const time = (until: number) => new Date(until).toLocaleTimeString();
  if (status.cooldown) return `cooling down after ${status.cooldown.reason} until ${time(status.cooldown.until)}`;
  if (status.writeCooldown) return `writes paused after ${status.writeCooldown.reason} until ${time(status.writeCooldown.until)}`;
  return null;
}

authCmd
  .command("list")
  .description("List saved accounts")
  .option("--json", "Output as JSON")
  .action((opts) => run(opts, async () => {
    const accounts = listAccounts().map((a) => ({ ...accountSummary(a), ...cooldownStatus(a.account) }));
    if (opts.json) return output(accounts, true);
    if (accounts.length === 0) {
      console.log("No saved accounts. Save one with: redbook auth export --account <name>");
      return;
    }
    for (const a of accounts) {
      const who = a.user ? `${a.user.nickname}  ${kleur.dim(a.user.id)}` : kleur.dim("(user unknown)");
      const note = cooldownNote(a);
      console.log(`${kleur.bold(a.account.padEnd(12))} ${who}  ${kleur.dim(a.platform ?? "")}${note ? kleur.yellow(`  ${note}`) : ""}`);
    }
  }));

addBrowserOptions(
  authCmd
    .command("export [file]")
    .description("Save the browser's current login as an account")
    .option("--account <name>", "Save as this account (default: ~/.redbook/cookies.json)")
    .option("--output <path>", "Write to this file instead")
)
  .option("--json", "Output as JSON")
  .action((file: string | undefined, opts) => run(opts, async () => {
    const source = opts.cookieSource as CookieSource;
    const explicit = opts.global ? "rednote" : opts.platform;
    const detected = explicit ? null : await detectPlatform(source, opts.chromeProfile);
    const platform = detected?.platform ?? resolvePlatform(explicit);
    const cookies = detected?.cookies ?? await extractCookies(source, opts.chromeProfile, platform.cookieUrl);
    const path = cookieFilePath({ file: file ?? opts.output, account: opts.account });
    const saved = await saveAccount(path, cookies, platform, opts.account);
    if (opts.json) output(accountSummary(saved), true);
    else printAccount(saved, "Exported");
  }));

authCmd
  .command("save")
  .description("Save a cookie string as an account")
  .requiredOption("--cookie-string <cookies>", 'Cookie string from Chrome DevTools, e.g. "a1=VALUE; web_session=VALUE"')
  .option("--account <name>", "Save as this account (default: ~/.redbook/cookies.json)")
  .option("--output <path>", "Write to this file instead")
  .option("--platform <name>", "Cookie backend: 'xhs' or 'rednote'. Default: auto-detect.")
  .option("--global", "Shorthand for --platform rednote")
  .option("--json", "Output as JSON")
  .action((opts) => run(opts, async () => {
    const cookies = parseManualCookies(opts.cookieString, "--cookie-string");
    const explicit = opts.global ? "rednote" : opts.platform;
    const platform = explicit ? resolvePlatform(explicit) : await detectPlatformForCookies(cookies);
    const path = cookieFilePath({ file: opts.output, account: opts.account });
    const saved = await saveAccount(path, cookies, platform, opts.account);
    if (opts.json) output(accountSummary(saved), true);
    else printAccount(saved, "Saved");
  }));

authCmd
  .command("inspect [file]")
  .description("Show a saved account without printing cookie values")
  .option("--account <name>", "Account name")
  .option("--json", "Output as JSON")
  .action((file: string | undefined, opts) => run(opts, async () => {
    const saved = loadCookieFile(cookieFilePath({ file, account: opts.account }));
    if (opts.json) output(accountSummary(saved), true);
    else printAccount(saved, "Saved");
  }));

authCmd
  .command("path")
  .description("Print the cookie file path of an account")
  .option("--account <name>", "Account name")
  .option("--json", "Output as JSON")
  .action((opts) => run(opts, async () => {
    const path = cookieFilePath({ account: opts.account });
    if (opts.json) output({ path }, true);
    else console.log(path);
  }));

authCmd
  .command("clear [file]")
  .description("Remove a saved account")
  .option("--account <name>", "Account name")
  .option("--json", "Output as JSON")
  .action((file: string | undefined, opts) => run(opts, async () => {
    const path = cookieFilePath({ file, account: opts.account });
    const removed = existsSync(path);
    if (removed) unlinkSync(path);
    if (opts.json) output({ path, removed }, true);
    else console.log(removed ? kleur.green(`Removed: ${path}`) : kleur.yellow(`Not found: ${path}`));
  }));

// ─── cooldown ───────────────────────────────────────────────────────────────

program
  .command("cooldown")
  .description("Show or clear an account's risk-control cooldown (all requests after a read captcha or IP block, writes only after a write captcha)")
  .option("--account <name>", "Account name")
  .option("--clear", "End the cooldown now")
  .option("--json", "Output as JSON")
  .action((opts) => run(opts, async () => {
    const account = opts.account ?? process.env.REDBOOK_ACCOUNT ?? DEFAULT_ACCOUNT;
    if (opts.clear) clearCooldown(account);
    const status = cooldownStatus(account);
    if (opts.json) return output({ account, ...status }, true);
    const note = cooldownNote(status);
    console.log(note ? kleur.yellow(`Account "${account}": ${note}.`) : kleur.green(`Account "${account}" is not cooling down.`));
  }));

// ─── search ─────────────────────────────────────────────────────────────────

const SORTS = { general: "general", popular: "popularity_descending", latest: "time_descending" } as const;
const NOTE_TYPES = { all: 0, video: 1, image: 2 } as const;

apiCommand("search <keyword>", "Search notes by keyword")
  .option("--page <n>", "Page number", "1")
  .option("--sort <type>", "Sort: general, popular, latest", "general")
  .option("--type <type>", "Note type: all, video, image", "all")
  .action(withClient(async (client, opts, keyword: string) => {
    const result = await client.searchNotes(
      keyword,
      parseInt(opts.page),
      20,
      SORTS[opts.sort as keyof typeof SORTS] ?? "general",
      NOTE_TYPES[opts.type as keyof typeof NOTE_TYPES] ?? 0
    );
    enrichWithWebUrl(result, "pc_search");
    if (opts.json) return output(result, true);

    const items = (result as { items?: Array<{ note_card?: Rec }> }).items ?? [];
    for (const { note_card: card } of items) {
      if (!card) continue;
      const user = card.user as Rec | undefined;
      console.log(
        `${kleur.bold(String(card.title ?? "(no title)"))} — ${kleur.dim(`@${user?.nickname ?? "?"}`)}` +
        `  ${kleur.cyan(String(card.note_id ?? ""))}`
      );
      const info = card.interact_info as Rec | undefined;
      if (info) {
        console.log(`  ${kleur.dim(`♥ ${info.liked_count ?? 0}  💬 ${info.comment_count ?? 0}  ⭐ ${info.collected_count ?? 0}`)}`);
      }
    }
  }));

// ─── read ───────────────────────────────────────────────────────────────────

/** Note detail: the feed API when we have a token, the page HTML otherwise or as fallback. */
async function fetchNote(client: XhsClient, ref: NoteRef): Promise<Rec> {
  if (ref.xsecToken) {
    try {
      const res = (await client.getNoteById(ref.noteId, ref.xsecToken)) as { items?: Array<{ note_card?: Rec }> };
      const card = res?.items?.[0]?.note_card;
      if (card?.user) return card;
    } catch {
      // fall through to the HTML page
    }
  }
  const note = (await client.getNoteFromHtml(ref.noteId, ref.xsecToken ?? "")) as Rec;
  if (Object.keys(note).length === 0) {
    throw new XhsApiError(
      "Note came back empty, which usually means a missing or expired xsec_token. " +
      `Use the full URL from search results or the browser, e.g. ` +
      `https://www.xiaohongshu.com/explore/${ref.noteId}?xsec_token=TOKEN&xsec_source=pc_search`,
      "missing_xsec_token"
    );
  }
  return note;
}

apiCommand("read <url>", "Read a note by URL")
  .action(withClient(async (client, opts, url: string) => {
    const ref = parseNoteUrl(url);
    const note = await fetchNote(client, ref);
    // A bare /explore/<id> link hits the xhs_sec_server gate; hand back a tokenized one.
    if (ref.xsecToken && !note.webUrl) note.webUrl = buildWebUrl(ref.noteId, ref.xsecToken, "pc_share");
    if (opts.json) return output(note, true);

    console.log(kleur.bold(String(note.title ?? "(no title)")));
    console.log(kleur.dim(`by @${(note.user as Rec | undefined)?.nickname ?? "unknown"}`));
    console.log();
    console.log(String(note.desc ?? ""));
    const info = note.interact_info as Rec | undefined;
    if (info) {
      console.log();
      console.log(`♥ ${info.liked_count ?? 0}  💬 ${info.comment_count ?? 0}  ⭐ ${info.collected_count ?? 0}  📤 ${info.share_count ?? 0}`);
    }
  }));

// ─── comments ───────────────────────────────────────────────────────────────

apiCommand("comments <url>", "Get comments on a note")
  .option("--all", "Fetch all pages of comments")
  .action(withClient(async (client, opts, url: string) => {
    const { items } = await collectPages(commentPage(client, parseNoteUrl(url)), { maxPages: pageLimit(opts) });
    if (opts.json) return output(items, true);

    for (const c of items) {
      const user = c.user_info as Rec | undefined;
      console.log(`${kleur.bold(`@${user?.nickname ?? "?"}`)} — ${String(c.content ?? "")}`);
      if (c.like_count) console.log(kleur.dim(`  ♥ ${c.like_count}`));
    }
    console.log(kleur.dim(`\n${items.length} comments`));
  }));

// ─── user ───────────────────────────────────────────────────────────────────

addUserPageOptions(apiCommand("user <user>", "Get user profile info"))
  .action(withClient(async (client, opts, userArg: string) => {
    const user = parseUserProfileArg(userArg, opts);
    output(await client.getUserInfo(user.userId, user), opts.json ?? false);
  }));

// ─── user-posts ─────────────────────────────────────────────────────────────

function printNoteLine(note: Rec, extra = ""): void {
  console.log(
    `${kleur.bold(String(note.display_title ?? note.title ?? "(no title)"))}  ` +
    `${kleur.dim(String(note.note_id ?? ""))}  ${extra}`
  );
}

addUserPageOptions(apiCommand("user-posts <user>", "List a user's posted notes"))
  .option("--cursor <cursor>", "Resume pagination from a cursor (last note_id)")
  .option("--all", "Fetch all pages (paginate until no more results)")
  .option("--delay <ms>", "Minimum ms between requests", "3000")
  .action(withClient(async (client, opts, userArg: string) => {
    client.minGapMs = Number(opts.delay);
    const user = parseUserProfileArg(userArg, opts);

    if (!opts.all) {
      const result = await client.getUserNotes(user.userId, opts.cursor ?? "", user);
      enrichWithWebUrl(result, "pc_user");
      if (opts.json) return output(result, true);
      const notes = (result as ApiPage).notes ?? [];
      for (const note of notes) printNoteLine(note, `[${note.type ?? "?"}]`);
      console.log(kleur.dim(`\n${notes.length} notes`));
      return;
    }

    const { items } = await collectPages(userNotesPage(client, user), { cursor: opts.cursor, maxPages: Infinity });
    enrichWithWebUrl(items, "pc_user");
    if (opts.json) return output({ notes: items, total: items.length }, true);
    for (const note of items) printNoteLine(note, `[${note.type ?? "?"}]`);
    console.log(kleur.dim(`\n${items.length} notes total`));
  }));

// ─── account-report ─────────────────────────────────────────────────────────

addUserPageOptions(
  apiCommand("account-report [users...]", "Summarize posting activity and engagement for one or more accounts")
    .alias("creator-report")
)
  .option("--file <path>", "Read account IDs/profile URLs from a newline-separated file")
  .option("--month <yyyy-mm>", "Month to count posts for (default: current month)")
  .option("--all", "Fetch all pages for each account")
  .option("--max-pages <n>", "Max pages per account when --all is not set", "1")
  .option("--delay <ms>", "Minimum ms between requests", "3000")
  .action(withClient(async (client, opts, users: string[] | undefined) => {
    const inputs = collectAccountInputs(users ?? [], opts.file);
    if (inputs.length === 0) throw new Error("Provide at least one account ID/profile URL, or use --file <path>.");

    const month = parseReportMonth(opts.month);
    const maxPages = opts.all ? Infinity : Math.max(1, parseInt(opts.maxPages) || 1);
    client.minGapMs = Number(opts.delay);

    const result: AccountReportResult = {
      month: month.label,
      generatedAt: new Date().toISOString(),
      accounts: [],
      errors: [],
    };
    let exit = 0;
    for (const input of inputs) {
      let userId: string | undefined;
      try {
        const user = parseUserProfileArg(input, opts);
        userId = user.userId;
        const paged = await collectPages(userNotesPage(client, user), { maxPages });
        enrichWithWebUrl(paged.items, "pc_user");
        result.accounts.push(buildAccountReport(input, user.userId, paged.items, month, paged));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ input, userId, error: message });
        console.error(kleur.red(`Failed ${userId ?? input}: ${message}`));
        exit = Math.max(exit, errorInfo(err).exit);
        if (exit === 4) break; // risk control: report what we have and stop
      }
    }

    if (opts.json) output(result, true);
    else console.log(formatAccountReport(result));
    process.exitCode = exit;
  }));

// ─── feed ───────────────────────────────────────────────────────────────────

apiCommand("feed", "Get homepage feed")
  .option("--category <cat>", "Feed category", "homefeed_recommend")
  .action(withClient(async (client, opts) => {
    const result = await client.getHomeFeed(opts.category);
    enrichWithWebUrl(result, "pc_feed");
    output(result, opts.json ?? false);
  }));

// ─── post ───────────────────────────────────────────────────────────────────

function topicList(res: unknown): Topic[] {
  return Array.isArray(res) ? res : (res as { topic_info_dtos?: Topic[] }).topic_info_dtos ?? [];
}

async function publishNote(client: XhsClient, opts: Opts): Promise<Rec> {
  const fileIds: string[] = [];
  for (const path of opts.images as string[]) {
    const { fileId, token } = await client.getUploadPermit("image");
    const ext = path.toLowerCase().split(".").pop();
    const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    await client.uploadFile(fileId, token, path, contentType);
    fileIds.push(fileId);
    log(`Uploaded ${path}`);
  }

  // Prefer the topic whose name matches the keyword exactly; write it in the
  // body as "#name[话题]#" so the app links it.
  const topics: Topic[] = [];
  for (const keyword of (opts.topic as string[] | undefined) ?? []) {
    const found = topicList(await client.searchTopics(keyword));
    const topic = found.find((t) => t.name === keyword) ?? found[0];
    if (topic) topics.push(topic);
  }
  if (topics.length > 0) log(`Topics: ${topics.map((t) => `#${t.name}`).join(" ")}`);

  log("Publishing note...");
  const result = (await client.createImageNote(opts.title, opts.body, fileIds, {
    topics: topics.map((t) => ({ id: t.id, name: t.name, type: "topic" })),
    isPrivate: Boolean(opts.private),
  })) as Rec;
  if (result.note_id && typeof result.xsec_token === "string") {
    result.webUrl = buildWebUrl(String(result.note_id), result.xsec_token, "pc_share");
  }
  return result;
}

writeCommand("post", "Publish an image note")
  .requiredOption("--title <title>", "Note title")
  .requiredOption("--body <body>", "Note body text")
  .requiredOption("--images <paths...>", "Image file paths")
  .option("--topic <keywords...>", "Topics to search and attach; write them in the body as #name[话题]#")
  .option("--private", "Publish as private note")
  .action(withClient(async (client, opts) => {
    const images = opts.images as string[];
    const missing = images.find((p) => !existsSync(p));
    if (missing) throw new Error(`Image not found: ${missing}`);

    const plan = {
      action: "post",
      title: opts.title,
      body: opts.body,
      images,
      topics: opts.topic ?? [],
      private: Boolean(opts.private),
    };
    await write(client, opts, plan, () => publishNote(client, opts), (result) => {
      if (opts.json) return output(result, true);
      const r = result as Rec;
      console.log(kleur.green("Note published!"));
      if (r.note_id) console.log(`  URL: ${r.webUrl ?? buildWebUrl(String(r.note_id), null)}`);
      console.error(kleur.yellow("⚠ Rate limit: wait ≥3-4 hours before the next post (2-3 notes/day max)."));
    });
  }));

// ─── topics ─────────────────────────────────────────────────────────────────

apiCommand("topics <keyword>", "Search for topics/hashtags to use in posts")
  .action(withClient(async (client, opts, keyword: string) => {
    const result = await client.searchTopics(keyword);
    if (opts.json) return output(result, true);
    for (const topic of topicList(result)) {
      console.log(
        `#${kleur.bold(topic.name ?? "?")}  ${kleur.dim(`id:${topic.id ?? "?"}`)}  ${kleur.dim(`views:${topic.view_num ?? "?"}`)}`
      );
    }
  }));

// ─── favorites ──────────────────────────────────────────────────────────────

async function selfId(client: XhsClient): Promise<string> {
  const me = (await client.getSelfInfo()) as Rec;
  if (!me.user_id) throw new NotLoggedInError("Could not determine the current user ID");
  return String(me.user_id);
}

apiCommand("favorites [userId]", "List a user's collected/favorited notes (defaults to current user)")
  .option("--all", "Fetch all pages")
  .action(withClient(async (client, opts, userId: string | undefined) => {
    const uid = userId || await selfId(client);
    const { items } = await collectPages(async (cursor) => {
      const res = (await client.getUserCollectedNotes(uid, 30, cursor)) as ApiPage;
      return { items: res.notes ?? [], cursor: res.cursor, hasMore: res.has_more };
    }, { maxPages: pageLimit(opts) });
    enrichWithWebUrl(items, "pc_user");
    if (opts.json) return output(items, true);

    for (const note of items) printNoteLine(note, kleur.dim(`@${(note.user as Rec | undefined)?.nickname ?? "?"}`));
    console.log(kleur.dim(`\n${items.length} collected notes`));
  }));

// ─── collect / uncollect / like ─────────────────────────────────────────────

writeCommand("collect <url>", "Collect (bookmark) a note")
  .action(withClient(async (client, opts, url: string) => {
    const { noteId } = parseNoteUrl(url);
    await write(client, opts, { action: "collect", note: noteId }, () => client.collectNote(noteId), "Note collected!");
  }));

writeCommand("uncollect <url>", "Remove a note from your collection")
  .action(withClient(async (client, opts, url: string) => {
    const { noteId } = parseNoteUrl(url);
    await write(client, opts, { action: "uncollect", note: noteId }, () => client.uncollectNote(noteId),
      "Note removed from collection!");
  }));

writeCommand("like <url>", "Like a note")
  .option("--undo", "Unlike the note instead")
  .action(withClient(async (client, opts, url: string) => {
    const { noteId } = parseNoteUrl(url);
    await write(
      client,
      opts,
      { action: opts.undo ? "unlike" : "like", note: noteId },
      () => (opts.undo ? client.unlikeNote(noteId) : client.likeNote(noteId)),
      opts.undo ? "Note unliked!" : "Note liked!"
    );
  }));

// ─── followers / following ──────────────────────────────────────────────────

function listUsers(fetch: (client: XhsClient, userId: string, cursor: string) => Promise<unknown>, noun: string) {
  return withClient(async (client, opts, userId: string) => {
    const { items } = await collectPages(async (cursor) => {
      const res = (await fetch(client, userId, cursor)) as ApiPage;
      return { items: res.users ?? [], cursor: res.cursor, hasMore: res.has_more };
    }, { maxPages: pageLimit(opts) });
    if (opts.json) return output(items, true);

    for (const u of items) {
      console.log(
        `${kleur.bold(String(u.nickname ?? "?"))}  ${kleur.dim(String(u.user_id ?? ""))}  ` +
        kleur.dim(String(u.desc ?? "").slice(0, 60))
      );
    }
    console.log(kleur.dim(`\n${items.length} ${noun}`));
  });
}

apiCommand("followers <userId>", "List a user's followers")
  .option("--all", "Fetch all pages")
  .action(listUsers((client, id, cursor) => client.getUserFollowers(id, cursor), "followers"));

apiCommand("following <userId>", "List accounts a user follows")
  .option("--all", "Fetch all pages")
  .action(listUsers((client, id, cursor) => client.getUserFollowing(id, cursor), "following"));

// ─── delete ────────────────────────────────────────────────────────────────

writeCommand("delete <url>", "Delete your own note")
  .option("--yes", "Confirm the deletion")
  .action(withClient(async (client, opts, url: string) => {
    if (!opts.yes && !opts.dryRun) {
      throw new Error("Deleting a note can't be undone. Re-run with --yes to confirm, or --dry-run to preview.");
    }
    const { noteId } = parseNoteUrl(url);
    await write(client, opts, { action: "delete", note: noteId }, () => client.deleteNote(noteId), "Note deleted!");
  }));

// ─── boards ──────────────────────────────────────────────────────────────────

apiCommand("boards [user-id]", "List user's collection boards (收藏专辑列表)")
  .action(withClient(async (client, opts, userId: string | undefined) => {
    const uid = userId || await selfId(client);
    log(`Listing boards for ${uid}...`);
    const data = (await client.getUserBoards(uid)) as Rec;
    if (opts.json) return output(data, true);

    const boards = (data.boards ?? []) as Rec[];
    console.log(kleur.dim(`${data.board_count ?? boards.length} board(s)\n`));
    for (const b of boards) {
      const privacy = b.privacy === 1 ? kleur.yellow(" [private]") : "";
      console.log(`  ${kleur.bold(String(b.name ?? "(untitled)"))}  ${kleur.dim(`${b.total ?? 0} notes`)}${privacy}  ${kleur.dim(String(b.id ?? ""))}`);
      if (b.desc && b.desc !== "暂无简介") console.log(`    ${kleur.dim(String(b.desc))}`);
    }
  }));

// ─── board ───────────────────────────────────────────────────────────────────

interface BoardResult {
  boardId: string;
  name: string;
  desc: string;
  noteCount: number;
  notes: Array<{ note_id: string; xsec_token?: string; title: string; author: string; type: string; url: string; webUrl?: string }>;
}

apiCommand("board <url>", "List notes in a collection album (收藏专辑)")
  .action(withClient(async (client, opts, url: string) => {
    const boardId = parseBoardUrl(url);
    log(`Fetching board ${boardId}...`);

    let result: BoardResult;
    try {
      const [info, feeds] = (await Promise.all([client.getBoardInfo(boardId), client.getBoardNotes(boardId)])) as Rec[];
      const notes = ((feeds.notes ?? []) as Rec[]).map((n) => {
        const noteId = String(n.note_id ?? n.id ?? "");
        const token = String(n.xsec_token ?? "");
        const user = n.user as Rec | undefined;
        const link = buildWebUrl(noteId, token, "pc_board");
        return {
          note_id: noteId,
          xsec_token: token,
          title: String(n.display_title ?? n.title ?? ""),
          type: String(n.type ?? ""),
          author: String(user?.nick_name ?? user?.nickname ?? ""),
          url: link,
          webUrl: link,
        };
      });
      result = {
        boardId,
        name: String(info.name ?? ""),
        desc: String(info.desc ?? ""),
        noteCount: Number(info.total ?? notes.length),
        notes,
      };
    } catch {
      log("REST API unavailable, falling back to HTML scraping...");
      result = (await client.getBoardFromHtml(boardId)) as BoardResult;
    }

    if (opts.json) return output(result, true);
    if (result.name) console.log(kleur.bold(result.name));
    if (result.desc) console.log(kleur.dim(result.desc));
    console.log();
    for (const note of result.notes) {
      console.log(`  ${kleur.bold(note.title || "(no title)")}  ${kleur.dim(`@${note.author || "?"}`)}  [${note.type || "?"}]`);
      console.log(`    ${kleur.cyan(note.url)}`);
    }
    console.log(kleur.dim(`\n${result.notes.length} notes`));
  }));

// ─── health ──────────────────────────────────────────────────────────────────

function formatFlags(n: NoteDiagnostics): string {
  const parts: string[] = [];
  if (n.sensitiveHits.length > 0) parts.push(kleur.yellow(`⚠️${n.sensitiveHits.join("、")}`));
  if (n.tagWarning) parts.push(kleur.yellow(`📛${n.tagCount}tags`));
  return parts.length > 0 ? "  " + parts.join(" ") : "";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

apiCommand("health", "Check note distribution health — detect hidden rate-limiting (限流)")
  .option("--all", "Fetch all pages of notes")
  .action(withClient(async (client, opts) => {
    // The creator backend's v2 note list carries the hidden `level` field.
    log("Fetching notes from creator backend...");
    const { items } = await collectPages(async (cursor) => {
      const page = Number(cursor || 0);
      const res = (await client.getCreatorNoteList(0, page)) as ApiPage;
      return { items: res.notes ?? [], cursor: String(page + 1), hasMore: res.has_more };
    }, { maxPages: pageLimit(opts) });

    if (items.length === 0) {
      console.log(kleur.yellow("No notes found."));
      return;
    }

    const report = buildHealthReport(items);
    if (opts.json) return output(report, true);

    console.log(kleur.bold("\n📊 Note Health Report"));
    console.log(kleur.dim("───────────────────────────────────────"));
    for (const [label, count] of Object.entries(report.distribution)) {
      console.log(`  ${label.padEnd(14)} ${kleur.dim("█".repeat(Math.min(count, 40)))} ${count}`);
    }
    console.log(kleur.dim(`\n  Total: ${report.totalNotes} notes`));

    if (report.limitedNotes.length > 0) {
      console.log(kleur.red(kleur.bold(`\n⚠ ${report.limitedNotes.length} notes with limited distribution:`)));
      for (const n of report.limitedNotes) {
        console.log(`  ${n.levelMeta.emoji} ${kleur.red(`L${n.level}`.padEnd(6))} ${truncate(n.title, 50)}${formatFlags(n)}`);
      }
    } else {
      console.log(kleur.green("\n✓ All notes have normal distribution!"));
    }

    if (report.sensitiveNotes.length > 0) {
      console.log(kleur.yellow(`\n⚠ ${report.sensitiveNotes.length} notes with risk factors:`));
      for (const n of report.sensitiveNotes) {
        const reasons: string[] = [];
        if (n.sensitiveHits.length > 0) reasons.push(`敏感词: ${n.sensitiveHits.join("、")}`);
        if (n.tagWarning) reasons.push(`标签过多(${n.tagCount}个)`);
        console.log(`  ${kleur.dim(n.noteId.slice(0, 8))} ${truncate(n.title, 40)} ${kleur.yellow(reasons.join(" | "))}`);
      }
    }
    console.log();
  }));

// ─── analyze-viral / viral-template ─────────────────────────────────────────

// Parts of an analysis may fail and fall back to a default, but never quietly
// through risk control.
function orElse<T>(fallback: T) {
  return (err: unknown): T => {
    if (errorInfo(err).exit === 4) throw err;
    return fallback;
  };
}

function followerCount(info: unknown): number {
  const interactions = ((info as Rec).interactions ?? []) as Array<{ type?: string; count?: string }>;
  return metricNumber(interactions.find((i) => i.type === "fans")?.count);
}

/** The note plus its first comment pages, the author's posts and follower count. */
async function analyzeNote(client: XhsClient, ref: NoteRef, commentPages: number): Promise<ViralAnalysis> {
  const note = await fetchNote(client, ref);
  const userId = String((note.user as Rec | undefined)?.user_id ?? "");
  if (!userId) throw new Error(`Could not find the author of note ${ref.noteId}`);

  const [comments, authorPosts, authorFollowers] = await Promise.all([
    collectPages(commentPage(client, ref), { maxPages: commentPages }).then((p) => p.items).catch(orElse([])),
    client.getUserNotes(userId).then((r) => (r as ApiPage).notes ?? []).catch(orElse([])),
    client.getUserInfo(userId).then(followerCount).catch(orElse(0)),
  ]);
  return analyzeViral(ref.noteId, note, comments, authorPosts, authorFollowers);
}

function commentPageLimit(opts: Opts): number {
  return Math.min(parseInt(opts.commentPages) || 3, 10);
}

apiCommand("analyze-viral <url>", "Analyze why a viral note works — hooks, engagement, structure")
  .option("--comment-pages <n>", "Comment pages to fetch (max 10)", "3")
  .action(withClient(async (client, opts, url: string) => {
    log("Fetching note, comments, author posts, and profile...");
    const analysis = await analyzeNote(client, parseNoteUrl(url), commentPageLimit(opts));
    if (opts.json) output(analysis, true);
    else console.log(formatViralAnalysis(analysis));
  }));

apiCommand("viral-template <urls...>", "Extract a content template from 1-3 viral notes")
  .option("--comment-pages <n>", "Comment pages to fetch per note (max 10)", "3")
  .action(withClient(async (client, opts, urls: string[]) => {
    if (urls.length > 3) throw new Error("Maximum 3 URLs allowed");

    const analyses: ViralAnalysis[] = [];
    for (const url of urls) {
      const ref = parseNoteUrl(url);
      log(`Analyzing ${ref.noteId}...`);
      try {
        analyses.push(await analyzeNote(client, ref, commentPageLimit(opts)));
      } catch (err) {
        if (errorInfo(err).exit === 4) throw err;
        console.error(kleur.yellow(`Skipping ${ref.noteId}: ${err instanceof Error ? err.message : err}`));
      }
    }
    if (analyses.length === 0) throw new Error("No notes could be analyzed");

    const template = extractTemplate(analyses);
    if (opts.json) output(template, true);
    else console.log(formatTemplate(template));
  }));

// ─── comment / reply ─────────────────────────────────────────────────────────

writeCommand("comment <url>", "Post a top-level comment on a note")
  .requiredOption("--content <text>", "Comment text")
  .action(withClient(async (client, opts, url: string) => {
    const { noteId } = parseNoteUrl(url);
    const plan = { action: "comment", note: noteId, content: opts.content };
    await write(client, opts, plan, () => client.postComment(noteId, opts.content), (result) => {
      if (opts.json) return output(result, true);
      console.log(kleur.green("Comment posted!"));
      console.error(kleur.yellow("⚠ Rate limit: wait ≥3 minutes before the next comment to avoid risk control."));
    });
  }));

writeCommand("reply <url>", "Reply to a comment on a note")
  .requiredOption("--comment-id <id>", "Comment ID to reply to")
  .requiredOption("--content <text>", "Reply text")
  .action(withClient(async (client, opts, url: string) => {
    const { noteId } = parseNoteUrl(url);
    const plan = { action: "reply", note: noteId, comment: opts.commentId, content: opts.content };
    await write(client, opts, plan, () => client.replyComment(noteId, opts.commentId, opts.content), (result) => {
      if (opts.json) return output(result, true);
      console.log(kleur.green("Reply posted!"));
      console.error(kleur.yellow("⚠ Rate limit: wait ≥3 minutes before the next reply to avoid risk control."));
    });
  }));

// ─── batch-reply ─────────────────────────────────────────────────────────────

apiCommand("batch-reply <url>", "Reply to multiple comments using a strategy")
  .option("--strategy <name>", "Filter strategy: questions, top-engaged, all-unanswered", "questions")
  .option("--template <text>", "Reply template with {author}, {content} placeholders")
  .option("--max <n>", `Max replies to send (hard cap: ${MAX_REPLIES_HARD_CAP})`, "10")
  .option("--delay <ms>", `Delay between replies in ms (min: ${MIN_REPLY_DELAY / 1000}s)`, String(DEFAULT_DELAY_MS))
  .option("--dry-run", "Preview candidates without posting")
  .action(withClient(async (client, opts, url: string) => {
    const ref = parseNoteUrl(url);
    const strategy = opts.strategy as StrategyName;
    const max = Math.min(parseInt(opts.max) || 10, MAX_REPLIES_HARD_CAP);

    log("Fetching comments...");
    const { items } = await collectPages(commentPage(client, ref), { maxPages: Infinity });
    const plan = selectCandidates(items, strategy, max);
    plan.noteId = ref.noteId;

    if (opts.dryRun || !opts.template) {
      if (opts.json) return output(plan, true);
      console.log(kleur.bold(`\nBatch Reply Plan — ${strategy}`));
      console.log(kleur.dim(`${plan.totalComments} comments → ${plan.candidates.length} candidates (${plan.skipped} skipped)\n`));
      for (const c of plan.candidates) {
        console.log(`  ${kleur.cyan(c.commentId.slice(0, 8))}  ${kleur.bold(`@${c.author}`)}  ${kleur.dim(`♥ ${c.likes}`)}`);
        console.log(`    ${c.content.slice(0, 80)}${c.content.length > 80 ? "..." : ""}`);
      }
      console.log(kleur.yellow(opts.template
        ? "\nDry run mode. Remove --dry-run to execute."
        : "\nDry run (no --template provided). Add --template to execute."));
      return;
    }

    const delayMs = parseInt(opts.delay) || DEFAULT_DELAY_MS;
    log(`Sending ${plan.candidates.length} replies (delay: ~${Math.round(delayMs / 60000)}min ±30% jitter)...`);
    const results = await executeReplies(client, ref.noteId, plan.candidates, opts.template, delayMs, {});
    for (const r of results) {
      appendAudit({
        account: client.account,
        action: "reply",
        note: ref.noteId,
        comment: r.commentId,
        content: r.content,
        ok: r.success,
        ...(r.error ? { error: r.error } : {}),
      });
    }

    if (opts.json) return output(results, true);
    const failed = results.filter((r) => !r.success);
    console.log(kleur.green(`\n${results.length - failed.length} replies sent`));
    if (failed.length > 0) {
      console.log(kleur.red(`${failed.length} failed`));
      for (const r of failed) console.log(kleur.dim(`  @${r.author}: ${r.error}`));
    }
  }));

// ─── render ──────────────────────────────────────────────────────────────────

program
  .command("render <file>")
  .description("Render markdown to styled PNG cards for Xiaohongshu posts")
  .option("--style <name>", "Color style: purple, xiaohongshu, mint, sunset, ocean, elegant, dark", "xiaohongshu")
  .option("--pagination <mode>", "Pagination: auto, separator", "auto")
  .option("--output-dir <dir>", "Output directory (default: same as input file)")
  .option("--width <n>", "Card width in px", "1080")
  .option("--height <n>", "Card height in px", "1440")
  .option("--dpr <n>", "Device pixel ratio", "2")
  .option("--json", "Output as JSON")
  .action((file: string, opts) => run(opts, async () => {
    const { renderCards } = await import("./lib/render.js");
    const result = await renderCards(file, {
      style: opts.style,
      pagination: opts.pagination,
      outputDir: opts.outputDir,
      width: parseInt(opts.width),
      height: parseInt(opts.height),
      dpr: parseInt(opts.dpr),
    });
    if (opts.json) return output(result, true);
    console.log(kleur.green(`\nRendered ${result.totalCards + 1} images:`));
    console.log(`  Cover: ${kleur.bold(result.coverPath)}`);
    for (const p of result.cardPaths) console.log(`  Card:  ${kleur.bold(p)}`);
  }));

program.parse();
