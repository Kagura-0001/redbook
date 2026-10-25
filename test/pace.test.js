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
  assert.equal(cooldownStatus("c").cooldown.reason, "a captcha");
  await assert.rejects(pace("c"), (err) => err instanceof RiskCooldownError && errorInfo(err).code === "risk_cooldown");

  clearCooldown("c");
  assert.deepEqual(cooldownStatus("c"), { cooldown: null, writeCooldown: null });
  await pace("c", 0);
});

test("a write cooldown only blocks writes", async () => {
  startCooldown("d", "a captcha", "write");
  await pace("d", 0, "read");
  await assert.rejects(pace("d", 0, "write"), (err) => errorInfo(err).code === "write_cooldown" && errorInfo(err).exit === 4);
});
