# Engine audit — 24 September 2026

This report records **eight correctness issues found before the fixes were implemented**. The source references and reproductions below describe the initial behavior. The implementation update at the end records the current state.

## Scope and validation

Reviewed ingestion and historical backfill, processing filters, extraction dispatch, water fault splitting, outage state folding, graph evidence/undo, and quality/review wiring. This includes the existing uncommitted water implementation, not only the last commit.

- Existing unit suite: **372/372 passed** across 35 files.
- Existing integration suite: **201/201 passed** across 15 files, using its disposable PostgreSQL database and teardown.
- New isolated audit suite: **13/13 characterization tests passed**. These deliberately assert the defective behavior, so passing means reproduction, not correctness. Database and external service dependencies are mocked.
- Application data was inspected read-only, including an explicitly read-only transaction in the new data-check script. No X fetches, paid AI requests, rereads, repairs, or application server starts were performed.
- Only this report and three audit files were added. Production code and application data were not changed by this audit. An existing scheduler continued to update the database independently, so counts from separate commands can differ slightly.

## Findings

### 1. P1 — A capped backfill can permanently skip the remainder of its final page

Source: [ingestion.service.js, lines 303–315](../api/src/modules/ingestion/ingestion.service.js#L303).

The code slices a fetched page to the remaining `maxPosts` allowance. However, `ceiling` is conditional on `!windowDone`. If the page has no next token, or already contains a post older than the requested window, `windowDone` is true even when the in-window page was truncated. The run then declares completion, clears its cursor, and advances the live high-water mark.

**Reproduced:** X returns IDs `300, 200, 100` on the final page; `maxPosts: 1` stores only `300`, reports `complete: true, ceiling: false`, and advances the live mark to `300`. Subsequent live ingestion starts above `300`, so `200` and `100` are never retrieved by live polling.

There is a second failure at a non-final partial page: saving the incoming page token and charging already-stored duplicates against the next run's cap means rerunning the same small cap can make no progress. The test runs a one-post cap twice against a three-post page; the second run fetches and deduplicates `300` again, without reaching `200`.

**Fix:** complete only after every in-window item has been persisted. Either commit whole pages with an explicitly documented page-sized budget allowance, or persist a within-page offset and resume it correctly. Do not consume the insertion allowance repeatedly on the same already-committed prefix. Test final-page truncation, the older-than-window boundary, and repeated identical caps.

**Evidence level:** reproduced with injected pages; no claim that historical production posts have already been lost this way.

### 2. P1 — Backfilling a separate interval can advance the live checkpoint across an unfetched gap

Source: [ingestion.service.js, line 314](../api/src/modules/ingestion/ingestion.service.js#L314).

Every completed historical window promotes `max(oldCompletedHighWater, newestBackfillId)` to the live completed mark. Completion of an arbitrary `[from, to)` interval does not establish that all posts between the previous live mark and `from` have been fetched.

**Reproduced:** with live mark `100`, a later bounded window containing `300` completes and moves the next live request to `sinceId: 300`. Any unstored `200` between the old mark and the window is skipped. This matters when the helper is used on an established account with a gap, or while an older live interval is unfinished. For an intentionally bounded initial bootstrap, excluding earlier history may be a deliberate policy, but it must not silently become the policy for every backfill.

**Fix:** keep historical-job state separate from the live checkpoint. Advance the live checkpoint only after proving contiguous coverage from its previous position, or under an explicit initial-bootstrap policy.

The backfill resume identity also records only `from`, not `to` ([lines 257 and 275](../api/src/modules/ingestion/ingestion.service.js#L257)). A separate test confirms that changing `to` still sends the previous window's cursor. The CLI's `--to now` changes on every invocation. Persist the original bounds and resume those exact bounds; any additional effect depends on how X validates the cursor and was not tested against the paid API.

### 3. P1 — Whole-post recovery wording overwrites correctly separated water faults

Source: [outage-state.js, lines 185–189](../api/src/modules/outages/outage-state.js#L185).

`noticeEffect()` reads the entire source post for every individual fault. If that text matches a recovery phrase, it unconditionally replaces that fault's `waterState` with `RECOVERING`, clears customer restoration, and sets the effect status to `INVESTIGATING`. A shared headline such as “Recovery at … and Supply Zone” cannot establish the condition of every asset in the attached bulletin.

**Observed in stored data:** post `2100174345494548955` has four separate accepted faults. Its stored image transcription distinguishes:

- Heldekruin Reservoir: normal customer supply; stored effect `NORMAL`.
- Heldekruin Tower: recovering; stored effect `RECOVERING`.
- CR Swart Booster Pump Station: normal customer supply; stored effect `NORMAL`.
- Vuurlelie Booster Pump Station: remains off with insufficient supply; stored effect `NO_SUPPLY`.

The source post's short text begins “Recovery at Heldekruin Reservoir and Tower and Supply Zone”. All four resulting outages have `waterState: RECOVERING`; the three distinct normal/no-supply effects are overwritten. The outages are currently `STALE`, so this also leaves the two normal-supply reports without the restoration lifecycle justified by their per-fault readings.

**Reproduced independently:** a post saying Alpha's pumping resumed while Beta has no supply changes Beta's explicit `NO_SUPPLY` effect to `RECOVERING` during refolding.

**Fix:** apply deterministic overrides only to text attributable to the particular fault. Preserve explicit per-asset conditions when a bulletin has been split. Recompute the affected stored outages after fixing the rule. The production image itself was not independently reread during this audit; the finding is supported by the stored transcription, accepted per-fault readings, effects, and deterministic override.

### 4. P1 — Water readings bypass reading-based quality and review checks

Sources: [cycle wiring, line 217](../api/src/modules/processing/cycle.js#L217), [quality selection and splitting, lines 142–154](../api/src/modules/processing/quality.js#L142), [review selection, line 24](../api/src/modules/review/review.service.js#L24), [water prompt version](../api/src/modules/ai/prompts/water.prompt.js#L1).

Water extraction stores readings under `water-2`. The cycle passes `env.AI_PROMPT_VERSION` to the assessor, and the review service independently filters on that electricity version. Water posts therefore arrive at these checks without their accepted reading. Expected faults, discarded-fault checks, revision comparisons, and reader uncertainty checks are skipped. Post-status and some outage-level checks still run; the gap is specifically the reading-dependent validation.

**Reproduced:** a water post marked `RELEVANT` with no decisions or timeline entries is assessed `COMPLETE` with zero expected faults. A water reading with uncertainty is ignored by the review detector.

**Observed exposure:** all **504** current accepted water readings use the excluded version; **189** contain multiple faults. This does not establish that all 504 are wrong, or that the six stored water notices with `review_reason` require intervention—several are harmless informational posts.

Selecting the right version alone is insufficient: both consumers use the electricity `faultItems()` helper, which spreads `f.equipment`; water faults use `f.entities`. A third test shows that the existing helper throws on a multi-fault water reading.

Related maintenance paths have the same version assumption: [audit.js, line 150](../api/scripts/audit.js#L150), [eval-all.js, line 24](../api/scripts/eval-all.js#L24), and [reread.js, lines 26–48](../api/scripts/reread.js#L26). In particular, the generic reread command does not select existing `water-2` readings.

**Fix:** dispatch reading selection, fault splitting, freshness checks, and reread/restore versions by each post's service. Add an end-to-end cycle test covering an incomplete multi-fault water disposition and reader uncertainty.

### 5. P2 — Undo loses typed water network edges

Sources: [typed evidence encoding](../api/src/modules/infrastructure/infrastructure.service.js#L251), [snapshot lookup](../api/src/modules/processing/repair.js#L28), [restore lookup](../api/src/modules/processing/repair.js#L128).

Water edge evidence stores `refB` as `SUPPLIES:<childId>` or another typed relationship prefix. Removal correctly decodes this representation. Snapshotting and restoring still treat all of `refB` as a child node ID.

**Reproduced:** snapshotting a `SUPPLIES` edge queries `childId: 'SUPPLIES:child'` instead of `'child'` and omits the real edge. Undo subsequently looks for that prefixed child under `LEGACY_PARENT`, cannot recreate the omitted edge, but restores the evidence contribution anyway. The graph and its evidence ledger disagree after a supposedly successful undo.

**Fix:** share one typed-edge encoder/decoder between learning, removal, snapshotting and restoration. Include relationship type in edge identity maps. Verify undo after deleting or changing a learned water relationship, including multiple relationship types between the same nodes.

**Evidence level:** source-confirmed and mocked reproductions; no production repair was attempted.

### 6. P2 — An unfinished account fetch erases the requested processing-account filter

Source: [processor.service.js, line 227](../api/src/modules/processing/processor.service.js#L227); the held count repeats the problem at [line 254](../api/src/modules/processing/processor.service.js#L254).

`baseWhere` contains the caller's `sourceAccount`, but the incomplete-account exclusion overwrites that property. A call targeting one source starts selecting every non-held source matching the other filters. If the requested account itself is held, unrelated accounts can be processed instead of nothing. This can spend AI calls and modify incidents outside the requested scope; remaining/held counters also cease to describe the same selection.

**Reproduced:** `processPending({ sourceAccount: 'JHBWater', serviceType: 'WATER' })` with `OtherWater` incomplete queries only `sourceAccount: { notIn: ['OtherWater'] }`; it no longer restricts the query to JHBWater. Current live cycles are unscoped, and the historical CLI's explicit `ignoreIncomplete` bypasses this condition, so the defect is conditional rather than a claim of current cross-account processing.

**Fix:** intersect the caller's filter with the exclusion, using `AND`, and apply the same scope to all counters.

### 7. P2 — Water changes can leave the reading revision unchanged

Source: [reading-revision.js, lines 13–39](../api/src/lib/reading-revision.js#L13).

The fingerprint omits `water_state` and `customer_supply`, and per-fault identity includes only electricity `equipment`, not water `entities`. Different water conditions often retain the same generic pipeline status, so the existing status field does not cover this omission.

**Reproduced:** changing `NO_SUPPLY` to `RECOVERING` and changing a fault's reservoir from Alpha to Beta produces the same revision. `effectReadingMismatch()` returns false. Accepted rereads can consequently miss revision archival, and revision-based checks/relink detection can miss meaningful water changes.

**Fix:** fingerprint all fields that influence service-specific processing, including per-fault water assets and operating/customer conditions. Define compatibility for already-stored fingerprints and test both state changes and renamed per-fault assets.

### 8. P2 — Reopened water outages retain a stale 100% restoration value

Source: [outage-state.js, lines 135–140](../api/src/modules/outages/outage-state.js#L135).

Full restoration sets the accumulated percentage to 100. A later water effect can correctly reopen the incident as `ACTIVE/NO_SUPPLY`, but if it carries no explicit percentage, the old 100 is retained. Both the public API and outage cards expose this value.

**Reproduced:** folding `NORMAL/RESTORED`, followed by `NO_SUPPLY` with a null percentage, yields `ACTIVE`, `waterState: NO_SUPPLY`, `restoredAt: null`, and `restorationPercent: 100`.

**Fix:** clear the inherited percentage when customer supply worsens and the new report supplies no valid replacement. Test restoration followed by no supply, low pressure, and partial supply. No currently live water outage with this contradiction was found in the inspected data.

## Current operational picture

Read-only inspection around **20:55 UTC / 22:55 SAST** found:

- CityPowerJhb, CityTshwane, and JHBWater active, with completed checkpoints, no pending cursors, and completed polls around 20:53 UTC.
- Zero unprocessed posts, processing errors, or stuck processing posts in the health report.
- **21 open review concerns**: 15 CityPowerJhb and 6 CityTshwane. Public quality status is `NEEDS_REVIEW`, despite the latest individual cycle being `COMPLETE`.
- One SourcePost explicitly `NEEDS_REVIEW`: Tshwane post `2078737661099982985`.
- **1,795 of 1,805** current-version electricity readings have an old prompt/model fingerprint. All **504** current water readings match their current fingerprint. Staleness is not proof of semantic error, and blanket rereading was not performed.
- The built-in audit inspected **776 outages** and exited **1 / FAIL** because review work remains. Its checked structural categories found no empty outages, cross-service links, or water nodes using electricity types. Its water checks did not catch finding 3.

## Original reproduction and repair order

From `api/`:

```powershell
npm test
npm run test:integration
node node_modules/vitest/vitest.mjs run --config audit/engine-audit-0924.config.js
node audit/engine-data-0924.mjs
```

The audit suite is separate from the default test suite. Its assertions were converted to the desired behavior during the implementation update below. The data script only reads stored data; it does not infer whether missing historical X posts exist.

Fix backfill coverage/checkpoint handling and service-aware quality validation first. Fix the per-fault water override and typed-edge undo before repairing affected water history. Then address filter scope, fingerprints, and restoration percentages. Recompute affected stored results with backups after the deterministic fixes; do not treat rerunning the current engine as a repair for these defects.

## Implementation update — 24 September 2026

All eight reported code defects were addressed in the working tree. Historical backfill now stores complete X pages and keeps its original bounds and cursor on ingestion-run records. Only an initial bootstrap can establish a live high-water mark; established marks are not advanced by a separate historical window. Unfinished historical windows continue to hold their account's pending posts until the window completes. The `maxPosts` safety ceiling is now soft by one page, because a fetched page must be committed in full.

Quality, review, evaluation, audit and reread paths select each service's current reader version and fault layout. Water fingerprints include operational conditions and per-fault water assets. Split water faults retain their own states during refolding, stale confirmed restorations can become restored, and a reopened water incident clears an inherited 100% value. Requested account filters remain in force while incomplete accounts are excluded. Typed edge evidence is decoded consistently for graph learning, snapshots, removal and undo.

The four outages linked to post `2100174345494548955` were refolded under the pipeline lease with [a backup](../api/data/backups/water-refold-2100174345494548955-2026-09-24T21-18-59-496Z.json). Helderkruin Reservoir and CR Swart Booster Pump Station now show `RESTORED/NORMAL`; Helderkruin Tower remains `STALE/RECOVERING`; Vuurlelie Booster Pump Station is `STALE/NO_SUPPLY`. The repair script supports an undo from that backup if the outages' posts have not changed. The existing open review queue and stale electricity readings were left for separate editorial/paid reread work.

The original characterization suite was converted to desired-behavior assertions and passes **13/13**. New disposable-database tests cover service-aware water quality, typed-edge undo and legacy multi-fault refolding. The final unit suite passed **375/375** and the full integration suite passed **208/208** across 16 files. `npm run eval:all` reported **4,137/4,142** expected dispositions, including the previously omitted water readings; the five exceptions are four existing `GENERAL_NOTICE` versus `NEEDS_REVIEW` disposition disagreements and one genuine Tshwane review item. `npm run audit` still exits `1` for that review item, with zero hard failures in its checked outage, water-type and cross-service categories. `git diff --check` passed.
