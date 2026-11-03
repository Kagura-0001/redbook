import { test } from "node:test";
import assert from "node:assert/strict";
import { snakeKeys, searchUrl, SORTS, NOTE_TYPES, SINCES } from "../dist/lib/web.js";

test("snakeKeys turns page state into API-shaped keys, recursively", () => {
  const note = { noteId: "abc", interactInfo: { likedCount: "3" }, imageList: [{ urlDefault: "u" }], user: { xsecToken: "t" } };
  assert.deepEqual(snakeKeys(note), {
    note_id: "abc",
    interact_info: { liked_count: "3" },
    image_list: [{ url_default: "u" }],
    user: { xsec_token: "t" },
  });
});

test("searchUrl opens the results page the way the explore page does", () => {
  const url = new URL(searchUrl("https://www.xiaohongshu.com", "多模态 实习"));
  assert.equal(url.pathname, "/search_result");
  assert.equal(url.searchParams.get("keyword"), "多模态 实习");
  assert.equal(url.searchParams.get("source"), "web_explore_feed");
});

test("filter choices start with the page default", () => {
  assert.deepEqual(SORTS, ["general", "latest", "popular"]);
  assert.deepEqual(NOTE_TYPES, ["all", "video", "image"]);
  assert.deepEqual(SINCES, ["any", "day", "week", "halfyear"]);
});
