import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountFile, cookieFilePath, listAccounts, loadCookieFile, saveCookieFile } from "../dist/lib/accounts.js";

const cookies = { a1: "a", web_session: "w", webId: "id" };

before(() => {
  process.env.REDBOOK_HOME = mkdtempSync(join(tmpdir(), "redbook-"));
  delete process.env.REDBOOK_COOKIE_FILE;
});

test("save and load an account", () => {
  const saved = saveCookieFile(accountFile("work"), cookies, "xhs", { id: "u1", nickname: "小明" });
  assert.equal(saved.account, "work");
  assert.equal(statSync(saved.path).mode & 0o777, 0o600);

  const loaded = loadCookieFile(saved.path);
  assert.equal(loaded.account, "work");
  assert.equal(loaded.platform, "xhs");
  assert.deepEqual(loaded.user, { id: "u1", nickname: "小明" });
  assert.deepEqual(loaded.cookies, cookies);
});

test("default account is cookies.json", () => {
  saveCookieFile(cookieFilePath(), cookies, "rednote");
  assert.equal(cookieFilePath(), join(process.env.REDBOOK_HOME, "cookies.json"));
  assert.deepEqual(listAccounts().map((a) => a.account), ["default", "work"]);
});

test("older cookie file formats still load", () => {
  const path = join(process.env.REDBOOK_HOME, "legacy.json");
  writeFileSync(path, JSON.stringify({ a1: "a", web_session: "w" }));
  assert.deepEqual(loadCookieFile(path).cookies, { a1: "a", web_session: "w" });
  writeFileSync(path, "a1=a; web_session=w");
  assert.deepEqual(loadCookieFile(path).cookies, { a1: "a", web_session: "w" });
});

test("account names can't escape the accounts dir", () => {
  assert.throws(() => accountFile("../x"), /Invalid account name/);
});

test("cookies without a login are rejected", () => {
  assert.throws(() => saveCookieFile(accountFile("x"), { a1: "a" }, "xhs"), /web_session/);
});
