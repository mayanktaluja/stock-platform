# Phase 4 Rollout — V2 Scorer Behind `SCORER_MODE`

Phase 3 backtest cleared V2 (+10.6pp XIRR vs V1, +18pp win rate, 13 fewer
stop-outs). Phase 4 wires V2 behind a feature flag so the operator can
flip it on without touching code.

## The flag

`SCORER_MODE` env var. Three values:

| Value        | Behaviour                                                    |
|--------------|--------------------------------------------------------------|
| `v1`         | V1 only. No V2 computation. Rollback escape hatch.           |
| `v2-shadow`  | V1 authoritative. V2 attached as `shadowV2`. **Default.**    |
| `v2-primary` | V2 authoritative. V1 attached as `legacyV1` for disclosure.  |

Verified: if the env var is unset, or is set to a value outside this set,
the server falls back to `v2-shadow` and logs a warning.

## Which endpoints respect the flag

User-facing verdict surfaces (what retail users see):

- `GET /api/fundamentals/:symbol` — detail view
- `GET /api/scan/fundamentals` — Deep Value / Quality Growth / etc. buckets

Internal scorer callsites in server.js (buynow scan, volume-breakout scan,
combined scanner at line 5085, 5411, etc.) are **deliberately NOT gated**
in this phase. They consume the score for ranking inside larger composite
signals and can be migrated individually later. Gating them now would
expand the blast radius beyond the two user-visible surfaces Phase 3
actually validated.

## Response shape under each mode

### Detail endpoint

Every response carries `scorerMode`. Top-level `score` / `verdict` /
`scorerVersion` always reflect the authoritative scorer.

| Field        | `v1`    | `v2-shadow`       | `v2-primary`                            |
|--------------|---------|-------------------|-----------------------------------------|
| `score`      | V1      | V1                | V2                                      |
| `verdict`    | V1      | V1                | V2                                      |
| `scorerVersion` | V1   | V1                | V2                                      |
| `shadowV2`   | `null`  | V2 full object    | `null`                                  |
| `legacyV1`   | `null`  | `null`            | V1 full object                          |
| `scorerMode` | `"v1"`  | `"v2-shadow"`     | `"v2-primary"` (or fallback tag if V2 threw) |

If V2 throws under `v2-primary`, the server falls back to V1 and returns
`scorerMode: "v2-primary-fallback-v1"` — the UI should render a banner so
the operator notices.

### Scan endpoint

Every row in `stocks[]` now carries lightweight `legacyV1` / `shadowV2`
(score + verdict + scorerVersion only — the row-per-stock payload stays
small). The top-level response also carries `scorerMode`.

Under `v2-primary`, `categoriseBatch` buckets off V2's verdict because V2
uses identical verdict labels. SUZLON, TCS, MARUTI (etc.) move out of the
Deep Value bucket as Phase 3 backtest showed they should.

## Rollout procedure

**Recommended staged path** (mirrors the Phase 3 gate report):

1. **Ship this phase with default = `v2-shadow`.** Nothing changes for
   users today. V2 is visible in `shadowV2` but non-authoritative.
2. **Run shadow-compare weekly** for 2–4 weeks:
   ```
   node scripts/shadow-compare.mjs
   ```
   Confirm the V1↔V2 delta distribution stays stable (mean near −1,
   p90≈+12, max|Δ| bounded).
3. **Flip to `v2-primary` in staging** first. Re-run the backtest-compare
   to sanity-check trade outcomes haven't regressed:
   ```
   node scripts/backtest-v2-compare.mjs
   ```
   Still expect V2 to beat V1 on XIRR.
4. **Flip `v2-primary` in production** via the deploy-time env var.
   Monitor for 1 full refresh cycle (Sunday enrichment cron → next
   Sunday). Watch for: scorer exceptions in logs, unusual churn in
   the Deep Value bucket, any user reports of verdict mismatches.
5. **Sunset V1** — after one clean cycle under `v2-primary`, drop the
   V1 import and remove `legacyV1` from the response. This is a
   separate changelog entry (SEBI Reg 15(2) compliance: users need
   notice before a scorer change becomes invisible).

**Rollback** at any step: set `SCORER_MODE=v1` and redeploy. V2 stops
running entirely, eliminating any scorer-related blast radius.

## SEBI Reg 15(2) compliance note

Reg 15(2) prohibits misleading labels. Under `v2-primary`, the `legacyV1`
field is there specifically so the UI can show *both* verdicts during the
transition — users see "we upgraded the scorer; here's what it used to
say." That's the transparency bar Reg 15(2) actually asks for. Do not
remove `legacyV1` from responses until step 5 above lands and is
announced.

## Verification

Confirmed during Phase 4 build:

- `SCORER_MODE` unset → server logs `[scorerMode] active: v2-shadow`
  and returns V1 as `score`/`verdict` with V2 attached. ✓
- `SCORER_MODE=v2-primary` → server logs `[scorerMode] active: v2-primary`;
  TCS detail returns V2 (70 QUALITY_GROWTH) with V1 (78 DEEP_VALUE) as
  `legacyV1`; scan deepValue bucket fills from V2 verdicts
  (IDBI/JSWDULUX/J&KBANK/... replacing V1's SUZLON/BLS/CHAMBLFERT).
  Bucket size shrinks 15 → 14 as expected from V2's tighter bands. ✓
- `SCORER_MODE=v1` → no V2 computation, `shadowV2`/`legacyV1` both
  `null` on every response. V1 behaviour identical to pre-Phase-2. ✓
- Invalid `SCORER_MODE=banana` → server logs the warning and proceeds
  as `v2-shadow`. ✓

## Files touched

- **new:** `scorerMode.js` — the mode helper (70 lines)
- **edit:** `server.js` — import block + detail endpoint + scan endpoint
- **new:** this doc

No frontend changes were needed — `public/app.js` already reads
`scorerVersion` / `score` / `verdict` from the top-level response, so the
swap is transparent to the UI. A future UI ticket can add an explicit
"legacy V1 said" inline chip using `response.legacyV1.verdict` when
`scorerMode === "v2-primary"`.
