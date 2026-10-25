import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAccountReport, metricNumber, parseReportMonth } from "../dist/lib/report.js";

test("metric numbers", () => {
  assert.equal(metricNumber("1,234"), 1234);
  assert.equal(metricNumber("3.1万"), 31000);
  assert.equal(metricNumber("2亿"), 200000000);
  assert.equal(metricNumber(""), 0);
  assert.equal(metricNumber(undefined), 0);
});

test("month totals only count notes published that month", () => {
  const notes = [
    { note_id: "1", time: Date.parse("2026-07-03"), interact_info: { liked_count: "10", comment_count: "2" } },
    { note_id: "2", time: Date.parse("2026-06-30"), interact_info: { liked_count: "1万" } },
  ];
  const report = buildAccountReport("u", "u", notes, parseReportMonth("2026-07"), { pages: 1, hasMore: false, cursor: "" });

  assert.equal(report.postsInMonth, 1);
  assert.equal(report.monthTotals.likes, 10);
  assert.equal(report.totals.likes, 10010);
  assert.equal(report.topByLikes.noteId, "2");
  assert.equal(report.averages.totalEngagement, 5006);
  assert.equal(report.complete, true);
});

test("bad month", () => {
  assert.throws(() => parseReportMonth("2026-13"), /YYYY-MM/);
});
