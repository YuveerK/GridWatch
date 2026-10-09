# Latest-post repairs — 1 October 2026

The checkpoint review covered 60 posts inserted after 2026-09-30T20:51:18.888Z and through 2026-10-01T14:19:17.984Z: CityPowerJhb 45, CityTshwane 7, JHBWater 8. The three incident errors were investigated from stored source text, image transcription, readings, candidate reasons and timeline effects.

## Mechanisms corrected

- **Explicit station cascade:** [Tshwane's Waltloo report](https://x.com/CityTshwane/status/2105591084688736699) states that one 132kV infeed is off and names seven secondary substations. Their explicit parent relationships describe one failure. A separate depot heading must not make the nine-node reading an ambiguous digest. Source wording, one named parent and the bounded context heading are required; independent stations and multiple fault readings retain the existing guard.
- **Descriptive equipment:** `faulty cable` is a condition, not a city-wide asset identity. Descriptions are rejected during infrastructure learning and ignored when scoring legacy candidate nodes. Named sites, routes and numbered equipment remain valid identities.
- **Named customer sites:** [UJ Soweto Campus repairs](https://x.com/CityPowerJhb/status/2105578867507278264) continue the campus cable faults reported on 28 September. Customer-site names now survive in effects and matching evidence, even when they cannot become suburbs. Historical evidence comes from the exact fault's accepted reading, excludes future posts and the post being repaired, and never borrows a sibling graphic fault's sites. Continuation evidence requires shared equipment and recent UPDATE/RESTORATION wording; a new outage or distinct distributors do not receive it.
- **Bare area headings:** the Lenasia graphics said `Freedom Park South:`, without a station type. The reader invented a same-named substation. An exact graphic heading, a known municipal suburb, no other equipment and no existing locality list allow a deterministic correction to area evidence. Explicit `Substation:` headings are retained. This lets [Goldev's restoration](https://x.com/CityPowerJhb/status/2105400598094922147) close the preceding Freedom Park South incident.
- **An investigation gains an equipment name:** the first authorized replay exposed an older correction regression. Corlett Gardens / Lyndhurst were first reported as areas; the partial-restoration update identified the Lyndhurst distributor and named Corlett Gardens plus its remaining streets. A narrow rule uses both independent names, an area-only active incident, the same SDC, partial/full restoration and at most six hours. It does not create suburb impact from equipment names. Fresh reports, different equipment, missing areas and older incidents are negative regression cases.

## Source-supported review items

- Nancefield's 1 October 08:30–13:00 emergency isolation is deliberate maintenance for Bushkoppies Estate / Eldorado Park Extension 3. It remains separate from the existing unplanned cable fault affecting Extension 1.
- The Johannesburg Water morning graphic explicitly names all eight Hursthill 2 supply-zone suburbs and continued supply via bypass. Their addition is supported by the source and is not customer restoration.

Those two review items were dismissed with explanatory notes. No global suspicion rule was weakened.

## Permanent learning and validation

- Unit and integration regression tests cover the cascade, generic equipment, named-site continuation, chronology, fault boundaries and area-heading correction, with negative cases.
- `api/tests/golden/cases-1001.json` records the six real posts, including the Pimville termination and Allandale faults that must remain separate.
- Two real final-state expectations were added for Freedom Park South restoration and the Waltloo cascade.
- All 556 unit tests and 276 integration tests pass. All task integration and replay databases were dropped; a final database inventory found none remaining.
- Full historical replay uses stored readings and capped tie-breaks, without copying manual overrides. Before/after evidence is in the adjacent replay logs.

The initial `before.log` and `after.log` runs could not reach Gemini from the restricted sandbox (zero provider tokens); their downstream scores are not valid before/after validation. After explicit authorization for capped provider validation, the pre-fix engine was reconstructed in an isolated local copy while retaining the existing self-correction work. It replayed the same 3,311 posts and 3,572 stored readings with its own tie-break cache. The authorized baseline used 26 calls, with no failed tie-breaks, and its disposable database was dropped.

The first authorized fixed replay used 141 calls and exposed the two Lyndhurst correction failures above. They were reproduced with provider-free cached replays, fixed generally and regression-tested. The final replay used one additional call, with no failed tie-breaks. Each provider-enabled replay had a 250-call cap; none reread posts. The isolated pre-fix copy and temporary repair runners were removed.

| Unassisted replay measure | Pre-fix | Final engine |
| --- | ---: | ---: |
| Holdout F1, 10 September | 94.5% | 94.5% |
| Holdout F1, 11 September | 97.2% | 97.2% |
| Holdout F1, 12 September | 93.9% | 93.9% |
| Holdout F1, 14 / 15 September | 100% / 100% | 100% / 100% |
| Existing correction expectations | 52/77 | 52/77 |
| Final-state expectations | 15/17 | 17/17 |
| New six-post regression F1 | 66.7% | 100% |
| Accepted fault dispositions | 4347/4349 | 4348/4349 |
| Water fault dispositions | 1400/1400 | 1400/1400 |
| Needs-review decisions | 2 | 1 |

The replay still has historical failures outside this repair scope, including 25 correction expectations and one unresolved Tshwane fault. The live database retains its prior human corrections: its post-repair evaluation passes **77/77 corrections, 17/17 final states and 4349/4349 fault dispositions**. These stored-assignment figures must not be described as unassisted engine accuracy.

## Applied live repairs and undo

Five stored posts were reprocessed under the pipeline lease: the two Lenasia graphics that introduced the bare-area equipment, Goldev restoration, UJ continuation and Waltloo cascade. The repair verified the two original incident anchors, Freedom Park South restoration, separation from Pimville and Allandale, and seven explicit cascade edge contributions. Two duplicate incidents disappeared through the normal refold path. No fresh readings or manual incident-row patches were used.

The post-repair snapshot is `api/data/backups/repair-2026-10-01T15-19-12-736Z-latest-posts-20261001.json`. From `api/`, undo with:

```text
node scripts/restore-repair.js data/backups/repair-2026-10-01T15-19-12-736Z-latest-posts-20261001.json --apply
```

The normal production lifecycle sweep then marked **six Water and two Electricity incidents STALE**, and closed **seven previously restored Electricity incidents and one previously restored Water incident**. Quiet Water supply was not declared restored. The separate lifecycle backup is `api/data/backups/repair-2026-10-01T15-19-36-089Z-lifecycle-sweep.json`; its guarded undo checks that incidents have not changed since the sweep:

```text
node data/backups/repair-2026-10-01T15-19-36-089Z-lifecycle-sweep-undo.mjs
```

If undoing both operations, undo the lifecycle sweep first, then the post repair. Detailed before/after assignments are in `latest-posts-2026-10-01-live-repairs.json`.

## Final live verification

- Original window: **60 posts, zero flagged**, with CityPowerJhb 45, CityTshwane 7 and JHBWater 8 all covered.
- Follow-up insertion window through `2026-10-01T15:21:09.709Z`: **no new posts** for any account. This does not claim a fresh fetch from X.
- Audit: **PASS**, zero hard failures, zero cross-service errors, no overdue quiet-sweep incidents, no unprocessed/stuck/error/review posts.
- Review queue: **zero actionable open items**. The two source-supported informational dismissals remain documented.
- Water diagnostics: zero false restorations, service contamination or electricity-typed Water assets; all 1400 expected Water faults have accepted dispositions.
- The existing **1794 older-instruction/model reading warnings** remain; no global reread was performed.
- The last recorded scheduler cycle remains COMPLETE at 10:42:57 UTC with zero covered posts. The manual repairs were validated separately by the fixed-window batch, audit and evaluation above.

## Rechecking the original window

Run from `api/`:

```text
npm run batch -- --from=2026-09-30T20:51:18.888Z --to=2026-10-01T14:19:17.984Z
npm run audit
npm run eval:all
```

The explicit-window batch report does not move `api/data/check-checkpoint.json`. The original checkpoint remains intact. No source account settings, self-correction mode/policies or server processes were changed. The running server loads the new code when the user next restarts it.
