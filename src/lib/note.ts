/**
 * A note directory: post.md (frontmatter with title and topics, then the body)
 * and images/ (1.png, 2.png, …; the first is the cover). The body ends at the
 * first "## " heading, so notes like a "## 复盘" section never get posted.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Note {
  title: string;
  body: string;
  topics: string[];
  images: string[];
}

export function readNote(dir: string): Note {
  const raw = readFileSync(join(dir, "post.md"), "utf-8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const fm: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split("\n")) {
    const kv = /^(\w+)\s*:\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  if (!fm.title) throw new Error(`${join(dir, "post.md")} needs a title in its frontmatter`);

  const topics = (fm.topics ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);

  const imageDir = join(dir, "images");
  const images = existsSync(imageDir)
    ? readdirSync(imageDir)
        .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((f) => join(imageDir, f))
    : [];
  if (images.length === 0) throw new Error(`No images in ${imageDir}`);

  const body = raw.slice(match?.[0].length ?? 0).split(/^## /m)[0].trim();
  return { title: fm.title, body, topics, images };
}
