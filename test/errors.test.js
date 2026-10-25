import { test } from "node:test";
import assert from "node:assert/strict";
import { NeedVerifyError, NotLoggedInError, XhsApiError, errorInfo } from "../dist/lib/errors.js";

test("error codes and exit statuses", () => {
  const cases = [
    [new NeedVerifyError("124", "u"), "captcha", 4],
    [new XhsApiError("blocked", 300012), "ip_blocked", 4],
    [new XhsApiError("expired", -100), "not_logged_in", 3],
    [new NotLoggedInError("no a1"), "not_logged_in", 3],
    [new XhsApiError("search", -104), "no_permission", 3],
    [new XhsApiError("406", -1, null, 406), "signature_rejected", 1],
    [new XhsApiError("empty", "missing_xsec_token"), "missing_xsec_token", 1],
    [new XhsApiError("other", 500), "api_error", 1],
    [new Error("boom"), "error", 1],
  ];
  for (const [err, code, exit] of cases) {
    assert.deepEqual(errorInfo(err), { code, exit }, err.message);
  }
});
