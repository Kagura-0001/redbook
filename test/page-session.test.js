import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_IDLE_MS, nextPageRequest } from "../dist/lib/page-session.js";
import { signMainApi } from "../dist/lib/signing.js";

before(() => {
  process.env.REDBOOK_HOME = mkdtempSync(join(tmpdir(), "redbook-"));
});

test("requests from one page share its load time and count up", () => {
  const t = Date.now();
  const first = nextPageRequest("a1-same", t);
  const second = nextPageRequest("a1-same", t + 20_000);
  assert.equal(second.seq, first.seq + 1);
  assert.equal(second.loadedAt, first.loadedAt);
  assert.equal(second.windowProps, first.windowProps);
  assert.equal(second.x36, first.x36);
  assert.ok(first.loadedAt < t);
});

test("a long pause starts a new page", () => {
  const t = Date.now();
  const before = nextPageRequest("a1-idle", t);
  const after = nextPageRequest("a1-idle", t + PAGE_IDLE_MS + 1000);
  assert.ok(after.loadedAt > before.lastAt);
});

test("each a1 has its own page", () => {
  const t = Date.now();
  nextPageRequest("a1-x", t);
  nextPageRequest("a1-x", t + 1000);
  const y = nextPageRequest("a1-y", t + 2000);
  assert.ok(y.seq <= 30);
});

test("signing advances the page", () => {
  const t = Date.now();
  const before = nextPageRequest("a1-sign", t);
  signMainApi("GET", "/api/sns/web/v1/search/notes", { a1: "a1-sign" }, { keyword: "x" });
  assert.equal(nextPageRequest("a1-sign").seq, before.seq + 2);
});
