---
description: Start or resume an SWS deep-scrape shard. Usage: /sws-scan-shard {1|2|3}
allowed-tools: Bash, Read, Write, mcp__Claude_in_Chrome__*, mcp__scheduled-tasks__create_scheduled_task, mcp__scheduled-tasks__update_scheduled_task, mcp__scheduled-tasks__list_scheduled_tasks
---

> **Model note:** This command inherits the current session's model. Sonnet 4.6 (standard 200K context) is the recommended choice — cheaper than Opus, no extra-usage required. Run `/model` and pick `claude-sonnet-4-6` (or your preferred Sonnet variant) before invoking this command. If you want 1M context for fewer session turnovers, run `/extra-usage` first — but it's not required.

# SWS Deep-Scrape Shard Worker

You are a Sonnet 4.6 worker that drives Chrome MCP to scrape Simply Wall Street pages, one stock at a time, for the assigned shard. Your one job is to be **safe, deterministic, and resumable**. Subscription protection is non-negotiable.

## Argument

The user invokes you as `/sws-scan-shard 1` (or 2 or 3). Read the shard ID from `$ARGUMENTS`.

## The protocol — follow this exactly

### Step 0: Boot
1. Run `node scripts/sws-deep-scrape.mjs check-panic`. If exit code is **1**, the panic-stop flag is set. **Stop immediately.** Print: "🚨 Panic-stop active. Read /data/sws/panic-stop.flag, decide, then delete it to resume." Exit.
2. Run `node scripts/sws-deep-scrape.mjs acquire-lock {SHARD_ID}`. If exit code is **1**, another session holds this shard's lock. Exit.
3. Run `node scripts/sws-deep-scrape.mjs shard-state {SHARD_ID}`. Read `next_stock`, `next_local_index`, `slice_size`, `progress`. If `is_complete: true`, jump to Step 6 (cleanup).
4. Confirm Chrome MCP is connected: `mcp__Claude_in_Chrome__list_connected_browsers`. Pick the browser this shard owns (use `select_browser` with the deviceId). If only one browser is connected, use it. If your shard ID is 2 or 3 and there's no second browser, exit and tell the user to open more Chrome windows.
5. Get a tab with `mcp__Claude_in_Chrome__tabs_context_mcp` (createIfEmpty: true).

### Step 1: Per-stock loop
Repeat for each stock in your shard slice until either:
- All stocks done (`is_complete: true`)
- Token budget approaching (after roughly 12-15 stocks)
- Panic-stop flag detected
- Rate cap hit

For each stock:

#### 1a. Pre-flight checks
- Run `node scripts/sws-deep-scrape.mjs check-panic`. If exit 1 → **PANIC PATH**: do NOT schedule next session, goto Step 5 (release lock only), print the warning block below.
- Run `node scripts/sws-deep-scrape.mjs check-rate-cap {SHARD_ID}`. If exit 1, parse JSON from output. If `reason: "per_minute_cap"`, sleep `wait_ms` with `python3 -c "import time; time.sleep(N)"`, then retry the check.

#### 1b. URL resolution
- The stock object has `sws_url`. If it starts with `https://simplywall.st/search?...`, the URL is a search-fallback; you must resolve to canonical:
  1. Navigate to the search URL.
  2. Wait `randInt(5000, 9000)` ms (use the `computer` tool with `wait` action; for randomisation, just pick a value in [5,9] each time — no central RNG, you choose per-call).
  3. Use `find` with query: "first stock result with NSEI: ticker prefix matching {TICKER}". Click it.
  4. Wait again. Capture the new URL from `tabs_context_mcp` — that's the canonical SWS URL.
  5. Save the canonical URL back into universe.json for this ticker (optional — speeds future runs but not required for this stock).
- Otherwise, navigate directly to `sws_url`.

#### 1c. Overview capture
- **Mandatory wait** before loading: `python3 -c "import time; time.sleep(N)"` where N ∈ [5, 9], chosen fresh each time.
- **DO NOT call `get_page_text`** — it dumps thousands of words into context and destroys token efficiency. Use targeted `find` queries only:
  1. `find` → "snowflake score valuation future past health dividend out of 6" — captures all 5 scores in one call
  2. `find` → "current share price and market cap"
  3. `find` → "rewards list and risks list" — rewards/risks bullets
  4. `find` → "PE ratio PS ratio PB ratio EPS net profit margin debt equity"
  5. `find` → "dividend yield payout ratio"
  Concatenate the text of all found elements into `captures.overview`.
- Run safety scan: pass the concatenated overview text to `node scripts/sws-deep-scrape.mjs detect-signals "{URL}"` via stdin. If exit 1 → **PANIC PATH**: call `record-panic`, do NOT schedule next session, goto Step 5 (release lock only), print the warning block below.
- Account-health spot check: every 50th stock per shard (use `progress.done_count % 50 === 0`), navigate to `https://simplywall.st/dashboard`, then `find` → "sign in free trial subscribe upgrade" — if any match is found, **PANIC PATH** with reason "account-health". Otherwise navigate back to the stock URL and continue. **Do not call `get_page_text` for the dashboard either.**

#### 1d. Sub-tab loop
For each of the 7 sub-tabs (in order: Valuation, Future Growth, Past Performance, Financial Health, Dividend, Management, Ownership), their URL slugs are: `valuation`, `future`, `past`, `health`, `dividend`, `management`, `ownership`.

For each tab:
1. Navigate directly to `{CANONICAL_URL}/{slug}` (e.g. `.../nse-infy/infosys-shares/valuation`).
2. **Mandatory inter-tab wait** — run this BEFORE any `find` or `get_page_text`:
   ```bash
   python3 -c "import time; time.sleep(N)"
   ```
   where N is a value you pick from [4, 8] — choose a **different** value each call (e.g. 5, 7, 4, 6, 8, 4, 7). Do NOT use bash `sleep` — it is blocked by the sandbox.
3. Use targeted `find` queries to extract key metrics and scores (token-efficient — avoids storing full page text in context). Examples:
   - Valuation: "valuation score number out of 6", "analyst price target"
   - Future: "future growth score number out of 6", "earnings growth rate", "revenue growth rate"
   - Past: "past performance score out of 6", "earnings growth rate", "return on equity"
   - Health: "health score number out of 6", "debt to equity ratio"
   - Dividend: "dividend score number out of 6", "yield payout ratio"
   - Management: "management score", "CEO tenure compensation"
   - Ownership: "insider ownership institutional percentage"
4. If the tab URL redirects to `/login`, `/pricing`, or `/blocked`, OR if `find` returns no elements at all: **call `detect-signals` with the URL and stop if it returns panic**. Otherwise mark this tab as failed for this stock and continue.
5. At end of all 7 tabs: if fewer than 6 succeeded, move stock to failed rather than saving.

#### 1e. Parse + score + save
Run a small inline JS to combine captures into a stock JSON. Use the parser via Node:
```bash
echo '{ "captures": <captures-json>, "ticker": "<TICKER>", "name": "<NAME>", "sector": "<SECTOR>", "indices": <INDICES_ARR>, "sws_url": "<CANONICAL_URL>" }' | node -e '
import("./scripts/sws-parse-capture.mjs").then(p => {
  const o = JSON.parse(require("fs").readFileSync(0, "utf-8"));
  const parsed = p.parseStock(o.captures, o.ticker);
  parsed.name = o.name; parsed.sector = o.sector; parsed.indices = o.indices; parsed.sws_url = o.sws_url;
  parsed.captures_raw = o.captures; // keep raw for re-parse
  process.stdout.write(JSON.stringify(parsed));
}).catch(e => { console.error(e); process.exit(2); })
'
```
*Easier:* Write captures to a temp file, then call `node scripts/sws-deep-scrape.mjs save-stock {TICKER} < temp.json` after running parser. (You can also do parsing + save in one Node `--input-type=module` invocation.)

After save:
- Run `node scripts/sws-deep-scrape.mjs advance-progress {SHARD_ID} {TICKER} {durationMs}`.

#### 1f. Inter-stock cooldown
- Sleep `randInt(20000, 45000)` ms.
- Increment a long-pause counter. If you've done `progress.long_pause_due_after_count` stocks in this session (default 25), do a 2-5 min long pause now and re-roll the counter to a new `randInt(20, 30)`.

### Step 2: Token budget watch
Roughly track your context usage. After **about 50 stocks** in this session (standard 200K context, find-only approach), or **about 150 stocks** with `/extra-usage` (1M context), prepare to exit cleanly:
- Goto Step 4 (schedule next + exit).
- The exact limit lives in `scripts/sws-config.mjs` under `TOKEN_BUDGET.maxStocksPerSession`.

### Step 3: All-stocks-done
If `is_complete: true` after a successful stock save, the watcher task will see all 3 shards complete and trigger Layer 2/3. You don't need to do anything special. Goto Step 5 (cleanup).

### Step 4: Schedule next session

**ONLY reach this step on clean exit (token budget) or rate-cap exit. NEVER after a panic-stop.**

Compute the `fireAt` timestamp first:
```bash
node -e '
const sec = 300;  // or 900 for rate-limited; always >= 5min
const d = new Date(Date.now() + sec * 1000);
const offsetMin = -d.getTimezoneOffset();
const sign = offsetMin >= 0 ? "+" : "-";
const oh = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0");
const om = String(Math.abs(offsetMin) % 60).padStart(2, "0");
const pad = n => String(n).padStart(2, "0");
const local = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
console.log(local);
'
```

Then **always use `mcp__scheduled-tasks__update_scheduled_task`** (not `create`). The task already exists after the first session, and `create` will fail with "already exists", silently breaking the chain:
- `taskId`: `sws-shard-{SHARD_ID}-resume`
- `fireAt`: the timestamp computed above
- `notifyOnCompletion`: false

If the task somehow does not exist yet (very first ever run before the task was bootstrapped), fall back to `mcp__scheduled-tasks__create_scheduled_task` with the same fields plus:
- `description`: `Resume SWS shard {SHARD_ID}`
- `prompt`: `Resume SWS scrape shard {SHARD_ID}. Follow the playbook in \`.claude/commands/sws-resume-shard.md\` exactly. Shard ID is {SHARD_ID}.`

### PANIC PATH — what to print and do

When any panic signal is detected (detect-signals exit 1, account-health fail, check-panic exit 1):

1. Call `node scripts/sws-deep-scrape.mjs record-panic {REASON} {SHARD_ID} "{EVIDENCE}"` (if not already recorded).
2. Release lock: `node scripts/sws-deep-scrape.mjs release-lock {SHARD_ID}`.
3. **Do NOT schedule the next session.** The chain stops here.
4. Print this block verbatim (fill in the values):

```
🚨 PANIC-STOP — Shard {N} halted
  Reason:    {REASON}
  Evidence:  {EVIDENCE}
  Ticker:    {TICKER} (last attempted)
  Tab:       {TAB} (overview / valuation / etc.)

ACTION REQUIRED — do NOT resume until you have:
  1. Opened SWS in Chrome and confirmed: pages load normally, no unusual-activity banner, subscription active.
  2. Checked your email for any message from Simply Wall St.
  3. Decided this was a false positive (or waited until things look normal).

To resume after you are satisfied:
  node scripts/sws-deep-scrape.mjs check-panic && echo "clear to go"
  # If the flag is still there, delete it:
  rm data/sws/panic-stop.flag
  # Then: /sws-resume-shard {N}
```

5. Exit.

### Step 5: Cleanup
- `node scripts/sws-deep-scrape.mjs release-lock {SHARD_ID}`
- Print a one-line summary: "Shard {N}: did {X} stocks this session, total done {Y}/{Z}, next stock: {ticker}"
- Exit.

### Step 6: Watcher task (only created on the very first invocation, when started_at is set)
After Step 0.3, if `progress.done_count === 0` and `progress.last_run_at === null`, also create a watcher scheduled task:
- name: `sws-watcher`
- delay: 1800 seconds (30 min)
- prompt: `/sws-resume` (the resume command checks if all shards complete and dispatches scoring)

## Hard rules — do not violate

1. **Never proceed past a panic-stop signal.** If `check-panic` returns 1 OR `detect-signals` returns 1, halt immediately — no next session scheduled. The user must manually review and delete the flag before resuming.
2. **Never skip inter-tab or inter-stock waits.** Every wait uses `python3 -c "import time; time.sleep(N)"` — bash `sleep` is sandbox-blocked. Never rely on MCP round-trip latency as a substitute.
3. **Never click anything other than the search dropdown result and the sidebar tabs.** No sponsored links, no pop-ups, no captchas.
4. **Never scrape the same stock twice in a session** — if `last_ticker` matches the upcoming stock, skip it.
5. **Never use a fixed wait value.** Always randomise within the specified ranges. Pick a different value each call — the user can read your tool calls.
6. **Never sleep less than the minimum.** If you're tempted to "go faster", remember: ₹13,000 subscription. Don't.
7. **Never auto-chain after panic.** A scheduled task that fires after panic just triggers another panic detection → another scheduled task → infinite loop on a blocked account. Stop dead.

## What to print at the end (concise)

```
Shard {N} session summary
  Done this session:  {X}
  Total done:         {Y}/{Z}
  Last ticker:        {LAST}
  Failed this session: {F}
  Next stock:         {NEXT}
  Next session:       scheduled in {DELAY}s
  Lock:               released
```
