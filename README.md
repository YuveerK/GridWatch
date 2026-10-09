# GridWatch

Tracks City Power (Johannesburg) outages from their posts on X.

## Run locally

On this prepared Windows workspace, double-click **Start-GridWatch.cmd** at the repository root, then open **http://localhost:4000/review**. The built web app and API run in the same foreground window. Press Ctrl+C to stop them. Automatic fetching is paused in this launcher; the existing **Fetch latest posts** control remains available. Local operator access and guided corrections are configured for this machine.

For a fresh setup or separate development servers:

```
cd api && npm install && cp .env.example .env   # then fill in DATABASE_URL, GEMINI_API_KEY, X_API_BEARER_TOKEN and an OPERATOR_TOKEN
npx prisma migrate deploy
npm run seed:geography          # empty database only: loads the Johannesburg suburbs (add -- --dry-run to preview)
SCHEDULER=off npm start          # API on :4000 (omit SCHEDULER=off to poll X every few minutes)
cd ../client && npm install && npm run dev   # UI on :5173, proxies /v1 and /admin to the API
```

Useful scripts (in `api/`): `npm run ingest -- --process` (fetch new posts and process them),
`npm run process -- --reset --confirm` (deletes every outage and replays from stored readings), `npm run relink` (same replay; report-only unless `--confirm`), `node scripts/reprocess.js <postId>` (re-link single posts), `npm run eval` (linking accuracy on the hand-labelled set in `tests/golden/links.json`).

Tests: `npm test` (unit, no database), `npm run test:integration` (creates and drops its own throw-away PostgreSQL database on the server in `DATABASE_URL`; it never touches your data), `npm run test:all`.

## Fetching the latest posts

The **Refresh / Fetch latest posts** button (header and overview) pulls new posts from X, reads them and updates the site.
It is an operator tool. Settings in `api/.env`:

| Setting | Default | What it does |
|---|---|---|
| `REFRESH_BUTTON` | `on` | `off` hides the button and blocks the endpoint (use this once the scheduler is running). |
| `REFRESH_COOLDOWN_SECONDS` | `60` | Minimum wait between manual fetches (a failed attempt can be retried at once). |
| `REFRESH_MAX_POSTS` | `200` | Most posts read per click, to cap spend. Click again if it says more are waiting. |
| `OPERATOR_TOKEN` | unset | Required for the button and every `/admin` route (see below). |

### Operator access

Anything that spends money or changes data (`POST /v1/refresh`, every `/admin/*` route) fails closed: it is refused unless the caller is an operator.

- Set `OPERATOR_TOKEN` (16+ random characters) in `api/.env`. Open any page with `?operator` in the address (for example `/?operator`) to show **Operator sign-in** in the footer (visitors never see it); paste the token once and the server keeps you signed in with an HttpOnly cookie for `OPERATOR_SESSION_HOURS`. The token is never in the web page. Scripts send `Authorization: Bearer <token>`.
- On your own machine you can instead set `ALLOW_LOCAL_OPERATOR=on`: requests from this computer are trusted. It is ignored in production and for proxied requests.
- If the client is served from a different origin than the API, list that origin in `CORS_ALLOWED_ORIGINS` (the Vite dev proxy does not need it).

Fetching, reading, linking, sweeping and admin actions all take one database lease (`WorkLease`), so the scheduler, the button, the admin routes and the CLI scripts never overlap; a second one is told it is busy. A crashed run's lease expires by itself and its half-finished posts are re-queued.

To use the scheduler instead, start the API without `SCHEDULER=off`; it runs the same single-flight cycle every few minutes.

X fetches leave out replies by default (`X_INCLUDE_REPLIES=off`). They are City Power answering individual customers, which is never outage news, and X charges per post returned.

## Reviewing exceptions

The pipeline is: **Fetch posts → read their meaning → separate faults → associate incidents → recompute timelines → check results → review exceptions.**

Open **`/review`** and use the existing operator sign-in. Signed-in operators also have a **Needs review** navigation link. The inbox covers Electricity, Water and all active sources, independently of the public map filters. Its tabs separate decisions, automatic waiting, engineering and history; source freshness remains visible even with no queued decisions.

Open an issue, inspect the complete utility evidence and current incident, choose a guided action, supply a short reason and source quote, then preview and apply. Joining, separating, changing a reading or classifying a notice recomputes source-post effects. Human readings and links survive reprocessing and rebuilds. Ordinary inspection and previews make no provider calls. A requested AI reread is a proposal until separately reviewed and applied. Water pumping or equipment recovery is not customer supply restoration.

Successful repairs show validation and remaining concerns. **Preview undo** refuses to overwrite newer processing. An interrupted action stays visible for recovery. **Copy investigation brief** prepares a handoff without sending it or resolving the case. **Export regression evidence** downloads reviewed labels; engineering reviews and commits fixtures separately.

Correction writes default to disabled (`REVIEW_CORRECTIONS_ENABLED=off`). See [the review rollout guide](docs/GUIDED_REVIEW.md) for migration, coverage comparison, acceptance tests and enabling controls. Visiting the page never advances `api/data/check-checkpoint.json`.

## The map

The Map page and the "Where it reaches" panel on equipment pages show suburbs as dots at their centre. They are approximate: City Power names suburbs, not streets or cable routes, so the map says "roughly here".

Suburb positions come from free OpenStreetMap data (suburb areas first, then the Nominatim geocoder) and are stored on each suburb. New suburbs appear as posts are read, so run this now and then (it only places suburbs that have no position yet, about 1 request a second):

```
cd api
npm run geocode
```

Suburbs that fail (typos in City Power's posts, private complexes) stay off the map and are counted as "could not be placed". Map tiles come from OpenFreeMap, which is free and needs no key.

For Johannesburg there's a better source than OpenStreetMap guessing: the City's own CGIS GIS services (`docs/Johannesburg/build_johannesburg_area_dataset.py`) publish the official Region A-G boundaries, every cadastral suburb/township polygon, and City Power's vs Eskom's supply areas. Run it, then merge the result in (matches suburbs by name/alias rather than duplicating them, folds cadastral extensions into their parent suburb as aliases instead of creating one row per extension, and only creates new suburbs for genuine base areas — see the comment at the top of `api/scripts/import-coj-geography.js` for the exact rules):

```
pip install shapely
python docs/Johannesburg/build_johannesburg_area_dataset.py --out ./coj-gis-output
cd api
npm run import:coj-gis -- --in ../coj-gis-output          # add --dry-run to preview first
```

This gives affected suburbs an exact government-sourced position and shape (`geoSource: 'coj-cgis'`, plus a `boundary` polygon — the base suburb's own cadastral shape unioned with all its extensions) instead of a geocoder guess. It also sets `electricitySupplier` (`City Power` / `Eskom` / `Mixed/Boundary`) from the City's published supply-area overlap, but that field turned out unreliable in practice — the City Power and Eskom supply layers came back overlapping almost everywhere (e.g. 100%/100% for a suburb well inside Johannesburg), so don't treat it as fact until the source layers are better understood. Safe to re-run any time; already-placed suburbs and existing aliases are left alone.

## Keeping readings fresh

Every post is read once by Gemini and the result is stored. Each stored reading remembers which instructions (`prompt.js`) and model produced it. If you edit the instructions or change the model, `npm run audit` shows how many readings are now out of date, and this re-reads only those (with a backup, a spend cap and progress; a failed re-read keeps the old reading):

```
cd api
npm run reread            # re-read stale posts only (about $0.002 per post)
node scripts/reprocess.js <postId>...   # only posts whose fault layout changed are listed at the end of the run
npm run geocode           # place any newly learned suburbs on the map
```

Backups are written to `api/data/backups/` (not committed) and cover readings and their summaries. To undo a re-read: `npm run reread -- --restore=data/backups/<file>.json`, then re-link the posts it lists.

## Knowing the engine is right

The engine does not just run: every processing cycle saves a quality result, suspicious changes are queued, and every repair can be undone.

```
cd api
npm run quality               # did the last cycle COMPLETE? which posts, faults and outages did it cover, and what did the checks find
npm run quality -- --list     # the last 20 cycles
npm run review                # the queue of suspicious changes, most urgent first (it never edits an outage)
npm run review -- --resolve <id> [--dismiss] [--note "why"]
npm run eval:all              # measures reading, coverage, grouping (holdouts apart), manual corrections and final state separately
npm run eval:all -- --details # lists every post with a disposition mismatch, grouped totals by service/account
node scripts/reconcile-dispositions.js # preview targeted repairs; --apply snapshots and repairs under the pipeline lease
npm run audit                 # data health, exit status 1 on any contradiction, review/error/stuck work or unhealthy ingestion
npm run batch                 # the latest fetch, post by post (exit 1 checks failed, 2 degraded)
npm run batch -- --from=<ISO> --to=<ISO> # recheck a repaired window without advancing the local checkpoint
```

Disposition reconciliation reuses stored readings; ambiguous links may require Gemini tie-breaks (bounded by `GRIDWATCH_AI_MAX_CALLS`, default 100). Posts referenced by manual overrides are held for inspection unless `--include-overrides` is supplied. `--post=<externalId>` limits the repair to one post. A processing failure restores the batch snapshot automatically, and the printed undo command remains available afterward.

- **Quality results** (`CycleQuality`): one per cycle, with status COMPLETE / INCOMPLETE / NEEDS_REVIEW / FAILED. `GET /v1/quality/status` gives the one-word answer; `/admin/quality/latest` (operator) gives the detail.
- **Retries**: a temporary AI failure on a tie-break is retried in the call, then queued and retried by itself (5 min, 15 min, 45 min, 2 h, 6 h). After the last try it waits for a person and shows in the review queue.
- **Review queue** (`ReviewItem`): new outage next to a live similar one, a restoration that opened its own outage, planned versus unplanned on the same equipment, a fault that produced no outage, an uncertain reading, near-duplicate equipment names, many new suburbs. An optional independent verifier (`VERIFIER_ENABLED=on`, capped by `VERIFIER_MAX_CALLS_PER_DAY`, spot-checking `VERIFIER_SAMPLE_RATE` of clean posts) must quote its evidence and only ever raises an item's priority.
- **Corrections become tests**: `node scripts/correct-link.js <post> --join <anchor> --apply` (or `--split --from <post>`) saves a snapshot, applies the correction and adds a case to `api/tests/golden/corrections.json`. Commit that file. See `api/tests/golden/README.md` for what each labelled set is and which may be tuned on.
- **Undoing a repair**: `reprocess.js`, `correct-link.js` and `merge-nodes.js` save a snapshot to `api/data/backups/repair-*.json` first and print the undo command: `node scripts/restore-repair.js <file> --apply`. `reprocess.js --preview` shows where posts are now without changing anything. A reading that a re-read replaces is kept in `ReadingRevision`.
- **Rebuilding everything**: `node scripts/rebuild-history.js --confirm` (with `GRIDWATCH_AI_MAX_CALLS` to cap the small tie-break calls). It holds the pipeline lease throughout and writes a backup first.

### Self-correction (off by default)

A bounded, evidence-based engine that detects specific, narrow pipeline defects (a stored disposition that no longer
matches the current reading; an unresolved restoration that quotes exactly one earlier, compatible incident),
proposes a typed repair, and - only for explicitly allowlisted policies in `auto` mode - applies it reversibly under
the pipeline lease, with a snapshot and postcondition checks. See
`docs/CLAUDE_SELF_CORRECTING_ENGINE_IMPLEMENTATION.md` for the full design and `docs/audits/self-correction-phase0-baseline-2026-09-30.md`
for the baseline it was built against.

```
node scripts/self-correct.js --preview [--service=WATER] [--post=<externalId>]   # read-only, provider-free
node scripts/self-correct.js --shadow                                           # persists proposal records only (SELF_CORRECTION_MODE != off)
node scripts/self-correct.js --inspect=<proposalId>
node scripts/self-correct.js --report [--since=<ISO-time>]
node scripts/self-correct.js --apply --proposal=<id>                            # SELF_CORRECTION_MODE=auto and the policy must be allowlisted
node scripts/self-correct.js --recover --attempt=<id>
node scripts/correction-lessons.js --import-existing [--apply]                  # human LinkOverride corrections -> CANDIDATE lessons
node scripts/correction-lessons.js --list | --inspect=<id> | --promote=<id> --to=REVIEWED|ACTIVE | --retire=<id> --reason="..."
```

- **Modes** (`SELF_CORRECTION_MODE`): `off` (default; no records, no mutation - identical to today's behaviour), `shadow` (proposals are generated and persisted, nothing is ever applied), `auto` (an eligible, allowlisted policy version may also be applied). `SELF_CORRECTION_POLICIES` is the explicit `policyName@version` allowlist; empty means nothing can auto-apply, whatever the mode. Every other `SELF_CORRECTION_*` budget/limit is documented in `.env.example`.
- **What can run today**: two deterministic, no-AI generators - `disposition-layout-repair` (reprocesses a post from its stored reading when the current dispositions/timeline no longer match it) and `quote-restoration` (links an unresolved restoration that quotes exactly one compatible earlier incident). Both act through `REPROCESS_STORED` (no AI call). The executor also supports `JOIN_FAULT`/`SPLIT_FAULT` via a persisted `AutoRepairDirective`, checked by the linker with the same precedence as a human `LinkOverride` (the human decision always wins) - no generator emits these yet.
- **Reviewed lessons**: `correction-lessons.js --import-existing` reads every existing `LinkOverride` (a person's JOIN/SPLIT correction) and stages it as a `CANDIDATE` `CorrectionLesson`, scoped to the exact source post. Promotion to `REVIEWED`/`ACTIVE` - and generalising its applicability beyond that one case - is always a separate, explicit operator step; nothing is auto-promoted.
- **Release gates**: production `auto` mode stays disabled until the documented evidence gates in the design doc are met (≥200 independently reviewed eligible proposals per policy family, ≥99.5% correct, 14+ days, no critical misrepair). Until then every proposal, however correct, stays in `shadow`.
- **Rollback**: every applied repair snapshots first (`api/data/backups/repair-*-self-correct.json`) and is journalled in `RepairAttempt`; `--recover --attempt=<id>` restores it under the pipeline lease.

### About the map

- **Equipment positions are inferred.** City Power publishes no coordinates for its equipment, so each substation, switching station or distributor is drawn at the centre of the suburbs its posts tie it to. The connections (which suburbs it feeds) are real; the marker position is not. Suburbs implausibly far from the rest are left out of the animation.
