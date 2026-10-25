/**
 * Filling the creator center's image-note form. Stops before "发布": the user
 * looks it over in the window and presses it. Selectors follow
 * xpzouying/xiaohongshu-mcp (xiaohongshu/publish.go).
 */

import { basename } from "node:path";
import type { ElementHandle, Page } from "puppeteer-core";
import type { Note } from "./note.js";

const EDITOR_SELECTORS = [
  'div[role="textbox"][contenteditable="true"]',
  'div.tiptap[contenteditable="true"]',
  "div.ql-editor",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function publishUrl(creatorHost: string): string {
  return `${creatorHost}/publish/publish?source=official&target=image`;
}

/**
 * Open the publish page and wait until it either shows the upload area or
 * bounces to the login page (it loads first and redirects after a 401).
 */
export async function openPublishPage(page: Page, url: string): Promise<"ok" | "login"> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const state = await page.waitForFunction(
    () => location.pathname.includes("login") ? "login" : document.querySelector("div.upload-content") ? "ok" : "",
    { timeout: 30_000, polling: 300 }
  );
  return (await state.jsonValue()) as "ok" | "login";
}

export async function fillImageNote(page: Page, note: Note, log: (msg: string) => void): Promise<void> {
  await clickTab(page, "上传图文");
  await uploadImages(page, note.images, log);
  await dismissGuides(page);

  // Focus rather than click: an image sits on top of the title input.
  const title = await page.waitForSelector("div.d-input input", { visible: true, timeout: 30_000 });
  await title!.focus();
  await page.keyboard.type(note.title, { delay: 60 });
  log("Title filled");

  const editor = await findEditor(page);
  await editor.focus();
  await page.keyboard.type(note.body, { delay: 25 });
  log("Body filled");

  if (note.topics.length > 0) {
    // Topics go on their own line after the body.
    for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    for (const topic of note.topics) await addTopic(page, topic, log);
  }
  await page.bringToFront();
}

// Feature guides ("图片可以编辑啦…") pop up over the form; close them.
async function dismissGuides(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("button, span, div")) {
      if (el.children.length === 0 && el.textContent?.trim() === "我知道了") el.click();
    }
  });
}

async function clickTab(page: Page, name: string): Promise<void> {
  await page.waitForSelector("div.upload-content", { visible: true, timeout: 30_000 });
  for (let i = 0; i < 30; i++) {
    // The page also renders off-screen copies of the tabs; only click one inside the viewport.
    const tab = (await page.evaluateHandle((text) => {
      return [...document.querySelectorAll<HTMLElement>("div.creator-tab")].find((el) => {
        const r = el.getBoundingClientRect();
        return el.textContent?.includes(text) && r.width > 0 && r.left >= 0 && r.top >= 0
          && r.right <= innerWidth && r.bottom <= innerHeight;
      }) ?? null;
    }, name)).asElement() as ElementHandle<HTMLElement> | null;
    if (tab) {
      await page.keyboard.press("Escape"); // dismiss guide popups that cover the tabs
      await tab.click();
      return;
    }
    await sleep(500);
  }
  throw new Error(`Can't find the "${name}" tab on the publish page`);
}

async function uploadImages(page: Page, images: string[], log: (msg: string) => void): Promise<void> {
  for (const [i, path] of images.entries()) {
    const input = i === 0
      ? await page.waitForSelector(".upload-input", { timeout: 30_000 })
      : (await page.evaluateHandle(() => {
          const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
          return inputs.find((el) => /image|\.png|\.jpe?g|\.webp/i.test(el.accept)) ?? inputs[0] ?? null;
        })).asElement();
    if (!input) throw new Error("Can't find the image upload input");

    await (input as ElementHandle<HTMLInputElement>).uploadFile(path);
    await page.waitForFunction(
      (n) => document.querySelectorAll(".img-preview-area .pr").length >= n,
      { timeout: 60_000 },
      i + 1
    );
    log(`Uploaded ${basename(path)}`);
    await sleep(1000);
  }
}

async function findEditor(page: Page): Promise<ElementHandle<Element>> {
  for (let i = 0; i < 30; i++) {
    for (const selector of EDITOR_SELECTORS) {
      const el = await page.$(selector);
      if (el && (await el.isVisible())) return el;
    }
    await sleep(300);
  }
  throw new Error("Can't find the body editor on the publish page");
}

async function addTopic(page: Page, topic: string, log: (msg: string) => void): Promise<void> {
  await page.keyboard.type("#", { delay: 60 });
  await sleep(200);
  await page.keyboard.type(topic, { delay: 60 });
  await sleep(1200);

  // Prefer the suggestion whose name matches exactly, else the first one.
  const item = (await page.evaluateHandle((name) => {
    const items = [...document.querySelectorAll<HTMLElement>("#creator-editor-topic-container .item")];
    return items.find((el) => el.textContent?.trim().replace(/^#/, "").startsWith(name)) ?? items[0] ?? null;
  }, topic)).asElement() as ElementHandle<HTMLElement> | null;

  if (item) {
    await item.click();
    log(`Topic #${topic}`);
  } else {
    await page.keyboard.type(" ");
    log(`No suggestion for #${topic}, left as text`);
  }
  await sleep(500);
}
