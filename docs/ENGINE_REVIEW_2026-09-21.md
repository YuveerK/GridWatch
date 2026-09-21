# Ingestion engine review — 21 September 2026

Reviewed checkout: `96f096b`, including the current working tree. Scope: fetching, extraction, fault splitting, infrastructure learning, outage matching/state, reprocessing, and the checks intended to establish ingestion quality. Existing client changes and the earlier API audit were left intact. This is a review, not a remediation.

The engine has a good foundation: durable pagination, a shared renewable lease, per-fault decisions, transactional outage updates, stored event effects, and a substantial test suite. Its remaining weakness is that “processed successfully” does not establish that the interpretation or outage assignment is correct. Some automatic corrections and repair paths themselves introduce errors.

## Verification and current data

- Existing unit suite: **193/193 passed**.
- Existing integration suite: **115/115 passed**, on its own disposable PostgreSQL database.
- Added isolated audit evidence: **8 mocked/pure tests and 4 disposable-database tests passed by reproducing defects**. These are characterization tests, deliberately outside the normal suite; passing does not mean the behavior should be preserved.
- Read-only `npm run audit`: 203 outages, 981 current-version readings, zero reported invariant failures, zero review/error/unprocessed posts at the time checked.
- Read-only `npm run batch -- --all`: latest nonempty batch contained one Longmeadow update, published 20:25 UTC on September 21. Its existing checks passed. This is a structural check, not independent verification of its source image or semantic interpretation.
- No live X/Gemini calls, live reprocessing, or application-data changes. Test databases were removed by test teardown. No application server was started.

Stored-database evaluation, with strict missing/non-outage checks and an illustrative 95% F1 gate:

| Label set | Labelled posts | Precision | Recall | F1 |
|---|---:|---:|---:|---:|
| links | 105 | 94.5% | 96.3% | 95.4% |
| holdout-0910 | 69 | 95.3% | 96.8% | 96.1% |
| holdout-0911 | 71 | 94.4% | 97.1% | 95.8% |
| holdout-0912 | 37 | 100% | 100% | 100% |
| holdout-0914 | 56 | 96.4% | 96.4% | 96.4% |
| holdout-0915 | 43 | 100% | 100% | 100% |
| cases-0921 | 42 | 100% | 77.8% | **87.5%** |

All labels were present. Every set contained **zero non-outage examples**. These are pairwise grouping scores, not the percentage of posts ingested correctly. The database contains 17 manual overrides, and `cases-0921` explicitly says it was labelled after inspecting engine output. These results measure existing assignments, not fresh, unassisted end-to-end accuracy. No full replay or new independent image labelling was performed.

## Findings

### E01 — Future or impossible restoration is treated as completed restoration

**High; reproduced.** [restored-places.js:6](../api/src/lib/restored-places.js#L6), [processor.service.js:86](../api/src/modules/processing/processor.service.js#L86), [outage-state.js:16](../api/src/modules/outages/outage-state.js#L16).

`markRestoredPlaces` matches “restored to/in/for” without requiring a completed event. Both “Power **will be restored to Alpha by 23h00**” and “Power **cannot be restored to Alpha until repairs are complete**” change Alpha from AFFECTED to RESTORED. When Alpha is the only named suburb, `statusFor` promotes a REPAIRING reading to a fully RESTORED outage.

Fix: require affirmative completed restoration evidence, handle tense/negation, and preserve uncertainty. A proposed restoration must never override an affected locality. Add cases for future, conditional, negated, quoted, and partial restoration language.

### E02 — Reprocessing an opening post splits an unchanged outage

**High; reproduced with real PostgreSQL.** [processor.service.js:234](../api/src/modules/processing/processor.service.js#L234), [linker.service.js:76](../api/src/modules/outages/linker.service.js#L76).

Two posts at 10:00 and 10:01 link to one outage. Reprocessing the 10:00 post removes it and refolds the original outage, moving that outage's `startedAt` to 10:01. The candidate filter requires `startedAt <= incoming publication time`, so the original outage is now ineligible for the 10:00 post. A second outage is created, even with identical extraction and equipment.

Fix: preserve the original assignment as an explicit repair candidate when its identity is unchanged, or stage and replay the affected event group transactionally. Test opening/middle/latest posts, unchanged reprocessing, multi-fault siblings, and repeated repairs. Require equivalent membership after an unchanged repair; do not simply remove the temporal filter globally.

### E03 — An uncertain reread can erase a previously published outage

**High; reproduced in extraction and real-database repair tests.** [extraction.service.js:130](../api/src/modules/ai/extraction.service.js#L130), [processor.service.js:240](../api/src/modules/processing/processor.service.js#L240).

A forced reread protects an old successful reading only when the new result is completely absent. A valid but low-confidence result, or a result with a failed image, overwrites the successful reading with NEEDS_REVIEW. Reprocessing has already committed deletion of the original outage links before it obtains the replacement. For a one-post outage, the published outage disappears while the post waits for review. The deletion, evidence removal, new extraction, and new assignment also span separate commits.

Fix: stage the replacement reading first, keep the last accepted interpretation visible, validate it, then atomically replace the contribution. Record unsuccessful/uncertain rereads as separate attempts. A crash or rejected replacement must leave the previously accepted outage intact.

### E04 — An already-separated fault can be silently discarded as a digest

**High; reproduced.** [linker.service.js:20](../api/src/modules/outages/linker.service.js#L20), [linker.service.js:417](../api/src/modules/outages/linker.service.js#L417).

The digest predicate is `!fromDigest && rootCount >= 3 || (rootCount >= 2 && nodes.length >= 4)`. The second branch applies even to an individual fault already split out of a graphic. A fault with four equipment nodes and two independent roots, with no matching outage, receives `NEW` and “no outage created.” It is neither published nor queued for review. Batch checks only check that sibling faults do not share an outage; they do not establish that every expected fault received a valid disposition.

Fix: apply the `!fromDigest` condition to the whole umbrella-digest predicate. Require explicit per-fault outcomes and a reason for any intentionally excluded fault. A positive outcome such as `NEW` should not ambiguously mean both “opened an outage” and “discarded.”

### E05 — Database lease ownership is not checked on all writes

**High; reproduced with real PostgreSQL.** [ingestion.service.js:147](../api/src/modules/ingestion/ingestion.service.js#L147), [ingestion.service.js:174](../api/src/modules/ingestion/ingestion.service.js#L174), [processor.service.js:104](../api/src/modules/processing/processor.service.js#L104).

Outage link commits check database ownership, but ingestion page/checkpoint commits and infrastructure learning do not. `ctx.assertHeld()` only reads an in-memory flag updated by the heartbeat. During expiry/takeover there is a window where the worker has lost database ownership but has not noticed it.

Tests using an unowned context with `lost=false` show (1) ingestion commits a post and completed checkpoint successfully and (2) processing writes nodes and evidence before the final outage commit correctly rejects the expired owner. This proves missing fencing; it is not a claim that a takeover occurred in the current database.

Fix: check the held lease inside every authoritative write transaction, including checkpoint advancement and graph mutation; propagate context throughout. Test paused worker A, expiry, worker B takeover, and A resuming. Only B's writes should commit.

### E06 — Overall partial restoration overrides explicit suburb restoration

**Medium; reproduced.** [outage-state.js:88](../api/src/modules/outages/outage-state.js#L88), [linker.service.js:290](../api/src/modules/outages/linker.service.js#L290).

For “40% restored; Alpha restored, Beta affected,” the state fold calculates `restored = status === 'RESTORED' || (!partial && l.restored)`. Because the overall percentage is partial, it stores Alpha as unrestored despite explicit locality evidence. The legacy updater has the same behavior.

Fix: distinguish overall progress from an explicit per-suburb statement. Keep the outage partial while marking the specifically restored suburb restored. If the source only claims partial restoration *within* Alpha, represent that uncertainty separately rather than treating every partial percentage as a veto on locality facts.

### E07 — Refresh cleanup silently skips because its arguments do not match

**Medium; reproduced through the real sweep function.** [cycle.js:69](../api/src/modules/processing/cycle.js#L69), [cycle.js:136](../api/src/modules/processing/cycle.js#L136), [linker.service.js:450](../api/src/modules/outages/linker.service.js#L450).

The cycle calls `sweep({ ctx })`; `sweepStaleOutages` expects `(now = new Date(), { ctx } = {})`. The held context is consequently lost, and sweep tries to acquire the lock already held by its caller. It returns `{ skipped: true }`, which the cycle ignores before reporting success. With no competing lease, the misplaced object would instead fail at `now.getTime()`.

The separately scheduled hourly sweep uses the correct no-argument call, which limits the impact when scheduling is enabled. With scheduling off, manual refresh never performs its intended sweep. The existing cycle test mocks the same incorrect one-argument contract, so it misses the wiring defect.

Fix: adapt the dependency or standardize the signature; test the real composition and treat an unexpectedly skipped required stage as incomplete.

### E08 — Node evidence counters and their idempotency records can disagree

**Medium; reproduced with an injected counter-write failure.** [infrastructure.service.js:187](../api/src/modules/infrastructure/infrastructure.service.js#L187), [infrastructure.service.js:199](../api/src/modules/infrastructure/infrastructure.service.js#L199).

For an existing node, the contribution record commits before the counter update. If the update fails, retry sees an existing contribution and never increments the counter. The test leaves a two-source node at evidenceCount=1/CANDIDATE. For a new node, creation and recording its first contribution are also separate, permitting overcount on a retry after the opposite failure boundary.

Fix: make node creation/update and contribution insertion one fenced transaction, as edge contributions already do for atomicity. Test failure at each write boundary, not just successful duplicate processing.

### E09 — Existing data shows unstable incident kind and equipment identity

**Medium; observed assignments and source-confirmed contributing rules.** [linker.service.js:33](../api/src/modules/outages/linker.service.js#L33), [scoring.js:33](../api/src/modules/outages/scoring.js#L33), [scoring.js:53](../api/src/modules/outages/scoring.js#L53).

The ten labelled Glenanda isolation posts currently occupy four outages. Their readings describe Amanda Avenue as CABLE, LINE, and OTHER at different points. This turns a shared name into conflicting equipment IDs. The emergency-isolation restoration posts are classified as UNPLANNED when their relevance becomes UPDATE/RESTORATION: `isPlanned` recognizes a limited planned/scheduled phrase list, and the candidate scorer forbids cross-kind matches.

Concrete records: `2098379826721644652` opens a second PLANNED outage with LINE/Amanda Avenue; `2098397953366847909` opens UNPLANNED; `2099516703675658716` opens another UNPLANNED restoration. These produce 24 wrongly split labelled pairs. The current source explains contributing failure modes; this review did not replay the historical decisions to attribute every split to a single rule/version.

Fix: extract incident kind separately from update status, including per-fault kind in graphics. Preserve a stable programme/incident identity across daily restoration and resumptions. Resolve uncertain equipment type against known identities with supporting evidence; do not globally merge all cable/line/other names or loosen the planned/unplanned boundary.

### E10 — Rereading can update the interpretation without updating its outage effect

**Medium; source-confirmed.** [reread.js:86](../api/scripts/reread.js#L86).

`reread.js` recommends relinking only when fault count/layout or relevance changes. A new reading can change status, restored suburbs, cause, ETA, equipment, or dates while retaining the same relevance and fault count. Summaries/extractions then change, but the persisted `OutagePost.effect`, link decision, graph contribution, and outage aggregate remain based on the previous reading. The normal pending processor will not repair an already completed post.

Fix: fingerprint all fields that affect matching, learning, and state. Reconcile every accepted changed contribution, not merely changed fault counts. Link each decision/effect to a specific immutable reading revision and report mismatches automatically.

### E11 — The health scripts can return success while important work is missing

**Medium; source-confirmed.** [batch-report.js:12](../api/scripts/batch-report.js#L12), [batch-report.js:27](../api/scripts/batch-report.js#L27), [batch-report.js:70](../api/scripts/batch-report.js#L70), [audit.js:91](../api/scripts/audit.js#L91).

- Batch reporting only searches the last six runs. Six empty polls hide the last nonempty batch; it prints “No fetch has brought new posts yet” and exits zero.
- It hardcodes prompt version `outage-extraction.v1` rather than the configured version.
- It checks for *any* link decision and distinct sibling outage IDs, not a complete set of expected per-fault decisions and memberships. E04 can therefore pass.
- The general audit prints review/error/unprocessed counts but does not include those counts in its failing exit status. It does not check stuck PROCESSING work or ingestion cursor age/completeness.
- The planned-window audit uses age since last update rather than the actual stored scheduled window.

Fix: audit an explicit persisted cycle/run ID and its exact post/fault membership; query the latest nonempty run directly; use the configured reading version. Report degraded/incomplete/review states distinctly, with exit status and durable results suitable for automation.

### E12 — The image-host allowlist accepts unrelated domains

**Medium; reproduced without making a request.** [extraction.service.js:33](../api/src/modules/ai/extraction.service.js#L33).

The regex `/(^|.)twimg.com$/i` uses wildcard dots. `https://not-twimg.com/image.jpg` passes the claimed trusted-host restriction. Exploitability depends on untrusted media metadata entering storage; no such live payload was found or fetched.

Fix: compare `hostname === 'twimg.com' || hostname.endsWith('.twimg.com')`, retaining HTTPS-only requests, redirect refusal, size bounds, and deadlines. Test deceptive suffixes as well as real subdomains.

## Replacing repeated manual post reviews

Build on the existing batch report, decision records, and stored effects rather than adding an unconditional second AI read of every post.

1. **Persist a quality result after each cycle.** Record run ID, exact post IDs, expected fault indexes, checkpoint completeness, accepted reading revision, disposition, changed outage IDs, failures, and review reasons. Use clear COMPLETE / INCOMPLETE / NEEDS_REVIEW / FAILED states. The refresh result is currently in memory and is not a durable processing-quality record.
2. **Run deterministic checks automatically.** Require every expected fault to have exactly one accepted disposition; linked dispositions must have a matching timeline effect. Check reading/effect revision agreement, temporal order, restoration/locality contradictions, dropped fault siblings, overdue/stuck work, and incomplete pagination. Make these checks part of cycle completion, with an operator-visible result.
3. **Separate operational retries from ambiguity.** Retry transient AI/network tie-break failures with bounded backoff. Currently a failed tie-break becomes NEEDS_REVIEW and leaves the automatic pending set, even if the provider immediately recovers. Keep genuine semantic ambiguity for review; track attempts, next retry time, and last error separately.
4. **Review only suspicious changes.** Prioritize a new outage next to a similar active one, a restoration without a credible preceding incident, conflicting incident kinds, discarded faults, equipment identity changes, uncertain images, and changed scope. Give an optional independent verifier the source text/image and before/after assignments, require quoted evidence, and queue disagreement rather than letting it silently rewrite published state. Add a small sample of apparently clean posts to detect blind spots. This verifier would need separate implementation and a spend cap.
5. **Turn each correction into a test case.** Store full external IDs plus fault indexes, input text/image or a stable fixture, expected entities/localities/status, and expected incident membership. Separate untouched chronological holdouts from cases used to tune rules. Include notices/replies, future and negated restoration, mixed graphics, multi-day maintenance, typos, delayed posts, and failed images. Measure extraction, fault coverage, grouping, and final state separately.
6. **Make repairs staged and reversible.** Preview old versus proposed readings, links, and locality state; apply the accepted replacement atomically. Preserve the original source and reading revisions. Require live incremental processing, retry, and unchanged replay to agree on outage membership/state.

Suggested order: fix E01–E05 first; repair the batch validator and wire it into each cycle; address locality/identity/reread issues; then add selective independent verification. Broader fuzzy matching or more model calls alone will not correct the deterministic bugs above.

## Reproducing this review

From `api/`:

```powershell
npm test
npm run test:integration
npx vitest run --config audit/engine-review.config.js
npx vitest run --config audit/engine-review.integration.config.js
npm run audit
npm run batch -- --all
node scripts/eval.js --file=cases-0921.json --strict-missing --strict-none --min-f1=95
```

The two `engine-review` suites intentionally assert current defective behavior. When fixing a finding, convert its evidence into a normal regression test asserting the desired behavior. The integration configurations create and drop their own databases; the audit/batch/eval commands only read application data. The final evaluation command currently exits 1 because F1 is below the selected threshold.
