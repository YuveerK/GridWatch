# Self-correction engine — Phase 0 baseline and failure taxonomy

30 September 2026. Reproduces and extends the baseline in
[`engine-clean-slate-2026-09-30.md`](engine-clean-slate-2026-09-30.md) as the starting point
for `docs/CLAUDE_SELF_CORRECTING_ENGINE_IMPLEMENTATION.md`. No source-account settings
changed, no global reread ran, no API server touched.

## Reproduced baseline

| Check | Result | Matches prior record |
|---|---:|---|
| Unit tests | 499/499 | yes |
| Integration tests | 247/247 | yes |
| `audit.js` hard failures | 0 (1 new actionable review item since the prior checkpoint — expected, ingestion continues) | yes |
| `eval-all.js` reading | 2934/2934 (100%) | yes (post count drifted with new ingestion) |
| `eval-all.js` coverage | 4199/4199 expected fault dispositions | yes |
| `eval-all.js` corrections (stored, with overrides) | 76/76 | yes |
| `eval-all.js` final state | 15/15 | yes |
| Isolated replay (`replay-eval.js`, no AI — see `replay-baseline-2026-09-30-noai.log`) | mean holdout F1 97.1%, tuning F1 97.2%, regression F1 99.5%, corrections 52/76, final-state 15/15 | yes |

The `--tiebreaks` paid variant (`GRIDWATCH_AI_MAX_CALLS=250 --tiebreaks`) was not re-run in
this session pending explicit spend authorization from the user for *this* conversation —
the no-AI replay above reproduces the same corrections/final-state numbers the prior
session recorded, so it is sufficient to confirm the baseline is unchanged.

## Root-cause finding: all 24 unmet correction rows trace to existing `LinkOverride` rows

The live database currently holds **57 `LinkOverride` rows** (50 JOIN, 7 SPLIT). Spot-checked
against the `LinkDecision.reason` for a representative sample across clusters (Klipfontein
View ×3 posts, Bree Street/John Ware, Cottesmore/Standard Bank), every one of the 20 unique
posts behind the 24 failing correction-pair rows is *currently* linked in the live database
via `reason: 'manual: ...'`, i.e. by a human `JOIN`/`SPLIT` override — not by the automatic
scorer. `corrections.json` is populated automatically whenever `correct-link.js --apply` is
run, so this is expected: every entry in it is, by construction, a case where a human already
intervened. The 52/76-without-overrides number is not measuring 24 unaddressed engine bugs;
it is measuring **how much of human review the automatic scorer currently reproduces on its
own**, which is exactly the population `CorrectionLesson` import (Phase 3) should draw from,
and exactly why "one reviewed lesson changes a later, different case" is the correct success
condition for this feature rather than "make replay hit 76/76 unaided."

The 20 unique posts (24 pair-rows, with `corrections.json` containing exact duplicate rows
for at least 2 of the 20 — consistent with the existing golden-README disclosure that some
correction entries are duplicated) group into 11 unique underlying incidents:

| Cluster | Pairs | Override action(s) | Mechanism | Family classification |
|---|---:|---|---|---|
| Klipfontein View / Klipfontein / Klipfotein | 7 | JOIN ×7 | Verified: the anchor scored 0 against the true outage on the first post (correctly `NEW`); later posts scored **1.0 against a different, wrong outage** that also matched "Klipfontein" locality with a shared node, beating the true match's 0.298. A genuine two-candidate scoring ambiguity, plus a spelling variant ("Klipfotein") never normalized. | **Reading/normalization** (spelling variant) + **scoring ambiguity** (two plausible same-locality candidates). Not deterministically auto-fixable in v1 — a normalization fix is a candidate for `proposals.js`'s locality/reading family; the candidate-tie ambiguity is proposal/review-only per spec §9 ("incident split/merge based on model judgment"). |
| Bree Street / John Ware | 1 (×2 duplicate rows) | SPLIT, with `contrastPostId` set | Verified: human explicitly split two locality-adjacent-but-distinct equipment faults, recording a **counterexample** (`contrastPostId`) — exactly the "same parent, different distributor" shape spec §12 asks lessons to store. | **Identity/candidate recall** — negative lesson candidate (`INCIDENT_SEPARATION` with a stored counterexample), not an auto-repair. |
| Dale Lace Avenue vandalism | 2 | JOIN | Long inter-post gap (procurement delay) — original outage likely went stale/closed before the follow-up posted. | **Chronology/candidate recall** — lesson candidate (`INCIDENT_CONTINUATION`), needs independent source evidence per post, not auto-appliable from one prior JOIN alone. |
| Cottesmore vs Standard Bank No 2 | 1 | JOIN | Verified: human JOIN note explicitly *distinguishes* the two distributors ("Cottesmore is not Standard Bank No 2") while still joining them — i.e. the human judged them the same underlying incident despite different distributor names, only sharing substation `Khanyisa`. Second post shows the LLM tie-break got this right once but the raw scorer initially split them. | **Scoring/identity** — genuinely ambiguous distributor-vs-substation identity call; proposal/review-only. |
| Gresswold/Wynberg vs Kew | 1 | JOIN | Shared SDC, adjacent suburbs (Wynberg/Kew), different actual fault. | **Identity** — locality/SDC over-broad match; lesson candidate with explicit exclusion. |
| Fleurhof / "Fluerhof" | 1 | JOIN | Suburb name misspelled in source text, not normalized to canonical `Fleurhof`. | **Reading/normalization** — candidate for a deterministic alias-table fix (outside self-correction scope; a `normalize.js`/locality-alias engine fix), not a repair proposal. |
| Ferndale Hurley/Surrey vs Bond St/Pine Ave | 1 | JOIN | Restoration report named no equipment, only a shared suburb; scorer didn't weight locality-only match enough to beat the threshold. | **Scoring / missing source evidence** — proposal/review-only (no equipment evidence to ground a deterministic quote-restoration or locality-heading rule). |
| Booysens Reserve / Robertsham-Frampton | 1 | JOIN | Restoration named different street-level locality than the original investigation, same SDC, 2.5h later. | **Candidate recall/chronology** — lesson candidate. |
| Lynnwood Alpine Way | 2 | JOIN | One post ("in no outage") never linked at all — street-level locality (`Alpine Way`) not resolved to suburb `Lynnwood`. | **Reading/identity** — missing locality-alias entry; outside self-correction's action union (would need a geography-table fix, not a repair proposal). |
| Noordwyk investigation | 2 | JOIN | Already the subject of the most recent commit (`01e1615`, "Let a link correction join one fault of a multi-fault graphic, and record the Noordwyk joins") — a manual multi-fault split/join. | **Segmentation** — already human-resolved; confirms manual multi-fault overrides must survive reprocess/relink (spec §"Water-specific manual segmentation", applies equally here). |
| Central substation fire / partial restoration | 1 | JOIN | Long-running incident; a later partial-restoration post didn't link back, likely because the outage had gone stale/closed by then. | **Candidate recall/lifecycle** — lesson candidate; also a signal that the stale-outage candidate window may be too narrow for genuinely long electricity incidents (worth a deterministic look, not in this feature's scope). |

## What this means for Phase 1–3 scope

- **Zero of the 11 clusters are safe, deterministic, first-release auto-repairs.** Every one
  either needs a reviewed lesson (candidate/continuation/separation with counterexamples) or
  is genuine model-judgment territory the spec explicitly keeps proposal/review-only in v1.
  This *confirms* rather than contradicts the plan's scope decision: the four "auto-capable"
  families in spec §9 (disposition/layout inconsistency, stale-extraction-vs-fixed-rule,
  explicit single-incident quote restoration, exact locality-heading qualification) are a
  different population from these correction-pair gaps — they target structural/consistency
  defects the *pipeline* introduces, not scorer disagreements a human already resolved.
- The 57 live `LinkOverride` rows (with their `note` and, where present, `contrastPostId`
  counterexample) are exactly Phase 3's `importExistingCorrections` input population.
- Two of the clusters (Fleurhof misspelling, Lynnwood/Alpine Way) are **not** self-correction
  candidates at all — they are ordinary alias-table/normalization gaps for a future, separate
  engine fix, out of scope here, and are recorded so they are not mistaken for this feature's
  job later.

## Files

- `docs/audits/replay-baseline-2026-09-30-noai.log` — full isolated replay output this report is based on.
