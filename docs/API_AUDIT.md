# GridWatch API audit — 20 September 2026

Audited revision: `2c58313`. Scope: all 22 HTTP route registrations, application middleware/configuration, ingestion, extraction, processing, outage linking/lifecycle, infrastructure learning, mapping, Prisma schema/migrations, maintenance scripts, tests, and the client calls that consume affected API contracts.

**Result: 20 prioritized findings: 7 high and 13 medium.** Severity reflects this application's impact; the dependency advisory has its own upstream high rating. The most serious problems are unauthorized writes/spend, incomplete ingestion, and unsafe processing/reprocessing. This is an audit, not a remediation: application source, dependencies, and database data were not changed.

## Evidence and limits

- Original test suite: **60/60 tests passed** across 8 files.
- Added **25 audit characterization tests** across 6 files under `api/audit/`. They pass by reproducing current defective behavior. They are evidence, not assertions that this behavior should be preserved. Convert them to desired-behavior regression tests during remediation.
- All 36 existing JavaScript source/maintenance files passed `node --check`.
- Prisma schema validation passed. The connected local PostgreSQL database reports all 9 migrations applied. A clean-database migration replay was not performed.
- Existing read-only data audit: 191 outages, 858 current-version readings, no flagged invariant failures, no review/error/unprocessed posts at the time checked.
- Additional read-only queries found **7 of the 8 overview update entries would use an older timestamp**, and **7 restored locality associations within still-live outages**. The latter is valid stored data that the equipment-map endpoint misrepresents (A19).
- No currently RESTORED outage had a partial percentage, and no current OutagePost lacked a corresponding LinkDecision. A04/A08 remain reproduced failure-path bugs, not claims of existing corruption.
- No actual X, Gemini, geocoding, reprocessing, reset, or migration-write operation was invoked. HTTP tests used temporary localhost listeners with mocked dependencies, and closed every listener.
- No production penetration/load test, real PostgreSQL concurrency/fault-injection test, or full browser authentication test was performed. Mocked transaction tests establish operation ordering; PostgreSQL rollback/locking still needs integration coverage.

The existing labelled linking evaluation produced these read-only baseline results:

| Golden file | Labelled posts | Precision | Recall | F1 |
|---|---:|---:|---:|---:|
| links.json | 105 | 93.9% | 86.9% | 90.3% |
| holdout-0910.json | 69 | 95.3% | 96.8% | 96.1% |
| holdout-0911.json | 71 | 93.9% | 88.6% | 91.2% |
| holdout-0912.json | 37 | 100.0% | 100.0% | 100.0% |
| holdout-0914.json | 56 | 96.4% | 96.4% | 96.4% |
| holdout-0915.json | 43 | 100.0% | 100.0% | 100.0% |

All labels were present. Every file reported zero non-outage examples, so these scores do not validate irrelevant-post rejection. The evaluator exits successfully despite mismatches; its exit code alone is not an accuracy gate. Current `links.json` failures include incorrect merges of Ennerdale/Lehae and Northcliff/Roosevelt groups, and splits within Booysens and other groups. These are observed quality issues; the audit does not attribute each mismatch to a particular code defect without examining its evidence.

## High-priority findings

### A01 — Admin routes bypass authentication and spend controls

**High · reproduced and source-confirmed.** `api/src/modules/api/routes.js:469`, `:478`; `api/src/config/env.js:20`.

`POST /admin/ingest`, `/admin/process`, and `/admin/reprocess/:postId`, plus `GET /admin/review-queue`, have no authentication middleware. The optional REFRESH_TOKEN and REFRESH_BUTTON checks only protect `/v1/refresh`. `/admin/process` also bypasses the refresh batch cap, cooldown, and cycle guard. The server listener does not restrict itself to localhost. Exposure depends on deployment/network controls; no external compromise is claimed.

**Fix/acceptance:** require operator authorization before any admin read/write or paid manual operation. Fail closed for missing credentials outside an explicitly enabled local development mode. Preserve public read endpoints. Unauthorized calls must neither query sensitive admin data nor invoke ingestion, processing, or deletion. Route authorized writes through the common coordinator. Do not rely on CORS as authentication.

### A02 — Partial pagination permanently skips unseen posts

**High · reproduced.** `api/src/modules/ingestion/ingestion.service.js:11`, `:80`; `api/src/modules/ingestion/x.client.js:61`.

The checkpoint is the largest stored externalId, while pages arrive newest first and are persisted immediately. Starting at ID 100, page one saves ID 300; if page two fails before returning ID 200, the next run starts at `since_id=300`, permanently excluding 200. Reaching MAX_PAGES=20 creates the same gap and is still labelled SUCCEEDED. A failure partway through saving a page can also trigger this.

**Fix/acceptance:** persist a completed high-water mark separately from partially fetched rows, with resumable pagination or safe replay from the previous completed boundary. Only advance it after the interval is exhausted. Surface capped/incomplete ingestion. Test page failure, row-write failure, rate limit, process restart, token expiration, and page-budget exhaustion; every missing ID must remain recoverable without duplicate rows.

### A03 — Ingestion lease is not atomic, owner-safe, or reliably released

**High · reproduced; expiry behavior source-confirmed.** `api/src/modules/ingestion/ingestion.service.js:16`, `:28`, `:76`, `:123`.

Two callers can both read a missing/expired lease and both upsert ownership, then fetch concurrently. Release deletes by fixed ID without checking owner; an expired worker can delete its successor's lease. There is no renewal. Setup calls after acquisition occur before try/finally, and a final run-update failure also prevents release.

**Fix/acceptance:** use an atomic conditional database acquisition, owner-checked release/renewal, and an outer finally covering every operation after acquisition. Account for work exceeding the ten-minute lease. Test actual competing PostgreSQL connections, expiry takeover, old-owner completion, setup failure, and completion-record failure.

### A04 — Processing has no durable claim and does not atomically record its decision

**High · commit-order defect reproduced; cross-worker races source-confirmed.** `api/src/modules/processing/processor.service.js:52`, `:115`; `api/src/modules/processing/cycle.js:22`; `api/src/modules/outages/linker.service.js:178`, `:312`, `:323`.

The cycle guard exists only in one process. Admin/CLI calls bypass it, and ingestion releases its lease before processing. PROCESSING is written unconditionally and is not excluded from the pending query. Both workers can extract/learn/link a post. Separately, applyPost commits outage/timeline changes before LinkDecision is inserted. Failure or a uniqueness race at that last insert leaves already-committed work without the idempotency marker. Learning also increments evidence before linking, so retries can inflate evidence.

**Fix/acceptance:** introduce a durable work claim/coordinator that covers every entry point and preserves chronological linking. Commit outage mutation, timeline membership, and per-fault decision together, with idempotent learning evidence. Keep network/AI calls outside long database transactions. Integration tests must prove one result and one evidence contribution under duplicate requests, two workers, crash/retry, and final-write failure.

### A05 — Partially processed multi-fault posts cannot recover correctly

**High · reproduced.** `api/src/modules/processing/processor.service.js:23`, `:45`, `:69`, `:76`, `:118`.

After fault 0 gets a decision, failure in fault 1 leaves a partial post. `return processFaults(...)` does not await inside the try, so rejection escapes the intended catch and can leave PROCESSING. Pending selection excludes any post having any decision, and an explicit retry returns ALREADY_LINKED on the first decision, skipping the remaining faults. Additionally, fault-level NEEDS_REVIEW outcomes are collapsed into NEW and the source post becomes RELEVANT, hiding review work.

**Fix/acceptance:** track completion and retry per fault; await the multi-fault operation inside error handling. Resume missing work without skipping or duplicating completed faults. Propagate partial failure/review status and retain an actionable review path. Test fault 0 success/fault 1 failure followed by restart, and mixed linked/review/no-location faults.

### A06 — Reprocessing leaves old relationships and aggregate state behind

**High · route behavior reproduced; linker consequences source-confirmed.** `api/src/modules/api/routes.js:480`; `api/src/modules/outages/linker.service.js:276`; `api/src/modules/processing/processor.service.js:77`.

The reprocess route deletes only LinkDecision rows. It retains OutagePost, outage equipment/localities, and old aggregate status while processing again and incrementing graph evidence. A changed assignment can attach the same fault to both old and new outages. Reprocessing a multi-fault post excludes its former outages through linkedToPost, encouraging duplicate outages even with unchanged extraction. Also, extractPost normally reuses the successful reading, so this endpoint does not necessarily re-extract anything.

**Fix/acceptance:** define re-extract versus relink semantics explicitly. Replace the selected reading's contribution atomically, recompute both old/new outage aggregates and affected evidence, and handle empty outages deliberately. Repeating the same operation must not change link count, outage count, or evidence. Corrections moving a fault must remove its old contribution without touching unrelated posts.

### A07 — Late or historical posts can rewrite the present using older facts

**High · reproduced.** `api/src/modules/outages/linker.service.js:39`, `:207`; `api/src/modules/outages/scoring.js:65`.

Candidate loading has a lower time bound but no guard against outages from the post's future. Scoring clamps negative age to zero, giving future candidates maximum recency. applyPost unconditionally sets lastUpdateAt and current fields from the incoming post. An older imported/reprocessed post can move lastUpdateAt backwards and replace newer ETA/cause/restoration facts. Sorting one pending batch does not protect against later imports or retries.

**Fix/acceptance:** define temporal candidate eligibility and derive current outage state from chronological effective events. Store late posts in the timeline without making older facts the latest state; recompute when necessary. Test backfills before outage opening, delayed updates after restoration, equal timestamps, and replay versus incremental equivalence.

## Medium-priority findings

### A08 — Restoration fields can contradict each other

**Medium · three cases reproduced.** `api/src/modules/outages/linker.service.js:186`, `:201`, `:213`, `:214`, `:225`.

Full restoration without an explicit percentage preserves an earlier 48% value. A later ordinary update to a restored outage overwrites restoredAt with its own publication time, distorting restored24h counts. For a retroactive RESTORATION reading with UNKNOWN status, initialStatus changes the stored status to RESTORED but timestamp/locality handling uses the pre-adjustment ACTIVE status, creating RESTORED with no restoration time and unrestored places.

**Fix/acceptance:** derive all fields from one effective transition. Make the meaning of null versus 100% explicit, preserve the original confirmed restoration time unless corrected, and keep locality flags consistent. Add transaction-level tests for each case and for genuine subsequent new outages. These contradictions were not present in the current database snapshot.

### A09 — Planned work can be closed before its scheduled date

**Medium · closure predicate reproduced.** `api/src/modules/outages/linker.service.js:333`, `:337`, `:340`; `api/src/lib/schedule.js:14`; `api/src/modules/api/routes.js:66`.

The first sweep closes all PLANNED outages last updated over ten days ago before consulting scheduled dates. A September 1 announcement for September 30 disappears on September 12. The later date sweep uses UTC dates while overview uses Johannesburg dates. Schedule parsing only reads post prose, not image/fault schedule facts; it takes the last date but the first time window, does not reject impossible calendar/time values, and uses the reference year for yearless January notices posted in December.

**Fix/acceptance:** model or consistently derive scheduled start/end per fault, including image-only announcements; close only after the actual window when known. Apply an explicit fallback only for unknown schedules. Test future notices older than ten days, rescheduling, overnight/multi-day work, year rollover, invalid dates, and SAST midnight boundaries.

### A10 — Refresh status hides extraction failures and relaxes cooldown after paid work

**Medium · reproduced.** `api/src/modules/processing/processor.service.js:64`; `api/src/modules/processing/cycle.js:68`, `:74`.

Failed extraction returns outcome FAILED, but result.failed only counts tally.ERROR. Three failed extractions can be reported as a completed refresh with zero failures. Every manual-cycle error resets the cooldown, including errors after successful paid ingestion/AI calls. The REFRESH_MAX_POSTS cap limits processing only; ingestion can fetch up to 20 pages independently.

**Fix/acceptance:** report attempted/succeeded/retryable-failed/review-needed/backlog counts accurately, preserve spend controls once work may have been billed, and distinguish processing versus fetch budgets. Test provider failures, partial progress followed by failure, no-new-post backlog processing, and an exact cap with no remaining backlog.

### A11 — Latest updates show older content

**Medium · reproduced and observed in current data.** `api/src/modules/api/routes.js:187`, `:227`.

The SQL returns newest-first rows, then `new Map(updates.map(...))` overwrites each outage's newest row with its oldest row in the 60-row result. Map insertion order stays tied to the newest encounter, so displayed ordering and timestamps disagree. The current snapshot would show older timestamps in 7 of 8 entries. Limiting before deduplication can also omit other recently updated outages.

**Fix/acceptance:** select the latest row per outage deterministically in SQL before limiting, or retain only the first row with suitable pagination. Cover multiple updates per outage, tied timestamps, and an outage with more than 60 recent updates.

### A12 — Query and body errors are not treated as client errors

**Medium · reproduced.** `api/src/modules/api/routes.js:115`, `:136`, `:408`, `:438`; `api/src/app.js:22`, `:28`.

Enum filters, integer pagination, query shape, and ranges are not validated. Negative/fractional/infinite values reach Prisma; negative take can reverse pagination, and invalid skip/enums produce validation failures. Malformed JSON produces 500 internal_error instead of 400; oversized JSON is also forced through the generic 500 handler. Invalid `since` silently changes the requested interval to 24 hours, while valid ancient timestamps allow an unbounded changes response.

**Fix/acceptance:** validate request shapes and bounded ranges with consistent 4xx JSON responses; preserve parser 400/413 statuses and conceal unexpected error details. Add bounded pagination to changes and stable tie-break ordering to offset/cursor lists. Test arrays/repeated parameters, blanks, NaN/infinity, invalid enums, malformed/oversized JSON, and unsupported sort/date inputs.

### A13 — Enabling the documented refresh token breaks the supplied client

**Medium · CORS reproduced, client source-confirmed.** `api/src/app.js:18`; `client/src/lib/refresh.js:50`; `api/src/modules/api/routes.js:471`.

The client never supplies x-refresh-token, so setting REFRESH_TOKEN makes its button return 401. A separately hosted operator client that supplies it is blocked by the preflight allow-header list, which contains only content-type.

**Fix/acceptance:** implement a coherent operator-authenticated refresh flow and its CORS contract. Do not put a server operator secret in a public Vite build variable. Test same-origin and configured cross-origin authorized requests, missing/wrong credentials, and denied origins. Complete this with A01 rather than weakening authorization to make the button work.

### A14 — Same-name equipment of different types overwrites graph facts

**Medium · reproduced.** `api/src/modules/infrastructure/infrastructure.service.js:175`, `:178`, `:185`.

Resolved equipment is keyed only by normalized name although the database distinguishes type plus name. A Central substation and Central distributor collapse to the last entry. Its parent lookup can point to itself, the real edge is skipped, and rootCount becomes incorrect. Wrong facts feed subsequent linking and mapping.

**Fix/acceptance:** retain distinct node identities using type/ID and explicitly disambiguate name-only parent references; never silently choose self or an ambiguous parent. Test same-name station/distributor, duplicate aliases referring to one node, and ambiguous parent names.

### A15 — Rereads and restores leave summaries inconsistent with readings

**Medium · two cases reproduced, restore path source-confirmed.** `api/src/modules/ai/extraction.service.js:95`, `:108`; `api/scripts/reread.js:23`, `:29`, `:70`; `api/src/modules/api/routes.js:145`.

Summaries are upserted before the extraction and outside a shared transaction. A final extraction save failure leaves new summaries with the old reading. Shrinking two faults to one leaves obsolete summary index 1. Summaries have no prompt-version identity, and reread backups/restores only include PostExtraction fields, so restoring a reading does not restore its visible summaries. Existing outage links can temporarily refer to reordered fault indices. Outage detail also chooses extractions[0] without version/status ordering.

**Fix/acceptance:** persist a coherent active reading and complete summary set transactionally, remove obsolete rows, select the intended reading deterministically, and make backup/restore cover the same versioned data. Coordinate fault-index changes with relinking. Verify failed save, failed reread, changed fault count/order, changed prompt version, and full restore round trips without mixed summaries.

### A16 — Numeric configuration accepts values that defeat limits or scheduling

**Medium · zero-limit behavior reproduced, schema source-confirmed.** `api/src/config/env.js:6`, `:16`, `:21`; `api/src/modules/processing/processor.service.js:124`; `api/src/server.js:28`.

Numeric settings have coercion but no integer/range validation. REFRESH_MAX_POSTS=0 is accepted and then treated as no limit by processPending; negatives/fractions are also accepted. Invalid cron-step values reach node-cron, and intervals above an hour cannot be represented faithfully by a minute-field step. Link thresholds are neither range-checked nor ordered.

**Fix/acceptance:** validate ports, positive integer work/byte/time budgets, supported scheduler intervals, and `0 <= low <= high <= 1`. Define zero intentionally rather than using truthiness. Either constrain cron configuration to supported minute steps or use an elapsed-interval scheduler. Document/remove unused PROCESSING_CONCURRENCY rather than promising nonexistent concurrency control.

### A17 — Fresh setup and advertised maintenance commands are broken

**Medium · source/file inventory confirmed.** `api/package.json:12`, `:15`; `api/scripts/import-csv.js:12`, `:27`, `:68`; `README.md:8`; `api/data/README.md`.

seed:geography and relink refer to missing scripts. The historical importer defaults `before` to the oldest database post; an empty database returns null, making all modern rows fail `publishedAt < before`, then `before.toISOString()` throws. This contradicts the documented fresh-database bootstrap use. README's environment-copy source is ignored/untracked, so a clean clone has no supplied safe environment template.

**Fix/acceptance:** restore or replace the documented scripts, support empty-database import, validate cutoff/input data before writes, and provide a secret-free tracked example environment. Verify clean checkout/setup against a disposable database, import idempotency, geography seed, and every package script reference.

### A18 — One upstream dependency advisory affects three installed packages

**Medium application priority · npm audit/upstream confirmed; remote exploitability unproven.** `api/package-lock.json:99`, `:1011`, `:2432`.

`npm audit --omit=dev --json` reports three high package entries for one chain: prisma 6.19.3 → @prisma/config 6.19.3 → deepmerge-ts 7.1.5. The root advisory is GHSA-ggr8-5vv4-36mx / CVE-2026-40345: recursive input object graphs can exhaust the stack; versions below 8.0.0 are affected. Plain JSON cannot create the required self-references. No HTTP path feeding such objects into this package was demonstrated. See the [maintainer advisory](https://github.com/RebeccaStevens/deepmerge-ts/security/advisories/GHSA-ggr8-5vv4-36mx).

**Fix/acceptance:** assess reachable usage and a compatible dependency update/remediation, keep Prisma CLI/client compatible, regenerate and validate as necessary, and rerun the audit. The automated suggestion was a Prisma downgrade to 6.12.0; do not blindly apply `npm audit fix --force` or an incompatible transitive override. Document any temporary risk acceptance and its scope.

### A19 — Equipment map marks restored suburbs as currently without power

**Medium · reproduced; relevant data present.** `api/src/modules/api/routes.js:355`, `:356`; `client/src/components/NodeReach.jsx:16`.

The map gathers every locality of a live outage, without filtering OutageLocality.restored. A restored suburb within a partially restored outage becomes live:true and the client labels it “Power out now.” Seven such stored associations exist. The locality answer flow also reasons from overall outage status rather than the selected locality's restoration flag (`client/src/components/AreaAnswer.jsx:8`).

**Fix/acceptance:** compute live/partial/restored state for the requested locality, preserving history and accounting for a second still-active outage in that suburb. Verify a partial outage where A is restored and B remains affected, plus A having another independent active outage.

### A20 — Cached tie-breaks can select the wrong sibling fault's outage

**Medium · reproduced.** `api/src/modules/outages/linker.service.js:58`, `:120`, `:123`, `:134`.

Candidate stableId is only the earliest postId. Two outages opened by different faults of the same digest therefore share a stableId. A first AI tie-break selects outage B, stores that shared ID, and the next cached call resolves it using shortlist.find, returning outage A. The audit reproduces this exact switch with one provider call. Cache keys also omit the extraction/model/semantic input fingerprint, so changed readings can reuse obsolete decisions.

**Fix/acceptance:** give each candidate a deterministic identity including its originating fault, and version/fingerprint the decision inputs. Invalidate existing ambiguous entries. Test cold-cache/warm-cache equality across sibling faults, replayed database IDs, reordered candidates, and changed extraction/model inputs.

## Additional hardening and test gaps

These are follow-up review items, not additional counted/proven exploit findings:

- `extraction.service.js:31`: media size is checked only after the entire body is buffered. URLs are taken directly from stored/imported media and followed by fetch; no host/protocol/redirect policy is enforced, and appending `?name=large` mishandles existing query strings. Add streaming limits and trusted-provider URL handling. The public API does not expose a media-URL input route, so arbitrary public SSRF was not demonstrated.
- `gemini.client.js:5`, `cycle.js:30`, `geocode.service.js:115`: no application-level AI/cycle deadline or shutdown cancellation; geocoding checks its time budget between localities rather than each fallback request. Explicit bounded cancellation would prevent a slow provider from holding the cycle beyond its advertised budget. Verify installed SDK timeout/retry behavior before changing it.
- `server.js`: the HTTP listener/cron handles are not retained for graceful shutdown. Sweep runs at startup even with SCHEDULER=off, and its final date-based update is not conditional on still being PLANNED. Serialize/recheck against concurrent processing when implementing the common coordinator.
- Public `/v1/changes` can return all history for an ancient since value. Candidate loading includes complete timelines; map hubs scan the complete node/locality relation; knowledgeContext does per-node queries; currentCheckpoint scans all source IDs. Benchmark realistic volumes and add bounded query shapes/indexes where measurements support them. No production load claim is made.
- The overview planned count is computed from at most 60 recently updated planned rows, after which date filtering occurs. It is not an exact total and can omit an older announcement whose schedule is imminent.
- Read-stamp hashing excludes buildUserText and runtime knowledge/thinking settings; define which semantic changes require rereading. Normal processing's reuse of existing readings is documented behavior and should not silently trigger paid rereads.
- The local tie-break cache is a synchronous whole-file write, is not atomic across processes, and silently ignores write errors. Make it robust if retained after A20.
- Historical migrations include an unconditional legacy-table drop described as safe because those tables were empty. Do not rewrite applied migrations; document/preflight any real legacy upgrade. A fresh migration-chain execution still needs testing on a disposable database.
- Re-read spend scripts check estimates after calls and have in-flight concurrency; these are soft estimates, not guaranteed hard billing limits. model-test resets the learned database before work and uses an asynchronous onPost callback that processPending does not await. Keep destructive experiments on disposable databases and make budgets/callback sequencing explicit.
- Existing automated coverage is primarily pure helpers and mocked cycle/X behavior. Add real PostgreSQL tests for transactional/idempotency/lease guarantees and HTTP tests for all relevant validation/auth contracts. Review the golden mismatches and add non-outage and multi-fault-labelled cases before tightening accuracy gates.

## Reproduction commands

Run from `api/`:

```text
npm test
node node_modules/vitest/vitest.mjs run audit
node node_modules/prisma/build/index.js validate
node node_modules/prisma/build/index.js migrate status
node scripts/audit.js
node audit/read-only-data-check.mjs
node scripts/eval.js
node scripts/eval.js --file=holdout-0910.json
node scripts/eval.js --file=holdout-0911.json
node scripts/eval.js --file=holdout-0912.json
node scripts/eval.js --file=holdout-0914.json
node scripts/eval.js --file=holdout-0915.json
npm audit --omit=dev --json
```

The read-only database commands require the configured database. Audit characterization tests mock persistence/providers and do not need credentials. `npm test` discovers these new characterization tests too; after remediation, replace their intentionally defective expectations with correct contract assertions. Never treat a passing characterization test as evidence that the underlying defect is fixed.
