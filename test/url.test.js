import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBoardUrl, parseNoteUrl, parseUserProfileArg } from "../dist/lib/url.js";

test("note urls", () => {
  assert.deepEqual(
    parseNoteUrl("https://www.xiaohongshu.com/explore/abc123?xsec_token=T&xsec_source=pc_search"),
    { noteId: "abc123", xsecToken: "T" }
  );
  assert.deepEqual(parseNoteUrl("https://www.rednote.com/explore/abc123?xsec_token=T"), { noteId: "abc123", xsecToken: "T" });
  assert.deepEqual(parseNoteUrl("https://www.xiaohongshu.com/discovery/item/abc123"), { noteId: "abc123", xsecToken: null });
  assert.deepEqual(parseNoteUrl("abc123"), { noteId: "abc123", xsecToken: null });
});

test("profile urls", () => {
  const user = parseUserProfileArg("https://www.xiaohongshu.com/user/profile/5fc3bb8a000000000100037e?xsec_token=T");
  assert.deepEqual(user, { userId: "5fc3bb8a000000000100037e", xsecToken: "T", xsecSource: "pc_search" });
  assert.equal(parseUserProfileArg("5fc3bb8a000000000100037e", { xsecToken: "T", xsecSource: "pc_note" }).xsecSource, "pc_note");
  assert.throws(() => parseUserProfileArg("1084843434"), /小红书号/);
});

test("board urls", () => {
  assert.equal(parseBoardUrl("https://www.xiaohongshu.com/board/b1?source=x"), "b1");
  assert.equal(parseBoardUrl("b1"), "b1");
});
