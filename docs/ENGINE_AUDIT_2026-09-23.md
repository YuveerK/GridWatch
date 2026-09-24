# Engine and ingestion audit — 23 September 2026

The latest ingestion batches are structurally healthy, but the engine has correctness gaps. This audit found **eight actionable issues**, including wrong municipality assignments in stored data, missing outage coverage, and reproducible pagination and undo defects. Existing tests passing does not rule these out.

## Scope and validation

Reviewed ingestion/checkpoints, processing order, multi-account behavior, infrastructure/locality resolution, outage linking and folding, repair restoration, geocoding, and quality checks. Read application data without changing it. No X ingestion, AI rereading, repair, or application server start/stop was performed.

- Existing unit suite: **296/296 passed** across 28 files.
- Existing integration suite: **183/183 passed** across 14 files; disposable PostgreSQL database.
- New isolated characterization suite: **7/7 passed**. Here a passing test means the defect was reproduced, not that the engine is correct. X, AI and tie-break cache writes are mocked. Its disposable database was removed.
- Latest three non-empty fetch runs: **7 posts**, all built-in batch checks passed.
- Full data audit: **exit 1**, with one outage lacking equipment/suburbs and one post awaiting review. No unprocessed/stuck posts at inspection.
- Both active source accounts had completed checkpoints, no pending cursor, and successful fetches around **10:01 UTC**.
- Stored-data evaluation: **1,995/1,999** expected fault dispositions accepted; holdout mean F1 **98.2%**; **54/54** corrections and **15/15** final-state expectations hold on the current database. These are not an unassisted replay or a measure of semantic extraction accuracy.
- Public quality calculation: **NEEDS_REVIEW**, with **81** open concerns. The latest cycle itself was COMPLETE with zero posts.

## Findings, in priority order

### 1. P1 — Municipality is missing from identity resolution

Sources: [locality lookup](../api/src/modules/infrastructure/infrastructure.service.js#L108), [first-match fallback](../api/src/modules/infrastructure/infrastructure.service.js#L131), [equipment identity](../api/src/modules/infrastructure/infrastructure.service.js#L159), [learning](../api/src/modules/infrastructure/infrastructure.service.js#L279), [candidate selection](../api/src/modules/outages/linker.service.js#L84).

The locality index spans every municipality, but resolution receives only a name and previously associated locality IDs. It falls back to the first name match. Equipment is also globally identified by `(type, normalizedKey)`, and outage candidate selection has no source or municipality boundary. Although SourceAccount stores municipalityId, that context does not reach these decisions.

**Observed in stored data:** four Tshwane outage/locality associations point into Johannesburg regions:

- Orchards in Johannesburg Region E on two Tshwane Orchards transformer incidents, including post `2092095043850957167`.
- Naledi in Johannesburg Region D on the Mamelodi 1 incident, post `2081399174063427632`.
- Orange Farm in Johannesburg Region G on the Soshanguve/Buffel interruption, post `2092270432036528349`.

These are wrong geographic matches: the source texts/transcription identify Tshwane contexts. The same defect can combine incidents: the isolated test processes two utilities' same-named station/suburb reports and produces one shared node and one outage. No already-mixed-source outage was found in the inspected database.

**Fix:** carry source account and municipality through learning/linking; scope exact, alias and fuzzy locality matches; namespace equipment identity appropriately; require explicit evidence for cross-utility relationships. Repair the four known wrong associations and their graph contributions after the resolver is fixed.

### 2. P1 — Page-budget exhaustion breaks chronological processing

Sources: [ingestion page budget](../api/src/modules/ingestion/ingestion.service.js#L186), [processing after ingestion](../api/src/modules/processing/cycle.js#L50), [exclusion of later-started candidates](../api/src/modules/outages/linker.service.js#L93).

X pages arrive newest first. A budget-exhausted fetch correctly retains its cursor and reports `SUCCEEDED` plus `incomplete: true`, but the cycle immediately processes those newer posts. An older page arrives in the next cycle. Sorting each cycle's stored posts does not restore ordering across cycles.

**Reproduced:** page one contains Alpha's restoration; page two contains its original incident. With a one-page budget, two cycles leave **two outages: one RESTORED and one ACTIVE**. When the older incident arrives, the existing restoration outage is excluded because it started after that post. The checkpoint loses no posts, but the resulting incident history is wrong.

**Fix:** stage an incomplete account interval until it can be processed in chronological order, or explicitly reconcile/replay late pages with already processed posts. Retain a regression spanning ingestion and processing together. The trigger is a reached page cap, such as initial backfill or an extended backlog; the current latest checkpoints were complete.

### 3. P1 — One failing source blocks processing for all sources

Sources: [combined account result](../api/src/modules/ingestion/ingestion.service.js#L144), [early cycle abort](../api/src/modules/processing/cycle.js#L50).

Ingestion stores successful accounts' pages but reduces any account failure/rate limit to an overall failure. The cycle then throws before processPending, retries, and cleanup. A persistently unavailable secondary account can therefore prevent the healthy account's new posts and existing backlog from updating the site every cycle.

**Reproduced:** an ingestion result with one inserted post and a second-account failure never calls processing.

**Fix:** record per-account fetch failures, continue safe processing and maintenance for completed account intervals, and report a degraded/failed fetch result separately. Coordinate this with finding 2 so incomplete intervals are not processed out of order. Both accounts were fetching successfully at inspection; this is a reproduced failure-mode defect.

### 4. P1 — Undo falsely reports “already restored” when a reading/effect changed

Source: [restoreSnapshot early return](../api/src/modules/processing/repair.js#L72).

The idempotency signature compares only outage membership and evidence identities/counts. It ignores extraction content, summaries, timeline effects, decisions and overrides, despite the snapshot containing them. A reread/reprocess can change the cause or restoration state while retaining the same outage and equipment.

**Reproduced:** snapshot a post, change its accepted cause, and reprocess it into the same outage. Undo returns `alreadyRestored: true`; both the changed reading and incorrect outage cause remain. This is separate from the absolute-counter overwrite fixed after the earlier audit.

**Fix:** make the restore operation idempotent across all restored state, or use an explicit restore receipt/version and detect subsequent changes. Do not use topology equality as proof that a content repair was undone.

### 5. P1 — A real incident with five components can still be discarded as a digest

Source: [genuineDigest threshold and exclusion](../api/src/modules/outages/linker.service.js#L459).

The recent change permits smaller co-affected equipment lists, but five nodes still trigger digest exclusion when roots are independent and no candidate matches. Equipment count is not proof of multiple unrelated faults. An accepted `OUTAGE` reading with `faults: []` can produce no outage while its SourcePost becomes RELEVANT.

**Observed and reproduced:** Tshwane post `2095925343920013396` says one medium-voltage outage affects Rietfontein/Deerness and lists components. Its accepted reading contains five equipment entities, two localities, confidence 1, and zero separate faults. Its decision says `digest post covering several faults: no outage created`. It has no outage timeline entry. A synthetic five-component incident reproduces the same result.

**Fix:** distinguish explicit independent faults from components of one incident. If still ambiguous, request review rather than recording an accepted exclusion. Correct/reprocess the known post after the rule is fixed. Disposition coverage currently accepts this reasoned exclusion, so 99.8% coverage understates this missing incident.

### 6. P2 — Already-separated digest faults lose geographic scope

Sources: [expand flag](../api/src/modules/outages/linker.service.js#L275), [scope folding](../api/src/modules/outages/outage-state.js#L107).

Every `fromDigest` update joining an existing outage is assigned `expand: false`, even after faultItems has separated a graphic into independent faults. Its own equipment and newly affected suburbs cannot enter the outage. That restriction also remains attached to the effect after repairs remove earlier scope-establishing posts.

**Two reproductions:**

1. A separated fault names a newly affected suburb alongside the original suburb. It links successfully, and the new locality is learned, but that locality never appears on the outage.
2. Move the opening post to another incident. Its old outage retains a digest update but has **zero OutageNode and OutageLocality rows**.

**Observed matching state:** `River (Pretoria CBD)`, outage `cmudtuy4w0001iyp8n4qbyy8c`, has two remaining posts and no linked equipment/suburbs. Both stored effects contain equipment/localities but have `expand: false`. This confirms the same folding condition, not the exact historical repair sequence.

**Fix:** let a separately identified fault establish/update its own legitimate scope. Preserve the restriction for unsplit umbrella updates where appropriate. Recompute scope coherently when an opening contribution is removed.

### 7. P2 — The fallback geocoder is still restricted to Johannesburg

Sources: [bounding box](../api/src/modules/geo/geocode.service.js#L12), [query suffix](../api/src/modules/geo/geocode.service.js#L45), [result acceptance](../api/src/modules/geo/geocode.service.js#L137), [permanent miss marker](../api/src/modules/geo/geocode.service.js#L156).

The fallback always appends `Johannesburg` and uses a Johannesburg bounding box for every locality. It also rejects cached/known positions outside that box. New Tshwane places can therefore be misplaced to Johannesburg namesakes or marked `geoSource: none`; routine later cycles skip those misses unless retry is requested.

**Source-confirmed and checked against stored coordinates:** all 318 imported Tshwane places already have GIS coordinates, so those positions are preserved. However, **268 of those 318 valid coordinates fall outside the fallback's acceptance box**. The bug concerns newly learned/unplaced Tshwane localities, not destruction of the existing GIS import.

**Fix:** resolve municipality before fallback geocoding and use its search context/bounds. Scope the known-place cache too. Revisit failed Tshwane lookups after the change.

### 8. P2 — Ingestion health audits check only the env-default account

Sources: [audit.js](../api/scripts/audit.js#L79), [batch-report.js](../api/scripts/batch-report.js#L151), [default ingestion status](../api/src/modules/ingestion/ingestion.service.js#L65).

Ingestion polls all active SourceAccount rows, but both health scripts inspect only `env.X_SOURCE_ACCOUNT_ID`. A stale/missing/incomplete checkpoint for Tshwane is invisible to their ingestion-health checks while Johannesburg is healthy. The latest non-empty batch need not be from the failing account either.

**Fix:** assess every active account, identify each problem by account, and aggregate health. This is a source-confirmed monitoring gap; this audit separately checked both accounts and found neither currently incomplete.

## Other current data requiring attention

- **1,671 of 1,690 stored readings** differ from the current prompt/model fingerprint. This establishes staleness, not that all those readings are wrong. A bounded reread followed by relinking changed results is appropriate after the deterministic bugs are fixed.
- **81 open review items**, including **42 on IRRELEVANT posts**, mostly water-service notices flagged because their reading supplied a review_reason. Eighteen items have DISCARDED_FAULT reasons, although the current accepted readings/decisions contain only one linkable exclusion. The queue needs triage; an old warning is not proof of a current missing outage. Avoid dismissing all irrelevant-post items without checking their evidence.
- Four disposition failures: three GENERAL_NOTICE posts retain NEEDS_REVIEW decisions, and one Lynnwood Alpine Way report (`2078737661099982985`) remains NEEDS_REVIEW for missing identifiable equipment/locality. The pipeline's harmless-notice status policy and disposition checker disagree for the first three.
- No stored timeline effect fingerprint mismatch was found. Existing undo counter, disposition, and quality-status fixes were considered; old characterization tests were not treated as current findings.

## Reproduce and next steps

From `api/`:

```powershell
node audit/current-data-check.mjs
npx vitest run --config audit/ingestion-audit.config.js
```

The first command only reads application data. The second creates/removes a disposable database and deliberately asserts the defective behaviors. Convert those assertions to desired behavior as fixes land.

Fix municipality identity, ingestion ordering/failure isolation, and undo first. Then repair the known missing/wrongly scoped incidents, correct geography, and refresh/triage stale readings and review items. Validate fixes against both utilities and the labelled holdouts. The current audit used stored readings and mocked provider responses; it did not test live X/Gemini responses, reread source images, or perform a full history replay.

Only this report and audit helpers/tests were added. Application source and application data were unchanged. No project process was started or left running by the audit.
