# Follow-up review of 861f807 — 22 September 2026

The rebuild and new controls are present. This follow-up checks the new quality, review, retry, and undo behavior rather than repeating the original audit.

## What was verified

- Engine commit `861f807` is present. During review HEAD advanced to `54e0050`; that additional commit adds the existing audit documents/tests and client changes, without changing the reviewed API implementation.
- Port 4000 already runs Node PID 60292, started at **01:17:48 SAST**, after `861f807` at **01:14:22**. `/v1/quality/status` responds and a scheduled cycle had recorded COMPLETE at **01:23:14 SAST**. The requested activation had already happened; another restart was unnecessary. This review did not start or stop a server.
- **276 unit tests and 163 integration tests passed**. Integration tests used the repository's disposable database setup.
- Added **7 isolated characterization tests** reproducing the findings and scheduling behavior below. These passed by asserting observed behavior, not the intended fixed behavior. No real AI calls were made.
- Read-only health audit: **203 outages**, 986 current-version readings, no reported review/error/unprocessed/stuck posts. The earlier 204-outage count is not the current snapshot count.
- Current stored assignments: hard cases **100% F1**, holdout-0911 **96.5%**, holdout-0914 **98.2%**, matching the reported improvements. Stored correction pairs are **18/18** and final-state checks **15/15**.
- `eval:all` reads the current database, including manual corrections; it does not itself measure unassisted replay. The reported **14/18 unassisted corrections** and **14/15 unassisted final states** were not independently replayed in this review. Accepted-reading coverage is not semantic extraction accuracy.
- No application source or live data was changed by this review. Added only the follow-up report and isolated tests.

## Remaining findings

### F01 — Undo overwrites contributions from newer posts

**High; reproduced with PostgreSQL.** [repair.js:82](../api/src/modules/processing/repair.js#L82), also the edge and node/locality upserts immediately below.

Restore first removes the repaired posts' current contributions, then writes the snapshot's *absolute* graph counters and timestamps. If another post has since contributed to the same node, its evidence record remains but its increment is overwritten.

Reproduction: process two Alpha posts, snapshot the second, reprocess it, process a third Alpha post, then undo the repair. The node changes from evidenceCount **3 to 2**, while **three NODE contribution records remain**. The lease prevents simultaneous writers during undo; it does not protect work committed between snapshot and undo. Restoring an older lifecycle or first/last-seen time has the same class of risk.

An immediate undo with identical before/after counts does not test this case.

Fix: restore the selected posts' contribution records and recompute affected counters/timestamps/lifecycle from current evidence, preserving later posts. If legacy baselines prevent exact recomputation, detect changed dependencies and refuse a conflicting undo with a specific explanation. Test new evidence arriving before undo and undoing the same snapshot twice.

### F02 — Coverage checks miss broken NEW assignments and duplicate timeline membership

**High for the monitoring guarantee; reproduced.** [quality.js:23](../api/src/modules/processing/quality.js#L23).

The checker requires a matching timeline entry only for `LINKED`. A `NEW` decision with an outage ID and no timeline entry passes. A valid LINKED entry plus a second entry for the same fault in another outage also passes, because timeline entries are checked only for unexpected fault indexes.

Both examples return zero problems in the new evidence tests. These conditions can therefore be included in a claimed 100% coverage result.

Fix: for both NEW-with-outage and LINKED, require exactly one timeline entry for `(postId, faultIndex)` and require its outage ID to match the decision. Validate the reverse relationship too. Explicit exclusions must have zero timeline entries. Include mixed-fault SDC summaries when checking excluded fault outcomes.

### F03 — Open review items do not affect the quality verdict

**Medium; reproduced with PostgreSQL.** [quality.js:148](../api/src/modules/processing/quality.js#L148).

Quality counts only source posts with `processingStatus === NEEDS_REVIEW`. Suspicion detection creates separate ReviewItem rows while successfully processed source posts remain RELEVANT. A covered post with an OPEN, high-priority KIND_CONFLICT review item consequently produces **COMPLETE / needsReview=0**.

Fix: include unresolved actionable review items for covered posts in the assessment, with routine sampling distinguished from actual concerns. If COMPLETE is deliberately restricted to structural pipeline execution, expose a separate review verdict and outstanding count so it cannot be read as “nothing needs attention.” The public endpoint currently only exposes the cycle verdict, not this distinction.

### F04 — A failed assessment can leave a successful-looking cycle and stale public quality status

**Medium; reproduced at cycle level.** [cycle.js:92](../api/src/modules/processing/cycle.js#L92), [routes.js:692](../api/src/modules/api/routes.js#L692).

When `assess` throws, the cycle logs the error and still returns `state: done` with `quality: null`. The status endpoint serves the most recently saved assessment, which may be an earlier COMPLETE result. The promised quality record for every cycle is then missing without an explicit degraded verdict in the cycle result.

Review-stage failures are similarly logged and swallowed. The next cycle scans newly covered posts, so a skipped review pass is not guaranteed to revisit the previous batch.

Fix: persist a cycle record at start, update it through completion, and make assessment/review failure an explicit required-stage outcome. Retain pending review work for retry. Report freshness/current-cycle identity alongside the latest successful quality result; database unavailability must not be interpreted as a clean assessment.

### F05 — The verifier's daily cap counts distinct items, not calls

**Medium; reproduced with a mocked provider and real database.** [verifier.js:30](../api/src/modules/review/verifier.js#L30), [verifier.js:71](../api/src/modules/review/verifier.js#L71).

The budget query counts ReviewItem rows whose latest verdict was saved today. Rechecking one item overwrites the same JSON column, so additional calls do not increase usage. With maxPerDay=2, the test makes three calls to the same item and still reports one call remaining. Concurrent callers can also pass the count check before either saves its verdict.

The automatic pass normally selects unverified items, which narrows routine exposure; the explicit CLI verification path can repeat an item. A failed result write also loses the spend record.

Fix: reserve a call in an append-only attempt ledger atomically before contacting the provider. Count attempts/reservations, including failures and repeated item checks. The verifier remains off by default, so this finding does not imply current unexpected spend.

### F06 — The documented six-hour retry is never scheduled

**Low/medium; source-confirmed.** [processor.service.js:209](../api/src/modules/processing/processor.service.js#L209), [linker.service.js:397](../api/src/modules/outages/linker.service.js#L397).

An initial failure creates attempts=1 and a five-minute retry. The retry worker increments attempts *before* calculating its next time and gives up at attempts>=5. It therefore runs the queued retries after gaps of 5, 15, 45, and 120 minutes, then stops. The backoff's 360-minute entry is unreachable in this path. Also, `retryTransient` defaults to two retries after the initial call, or three total attempts; “retried three times” is ambiguous.

Fix: separate initial failure count from automatic retry count, or adjust termination/indexing to match the promised schedule. Test the entire queue lifecycle through exhaustion with a controlled clock, rather than only each backoff helper value.

## The intermittent concurrency test

[linking.test.js:83](../api/tests/integration/linking.test.js#L83) starts two promises and insists exactly one returns BUSY. Starting promises together does not guarantee the database observes both acquisition requests before the first worker releases its lease.

The new test deterministically delays the second lease-acquisition query until the first call completes. Both calls are invoked before awaiting either; results are **NEW, ALREADY_LINKED**, with **one outage, one decision, and one evidence contribution**. The original BUSY assertion would fail although the processing result is correct.

This is a reproduced explanation for the flaky assertion, not proof of the historical failure's exact cause without its output. Fix the test by using a barrier to hold the first worker inside the lease before starting the competing request; test serialized duplicate requests separately. Keep the database/evidence invariants in both tests. Do not weaken duplicate-state assertions or rely on repeated reruns as a fix.

## Limits of the independent verifier

The verifier checks one source post, the first extractor's image transcription, and a short description of the chosen outage. It does not receive the original image or the candidate outage's source timeline. A real quote proves textual presence; it does not establish that the image was read correctly or that two similarly named incidents are the same fault. Use it as a selective review aid, not an independent end-to-end accuracy guarantee. Supplying source images and relevant candidate evidence would make that check stronger.

## Suggested next steps

Fix F01 and F02 first, then make the quality endpoint reflect unresolved review and failed assessment. Add call reservations before enabling the verifier. Stabilize the concurrency test with explicit overlap, and verify the full retry schedule. A small operator screen showing current quality, outstanding review items, and source/assignment evidence would then make these controls practical without repeated agent prompts.

Run the isolated follow-up evidence from `api/`:

```powershell
npx vitest run --config audit/followup-review.config.js
```

It creates and removes a disposable database using the existing global setup. AI responses and tie-break cache writes are mocked. Convert these characterization assertions to desired-behavior regression tests when the findings are fixed.
