# Command Details

### `redbook search <keyword>`

Search for notes by keyword. Returns note titles, URLs, likes, author info.

```bash
redbook search "Claude Code教程" --json
redbook search "AI编程" --sort popular --json        # Sort: general, popular, latest
redbook search "Cursor" --type image --json           # Type: all, video, image
redbook search "MCP Server" --page 2 --json           # Pagination
```

**Options:**
- `--sort <type>`: `general` (default), `popular`, `latest`
- `--type <type>`: `all` (default), `video`, `image`
- `--page <n>`: Page number (default: 1)

### `redbook read <url>`

Read a note's full content — title, body text, images, likes, comments count.

```bash
redbook read "https://www.xiaohongshu.com/explore/abc123" --json
```

Accepts full URLs or short note IDs. Falls back to HTML scraping if API returns captcha.

### `redbook comments <url>`

Get comments on a note. Use `--all` to fetch all pages.

```bash
redbook comments "https://www.xiaohongshu.com/explore/abc123" --json
redbook comments "https://www.xiaohongshu.com/explore/abc123" --all --json
```

### `redbook user <userId|profileUrl>`

Get a creator's profile — nickname, bio, follower count, note count, likes received.

```bash
redbook user "https://www.xiaohongshu.com/user/profile/5a1234567890abcdef012345?xsec_token=...&xsec_source=pc_search" --json
```

Accepts a bare userId or a full profile URL. If a bare userId returns `code=-1`, use a fresh profile URL containing `xsec_token`, or pass `--xsec-token <token> --xsec-source pc_search`.

### `redbook user-posts <userId|profileUrl>`

List all notes posted by a creator. Returns titles, URLs, likes, timestamps.

```bash
redbook user-posts "https://www.xiaohongshu.com/user/profile/5a1234567890abcdef012345?xsec_token=...&xsec_source=pc_search" --json
```

### `redbook account-report <userId|profileUrl...>`

Batch summarize account posting and engagement metrics.

```bash
redbook account-report --file accounts.txt --month 2026-07 --json
redbook account-report "<profileUrl1>" "<profileUrl2>" --max-pages 2 --json
```

Options:
- `--file <path>`: newline-separated account IDs/profile URLs
- `--month <YYYY-MM>`: month used for `postsInMonth` (default: current month)
- `--max-pages <n>`: page cap per account when not using `--all` (default: 1)
- `--all`: fetch every page for each account
- `--delay <ms>`: delay between page/account requests (default: 3000)

For KOS/KOC reporting, feed it known account IDs or profile URLs instead of using keyword search. If a bare userId returns `code=-1`, use a fresh profile URL containing `xsec_token`.

### `redbook feed`

Browse the recommendation feed.

```bash
redbook feed --json
```

### `redbook topics <keyword>`

Search for topic hashtags. Useful for finding trending topics to attach to posts.

```bash
redbook topics "Claude Code" --json
```

### `redbook favorites [userId]`

List a user's collected (bookmarked) notes. Defaults to the current logged-in user when no userId is provided.

```bash
redbook favorites --json                        # Your own favorites
redbook favorites "5a1234567890abcdef" --json   # Another user's favorites
redbook favorites --all --json                  # Fetch all pages
```

**Options:**
- `--all`: Fetch all pages of favorites (default: first page only)

**Note:** Other users' favorites are only visible if they haven't set their collection to private.

### `redbook collect <url>`

Collect (bookmark) a note to your favorites.

```bash
redbook collect "https://www.xiaohongshu.com/explore/abc123"
```

### `redbook uncollect <url>`

Remove a note from your collection.

```bash
redbook uncollect "https://www.xiaohongshu.com/explore/abc123"
```

### `redbook analyze-viral <url>`

Analyze why a viral note works. Returns a deterministic viral score (0–100).

```bash
redbook analyze-viral "https://www.xiaohongshu.com/explore/abc123" --json
redbook analyze-viral "https://www.xiaohongshu.com/explore/abc123" --comment-pages 5
```

**Options:**
- `--comment-pages <n>`: Comment pages to fetch (default: 3, max: 10)

**JSON output structure:**
Returns `{ note, score, hook, content, visual, engagement, comments, relative, fetchedAt }`.

- `score.overall` (0–100) — composite of hook (20) + engagement (20) + relative (20) + content (20) + comments (20)
- `hook.hookPatterns[]` — detected title patterns (Identity Hook, Emotion Word, Number Hook, Question, etc.)
- `engagement` — likes, comments, collects, shares + ratios (collectToLikeRatio, commentToLikeRatio, shareToLikeRatio)
- `relative.viralMultiplier` — this note's likes / author's median likes
- `relative.isOutlier` — true if viralMultiplier > 3
- `comments.themes[]` — top recurring keyword phrases from comments

### `redbook viral-template <url> [url2] [url3]`

Extract a reusable content template from 1-3 viral notes. Analyzes each note (same pipeline as `analyze-viral`) and synthesizes common structural patterns.

```bash
redbook viral-template "<url1>" "<url2>" "<url3>" --json
redbook viral-template "<url1>" --comment-pages 5 --json
```

**Options:**
- `--comment-pages <n>`: Comment pages to fetch per note (default: 3, max: 10)

**JSON output structure:**
Returns `{ dominantHookPatterns, titleStructure, bodyStructure, engagementProfile, audienceSignals, sourceNotes, generatedAt }`.

- `dominantHookPatterns[]` — hook types appearing in majority of input notes
- `titleStructure.avgLength` — average title length across notes
- `bodyStructure.lengthRange` — [min, max] body length
- `engagementProfile.type` — "reference" / "insight" / "entertainment"
- `audienceSignals.commonThemes[]` — merged comment themes across notes

### `redbook comment <url>`

Post a top-level comment on a note.

```bash
redbook comment "<noteUrl>" --content "Great post!" --json
```

**Options:**
- `--content <text>` (required): Comment text

### `redbook reply <url>`

Reply to a specific comment on a note.

```bash
redbook reply "<noteUrl>" --comment-id "<commentId>" --content "Thanks for asking!" --json
```

**Options:**
- `--comment-id <id>` (required): Comment ID to reply to (from `comments --json` output)
- `--content <text>` (required): Reply text

### `redbook batch-reply <url>`

Reply to multiple comments using a filtering strategy. Always preview with `--dry-run` first.

```bash
# Preview which comments match the strategy
redbook batch-reply "<noteUrl>" --strategy questions --dry-run --json

# Execute replies with a template (default 5 min delay with jitter)
redbook batch-reply "<noteUrl>" --strategy questions \
  --template "感谢提问！{content}" --max 10
```

**Options:**
- `--strategy <name>`: `questions` (default), `top-engaged`, `all-unanswered`
- `--template <text>`: Reply template with `{author}`, `{content}` placeholders
- `--max <n>`: Max replies (default: 10, hard cap: 30)
- `--delay <ms>`: Delay between replies in ms (default: 300000 / 5 min, min: 180000 / 3 min). ±30% random jitter applied automatically.
- `--dry-run`: Preview candidates without posting (default when no template)

**Safety:** Stops immediately on captcha. No template = dry-run only. Delays include random jitter to avoid uniform timing patterns that trigger XHS bot detection.

### `redbook render <file>`

Render a markdown file with YAML frontmatter into styled PNG image cards. Uses the user's existing Chrome installation — no browser download needed.

```bash
redbook render content.md --style xiaohongshu
redbook render content.md --style dark --output-dir ./cards
redbook render content.md --pagination separator --json
```

**Options:**
- `--style <name>`: `purple`, `xiaohongshu` (default), `mint`, `sunset`, `ocean`, `elegant`, `dark`
- `--pagination <mode>`: `auto` (default), `separator` (split on `---`)
- `--output-dir <dir>`: Output directory (default: same as input file)
- `--width <n>`: Card width in px (default: 1080)
- `--height <n>`: Card height in px (default: 1440)
- `--dpr <n>`: Device pixel ratio (default: 2)

**Requires:** `puppeteer-core` and `marked` (`npm install -g puppeteer-core marked`). Does NOT require XHS cookies — purely offline rendering.

**Override Chrome path:** Set `CHROME_PATH` environment variable if Chrome is not in the standard location.

### `redbook whoami`

Check connection status. Verifies cookies are valid and shows the logged-in user.

```bash
redbook whoami
```

### `redbook auth`

Manage saved accounts. Each account is a cookie file: `~/.redbook/cookies.json` for the default account, `~/.redbook/accounts/<name>.json` for named ones. Useful for running several XHS accounts, and for OpenClaw, cloud or CI runs where browser cookies are unavailable.

```bash
# Save the browser's current login (default account, or a named one)
redbook auth export
redbook auth export --account brand --chrome-profile "Profile 2"

# Or save a cookie string copied from Chrome DevTools
redbook auth save --account brand --cookie-string "a1=VALUE; web_session=VALUE"

# See what is saved, without printing cookie values
redbook auth list
redbook auth inspect --account brand --json
redbook auth path --account brand

# Remove one
redbook auth clear --account brand
```

`export` and `save` check the cookies with one `/user/me` call and store the account's nickname and user ID. Without `--account`, normal commands resolve cookies in this order: `--cookie-string`, `REDBOOK_COOKIE_STRING`, `REDBOOK_COOKIE_FILE`, `~/.redbook/cookies.json`, then browser extraction. With `--account <name>` (or `REDBOOK_ACCOUNT`) only that account's file is used. Saved cookie files are plaintext login credentials written with `0600` permissions; never commit them or include them in logs.

### `redbook cooldown`

Show or clear an account's risk-control cooldown. A captcha or IP block puts the account into a 30-minute cooldown during which every command for it fails with `risk_cooldown` (exit 4) without sending requests.

```bash
redbook cooldown --account brand
redbook cooldown --account brand --clear   # only after the captcha is solved in the browser
```

### `redbook post` (Limited)

Publish an image note. **Frequently triggers captcha (type=124) on the creator API.** Image upload works, but the publish step is unreliable. For posting, consider using browser automation instead.

```bash
redbook post --title "标题" --body "正文" --images cover.png --json
redbook post --title "测试" --body "..." --images img.png --private --json
```

**Options:**
- `--title <title>`: Note title (required)
- `--body <body>`: Note body text (required)
- `--images <paths...>`: Image file paths (required, at least one)
- `--topic <keyword>`: Search and attach a topic hashtag
- `--private`: Publish as private note
- `--dry-run`: Show the post without uploading or publishing anything

### Global Options

All commands that talk to XHS accept:
- `--account <name>`: act as a saved account (see `redbook auth`). Never falls back to browser cookies.
- `--cookie-source <browser>`: `chrome` (default), `safari`, `firefox`
- `--chrome-profile <name>`: Chrome profile directory name (e.g., "Profile 1"). Auto-discovered if omitted.
- `--cookie-string <cookies>`: manual cookie string, e.g. `"a1=VALUE; web_session=VALUE"`
- `--platform <name>`: force `xhs` (mainland) or `rednote` (global). **Default: auto-detect** which one you're logged into — see [Mainland vs Global](#mainland-xiaohongshu-vs-global-rednote).
- `--global`: force the global RedNote backend (= `--platform rednote`)
- `--json`: Output as JSON. On failure prints `{"error": {"code", "message"}}`; see [Exit Codes](../SKILL.md#exit-codes).

Write commands (`post`, `comment`, `reply`, `like`, `collect`, `uncollect`, `delete`) also accept `--dry-run`. `delete` requires `--yes`.

---

## Mainland Xiaohongshu vs Global RedNote

XHS runs **two separate backends that do NOT share sessions or cookies**:

| | Mainland | Global |
|---|---|---|
| App / site | 小红书 / `xiaohongshu.com` | RedNote / `rednote.com` |
| API host | `edith.xiaohongshu.com` | `webapi.rednote.com` |
| Cookie domain | `.xiaohongshu.com` | `.rednote.com` |

RedNote routes you to mainland vs global **by IP/region**, and you can only be signed into one at a time on a machine — so **the CLI auto-detects which one you're logged into**. You normally pass **no flag at all**:

```bash
redbook whoami            # auto-detects mainland vs global, then shows your account
redbook search "AI"       # runs against whichever backend you're logged into
```

**How detection works:** it probes both cookie domains; if only one has a session it uses that, and if both have cookies (the unused domain often keeps a stale guest cookie) it verifies which is actually logged in via one lightweight `/user/me` call. The result is cached in `~/.redbook/platform-cache.json` (keyed by a cookie fingerprint), so it doesn't re-hit the API every command and self-invalidates when you log in/out. You'll see a dim `Platform: … [auto-detected|cached]` line on stderr.

**Override** only if you need to force one (rare):

```bash
redbook whoami --global            # force global RedNote (= --platform rednote)
redbook whoami --platform xhs      # force mainland
# or: export REDBOOK_PLATFORM=rednote
```

The web signing (x-s/x-t) algorithm is **identical** across both — only the host + cookie domain differ.

**Known gaps on the global backend:**
- `user-posts` / `user` may need a fresh profile `xsec_token`; pass a full profile URL or `--xsec-token` if a bare userId returns `code -1`.
- `health` (note throttle levels) needs creator-dashboard cookies; log into the RedNote creator dashboard first.

---

## Chinese Number Formats in API Responses

The XHS API returns abbreviated numbers with Chinese unit suffixes:

| API value | Actual number |
|-----------|---------------|
| `"1.5万"` | 15,000 |
| `"2.4万"` | 24,000 |
| `"1.2亿"` | 120,000,000 |
| `"115"` | 115 |

`万` = ×10,000. `亿` = ×100,000,000. Numbers under 10,000 are plain integers as strings.

The `analyze-viral` command handles this automatically. When parsing `--json` output manually, watch for these suffixes in `interact_info` fields (`liked_count`, `collected_count`, etc.).
