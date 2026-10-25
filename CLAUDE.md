# CLAUDE.md — redbook CLI

## Publishing

**NEVER publish npm packages directly from local.** Always use the `npm-publish-cli` agent to bump version and publish via CI. The GitHub Actions workflow (`Publish to npm`) handles publishing on push to main. Publishing locally races CI and causes workflow failures.

**Dual publishing (automated):**
- **npm** — publishes when `package.json` version changes on push to main
- **ClawHub** — publishes when `SKILL.md` changes on push to main (uses `CLAWHUB_TOKEN` secret)

Both are conditional jobs in `.github/workflows/npm-publish.yml`. Manual trigger via `workflow_dispatch` is also available.

## Fork

This is Kagura-0001's fork of lucasygu/redbook, installed with `npm install -g github:Kagura-0001/redbook` (the `prepare` script builds `dist/` during a git install). When upstream fixes signing or adds endpoints, bring them in with `git fetch upstream && git merge upstream/main`, then push and reinstall. The package keeps the `@lucasygu/redbook` name so a git install replaces the npm one in place.

## Build & Test

- `npm run build` — TypeScript compile + chmod
- `npm test` — build, then `node --test` over `test/*.test.js` (runs against `dist/`, no network)
- Live check: `redbook whoami`; set `REDBOOK_HOME` to a temp dir to keep test accounts out of `~/.redbook`

## Project Structure

- `src/cli.ts` — CLI entry point. `getClient()` picks the cookies (which account), `run()` maps errors to codes and exit statuses, `write()` handles `--dry-run` and the audit log
- `src/lib/client.ts` — XHS API client; every request goes through `send()` (pacing, GET retries)
- `src/lib/accounts.ts` — saved accounts under `~/.redbook` (`$REDBOOK_HOME`), audit log
- `src/lib/pace.ts` — per-account request pacing and risk cooldown, shared across processes via `state/<account>.json`
- `src/lib/errors.ts` — error classes and `errorInfo()` (stable codes; exit 3 = login, 4 = risk control)
- `src/lib/report.ts` — `account-report` aggregation
- `src/lib/cookies.ts` — Cookie extraction with Chrome profile auto-discovery
- `src/lib/signing.ts` — Request signing
- `src/lib/analyze.ts` — Viral note analysis and question detection
- `src/lib/reply-strategy.ts` — Batch reply filtering, templating, rate-limited execution
- `src/lib/template.ts` — Viral content template extraction
- `src/lib/health.ts` — Note health check: level detection, sensitive words, tag count
- `src/lib/render.ts` — Card rendering (markdown → PNG via puppeteer-core, optional dep)
- `SKILL.md` — Skill documentation (serves both Claude Code and OpenClaw/ClawHub). Kept short; long material lives in `references/`
- `.github/workflows/npm-publish.yml` — CI: build, npm publish, ClawHub publish

## Render Command (Optional)

- `redbook render <file>` — markdown → styled PNG cards using user's existing Chrome
- Requires `puppeteer-core` and `marked` (optional peer deps, lazy imported)
- Uses Chrome at `/Applications/Google Chrome.app/...` or `CHROME_PATH` env var
- No cookies/XHS API needed — purely offline
- HTML/CSS templates embedded as TypeScript template literals (no external files)

## Cookie Architecture

- Uses `@steipete/sweet-cookie` to read browser cookies
- Auto-discovers Chrome profiles via `~/Library/Application Support/Google/Chrome/Local State`
- Keychain timeout patched to 30s in node_modules (upstream bug: hardcoded 3s)
- `--chrome-profile` flag available as escape hatch, but auto-discovery handles most cases
