# GridWatch — working notes for Claude Code

Tracks outage posts from municipal power utilities on X (currently City Power Johannesburg and City of
Tshwane) and turns them into a live map of outages. See `README.md` for setup/run instructions and the
"Knowing the engine is right" section for the full tool list — this file is about *how to use those tools*
when asked to check on the engine, and how to investigate and fix what they find.

Repo layout: `api/` (Node 22 ESM, Express, Prisma/PostgreSQL, Gemini extraction), `client/` (React/Vite/MapLibre),
`docs/` (engine review write-ups, per-city geography importers). All commands below run from `api/`.

## "Check the latest posts" / "is the engine healthy?"

Start with the built-in checks — they encode far more than a manual read of a few posts would:

```
npm run batch                 # the latest fetch: every post, what it read, where it linked, 15 automatic invariant checks
npm run batch -- --all        # also list posts that raised no concern (default: only flagged ones)
npm run batch -- --runs=3     # cover the last 3 fetches that brought posts, not just the latest
npm run quality               # did the last cycle COMPLETE? posts/faults/outages it covered, what the checks found
npm run quality -- --list     # the last 20 cycles, one line each — spot a pattern of INCOMPLETE/FAILED
npm run review                # the queue of suspicious changes, most urgent first (never edits an outage)
npm run audit                 # data health end to end; exit 1 on any contradiction, stuck work, or unhealthy ingestion
npm run eval:all              # reading %, coverage %, pairwise F1 (holdouts kept separate), corrections, final-state
```

`npm run batch` is the right first answer to "check the latest posts" — it already reads every post's extraction,
link decision and resulting outage, and runs the same 15 checks (dispositions, timeline consistency, digest rules,
restoration-vs-percentage, weak titles, stuck work, review queue) that the pipeline itself runs after every cycle.
Reach for a raw DB query only when you need something `batch`/`quality`/`review` don't show — full post text, the
raw Gemini JSON, or a specific `LinkDecision.candidates`/`reasons` breakdown.

**Reading the result:** `RESULT: PIPELINE OK` with 0 flagged posts is healthy. Anything flagged, or a check that
doesn't say `ok`, is worth opening — `npm run batch` names the problem in plain language per post.

## When something looks wrong: how to dig in

1. Pull the specific post's stored reading and decision (`PostExtraction.result`, `LinkDecision.reason` /
   `.candidates`, `OutagePost.effect`) — write a small throwaway script in `api/scripts/` (delete it when done;
   don't commit ad-hoc query scripts), or query via a REPL. This almost always shows the exact mechanism.
2. Match the symptom to where it lives:
   - Wrong equipment/hierarchy read from a post → `src/modules/ai/prompt.js` (the extraction instructions) or
     `src/modules/infrastructure/infrastructure.service.js` (`resolveNode`, `pickParent` — how a name/relationship
     becomes a graph node/edge).
   - Wrong outage chosen or opened → `src/modules/outages/scoring.js` (`scoreCandidate`) and
     `src/modules/outages/linker.service.js` (`loadCandidates`, the LINK/tie-break decision itself, `mayBeNewFault`,
     `tooCloseToCall`).
   - Wrong planned-maintenance date/window → `src/lib/schedule.js` (`parseSchedule`, `anchoredSchedule`,
     `scheduleWindow`).
   - Coverage/disposition bookkeeping wrong → `src/modules/processing/quality.js` (`checkPostDispositions`).
   - A stuck or missing quality/review result → `src/modules/processing/cycle.js`, `src/modules/review/*`.
3. Check whether it's one bad post (fix the data, see below) or a real engine bug (fix the code). A bug usually
   shows the same shape more than once — search for other posts hitting the same code path before assuming it's
   isolated.

## Fixing an engine bug

- **Prefer a general fix over a one-off patch.** A rule that only special-cases one post/outage/substation name is
  almost never right — trace to the actual mechanism (a falsy-zero check, a rank comparison, a missing case) and
  fix that, so every future post in the same situation is handled too.
- **Every fix gets a regression test.** Unit-test the pure function directly when there is one (`scoring.js`,
  `schedule.js`, `corrections.js`, `linker.service.js`'s exported helpers); add an integration test in
  `api/tests/integration/linking.test.js` reproducing the real scenario when the fix is only observable through
  the full pipeline.
- **Validate before shipping:**
  ```
  npm test && npm run test:integration
  GRIDWATCH_AI_MAX_CALLS=250 node scripts/replay-eval.js --tiebreaks     # full history replayed on a throwaway DB
  node scripts/eval-all.js                                              # same, against the live DB
  ```
  Compare holdout F1 and the corrections/final-state counts against what they were before the change. A change
  that fixes the one case you found but drops a holdout number is not safe to ship as-is — narrow it (see the
  tie-margin fix in git history for an example of tuning a threshold down after exactly this happened) or don't
  ship it.
- **A prompt.js change is lower-risk than it looks**, because `PostExtraction` is keyed on `(postId, promptVersion)`
  and `promptVersion` is a static config string (`AI_PROMPT_VERSION`), not derived from the prompt text — editing
  the prompt does **not** retroactively re-read anything already processed. It only affects posts read for the
  first time from now on, or a post you explicitly re-extract (`reprocessPost(id, { reextract: true })` /
  `node scripts/reprocess.js <postId> --reextract`). Still spot-check a re-extraction of a couple of known-good
  posts from *each* account before trusting a prompt change, since it's the one kind of fix that isn't purely
  deterministic.

## Fixing bad data (not a code bug)

Every repair tool snapshots first and is reversible:
```
node scripts/correct-link.js <post> --join <anchorPost> [--fault N] --note "why" --apply   # move a post
node scripts/correct-link.js <post> --split --from <post> --note "why" --apply             # give it its own outage
node scripts/restore-repair.js <snapshot-file> --apply                                     # undo any of the above
```
`correct-link.js` automatically appends the correction to `api/tests/golden/corrections.json` as a permanent
regression test (commit that file) — see `api/tests/golden/README.md` for what `_kind` (holdout/tuning/regression)
means and which sets may be tuned on. Run `node scripts/eval-pairs.js` after a batch of corrections to confirm
they all hold.

## Operating rules

- **Never start, stop or restart the API server** unless explicitly asked — you don't know what else is running
  in it. A code fix (including a data repair script, which imports the same source files) takes effect immediately
  for anything you run yourself; it only reaches *live* traffic once the running server process is restarted,
  which is the user's call.
- Apply new Prisma migrations with `npx prisma migrate deploy`. `prisma generate` can fail with EPERM while the
  API server holds the engine DLL open — harmless, the already-generated client still picks up schema changes.
- On Windows/Git Bash, don't hand-edit files through bash heredocs for anything with backslashes or `$` — write a
  small Node script with the `Write` tool (`String.raw` for the replacement text) instead; heredocs have mangled
  escapes here before.
- This repo tracks **two utilities' worth of posts** (`SourcePost.sourceAccount`: `CityPowerJhb`, `CityTshwane`).
  Their post styles differ (SDC-hashtag vs region/depot, and Tshwane's network cascades within one equipment type
  more often) — a fix should work for both, or explain why it's specific to one.
- If you find yourself repeating a multi-step ad-hoc investigation across sessions, it likely belongs as a proper
  script in `api/scripts/` (or a check in `batch-report.js`/`audit.js`) rather than being reinvented each time.
