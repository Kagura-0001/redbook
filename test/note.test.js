import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNote } from "../dist/lib/note.js";

test("reads a note directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "note-"));
  mkdirSync(join(dir, "images"));
  for (const f of ["10.png", "2.png", "1.png", "notes.txt"]) writeFileSync(join(dir, "images", f), "");
  writeFileSync(join(dir, "post.md"), [
    "---",
    "title: 测流式视频bench测到想哭🥲",
    "topics: [流式视频理解, #科研日常]",
    "status: ready",
    "---",
    "",
    "第一行",
    "第二行",
    "",
    "## 复盘",
    "不该发出去",
  ].join("\n"));

  const note = readNote(dir);
  assert.equal(note.title, "测流式视频bench测到想哭🥲");
  assert.deepEqual(note.topics, ["流式视频理解", "科研日常"]);
  assert.deepEqual(note.images.map((p) => p.split("/").pop()), ["1.png", "2.png", "10.png"]);
  assert.equal(note.body, "第一行\n第二行");
});

test("a note needs a title and images", () => {
  const dir = mkdtempSync(join(tmpdir(), "note-"));
  writeFileSync(join(dir, "post.md"), "---\ntopics: []\n---\nbody");
  assert.throws(() => readNote(dir), /title/);
  writeFileSync(join(dir, "post.md"), "---\ntitle: t\n---\nbody");
  assert.throws(() => readNote(dir), /No images/);
});
