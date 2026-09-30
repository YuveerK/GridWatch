# Engine repair and validation — 30 September 2026

## Scope and outcome

Repaired the current Electricity and Water data using stored readings and reversible snapshots. Gemini was permitted only for bounded incident tie-breaks after explicit user authorization. No source-account settings changed, no global AI reread ran, and no API server was started, stopped or restarted.

The working tree already contained engine, client and mobile changes. This repair preserves those changes; this document describes the additional repair work rather than attributing the entire working tree to it.

## Mechanisms repaired

- Coverage now counts accepted expected fault dispositions independently of obsolete indices and checks that decisions agree with timeline entries. Reports identify the affected source account, post and fault.
- Electricity fault grouping retains source indices, so merging earlier rows cannot move later overrides or summaries. Same-station rows with different lifecycle states or scheduled windows remain separate.
- A reading containing one detailed fault can supply equipment and locality identity even when the top-level reading is empty.
- An Electricity outage naming only a specific customer facility can retain that exact site as an `OTHER` identity. Generic facility references and general notices are excluded; no suburb-wide impact or supply relationship is inferred. This fixes the later Nelson Mandela Children's Hospital post.
- Bare extension names inherit an explicit, exactly matched locality heading in a single-fault Electricity notice. SDC hashtags, unknown headings and multi-fault graphics cannot supply that context. This fixes the later Lenasia restoration while preserving municipality scoping.
- Explicit reschedule and load-reduction captions preserve planned-work classification.
- Historical reprocessing can return a post to its original closed incident. A location-free restoration quoting exactly one incident can link to that historical episode within the configured time window. Cross-service isolation remains enforced.
- Water customer notices are not mistaken for headerless status tables. Numbered units in the same reported reservoir family retain their shared condition; independent asset conditions remain separate.
- Water diagnostics distinguish a legitimate large, explicitly named supply zone from a suspicious combined incident.
- The new disposition repair CLI previews inconsistencies, acquires the pipeline lease, snapshots affected state and rolls back a failed batch. Review tooling exposes IDs and can refresh stale queue conditions.

## Live validation

At 12:19 UTC (14:19 SAST), covering posts received through the 12:15:11 UTC checkpoint:

| Check | Result |
|---|---:|
| Accepted readings, excluding customer replies | 2,896 / 2,896 |
| Accepted expected fault dispositions | 4,119 / 4,119 |
| Missing, invalid or obsolete fault indices | 0 |
| City Power fault dispositions | 2,104 / 2,104 |
| Tshwane fault dispositions | 684 / 684 |
| Water fault dispositions | 1,331 / 1,331 |
| Saved correction expectations | 76 / 76 |
| Final-state expectations | 15 / 15 |
| Water review regressions | 3 / 3 |
| Actionable open reviews | 0 |
| Audit hard failures, including service contamination | 0 |
| Backlog, stuck posts and processing errors | 0 |
| Unit tests | 499 passed |
| Integration tests | 247 passed |

Stored holdout grouping mean remains 98.2% F1, unchanged by the repairs. Stored metrics include manual overrides and do not measure unassisted performance or image-reading accuracy. Existing holdout contamination is documented in `api/tests/golden/README.md`; no golden labels were changed to improve these results.

The first follow-up checkpoint covered 08:03:05–08:41:02 UTC: six City Power posts and one Tshwane post, all unflagged. JHBWater had no new posts in that interval. The next checkpoint covered 08:41:02–12:05:51 UTC: 18 City Power, two Tshwane and five Water posts. It found one unresolved named hospital, subsequently repaired with the general facility-identity fix. Historical NEEDS_REVIEW cycles remain as evidence even though their current review conditions were repaired.

The final checkpoint, 12:05:51–12:15:11 UTC, covered two additional City Power posts. It found a restoration whose reading omitted the explicit Lenasia heading from its extension names. The context fix attached it to the original outage and removed the duplicate restoration incident. A search of accepted historical readings found no other affected posts. Tshwane and Water had no new posts in this final interval.

A validation audit captured one incident immediately after crossing the 48-hour quiet threshold. The normal scheduler subsequently swept it; the later audit confirmed that stale condition was cleared. The intermediate failure remains in the archived log rather than being erased.

The Water report has zero current extraction failures, false restorations, cross-service errors, electricity-typed Water nodes or suspicious giant incidents. Its two posts without current-version readings are intentionally skipped customer-reply-shaped posts. The audit retains 1,794 older-model/prompt Electricity readings as warnings; these are not failed current reads and were not globally reread.

## Reviewed alerts

- Two location-free Tshwane restoration posts now link through their explicit quoted source: `2091513534211321982` and `2085632326944330069`. Their uncertainty alerts were resolved with evidence notes.
- Gresswold's 17 September maintenance is separate from the ongoing 14 September fault. The repaired segmentation produces a distinct planned incident; the nearby-kind alert was dismissed after source inspection.
- The weekly Mayfair and Sebenza footprint alerts were confirmed against their source lists. Sebenza's broad footprint is supported by the subsequent isolation notice explicitly naming seven downstream substations across three SDCs. These alerts were dismissed with evidence notes.
- The later hospital post `2105218278851276938` now opens an incident identified by the hospital itself. Its review resolved through reprocessing; the extraction was reused and no broader suburb was inferred.
- Lenasia restoration `2105269373862617392` now joins the outage reported in `2105211431071228361`. The repair resolved its review and used no fresh AI call.

## Reversibility

Successful repair snapshots are in the gitignored `api/data/backups/` directory:

- `repair-2026-09-30T08-27-12-571Z-dispositions.json` — initial 111-post batch.
- `repair-2026-09-30T08-30-28-016Z-dispositions.json` — eight source-index repairs.
- `repair-2026-09-30T08-34-31-185Z-reprocess.json` — four targeted identity/status/quoted-restoration repairs.
- `repair-2026-09-30T08-38-04-904Z-dispositions.json` — nine lifecycle/window segmentation repairs.
- `repair-2026-09-30T08-39-22-579Z-dispositions.json` — three additional schedule-window repairs.
- `repair-2026-09-30T08-43-47-504Z-dispositions.json` — five table rows with truncated times reconciled after confirming unknown times must not create conflicting windows.
- `repair-2026-09-30T12-08-41-386Z-dispositions.json` — named hospital identity, repaired without an AI call.
- `repair-2026-09-30T12-18-00-234Z-reprocess.json` — Lenasia locality context, repaired without an AI call.

Some posts occur in multiple batches; these counts must not be summed as unique posts. Earlier interrupted batches were restored before continuing. Use the existing `restore-repair.js` workflow for a deliberate rollback, accounting for later repairs and newly ingested posts rather than blindly restoring every snapshot.

## Operational follow-through

The running API still needs the user's normal restart/deployment to load the code fixes. Historical repairs have already been applied. Do not confuse repaired live assignments with proof that the engine will reproduce every manual correction from an empty database.

Validation logs are retained locally in `api/data/backups/clean-slate-2026-09-30/`. The final `live-audit-complete.log` and `live-eval-complete.log` commands exited successfully after the Lenasia repair. `water-report-final.log` also passed.

## Final isolated replay

`GRIDWATCH_AI_MAX_CALLS=250 node scripts/replay-eval.js --tiebreaks` completed on the final code using 3,171 posts and 3,432 stored readings. Processing exited successfully, no post was freshly read by Gemini, and all required tie-break verdicts were available from cache. The temporary replay database was dropped. No validation job remains running.

| Unassisted replay check | Result |
|---|---:|
| Holdout F1, 10 / 11 / 12 / 14 / 15 September | 94.5% / 97.2% / 93.9% / 100% / 100% |
| Mean holdout F1 | 97.1% |
| Tuning set F1 | 97.2% |
| 21 September regression set F1 | 99.5% |
| Correction expectations without overrides | 52 / 76 |
| Final-state expectations without overrides | 15 / 15 |
| Faults left for review | 1 |
| Uncached/failed tie-breaks | 0 |

These grouping and correction results match the preceding completed replay; the final facility and extension-context fixes did not reduce them. An earlier run exhausted its 250-call allowance and left 170 uncached tie-breaks, so its lower results are not a fair code-only baseline. That run is retained in the logs.

The current database is repaired, but the engine does not automatically generalize every human correction. The 24 unmet correction expectations in an override-free replay remain a limitation; the persisted overrides protect those assignments in the live database. A clean operational checkpoint is not a claim of perfect autonomous inference or verified image transcription.
