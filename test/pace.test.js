import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCooldown, cooldownStatus, pace, startCooldown } from "../dist/lib/pace.js";
import { RiskCooldownError, errorInfo } from "../dist/lib/errors.js";

before(() => {
  process.env.REDBOOK_HOME = mkdtempSync(join(tmpdir(), "redbook-"));
});

test("waits for the gap left by another process", async () => {
  mkdirSync(join(process.env.REDBOOK_HOME, "state"), { recursive: true });
  writeFileSync(join(process.env.REDBOOK_HOME, "state", "a.json"), JSON.stringify({ lastRequestAt: Date.now() }));
  const start = Date.now();
  await pace("a", 300);
  assert.ok(Date.now() - start >= 300);
});

test("concurrent requests queue up", async () => {
  const start = Date.now();
  await Promise.all([pace("b", 200), pace("b", 200), pace("b", 200)]);
  assert.ok(Date.now() - start >= 400);
});

test("cooldown blocks requests until cleared", async () => {
  startCooldown("c", "a captcha");
  assert.equal(cooldownStatus("c").reason, "a captcha");
  await assert.rejects(pace("c"), (err) => err instanceof RiskCooldownError && errorInfo(err).exit === 4);

  clearCooldown("c");
  assert.equal(cooldownStatus("c"), null);
  await pace("c", 0);
});
