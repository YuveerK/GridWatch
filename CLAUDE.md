# GridWatch — working notes for Claude Code

GridWatch tracks municipal utility outage/status posts on X and turns them into live maps and incident timelines.

It currently supports **two services**:

- **ELECTRICITY**
  - City Power Johannesburg (`CityPowerJhb`)
  - City of Tshwane (`CityTshwane`)
- **WATER**
  - Johannesburg Water (`JHBWater`)

See `README.md` for setup/run instructions and the **"Knowing the engine is right"** section for the full tool list.

This file is about **how to use those tools when asked to check the engine, how to investigate failures, and how to fix them safely**.

Repo layout:

- `api/` — Node 22 ESM, Express, Prisma/PostgreSQL, Gemini extraction, ingestion/linking/quality engine
- `client/` — React/Vite/MapLibre
- `docs/` — engine review write-ups, geography importers, utility/network data

All commands below run from `api/`.

---

# Core architecture rules

GridWatch is now a **multi-service system**.

`serviceType` is a hard isolation boundary.

A Water post must never attach to an Electricity incident, and an Electricity post must never attach to a Water incident even if they name the same suburb, road, facility or municipality.

Current service values:

```text
ELECTRICITY
WATER
```

Current source accounts:

```text
CityPowerJhb  -> ELECTRICITY
CityTshwane   -> ELECTRICITY
JHBWater      -> WATER
```

Existing API behaviour remains backwards compatible:

```text
GET ... without ?service=
-> ELECTRICITY

GET ...?service=WATER
-> WATER
```

Never use municipality alone as a proxy for service.

Johannesburg contains both City Power and Johannesburg Water.

---

# "Check the latest posts" / "is the engine healthy?"

When the user asks:

```text
check the latest posts
check the engine
is GridWatch healthy?
check what just came in
check the latest outages
```

the request means:

> Check every post that has arrived since the last post check, for **all active source accounts and both services**, not only City Power and not only the single newest fetch.

Start with the checkpoint check. It encodes more than a manual read of a few posts would:

```bash
npm run batch -- --since-checkpoint   # posts inserted since the last check, all accounts; then move the mark to now
npm run batch -- --since-checkpoint --all   # also list posts that raised no concern

npm run quality                # did the last cycle COMPLETE? posts/faults/outages/checks
npm run quality -- --list      # last 20 cycles, one line each

npm run review                 # suspicious changes, most urgent first; never edits an outage
npm run audit                  # end-to-end data health
npm run eval:all               # reading %, coverage %, pairwise F1, corrections, final-state
```

The plain latest-fetch report is only for a question about one fetch:

```bash
npm run batch                  # latest fetch only
npm run batch -- --all         # also list posts that raised no concern
npm run batch -- --runs=3      # last 3 fetches that brought posts
```

For Water-specific current/history diagnostics, also use:

```bash
node scripts/water-bootstrap-report.js --handle JHBWater --from 2026-09-01
```

## Required behaviour when checking latest posts

Do not stop after inspecting the first account returned.

Explicitly verify what happened for:

```text
ELECTRICITY
  CityPowerJhb
  CityTshwane

WATER
  JHBWater
```

When the user asks to check posts, run `npm run batch -- --since-checkpoint` from `api/`.

The window is every post inserted after the saved mark, up to the moment the command starts. The command then writes the mark forward, so the next check does not repeat those posts. Do not re-read the whole day, and do not stop at only the newest fetch per account.

The mark is the local file `api/data/check-checkpoint.json` (`checkedAt`, UTC). It is gitignored. It is not a database row and must not be moved into the database. It is a review cursor for the machine where the check is run. The live poller does not read it. Hosted fetching keeps its own progress in the database (`IngestionState`). On a server, the file starts missing: the first check there covers since midnight SAST, then saves a mark on that server's disk. If that disk is wiped, the next check starts from midnight SAST again. Losing the file does not affect outages or the map.

If the file is missing or `checkedAt` is unreadable, the check starts at midnight SAST (UTC+2) and then saves a new mark.

If one source had no new posts in the window, say so.

A healthy answer should make it clear that **both services were checked**, and it should name the window (from the previous mark to now).

If `npm run batch` or another built-in health script does not expose one of the active services correctly, treat that as an **engine/tooling gap** and improve the diagnostic itself rather than permanently falling back to ad-hoc queries.

## Reading the result

`RESULT: PIPELINE OK` with 0 flagged posts is healthy only if the report covered the active source accounts/services expected for that run.

Anything flagged, or any check that does not say `ok`, is worth opening.

`npm run batch -- --since-checkpoint` should be the first answer to "check the latest posts" because it already reads each post in the window:

- extraction
- fault segmentation
- link decision
- resulting incident
- timeline/status effect
- quality checks

Reach for a raw DB query only when `batch`, `quality`, `review`, `audit`, or the Water report do not show what is needed, for example:

- full source text
- raw Gemini JSON
- one `PostExtraction.result`
- one `LinkDecision.candidates`
- score reasons
- one `OutagePost.effect`
- infrastructure evidence
- current-vs-historical prompt-version rows

Do not make ad-hoc DB inspection the normal health-check workflow.

---

# When something looks wrong: how to dig in

## 1. Pull the exact stored mechanism

For the affected post/fault inspect:

```text
SourcePost
PostExtraction.result
fault index
LinkDecision.reason
LinkDecision.candidates
LinkDecision score/reasons
OutagePost.effect
resulting Outage
InfraNode / InfraEdge evidence if relevant
```

Use an existing script if possible.

If nothing exists, write a small throwaway script in `api/scripts/`, use it, then delete it. Do not commit one-off investigation scripts.

## 2. Identify which subsystem owns the symptom

### Extraction / reading problem

Electricity:

```text
src/modules/ai/prompts/electricity.prompt.js
src/modules/ai/schemas/electricity-extraction.schema.js
src/modules/ai/readers/electricity.reader.js
```

Water:

```text
src/modules/ai/prompts/water.prompt.js
src/modules/ai/schemas/water-extraction.schema.js
src/modules/ai/readers/water.reader.js
```

Shared extraction path:

```text
src/modules/ai/extraction.service.js
```

Check:

- prompt
- Gemini JSON schema
- Zod schema
- normaliser
- prompt version
- current stored extraction version

These must describe the same object.

Do not weaken schemas with `z.any()`, arbitrary strings, broad `.catch()` values, or silent malformed-object dropping just to make a live post pass.

### Wrong equipment / hierarchy / topology

Look at:

```text
src/modules/infrastructure/infrastructure.service.js
```

especially:

```text
resolveNode
pickParent
graph/evidence helpers
```

For Water, also inspect relation semantics and operator/source provenance.

Electricity and Water infrastructure types must remain separate.

### Wrong outage chosen / wrong new incident

Look at:

```text
src/modules/outages/scoring.js
src/modules/outages/linker.service.js
```

especially:

```text
scoreCandidate
loadCandidates
mayBeNewFault
tooCloseToCall
LINK / NEW / NEEDS_REVIEW decision
```

Before tuning thresholds, inspect multiple examples with the same failure shape.

A single bad post is not evidence that the scoring model should change globally.

### Wrong status / timeline

Inspect the service-specific fold and the stored `OutagePost.effect`.

Electricity and Water do **not** share all restoration semantics.

For Water, the lifecycle must preserve the distinction between:

```text
infrastructure recovery
system recovery
customer supply restoration
```

### Wrong planned-maintenance date/window

```text
src/lib/schedule.js
```

including:

```text
parseSchedule
anchoredSchedule
scheduleWindow
```

### Coverage/disposition bookkeeping wrong

```text
src/modules/processing/quality.js
```

especially:

```text
checkPostDispositions
```

### Stuck/missing quality/review result

```text
src/modules/processing/cycle.js
src/modules/review/*
```

### Service contamination

Inspect service propagation from:

```text
SourceAccount
-> SourcePost
-> extraction reader
-> linker candidates
-> Outage
-> InfraNode
-> API filters
```

A candidate from another service should be excluded **before scoring**, not merely penalised.

---

# Water engine rules

Water is not Electricity with different labels.

These rules are fundamental and should be preserved in extraction, folding, linking, quality checks and regression tests.

## Restoration semantics

These do **not** mean customer water has been restored:

```text
pumping resumed
pumping restored
pumping restored to full capacity
repairs completed
system recharging
reservoir recovering
levels improving
recovery at ...
power restored to a pump station
upstream electricity fault resolved
outlets opened
```

These normally mean:

```text
incident lifecycle remains live until quiet/stale or explicit customer restoration
water state = RECOVERING / relevant operating state
```

Only explicit customer-supply evidence should close a Water incident as restored.

Examples of strong restoration evidence:

```text
water supply restored to all affected areas
supply restored to customers
customers are receiving water normally
system supplying normally
```

Silence is not restoration.

A quiet Water incident becomes:

```text
STALE
```

under the production quiet-sweep rule.

## Water operating state is separate from outage lifecycle

Examples:

```text
ACTIVE + LOW
ACTIVE + LOW_PRESSURE
ACTIVE + NO_SUPPLY
ACTIVE + RECOVERING
ACTIVE + BYPASS
PARTIALLY_RESTORED + RECOVERING
RESTORED + NORMAL
STALE + RECOVERING
STALE + LOW
```

Do not collapse operating state into lifecycle status.

## Water locality impact

Canonical locality impact values are:

```text
NO_SUPPLY
LOW_PRESSURE
AFFECTED
RESTORED
UNKNOWN
```

If compatibility code still needs a simple locality `state`, derive it deterministically:

```text
impact == RESTORED
-> RESTORED

anything else
-> AFFECTED
```

Do not ask Gemini to independently invent two overlapping concepts.

## Water infrastructure types

Water assets must use Water types, for example:

```text
WATER_SYSTEM
RESERVOIR
WATER_TOWER
PUMP_STATION
DIRECT_FEED
BULK_CONNECTION
BULK_METER
BOOSTER_STATION
TREATMENT_WORKS
PRV
WATER_PIPELINE
WATER_OTHER
```

Never store a Water asset as an Electricity infrastructure type just because the names look similar.

## Water operators

Canonical operator values are machine enums, not display labels.

For example:

```text
JOHANNESBURG_WATER
RAND_WATER
UNKNOWN
```

Known display aliases may be normalised deliberately:

```text
Johannesburg Water
Joburg Water
JW
-> JOHANNESBURG_WATER

Rand Water
-> RAND_WATER
```

Unknown arbitrary operator strings should not silently pass validation.

## Multi-system / multi-fault Water graphics

Johannesburg Water frequently posts large graphics containing several reservoirs, towers, pump stations or systems.

Do not assume:

```text
one X post = one incident
```

and do not assume:

```text
many assets = many incidents
```

Determine whether the source describes:

- one upstream constraint with shared downstream effects
- several independent asset conditions
- a system-status board
- an ordinary outage update
- informational content

Independent assets with distinct operating conditions often need separate faults.

A single reservoir with a large listed supply zone may legitimately have 25+ explicit localities and should not be split merely because a generic "large outage" check fires.

## Direct feeds and topology

Water topology is not always:

```text
reservoir -> suburb
```

The graph must support paths such as:

```text
Rand Water connection
-> direct feed
-> locality
```

and typed relationships such as:

```text
SUPPLIES
PUMPS_TO
DIRECTLY_SUPPLIES
PART_OF
UPSTREAM_OF
BYPASSES
BACKFEEDS
```

Temporary bypass/backfeed evidence must not overwrite permanent supply topology.

## Explicit vs inferred impact

Keep explicit source evidence distinct from topology inference.

A locality inferred downstream from a Water asset is not equivalent to a locality explicitly named in the notice.

Inferred impact must not:

- close an incident
- count as confirmed customer restoration
- trigger a confirmed-outage alert as if Johannesburg Water named the suburb

---

# Water extraction contract

Water currently uses its own prompt/version path.

Do not assume `AI_PROMPT_VERSION` automatically describes Water.

When changing the Water reader:

1. align prompt, Gemini JSON schema, Zod schema and normaliser
2. bump the Water prompt/schema version when stored extraction reuse would otherwise hide the change
3. re-read only the posts needed to validate the change
4. do not globally reread all historical Water posts unless explicitly required

A failed old extraction beside a newer successful extraction is historical evidence, not a current failure.

Health reports should distinguish:

```text
current-version SUCCEEDED
current-version FAILED
no current-version reading

older-version SUCCEEDED
older-version FAILED
```

---

# Fixing an engine bug

## Prefer a general mechanism fix

A rule that special-cases one:

```text
post id
outage id
substation
reservoir
tower
suburb
X status id
```

is almost never the right engine fix.

Trace the actual mechanism:

```text
schema mismatch
bad normalisation
wrong service filter
missing state transition
score contribution
fault segmentation
candidate loading
stale fold
falsy-zero bug
rank comparison
missing enum case
```

and fix the mechanism so future posts with the same shape are handled correctly.

This rule applies equally to:

```text
City Power
Tshwane
Johannesburg Water
```

If a behaviour genuinely must be utility/service-specific, encode it at the proper service-specific seam and explain why.

Examples:

```text
Water restoration semantics
Tshwane same-type cascade behaviour
City Power SDC vocabulary
```

Do not hide service-specific behaviour inside a post-id exception.

## Every engine fix gets a regression test

No exception.

When a bug is found from a real post:

1. reproduce the real failure
2. fix the mechanism
3. add a regression test using the real wording/shape where practical
4. run the broader test suites
5. confirm the other service did not regress

Use unit tests for pure functions:

```text
scoring.js
schedule.js
corrections.js
reader normalisers
timeline folds
quality helpers
linker exported helpers
```

Use integration tests when the behaviour is only observable through the pipeline:

```text
api/tests/integration/linking.test.js
api/tests/integration/water-backfill.test.js
```

Water review/split regressions may also belong in:

```text
api/tests/golden/water-reviews.json
api/tests/unit/water-reviews.test.js
```

Corrections belong in:

```text
api/tests/golden/corrections.json
```

## Required cross-service regression

Any change touching:

```text
candidate loading
linking
service propagation
outage creation
infrastructure creation
API service filtering
```

must include/retain a regression proving:

```text
same suburb + same time
WATER post
ELECTRICITY outage

-> cannot link
```

Service isolation is a hard invariant.

---

# Fixing bad data, not an engine bug

First decide whether the bad result came from a reusable engine mechanism.

Only use a one-off correction when the source itself is genuinely exceptional or ambiguous and the engine is otherwise behaving correctly.

Every repair tool snapshots first and is reversible:

```bash
node scripts/correct-link.js <post> --join <anchorPost> [--fault N] --note "why" --apply

node scripts/correct-link.js <post> --split --from <post> --note "why" --apply

node scripts/restore-repair.js <snapshot-file> --apply
```

`correct-link.js` automatically appends the correction to:

```text
api/tests/golden/corrections.json
```

as a permanent regression case.

Commit that file.

See:

```text
api/tests/golden/README.md
```

for `_kind`:

```text
holdout
tuning
regression
```

and which sets may be tuned on.

Run:

```bash
node scripts/eval-pairs.js
```

after a batch of corrections.

## Water-specific manual segmentation

When a Johannesburg Water multi-system graphic genuinely requires a manual split/override:

- persist the override
- ensure replay/relink keeps the segmentation
- add a Water regression/golden fixture
- do not leave a manual DB state that disappears on reprocess

Manual review decisions must survive:

```text
reprocess
relink
replay
```

---

# Validating an engine fix

Before shipping deterministic engine changes:

```bash
npm test
npm run test:integration

GRIDWATCH_AI_MAX_CALLS=250 node scripts/replay-eval.js --tiebreaks

node scripts/eval-all.js
```

Compare:

```text
holdout F1
coverage
corrections
final-state counts
review counts
cross-service invariants
```

against the previous result.

A fix that repairs one live case but degrades holdout behaviour is not safe as-is.

Narrow it or reconsider the mechanism.

## Water-specific validation

When the change affects Water, also run the relevant Water tests and diagnostics, for example:

```bash
npx vitest run tests/unit/water-extraction.test.js
npx vitest run tests/unit/water-reviews.test.js
node scripts/water-bootstrap-report.js --handle JHBWater --from 2026-09-01
```

Use the repo's actual Vitest config/command if these test paths require a specific config.

Check at minimum:

```text
current Water extraction failures = 0
cross-service errors = 0
false Water restorations = 0
electricity-typed Water nodes = 0
unexpected NEEDS_REVIEW Water faults = 0
```

Do not demand that the global `npm run audit` be green if its only failures are known unrelated records in another service.

Instead report clearly:

```text
global audit exit
Water-specific result
Electricity-specific result
```

Never hide global failures; just do not misattribute them to Water.

---

# Prompt changes

A prompt change is lower-risk than a data migration, but it is still an engine change.

`PostExtraction` is versioned.

Editing prompt text does not automatically mean every historical row is reread.

Before trusting a prompt change:

1. understand which prompt version the service uses
2. bump the appropriate service version if needed
3. re-extract a few known-good examples
4. include image-heavy and text-only examples
5. spot-check every affected source account/service

For Electricity prompt changes, spot-check both:

```text
CityPowerJhb
CityTshwane
```

For Water prompt changes, spot-check:

```text
JHBWater
```

Do not run a global historical reread merely because a prompt changed.

---

# Status and quiet-sweep rules

The normal production stale/quiet sweep is part of incident lifecycle correctness.

For Water:

```text
quiet for the production threshold
-> STALE
```

unless already resolved/closed by stronger evidence.

Do not interpret quiet as customer restoration.

For completed restoration episodes, the normal sweep may later move old restored incidents to `CLOSED` according to existing production behaviour.

When historical replay is used, refold first, then apply the same production sweep rather than inventing special bootstrap status rules.

---

# Linking metrics: current vs historical

`LinkDecision` history may contain:

```text
retries
fault-level decisions
relinks
old prompt-version attempts
manual corrections
```

Do not compare raw historical `NEW + LINKED` row counts directly to unique source-post count and call that a bug.

Health/reporting tools should distinguish:

```text
historical decision rows
current final decisions
fault decisions
unique posts
posts that opened at least one incident
posts that only updated existing incidents
```

For multi-fault Water graphics, one post may legitimately produce several fault decisions.

---

# Infrastructure learning

GridWatch learns network structure from posts.

That is a product feature, not incidental metadata.

When investigating a post, also consider whether it teaches:

```text
asset -> asset relationship
asset -> locality relationship
operator
direct feed
pump/reservoir/tower/system relationship
temporary bypass
upstream dependency
```

But do not create topology merely because two names appeared in the same post.

Relationships require source-supported semantics.

Prefer explicit evidence and provenance.

Water topology may be imported from official static sources and also learned from X posts; preserve provenance rather than pretending both evidence types are the same.

---

# Client/API checks

The site has an:

```text
Electricity / Water
```

switch.

Water mode must request:

```text
service=WATER
```

Electricity remains the default when the parameter is omitted.

When an engine/API change touches service filtering, verify:

```text
Electricity view contains no Water incidents
Water view contains no Electricity incidents
switching services does not mutate state incorrectly
search/map/overview honour the selected service
```

Do not "fix" Water UI by changing default API behaviour in a way that breaks the existing Electricity site.

---

# Operating rules

- **Never start, stop or restart the API server** unless explicitly asked. You do not know what else is running in it.
- A code fix or repair script can be executed manually without restarting the server, but live server traffic only sees new code after the user restarts it.
- Apply new Prisma migrations with:

```bash
npx prisma migrate deploy
```

- `prisma generate` can fail with `EPERM` on Windows while the API server holds the engine DLL open. The already-generated client may still be usable depending on the schema change; do not treat the Windows lock itself as a data failure.
- On Windows/Git Bash, do not hand-edit files through bash heredocs when content contains backslashes or `$`. Use the proper write/edit tool or a small Node script with `String.raw`.
- Do not activate/deactivate source accounts unless explicitly asked.
- Do not run expensive/global AI rereads unless explicitly justified.
- Do not manually delete lease rows. Respect the existing `WorkLease`/pipeline coordination mechanism.
- If a processing command returns `skipped: true`, inspect whether another worker holds the `pipeline` lease before assuming the query or limit is broken.
- If a source account is active, live polling should continue from its stored high-water mark; historical bootstrap should not be rerun unless intentionally requested.

---

# Source-specific notes

## City Power Johannesburg

Typical characteristics:

```text
SDC hashtags
substations
feeders
distributors
planned maintenance
restoration percentages
large Johannesburg geography coverage
```

Keep City Power restoration/percentage rules intact when working on Water.

## City of Tshwane

Typical characteristics:

```text
region/depot language
same-equipment-type cascades
different posting style from City Power
```

A City Power-specific scoring rule should not silently harm Tshwane.

## Johannesburg Water

Typical characteristics:

```text
image-heavy posts
daily system-status boards
reservoir/tower/pump/direct-feed language
upstream Rand Water dependencies
multi-system graphics
recovery vs customer restoration distinction
large explicit reservoir supply-zone suburb lists
```

Water has its own reading/scoring/timeline semantics.

Do not force Water through Electricity vocabulary such as SDC assumptions.

---

# When fixing something found in "check latest posts"

The default workflow is:

```text
1. Run `npm run batch -- --since-checkpoint` across active services.
2. Identify the exact failing post/fault.
3. Pull stored reading, link decision and effect.
4. Search for other examples of the same failure shape.
5. Decide: engine bug or exceptional bad data?
6. If engine bug:
   - fix the general mechanism
   - add regression test(s)
   - validate both affected service and cross-service isolation
7. If exceptional bad data:
   - use reversible correction/override
   - persist a regression/golden fixture
8. Re-run batch/quality/audit/service-specific checks.
9. Report what changed and why.
```

Do not:

```text
patch one outage row
hard-code one X post id
special-case one reservoir name
special-case one suburb
change a threshold from one example only
mark recovery as restoration to make an audit green
silence a quality check instead of fixing its semantics
```

unless there is a documented, source-specific reason and a regression test that proves the intended behaviour.

---

# If investigation steps keep repeating

If the same multi-step investigation is needed across sessions, it probably belongs in:

```text
api/scripts/
batch-report.js
quality.js
audit.js
review tooling
```

rather than being reinvented manually.

Diagnostics are part of the engine.

A future "check the latest posts" request should get better because the previous investigation improved the tooling.
