# Research Loop — Rate-Limit-Safe Long-Running Research

The [Rate Limits & Safety](../SKILL.md#rate-limits--safety) section of SKILL.md paces *writes*. This section paces **reads** — the part research actually hammers. `read`, `comments`, and `analyze-viral` each hit the note-detail API (with `xsec_token`); fire 30–50 in a tight loop and XHS returns `NeedVerify` / captcha or IP-blocks you (300012), and a tripped account stays degraded for **hours**. So research here is **paced, not parallel**: one note in flight, spaced to look like a human reading rather than a script scraping.

The mechanism is a **file-based loop**: a queue of work items on disk, one item processed per "tick", every result checkpointed immediately. Because all state lives in files, the loop is **resumable and survives the session ending** — a fresh session (or a Push heartbeat) picks up exactly where the last left off. Pairs with the `/checkpoint-research` skill for the synthesis step.

### Pace — the safe band (why these numbers)

These are calibrated to XHS's documented read-side safe band, not guesswork. Community crawlers ([MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)) default to **~2 s/request, single-threaded** (`CRAWLER_MAX_SLEEP_SEC = 2`, `MAX_CONCURRENCY_NUM = 1`); reverse-engineering write-ups put the "looks-human" frequency at **3–8 s/request** and the per-IP ceiling at **≤5 requests/min** (~12 s average). This skill runs on your **real logged-in cookies + residential IP + real Chrome fingerprint** — the *lowest*-detection profile (the thing scrapers spend most of their effort faking). So the binding risk isn't request signature, it's **behavioral**: a human doesn't open 100 note-detail pages in two minutes. We therefore pace to a human reading cadence — comfortably inside the safe band — rather than to the absolute minimum. (5-minute gaps, an earlier guess, are ~25× slower than the ceiling and buy nothing.)

### The real rule: behave like a human reading (not "go slow")

Detection here is **distributional, not a rate threshold.** XHS doesn't ask "more than N requests?" — it models what a human session looks like and flags the *unlikely* ones. Pure speed isn't the tell; the **shape** of the behavior is. Three things give a script away:

- **Timing micro-structure.** A human's gaps between actions are high-variance and heavy-tailed (2 s, then 40 s, then 5 min — they read, scroll, get distracted). A script emits a tight, low-variance stream. *Three distinct searches in five seconds has near-zero variance and is faster than a person can read a result page* — that single fact is a stronger signal than the total count.
- **Session macro-structure.** Humans browse depth-first: search → open a note → dwell → open a related note → wander. A scrape is breadth-first enumeration: search A, search B, search C… never clicking in, never dwelling. A keyword list run top-to-bottom *is* the signature.
- **Action composition.** Real sessions mix likes, collects, dwell, scroll, video-watch. A research run is 100% read with zero dwell and zero engagement — an impossible ratio for a person.

So the rule is **not "go slow."** It's **make the session indistinguishable from a person reading**: human-shaped *variance* (jitter + the occasional long pause, not merely a bigger constant), one note at a time *with dwell*, depth over breadth, a ceiling because people don't open hundreds of things, and **stop at the first sign of friction** (a human who hits a captcha backs off; a bot retries — so the circuit breaker is itself human-like behavior).

**Safety-first is the *more* agentic posture, not the timid one.** An agent's real advantage isn't speed — it's *patience at scale*: it can run a human-shaped loop for eight hours, which no person will. Aggression imitates the one human trait that gets you caught (impatience) and wastes the one the agent uniquely has (tireless patience). Lean into the patience.

**This is a pattern, not a blacklist.** The numbers here were calibrated from a real incident — a beverage-trend sweep that fired *3 distinct searches in ~5 seconds* across ~17 unrelated keywords and drew an account-level warning. What's encoded is the *behavioral invariant* (human-shaped timing, one-in-flight, ceiling, dwell, breaker), **not** "don't run those queries." It generalizes to any topic and any platform. The incident is the calibration sample that tells us where the human/bot line sits — not a rule about matcha.

### Three modes

| Mode | Pace per note | ~Reads/min | Use when | Gate |
|------|--------------|-----------|----------|------|
| 🚶 **Steady (default)** | **20 s ± 50% jitter** (≈10–35 s) | ~2–3 | All routine / multi-note research | **None — this is the default.** |
| 🐢 **Deep / overnight** | 60–120 s | ~0.5–1 | Very large corpora, or minimizing footprint | Opt in for big jobs |
| ⚡ **Fast (emergency)** | **5 s ± jitter floor**, max 30-note burst then cooldown | ~10+ (over the safe ceiling) | A genuine deadline that cannot wait | MUST print the [fast-mode warning](#-fast-mode-warning-emergency-only) verbatim **and** get explicit user opt-in |

**Invariants (all modes):** never zero-delay, never parallel, exactly one note in flight, and — except for warned Fast mode — **never exceed ~5 reads/min sustained.** At the Steady pace a 100-note queue finishes in ~35–50 min; only very large queues or Deep mode stretch toward end-of-day.

### Strict rules (non-negotiable)

1. **The loop is mandatory; Steady is the default pace.** Any research touching more than ~5 notes runs through the loop at Steady pace. Deep/overnight and especially Fast are explicit opt-ins — Fast additionally requires the printed warning + user confirmation.
2. **One note in flight.** Never batch or parallelize reads. No `for url in …; do redbook read …; done` without the inter-item delay. No background `&` fan-out. (`MAX_CONCURRENCY = 1`, like the reference crawlers.)
3. **Stay under ~5 reads/min, always jittered.** The per-IP safe ceiling is ~5 requests/min (~12 s/note); Steady (20 s) sits comfortably under it. Apply ±50% random jitter to every wait — uniform intervals are a bot signature. Only warned Fast mode may cross the ceiling.
4. **Cap comment pagination.** Comment / sub-comment reads are the highest-risk endpoint — they trip 风控 first (deep comment crawls fail even at very long sleeps). Keep `--comment-pages ≤ 3`, count each comment page against the pace + budget like any other read, and never deep-crawl a comment thread.
5. **Checkpoint every item.** Write each result to disk and update the manifest *before* the next tick. Nothing in memory only.
6. **Respect the daily budget.** Default soft cap **~200 detail-reads/day** — anomalous *volume* is its own 风控 trigger, independent of pace. When `consumedToday >= dailyBudget`, stop until the next calendar day — do not "just finish a few more".
7. **Circuit breaker is absolute.** On the first 风控 signal (see [Circuit breaker](#circuit-breaker)), STOP the entire loop, persist state, surface to the user, and **do not auto-retry through it.** Resume only on an explicit human "resume".
8. **Reads, not writes.** This loop is for reading/analysis only. Engagement actions (comment/reply/like) keep their own [write-side limits](../SKILL.md#rate-limits--safety) and are never folded into a research tick.

### State contract (resumable, survives session death)

All state lives under one job directory — default `research/xhs/<job-slug>/` in the **private content repo** (ask if unclear which repo):

| File | Role |
|------|------|
| `queue.jsonl` | The work queue, one item per line: `{ "id": "001", "kind": "read\|comments\|analyze-viral\|search\|user\|user-posts", "arg": "<url-or-keyword-or-userId>", "status": "pending\|done\|error", "note": "" }` |
| `results/<id>.json` | Raw `--json` output for each processed item (the corpus) |
| `loop-state.json` | `{ "mode": "steady\|deep\|fast", "intervalSec": 20, "jitterPct": 50, "dailyBudget": 200, "consumedToday": 0, "budgetDate": "YYYY-MM-DD", "lastTickAt": "<iso>", "breaker": "ok\|tripped", "breakerReason": null }` (Deep: `intervalSec` 60–120; Fast: `intervalSec` 5 + `mode:"fast"`) |
| `manifest.md` | Human-readable plan + progress (checkmark per done item) — the recovery checkpoint, updated every tick |
| `SUMMARY.md` | Final synthesis, written once the queue drains |

**Seeding the queue:** the cheap list endpoints (`search`, `feed`, and `user-posts` with a fresh profile URL/token) are how you *build* the queue, not part of the paced loop. Run a `search`/`feed` up front, extract each note `webUrl`, and write one `read`/`analyze-viral` item per note into `queue.jsonl`. Then the loop drains the expensive detail-reads at the Steady pace. Always carry the fresh `webUrl` (with token) as the item `arg` — tokens expire, so don't queue bare noteIds (see [xsec_token](../SKILL.md#xsec_token--required-for-reading--sharing-notes)). For creator queues, prefer a profile URL containing `xsec_token`; bare userIds may return `code=-1`.

### One tick = one note

A tick is the unit both drivers call. It processes exactly one item and stops:

1. **Load `loop-state.json`.** If `breaker != "ok"` → exit immediately (surface the reason; do not process).
2. **Roll the daily budget.** If `budgetDate` != today, reset `consumedToday = 0`, `budgetDate = today`. If `consumedToday >= dailyBudget` → exit until tomorrow.
3. **Pop the next `pending` item** from `queue.jsonl`. If none remain → **finalize**: synthesize `SUMMARY.md` from `results/`, mark the loop complete, and tell the driver to stop. Done.
4. **Run exactly one read:** `redbook <kind> "<arg>" --json`.
5. **Inspect the result for a 风控 signal** (empty `{}`, `NeedVerify`/captcha, `Session expired`, IP block 300012). If found → **trip the breaker**: set `breaker:"tripped"` + `breakerReason`, leave the item `pending` (not consumed), persist, surface to the user, STOP. (See [Circuit breaker](#circuit-breaker).)
6. **On success:** write `results/<id>.json`, set the item `status:"done"`, check it off in `manifest.md`, `consumedToday += 1`, set `lastTickAt`.
7. **Stop.** One note only — the driver re-invokes after the (jittered) interval.

### Drivers — keeping the loop running in the background

The same tick, driven two ways. Pick by how long the job must outlive the current session:

**A) In-session pacing (default — Steady).** The simplest driver and the right one for most jobs: run ticks back-to-back inside one session, sleeping `intervalSec` ± jitter between each read. At Steady pace a 100-note queue finishes in ~35–50 min — comfortably within one session — and every item is checkpointed, so a crash just resumes. No scheduler needed. (Pace *per read*; don't fake it with one long blocking `sleep`.)

**B) `/loop` self-paced (Deep / overnight / survives idle gaps).** For Deep mode or jobs spanning hours, drive ticks with `/loop` *without* an interval (self-paced): do one tick, then `ScheduleWakeup` for `intervalSec` + jitter, and re-fire. `ScheduleWakeup` clamps to **≥60 s**, so it fits Deep (60–120 s) — not sub-minute Steady (run that in-session, per A). The loop ends itself when the queue drains (Step 3) or the breaker trips (Step 5).

**C) Hook — Push recurring issue (multi-day / true background, survives app restarts).** Best for "run this every day" research or corpora too big for one day. Create a **recurring issue** (`recurringIntervalSec` — a few minutes per tick, or a daily sweep) assigned to a redbook-capable agent. Each occurrence is a **fresh session = one tick** against the same job directory — so the issue body must point at the job dir and say "run exactly one tick, then exit." It keeps firing until a human retires it; the agent finalizes + comments when the queue drains, and comments + leaves it for human attention if the breaker trips. (Push "scout" pattern — the schedule lives on the issue, the agent's Auto switch gates it.)

> **Why file-state, not a long-lived process:** a single blocking `sleep`-loop dies with the terminal and can't be resumed. The queue + `loop-state.json` + per-item result files mean *any* future session — `/loop` wake, Push heartbeat, or a human re-running the tick — continues exactly where the last stopped, and the partial corpus is never lost.

### ⚡ Fast-mode warning (emergency only)

Before **any** fast-mode run, print this verbatim and require an explicit "yes, fast mode" from the user. Do not proceed on silence or a vague affirmative:

```
⚠️  XHS FAST RESEARCH MODE — elevated 风控 risk
    Reading at ~12 notes/min crosses the safe ~5/min ceiling and
    materially raises the chance of:
      • captcha / NeedVerify mid-run (stops the loop)
      • IP block (error 300012) for hours
      • account-level recommendation throttling
    Steady mode (the default, ~20s/note) stays inside the safe band
    and still finishes a typical job in well under an hour.
    Proceed with fast mode for this run only? (yes / no)
```

Fast mode still obeys the floor (≥5 s ± jitter between notes — never zero), caps a burst at 30 notes then forces a cooldown back to Steady pace, and the circuit breaker still hard-stops on the first 风控 signal. Fast mode raises the *pace* past the safe ceiling; it never removes the floor or the breaker.

### Circuit breaker

Trip the breaker and STOP the whole loop on the **first** of any of these from a read:

| Signal | Where it shows |
|--------|----------------|
| `NeedVerify` / captcha | error message or response flag |
| Empty `{}` response | usually expired/invalid `xsec_token` or anti-scrape — re-seed the queue with fresh `webUrl`s, don't retry blindly |
| `Session expired` / "No 'a1' cookie" | cookie invalid — re-login in Chrome before resuming |
| IP block `300012` | hard rate limit — wait it out / switch network |

On trip: set `loop-state.breaker:"tripped"` + `breakerReason`, leave the current item `pending`, persist, and surface to the user (or comment on the Push issue). **Never auto-retry through a block** — that's what escalates a soft throttle into a multi-hour block. Resume only after a human clears the cause and explicitly says to continue.
