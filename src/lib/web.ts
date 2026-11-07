/**
 * Searching and reading through redbook's own Chrome window instead of signed
 * API calls. The page does what a person's browser does: it loads the search
 * or note page and signs and sends its own requests, with Chrome's headers,
 * fingerprint and TLS. We only read what it got back. Filters are picked the
 * way a person picks them: hover 筛选, click the option.
 *
 * The flow and selectors follow xpzouying/xiaohongshu-mcp (xiaohongshu/search.go,
 * search_ready.go, feed_detail.go).
 *
 * Everything happens in one reader tab that stays open, so later commands
 * reuse it the way one person keeps using one tab. The window itself stays
 * behind whatever you're working in.
 */

import type { Browser, ElementHandle, HTTPResponse, Page } from "puppeteer-core";
import { NeedVerifyError, NotLoggedInError, XhsApiError } from "./errors.js";

export type Sort = "general" | "latest" | "popular";
export type NoteType = "all" | "video" | "image";
export type Since = "any" | "day" | "week" | "halfyear";

export interface SearchOptions {
  sort: Sort;
  type: NoteType;
  since: Since;
  page: number;
}

// [panel group label, option per value]; the first value is what the page starts with.
const FILTERS = {
  sort: ["排序依据", { general: "综合", latest: "最新", popular: "最多点赞" }],
  type: ["笔记类型", { all: "不限", video: "视频", image: "图文" }],
  since: ["发布时间", { any: "不限", day: "一天内", week: "一周内", halfyear: "半年内" }],
} as const;

export const SORTS = Object.keys(FILTERS.sort[1]) as Sort[];
export const NOTE_TYPES = Object.keys(FILTERS.type[1]) as NoteType[];
export const SINCES = Object.keys(FILTERS.since[1]) as Since[];

type Rec = Record<string, unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/**
 * The reader tab: the xiaohongshu.com tab that is showing in redbook's window,
 * else a new tab. It has to be the window's current tab: a hidden tab that
 * searches is something no person does. Opening it doesn't bring the window
 * forward or take focus from the app you're in.
 */
export async function readerTab(browser: Browser, homeUrl: string): Promise<Page> {
  const host = new URL(homeUrl).hostname;
  for (const page of await browser.pages()) {
    let onSite = false;
    try {
      onSite = new URL(page.url()).hostname === host;
    } catch {
      // about:blank and the like
    }
    if (!onSite) continue;
    if (await page.evaluate(() => document.visibilityState === "visible").catch(() => false)) return page;
    await page.close();
  }
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  await cdp.detach();
  const target = await browser.waitForTarget((t) => (t as unknown as { _targetId: string })._targetId === targetId);
  const page = await target.page();
  if (!page) throw new Error("Couldn't open a tab in redbook's window");
  return page;
}

export function searchUrl(homeUrl: string, keyword: string): string {
  const q = new URLSearchParams({ keyword, source: "web_explore_feed" });
  return `${homeUrl}/search_result?${q}`;
}

interface Seen {
  n: number;
  page: number;
  body: Rec;
}

/**
 * Search the way a person does: open the results page, then pick filters in
 * the 筛选 panel, then scroll for more pages. Returns the API's own `data`
 * (`{ items, has_more }`) for the requested page.
 */
export async function searchInWindow(page: Page, homeUrl: string, keyword: string, opts: SearchOptions): Promise<Rec> {
  const seen: Seen[] = [];
  let captcha: NeedVerifyError | null = null;
  let n = 0;

  const onResponse = async (res: HTTPResponse) => {
    if (!/\/api\/sns\/web\/v\d\/search\/notes$/.test(new URL(res.url()).pathname)) return;
    if (res.request().method() !== "POST") return;
    let req: Rec;
    try {
      req = JSON.parse(res.request().postData() ?? "{}");
    } catch {
      return;
    }
    if (req.keyword !== keyword) return;
    const id = ++n;
    if (res.status() === 461 || res.status() === 471) {
      captcha = new NeedVerifyError(res.headers()["verifytype"] ?? "unknown", res.headers()["verifyuuid"] ?? "unknown");
      return;
    }
    try {
      seen.push({ n: id, page: Number(req.page ?? 1), body: (await res.json()) as Rec });
    } catch {
      // body gone (navigated away)
    }
  };

  const wait = async (pick: () => Seen | undefined, what: string): Promise<Seen> => {
    for (let t = 0; t < 150; t++) {
      if (captcha) throw captcha;
      blockedPage(page.url());
      if (t % 5 === 4) await loggedOut(page);
      const hit = pick();
      if (hit) return checked(hit);
      await sleep(200);
    }
    throw new XhsApiError(`Timed out waiting for ${what} in redbook's window`);
  };

  page.on("response", onResponse);
  try {
    await page.goto(searchUrl(homeUrl, keyword), { waitUntil: "domcontentloaded" });
    let last = await wait(() => seen.find((s) => s.page === 1), "search results");

    const wanted = (Object.keys(FILTERS) as Array<keyof typeof FILTERS>)
      .map((key) => {
        const [group, options] = FILTERS[key];
        const values = Object.values(options) as string[];
        const value = (options as Record<string, string>)[opts[key]];
        return value && value !== values[0] ? [group, value] as [string, string] : null;
      })
      .filter((f): f is [string, string] => f !== null);

    if (wanted.length > 0) {
      await sleep(between(1500, 4000));
      const after = n;
      await pickFilters(page, wanted);
      // Each click reloads the results; wait for the last one to land.
      await wait(() => seen.find((s) => s.n > after && s.page === 1), "filtered results");
      await sleep(1200);
      last = seen.filter((s) => s.page === 1).at(-1)!;
    }

    for (let p = 2; p <= opts.page; p++) {
      if ((last.body.data as Rec | undefined)?.has_more === false) break;
      const after = last.n;
      last = await scrollFor(page, () => seen.find((s) => s.n > after && s.page === p), wait, p);
    }
    return (last.body.data as Rec) ?? {};
  } finally {
    page.off("response", onResponse);
  }
}

function checked(hit: Seen): Seen {
  const body = hit.body;
  if (body.success) return hit;
  throw new XhsApiError(`Search failed in redbook's window: ${JSON.stringify(body).slice(0, 200)}`, body.code as number);
}

/**
 * The page put up its login dialog instead of loading, e.g. 电脑设备登录超限 when
 * Xiaohongshu counts redbook's window as one computer too many.
 */
async function loggedOut(page: Page): Promise<void> {
  const reason = await page.evaluate(() =>
    document.querySelector(".login-modal") ? document.querySelector(".login-reason")?.textContent?.trim() ?? "" : null
  ).catch(() => null);
  if (reason !== null) throw windowLoggedOut(reason);
}

function windowLoggedOut(reason: string): NotLoggedInError {
  return new NotLoggedInError(
    `redbook's window is logged out${reason ? ` (${reason})` : ""}. ` +
    "Scan the QR code in that window with the Xiaohongshu app, then run this again."
  );
}

/** The page bounced to a captcha or the anti-scrape gate. */
function blockedPage(url: string): void {
  const u = new URL(url);
  if (u.pathname.includes("captcha")) {
    throw new NeedVerifyError(u.searchParams.get("verifyType") ?? "page", u.searchParams.get("verifyUuid") ?? "unknown");
  }
}

async function scrollFor(
  page: Page,
  pick: () => Seen | undefined,
  wait: (pick: () => Seen | undefined, what: string) => Promise<Seen>,
  pageNo: number
): Promise<Seen> {
  await pointInto(page);
  for (let round = 0; round < 25 && !pick(); round++) {
    await page.mouse.wheel({ deltaY: between(350, 800) });
    await sleep(between(250, 900));
    if (round % 5 === 4) await sleep(between(800, 2000));
  }
  return wait(pick, `page ${pageNo}`);
}

/** Hover 筛选, move into the panel, click each option, then move away so it closes. */
async function pickFilters(page: Page, wanted: Array<[string, string]>): Promise<void> {
  const button = await page.waitForSelector("div.filter", { visible: true, timeout: 15_000 });
  await moveOnto(page, button!);
  const panel = await page.waitForSelector("div.filter-panel", { visible: true, timeout: 5_000 });
  await moveOnto(page, panel!, 0.15);

  for (const [group, option] of wanted) {
    const handle = await page.evaluateHandle((group: string, option: string) => {
      for (const g of document.querySelectorAll("div.filter-panel div.filters")) {
        if (g.querySelector(":scope > span")?.textContent?.trim() !== group) continue;
        for (const tag of g.querySelectorAll("div.tags")) {
          const r = tag.getBoundingClientRect();
          if (tag.textContent?.trim() === option && r.width > 0 && r.height > 0) return tag;
        }
      }
      return null;
    }, group, option);
    const el = handle.asElement() as ElementHandle<Element> | null;
    if (!el) throw new XhsApiError(`The 筛选 panel has no「${group}: ${option}」option`);
    await sleep(between(300, 900));
    await clickLikeAPerson(page, el);
  }

  await sleep(between(400, 1000));
  await pointInto(page);
}

async function moveOnto(page: Page, el: ElementHandle<Element>, yFrac?: number): Promise<void> {
  const box = await el.boundingBox();
  if (!box) throw new XhsApiError("Element isn't on screen in redbook's window");
  const x = box.x + box.width * between(0.3, 0.7);
  const y = box.y + box.height * (yFrac ?? between(0.35, 0.65));
  await page.mouse.move(x, y, { steps: Math.round(between(8, 20)) });
}

async function clickLikeAPerson(page: Page, el: ElementHandle<Element>): Promise<void> {
  await moveOnto(page, el);
  await sleep(between(80, 250));
  await page.mouse.down();
  await sleep(between(40, 120));
  await page.mouse.up();
}

/** Put the pointer over the results, where a person scrolls. */
async function pointInto(page: Page): Promise<void> {
  const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  await page.mouse.move(w * between(0.35, 0.65), h * between(0.45, 0.75), { steps: Math.round(between(6, 14)) });
}

/**
 * Open a note page and take the note the page was served with
 * (`__INITIAL_STATE__.note.noteDetailMap`), keys in the API's snake_case.
 */
export async function readInWindow(page: Page, url: string, noteId: string): Promise<Rec> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const found = await page.waitForFunction((id: string) => {
    if (location.pathname.includes("captcha")) return JSON.stringify({ captcha: location.href });
    if (location.pathname.startsWith("/404")) return JSON.stringify({ gone: location.href });
    if (document.querySelector(".login-modal")) return JSON.stringify({ login: document.querySelector(".login-reason")?.textContent?.trim() ?? "" });
    const map = (window as unknown as { __INITIAL_STATE__?: any }).__INITIAL_STATE__?.note?.noteDetailMap;
    const note = map?.[id]?.note;
    if (note?.noteId) return JSON.stringify({ note });
    const wrap = document.querySelector(".access-wrapper, .error-wrapper, .not-found-wrapper, .blocked-wrapper");
    if (wrap?.textContent?.trim()) return JSON.stringify({ unavailable: wrap.textContent.trim() });
    return "";
  }, { timeout: 30_000, polling: 300 }, noteId);

  const result = JSON.parse((await found.jsonValue()) as string) as Rec;
  if (result.captcha) blockedPage(String(result.captcha));
  if (result.login !== undefined) throw windowLoggedOut(String(result.login));
  if (result.gone) {
    throw new XhsApiError(
      "The note page bounced to the anti-scrape gate, which usually means a missing or expired xsec_token. Use a fresh webUrl from search.",
      "missing_xsec_token"
    );
  }
  if (result.unavailable) throw new XhsApiError(`Note unavailable: ${result.unavailable}`, "note_unavailable");
  return snakeKeys(result.note) as Rec;
}

/** imageList → image_list, recursively, so window results look like API results. */
export function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Rec).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(v)])
  );
}
