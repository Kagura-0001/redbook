export class XhsApiError extends Error {
  constructor(
    message: string,
    public code?: number | string,
    public response?: unknown,
    public status?: number
  ) {
    super(message);
    this.name = "XhsApiError";
  }
}

export class NeedVerifyError extends XhsApiError {
  constructor(
    public verifyType: string,
    public verifyUuid: string
  ) {
    super(`Captcha required: type=${verifyType}, uuid=${verifyUuid}`);
    this.name = "NeedVerifyError";
  }
}

export class NotLoggedInError extends Error {
  name = "NotLoggedInError";
}

export class RiskCooldownError extends Error {
  constructor(public until: number, public reason: string, account: string) {
    const left = Math.ceil((until - Date.now()) / 60_000);
    const flag = account === "default" ? "" : ` --account ${account}`;
    super(
      `Account "${account}" is cooling down after ${reason} (${left} min left). ` +
      `Clear the captcha in the browser, then wait or run: redbook cooldown --clear${flag}`
    );
    this.name = "RiskCooldownError";
  }
}

/**
 * Stable error code and exit status, so an agent can tell "log in again"
 * (exit 3) from "stop, risk control" (exit 4) without parsing messages.
 */
export function errorInfo(err: unknown): { code: string; exit: number } {
  if (err instanceof NeedVerifyError) return { code: "captcha", exit: 4 };
  if (err instanceof RiskCooldownError) return { code: "risk_cooldown", exit: 4 };
  if (err instanceof NotLoggedInError) return { code: "not_logged_in", exit: 3 };
  if (err instanceof XhsApiError) {
    if (err.code === 300012) return { code: "ip_blocked", exit: 4 };
    if (err.code === -100 || err.code === -101) return { code: "not_logged_in", exit: 3 };
    if (err.code === -104) return { code: "no_permission", exit: 3 };
    if (err.code === 300015 || err.status === 406) return { code: "signature_rejected", exit: 1 };
    if (typeof err.code === "string") return { code: err.code, exit: 1 };
    return { code: "api_error", exit: 1 };
  }
  return { code: "error", exit: 1 };
}
