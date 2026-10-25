/**
 * Account report — posting activity and engagement per account, for KOS/KOC checks.
 */

import { readFileSync } from "node:fs";
import kleur from "kleur";

export interface ReportMonth {
  label: string;
  start: Date;
  end: Date;
}

export interface AccountReportNote {
  noteId: string;
  title: string;
  type: string;
  publishedAt: string | null;
  likes: number;
  comments: number;
  collects: number;
  shares: number;
  totalEngagement: number;
  webUrl?: string;
}

type Totals = Pick<AccountReportNote, "likes" | "comments" | "collects" | "shares" | "totalEngagement">;

export interface AccountReport {
  input: string;
  userId: string;
  month: string;
  fetchedPosts: number;
  postsInMonth: number;
  pagesFetched: number;
  complete: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  totals: Totals;
  monthTotals: Totals;
  averages: Totals;
  topByLikes: AccountReportNote | null;
  topByEngagement: AccountReportNote | null;
  notes: AccountReportNote[];
}

export interface AccountReportResult {
  month: string;
  generatedAt: string;
  accounts: AccountReport[];
  errors: Array<{ input: string; userId?: string; error: string }>;
}

/** Account inputs from arguments and a newline-separated file ("#" lines ignored), deduplicated. */
export function collectAccountInputs(users: string[], file?: string): string[] {
  const fromFile = file
    ? readFileSync(file, "utf-8").split(/\r?\n/).filter((line) => !line.trim().startsWith("#"))
    : [];
  const inputs = [...users, ...fromFile].map((s) => s.trim()).filter(Boolean);
  return [...new Set(inputs)];
}

export function parseReportMonth(input?: string): ReportMonth {
  const now = new Date();
  const label = input ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(label);
  if (!match) throw new Error("Invalid --month. Use YYYY-MM, for example 2026-07.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  return { label, start: new Date(year, month - 1, 1), end: new Date(year, month, 1) };
}

export function buildAccountReport(
  input: string,
  userId: string,
  rawNotes: Array<Record<string, unknown>>,
  month: ReportMonth,
  paging: { pages: number; hasMore: boolean; cursor: string }
): AccountReport {
  const notes = rawNotes.map(normalizeNote);
  const monthNotes = notes.filter((n) => {
    if (!n.publishedAt) return false;
    const date = new Date(n.publishedAt);
    return date >= month.start && date < month.end;
  });
  const totals = sumNotes(notes);

  return {
    input,
    userId,
    month: month.label,
    fetchedPosts: notes.length,
    postsInMonth: monthNotes.length,
    pagesFetched: paging.pages,
    complete: !paging.hasMore,
    hasMore: paging.hasMore,
    nextCursor: paging.hasMore ? paging.cursor : null,
    totals,
    monthTotals: sumNotes(monthNotes),
    averages: averageOf(totals, notes.length),
    topByLikes: topBy(notes, "likes"),
    topByEngagement: topBy(notes, "totalEngagement"),
    notes,
  };
}

function normalizeNote(note: Record<string, unknown>): AccountReportNote {
  const info = (note.interact_info ?? {}) as Record<string, unknown>;
  const likes = metricNumber(info.liked_count ?? note.liked_count);
  const comments = metricNumber(info.comment_count ?? note.comment_count);
  const collects = metricNumber(info.collected_count ?? note.collected_count);
  const shares = metricNumber(info.share_count ?? note.share_count);
  const webUrl = typeof note.webUrl === "string" ? note.webUrl : typeof note.url === "string" ? note.url : undefined;
  const publishedAt = parsePublishedAt(note);

  return {
    noteId: String(note.note_id ?? note.noteId ?? ""),
    title: String(note.display_title ?? note.title ?? note.desc ?? "(no title)"),
    type: String(note.type ?? "unknown"),
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
    likes,
    comments,
    collects,
    shares,
    totalEngagement: likes + comments + collects + shares,
    ...(webUrl ? { webUrl } : {}),
  };
}

const TIME_KEYS = [
  "time", "create_time", "createTime", "timestamp",
  "publish_time", "publishTime", "last_update_time", "lastUpdateTime",
];

function parsePublishedAt(note: Record<string, unknown>): Date | null {
  for (const key of TIME_KEYS) {
    const value = note[key];
    const raw = typeof value === "string" ? value.trim() : value;
    if (raw === "" || raw == null) continue;

    if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n);
    } else if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) {
      return new Date(raw);
    }
  }
  return null;
}

/** "1,234", "3.1万", "2亿" or a number → integer. */
export function metricNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;

  const s = value.trim().replace(/,/g, "");
  const scale = s.endsWith("万") ? 1e4 : s.endsWith("亿") ? 1e8 : 1;
  const n = parseFloat(scale === 1 ? s : s.slice(0, -1));
  return Number.isNaN(n) ? 0 : Math.round(n * scale);
}

function sumNotes(notes: AccountReportNote[]): Totals {
  const totals: Totals = { likes: 0, comments: 0, collects: 0, shares: 0, totalEngagement: 0 };
  for (const n of notes) {
    for (const key of Object.keys(totals) as Array<keyof Totals>) totals[key] += n[key];
  }
  return totals;
}

function averageOf(totals: Totals, count: number): Totals {
  const avg = { ...totals };
  for (const key of Object.keys(avg) as Array<keyof Totals>) {
    avg[key] = count === 0 ? 0 : Math.round((totals[key] / count) * 100) / 100;
  }
  return avg;
}

function topBy(notes: AccountReportNote[], field: "likes" | "totalEngagement"): AccountReportNote | null {
  if (notes.length === 0) return null;
  return notes.reduce((best, n) => (n[field] > best[field] ? n : best));
}

export function formatAccountReport(result: AccountReportResult): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const lines = [kleur.bold(`Account report (${result.month})`)];

  for (const a of result.accounts) {
    const partial = a.complete ? "" : kleur.yellow(" partial");
    const top = a.topByLikes ? `${fmt(a.topByLikes.likes)} likes - ${a.topByLikes.title}` : "n/a";
    lines.push(
      `${kleur.bold(a.userId)}${partial}  posts:${a.fetchedPosts}  month:${a.postsInMonth}  ` +
      `likes:${fmt(a.totals.likes)}  avg:${fmt(a.averages.likes)}  top:${top}`
    );
  }

  if (result.errors.length > 0) {
    lines.push(kleur.red(`\n${result.errors.length} account(s) failed:`));
    for (const err of result.errors) lines.push(`  ${err.userId ?? err.input}: ${err.error}`);
  }
  return lines.join("\n");
}
