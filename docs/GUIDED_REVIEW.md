# Guided operator review

The pipeline is **Fetch posts → read their meaning → separate faults → associate incidents → recompute timelines → check results → review exceptions**.

`/review` is the operator workspace for both services and all active sources. Public map selections do not constrain its inbox. Sign in using the existing operator token/session. Review filters live in the URL, including when following a case and returning to the queue.

## Use the prepared Windows workspace

Double-click `Start-GridWatch.cmd` in the repository root and open **http://localhost:4000/review**. The launcher serves the built client and API together, binds to loopback and runs in its foreground window. Press Ctrl+C to stop it. It starts with automatic fetching paused; **Fetch latest posts** remains an explicit operator action.

This machine's guided-review migration, backfill and coverage comparison have been completed, and correction controls are enabled in `api/.env`. Its existing local operator access is retained, so no new sign-in token is needed for local use. Other deployments retain disabled-by-default corrections until their own rollout checks pass. Rebuild `client/` after frontend changes before using the launcher.

## Everyday use

1. Read the source-coverage summary. A zero decision count does not establish that fetching or checking succeeded.
2. Open a case. Compare the original utility text, media, transcription and stored thread evidence with the selected fault and current incident timeline.
3. Choose a guided action. Named fault sections keep their identities when another section is edited. New sections receive new identities; deleted anchors must be resolved before removing a section.
4. Supply a short reason and an exact source-text quote, or quote evidence from an attached utility image. Water restoration requires explicit customer-supply evidence.
5. Inspect the preview: placements, all affected incident states and areas, timeline changes, empty incidents, sibling faults and provider use.
6. Apply the described change. Read the actual validation and any remaining concerns. A successful operation does not hide a still-blocked fault.
7. Preview undo if necessary. Newer processing or evidence can make direct undo unsafe. A refused undo records an engineering handoff and rejection journal without changing incident data.

“The current result is correct” acknowledges a published result using its evidence version. “I cannot decide yet” saves missing information and retains the case. “Needs engineering” keeps a case in that tab until explicitly rechecked or confirmed, even if its underlying condition disappears. Copying the brief does not resolve or send it anywhere.

Ordinary browsing, inspection and preview are read-only and provider-free. A fresh AI reading uses an explicit request budget (maximum two extraction calls) and the daily review reread allowance. Its result is stored in the action journal as a proposal. Failed or uncertain proposals never replace an accepted reading. No global AI or self-correction setting is changed.

## Data and consistency

- `ReviewCase` indexes stable subjects and workflow notes. Live records determine current concerns; a missed indexing pass cannot conceal blocked posts. Cases are reconciled by cycles and completed repairs, with bounded backfill. Reads scan stored posts in bounded batches without indexing or repairing them.
- Existing review reasons, dispositions, accepted service-specific readings, retries and quality/source-health records feed the inbox. Historical failed extractions do not supersede a current accepted reading.
- `ReadingOverride` retains a versioned typed Electricity or Water reading, original-reading/source fingerprints, stable section mapping, evidence and note. The original machine reading is retained. Source changes/incompatible payloads block processing instead of silently dropping human decisions.
- Existing `LinkOverride` stores durable joins/splits using source-post anchors. Missing anchors defer a join. Once later chronological anchors appear, a bounded stored-evidence pass completes deferred joins without reprocessing siblings. Self references and cycles are rejected.
- `OutagePost` is keyed by incident, post and fault. Two sections can contribute to one incident; resident timelines group the utility post and retain each section’s effect.
- Preview and apply share a deterministic planner and existing service-specific folds. Apply acquires the pipeline lease, checks the fingerprint, durably journals a snapshot, writes atomically, validates the actual result and reconciles cases. Duplicate request IDs return the original result. Busy/stale requests store no corrections. Failed deterministic writes roll back as one transaction.
- `ReviewAction` stores authorization method, request ID, reason/evidence, before/after, manifest, snapshot, execution state and validation. Interrupted journals appear in engineering. Guarded recovery can close an interrupted transaction that made no live changes; changed evidence requires investigation. Undo is itself journaled.
- Repairs recompute from utility evidence and do not replay push notifications. Silence and administrative closure remain distinct from confirmed restoration. Water operating state and customer supply remain separate.

## Rollout

The application ships with `REVIEW_CORRECTIONS_ENABLED=off`. Inspection, provider-free previews and workflow notes remain available. Do not enable mutation controls before checking the deployed data and acceptance paths.

From `api/`, after stopping the API for its normal deployment/restart:

```sh
npm run prisma:generate
npx prisma migrate deploy
npm run review:cases -- --backfill --limit=500
npm run review:cases -- --backfill --limit=500 --apply
```

The preview reports current legacy diagnostic findings, missing work and historical acknowledgements eligible for evidence fingerprint migration. Apply imports missed review flags, preserves prior decisions in the journal, and indexes cases without changing incidents. A legacy acknowledgement carries forward only when its reasons agree and its source, reading, media and processing evidence have not changed since review; otherwise the original note remains in history and the concern reopens.

Repeat the bounded backfill while `remainingFindings` or `remaining` is positive. It acquires the pipeline lease. The first backfill command previews its scope.

Record a fresh check of existing evidence after backfill:

```sh
npm run review:cases -- --check-stored
```

This runs current deterministic quality and proposal checks and records source check freshness. It does not fetch X, call AI, replay posts, mutate incident effects or advance the checkpoint. Its quality record explicitly says `stored-evidence`, retains real ingestion timestamps and reports unresolved concerns rather than claiming that everything is healthy.

Compare the unified queue against legacy diagnostics using the same stored publication window:

```sh
npm run review:cases -- --coverage --from=2026-10-01T00:00:00+02:00 --to=2026-10-02T00:00:00+02:00
npm run eval:all -- --details
npm run audit
```

Coverage comparison performs no repairs or provider calls, reports missing/unindexed diagnostic findings and exits 1 on a gap. Omit the dates to compare all stored posts. Batch reports use ingestion time; use a window containing the same stored posts when comparing them with publication-time coverage checks. Investigate any gaps and current unhealthy stages before enabling corrections. An identical acknowledged finding should stay acknowledged; materially changed evidence must be reviewed again.

Run acceptance checks:

```sh
npm test
npm run test:integration
cd ../client
npm test
npm run build
node scripts/review-ui-test.mjs
```

Integration tests create and drop a disposable PostgreSQL database. The browser smoke test serves fixture evidence in a temporary server, checks desktop/narrow widths and closes its browser/server. It never accesses X, Gemini or live incident data.

Set `REVIEW_CORRECTIONS_ENABLED=on` only after coverage, repairs, validation rollback, recovery and undo checks pass, then restart the API. `REVIEW_REREAD_MAX_REQUESTS_PER_DAY` defaults to 10; setting it to 0 prevents fresh review rereads. Monitor `/admin/review-cases/summary` for source freshness and stage failures, and engineering for unfinished action journals. Keep self-correction at the existing configured setting.

The migration is additive apart from widening the `OutagePost` primary key. Back up the database through the existing deployment procedure. Do not roll back to an old binary that assumes one post per incident after multiple faults have been recorded.

## Engineering and fixtures

Use **Copy investigation brief** for shared equipment, geography, network and engine problems. It includes the source IDs, selected fault, interpretation, candidates, effects, overrides, proposals and attempted actions. Engineering should fix the general mechanism and add realistic regression coverage, then recheck the case. Do not patch outage rows or suppress review checks.

**Export regression evidence** downloads the shared exporter’s association labels and typed human reading. The CLI equivalent is:

```sh
npm run review:cases -- --fixtures=rc_<case-id>
```

Review association labels against `api/tests/golden/README.md` before committing them to the regression set. A reading export is input evidence for a service-specific regression test, not a new holdout. The web server never writes repository fixtures.

An unassisted provider-free replay remains the engine benchmark. To separately verify persisted human decisions through chronological replay:

```sh
node scripts/replay-eval.js --with-human-decisions --sweep-as-of
```

Replay copies source evidence to a disposable database and drops it afterward. It does not fetch X. `--with-human-decisions` deliberately includes overrides, so its accuracy must not be described as unassisted engine accuracy.

The machine-local `api/data/check-checkpoint.json` remains unchanged. Continue the existing checkpoint batch command when explicitly asked to check the latest posts. Page visits, previews, corrections, coverage comparison and explicit-window checks do not advance it. Leave no project processes running after implementation or verification.
