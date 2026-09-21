# Golden data: what the engine is measured against

Every file here is hand-labelled truth about City Power posts. Keys are the **last 6 digits of the X post id** (or full ids in `corrections.json` / `states.json`). They are measured **separately**, so a gain in one part cannot hide a loss in another (`npm run eval:all`).

| File | Kind | What it is | May it be used to tune rules? |
|---|---|---|---|
| `holdout-0910/0911/0912/0914/0915.json` | **holdout** | Posts from one day each, labelled blind (from the post text, before looking at the engine's grouping) | **No.** Once a rule is tuned against one it is no longer a holdout; say so in its `_note` and move it to `tuning`. |
| `links.json` | tuning | The first labelled set, used while the rules were built | Yes |
| `cases-0921.json` | regression | Hard cases found while checking fresh posts, labelled *after* seeing the engine's grouping | Yes, but it only guards against regressions; it does not measure unseen accuracy |
| `corrections.json` | regression | One pair per manual correction: two posts that must share an outage (`same: true`) or must not (`same: false`) | Yes |
| `states.json` | regression | What an outage should look like at the end: status, kind, planned window (Johannesburg time), minimum posts | Yes |

## How each part is measured

1. **Reading**: how many posts have an accepted reading, and how many wait for review or failed.
2. **Coverage**: how many expected faults ended with exactly one accepted disposition.
3. **Grouping**: pairwise precision, recall and F1 of which posts share an outage (`scripts/eval.js`). Holdouts are reported apart from the others.
4. **Corrections**: how many manual corrections the engine now gets right *without help* (`scripts/eval-pairs.js`).
5. **Final state**: whether outages end up with the right status, kind and planned window (`scripts/eval-pairs.js`).

Run against the live database, corrections and states include the manual overrides, so they read as passing. Run them on a replay (`node scripts/replay-eval.js`, which ignores overrides) to see what the engine does on its own.

## Turning a correction into a test

`node scripts/correct-link.js <post> --join <anchor> --apply` (or `--split --from <the post it was wrongly joined with>`) stores the correction **and adds it to `corrections.json`** by itself. Commit that file. `node scripts/export-corrections.js --write` catches up on older corrections.

A new case that the labels above cannot express (a wrong planned window, a wrong status) goes in `states.json`. A new case about which posts belong together goes in a dated `cases-<date>.json` (labelled from the post text, noting whether it was blind).

## Known contamination

`holdout-0911` and `holdout-0914` contain Glenanda isolation posts. The Glenanda fixes (an emergency-isolation programme keeps one kind, one street read as cable/line/other is one thing) were motivated by `cases-0921` and raised both sets (0911 95.8 to 96.5, 0914 96.4 to 98.2). Treat those two gains as partly tuned, and do not tune further against these two files.

## Not yet covered

- Notices and customer replies as labelled negatives (every set has zero non-outage examples; `eval.js --strict-none` checks nothing until they exist).
- Reading accuracy itself (does the AI read a picture's table correctly?): the sets label grouping and outcomes, not the transcription.
- Pictures are not stored with the cases, only post ids; a case can only be re-run while the post is still in the database.
