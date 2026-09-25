# GridWatch codebase overview for Johannesburg Water

This document describes how GridWatch works today, so a later plan can add Johannesburg Water without duplicating systems that already exist. It was written from the code on `main` (commit `5934cf1` and the files it contains). The code is authoritative where a doc disagrees with it.

Nothing in this document is an implementation plan, a schema migration, or a water status design.

---

## 1. Repository structure

There is no monorepo of shared packages. Two Node apps, one Postgres database, and docs.

```text
/api                          Express API, ingestion, extraction, linking, Prisma
  /prisma/schema.prisma      the data model
  /prisma/migrations         SQL migrations, including 9f_municipality_identity
  /src/server.js             process entry: HTTP server + in-process schedulers
  /src/app.js                Express app, CORS, pino-http
  /src/config/env.js         validated environment
  /src/db/prisma.js          Prisma client
  /src/lib                   pure helpers: schedule, normalize, gis-import, fault categories, scheduler
  /src/modules/ingestion     X client and fetch/store
  /src/modules/ai            Gemini extraction, prompt, schema
  /src/modules/processing    one refresh cycle, per-post processing, quality, repair
  /src/modules/outages       linking, scoring, status fold, titles, manual corrections
  /src/modules/infrastructure  learned equipment graph
  /src/modules/geo           suburb geocoding and equipment map positions
  /src/modules/api           HTTP routes, insights, updates, municipality scope
  /src/modules/review        suspicion queue and optional verifier
  /src/modules/push          Expo push
  /src/modules/coordination  pipeline lease
  /scripts                   operational CLIs (ingest, process, relink, correct-link, GIS import, eval)
  /tests/unit                Vitest, no database
  /tests/integration         Vitest against a throwaway Postgres
  /tests/golden              labelled link pairs and final-state expectations
  /audit                     one-off characterization tests, not the default suite
/client                      React + Vite + MapLibre
  /src/views                 pages
  /src/components            map, cards, search
  /src/lib                   API client, municipality context, coverage estimate
/docs                        engine reviews, Gauteng research, CoJ/Tshwane GIS builders
/README.md                   local run instructions
```

There is no `/web`, no `/packages`, no worker process, no queue service, and no deployment directory.

What each major area does:

- `api/src/modules/ingestion` pulls X posts into `SourcePost` / `PostMedia`.
- `api/src/modules/ai` turns one post plus its images into one JSON reading.
- `api/src/modules/infrastructure` turns that reading into nodes, edges, and suburb links.
- `api/src/modules/outages` decides whether the post joins an existing outage or opens one, then folds a timeline.
- `api/src/modules/geo` places suburbs that have no coordinates yet.
- `api/src/modules/api` serves the React app.
- `api/src/modules/processing/cycle.js` runs those stages in order under one lease.
- `client` renders the map, lists, and detail pages. It does not own outage logic.

---

## 2. Technology stack

| Concern | What the repo actually uses | Evidence |
|---|---|---|
| Backend | Node 22 ESM, Express 5 | `api/package.json`, `api/src/app.js` |
| Frontend | React 19, Vite 7, react-router-dom 7 | `client/package.json` |
| Language | JavaScript only (no TypeScript) | both packages |
| ORM / database | Prisma 6.19 on PostgreSQL | `api/prisma/schema.prisma` `provider = "postgresql"` |
| PostGIS | Not used. Coordinates are `Float` lat/lon. Polygons are GeoJSON stored in a `Json` column | `Locality.lat`, `Locality.lon`, `Locality.boundary` |
| Queue | None. No Redis, Bull, or SQS | dependencies |
| Scheduler | In-process `setTimeout` loop | `api/src/lib/scheduler.js`, started from `api/src/server.js` |
| Hosting | Not defined in the repo. Local `npm start` / Vite only | no Dockerfile, no CI workflows |
| Caching | In-memory locality index (`localityIndex` in `infrastructure.service.js`) and a tie-break file cache. No Redis | `resetLocalityIndex`, `tiebreak-cache.js` |
| AI | Google Gemini via `@google/genai`. Default model `gemini-3.5-flash-lite` | `api/src/modules/ai/gemini.client.js`, `env.js` |
| OCR | None. No Tesseract, no Sharp. Images are sent to Gemini, which transcribes them into `image_text` | `extraction.service.js` `fetchImage` |
| X client | `fetch` against `https://api.x.com/2`. No Twitter SDK | `api/src/modules/ingestion/x.client.js` |
| Map | MapLibre GL 5.24. Basemap is OpenFreeMap | `client/src/components/MapView.jsx` |
| GIS | `@turf/union`, `@turf/buffer`, `@turf/concave` on the client, used to estimate a coverage blob. Official polygons come from offline Python builders | `client/package.json`, `docs/Gauteng/build_johannesburg_area_dataset.py` |
| Validation | Zod 4 | `env.js`, `extraction.schema.js`, route query parsing |
| Tests | Vitest 4 (API), `node:test` (one client file) | `api/package.json`, `client/package.json` |
| Logging | pino + pino-http | `api/src/lib/logger.js`, `api/src/app.js` |
| Error tracking | None. No Sentry, no metrics endpoint | searched dependencies and source |

---

## 3. End-to-end City Power pipeline

One refresh is `createCycle` in `api/src/modules/processing/cycle.js`. The live instance is `cycle`. A tick is synchronous from the scheduler's point of view: the next tick does not start until this one finishes. Inside the tick, stages run one after another under a single Postgres lease (`withLease` in `api/src/modules/coordination/lease.js`, lock name used by `cycle`).

```text
scheduler or POST /v1/refresh
  → cycle.run / cycle.start
  → withLease
      1. ingestNewPosts          X → SourcePost, PostMedia, IngestionRun, IngestionState
      2. processPending          each UNPROCESSED post:
            extractPost          Gemini → PostExtraction
            learnFromExtraction  InfraNode, InfraEdge, NodeLocality, Locality, EvidenceContribution
            linkPost             LinkDecision, Outage, OutagePost, OutageNode, OutageLocality
      3. retryImageFailures + retryTieBreaks
      4. reviewStage             ReviewItem
      5. placeLocalities         Locality.lat/lon (capped)
      6. sweepStaleOutages       Outage.status
      7. assessCycle             CycleQuality
```

Push notifications (`runNotifications`) are a separate one-minute scheduler. They read the database and do not fetch or extract.

### Stage detail

**1. Fetch.** `ingestNewPosts` (`ingestion.service.js`). Input: active `SourceAccount` rows, `IngestionState` cursor. Output: new `SourcePost` rows at `processingStatus = UNPROCESSED`, media rows, an `IngestionRun`. Synchronous HTTP to X, then a transaction per page. On `RATE_LIMITED` or `FAILED` the cycle throws. An account that fails does not block the other accounts; its name is recorded as `ingest:<displayName>` and its backlog is held. Duplicate posts are skipped on `(platform, externalId)`.

**2. Read.** `processPending` → `processPost` (`processor.service.js`). For each post, `extractPost` (`extraction.service.js`) loads up to 4 images, calls `generateJson`, validates with Zod, and writes `PostExtraction` keyed by `(postId, promptVersion)`. A stored successful reading is reused. `promptVersion` is the env string `AI_PROMPT_VERSION` (default `outage-extraction.v1`), not a hash of the prompt text. A separate stamp `__reading.prompt` (first 10 hex chars of a SHA-1 of the prompt plus schema plus model) is what `npm run audit` and `npm run reread` use to notice a prompt edit. Editing the prompt does not re-read old posts by itself.

**3. Learn.** `learnFromExtraction` (`infrastructure.service.js`). Input: the extraction JSON and the post's municipality. Output: nodes, parent/child edges, node-to-suburb links, learned suburbs. Writes are fenced by the lease. Evidence is one `EvidenceContribution` row per fact, so a retry cannot inflate `evidenceCount`.

**4. Link.** `linkPost` (`linker.service.js`). Input: the post, the extraction, and the learned node/locality ids (`facts`). Output: a `LinkDecision` and either a new `Outage` or an `OutagePost` on an existing one. Status is not "whatever this post says". `buildEffect` stores what this fault said, and `foldEffects` (`outage-state.js`) recomputes the outage from every effect in time order.

**5. Retry.** `retryImageFailures` re-reads posts whose pictures 404'd, between about 3 and 40 minutes old, a few per cycle. `retryTieBreaks` retries a Gemini tie-break that failed for a transient reason. Schedule is 5, 15, 45, 120, 360 minutes (`RetryAttempt`).

**6. Review.** `detectSuspicious` + `saveReviewItems` (`review.service.js`). Points at suspicious placements. It does not move an outage. If `VERIFIER_ENABLED=on`, `verifyItem` asks Gemini for a second opinion and stores it on `ReviewItem.verifier`.

**7. Geocode.** `placeLocalities` (`geocode.service.js`), at most 8 suburbs and 20 seconds per cycle. Failure is logged and retried next cycle.

**8. Sweep.** `sweepStaleOutages`. Unplanned `ACTIVE` / `PARTIALLY_RESTORED` with no news for `OUTAGE_AUTOCLOSE_HOURS` (default 48) become `STALE`. Restored or cancelled outages older than that become `CLOSED`. Planned outages close after their announced window plus 6 hours.

**9. Quality record.** `assessCycle` (`quality.js`) writes `CycleQuality` with the posts covered and the invariant problems. A failed assessment closes the row as `FAILED`. It does not roll back the outages.

Errors: a thrown cycle is logged, the lease releases in `finally`, and the scheduler tries again next interval. Posts left `PROCESSING_ERROR` or `UNPROCESSED` are picked up by a later `processPending`. X rate limits abort the cycle with a message, and the incomplete account's high-water mark does not advance.

---

## 4. X / Twitter ingestion

| Question | Answer |
|---|---|
| Client | `fetchTimelinePage` in `api/src/modules/ingestion/x.client.js` |
| Endpoint | `GET https://api.x.com/2/users/{userId}/tweets` with `tweet.fields`, `expansions=attachments.media_keys`, `media.fields` |
| Auth | `Authorization: Bearer ${X_API_BEARER_TOKEN}` |
| Scheduler | `createScheduler` in `server.js`, every `X_POLL_INTERVAL_MINUTES` (default 5). Elapsed time after the previous tick finishes, not a cron expression |
| Who is polled | Every `SourceAccount` with `active: true`. If the table is empty, one account is upserted from `X_SOURCE_ACCOUNT_ID` (default `337882328`) and `X_SOURCE_ACCOUNT_NAME` (default `CityPowerJhb`) |
| Pagination | `pagination_token`. Up to `X_MAX_PAGES_PER_RUN` pages (default 20), up to 100 posts each |
| since-id | `since_id` is the completed high-water mark, or the saved cursor's since-id when resuming |
| Cursor persistence | `IngestionState`: `completedHighWater`, `cursorToken`, `cursorSinceId`, `cursorNewest`, `incomplete`. A page and the next cursor commit in one transaction (`persistPage`) |
| Duplicates | `SourcePost` `@@unique([platform, externalId])`. Re-reading an interval inserts nothing |
| Rate limit | HTTP 429 becomes `XRateLimitError`. The run is stored `RATE_LIMITED`. One network failure is retried once after 3 seconds. An expired pagination token (`XInvalidTokenError`) drops the cursor and re-reads from the high-water mark |
| Raw storage | `SourcePost.rawPayload` is `{ tweet }`. Metrics, attachments, and note-tweet text are also columns |
| Media | `PostMedia.url` is `url` or `preview_image_url`. Bytes are not stored. They are fetched later from `*.twimg.com` at read time |
| Replies / reposts | `exclude=retweets,replies` unless `X_INCLUDE_REPLIES=on` (default `off`). Quote tweets are ordinary tweets if X returns them |
| Backfill | There is no "download the last N months" mode in the poller. History enters through `scripts/import-csv.js` or by the high-water mark being absent so the first runs walk backwards until the page cap |
| Already processed | `processingStatus` other than `UNPROCESSED` / `PROCESSING_ERROR`. `LinkDecision` `@@unique([postId, faultIndex])` makes a second link a no-op |

The ingestion layer is **generic for a second X account and specific to X**. `getActiveAccounts` already polls City Power and City of Tshwane as two `SourceAccount` rows. Adding `@JHBWater` is a new `SourceAccount` row (see `scripts/seed-source-account.js`) plus a municipality. Nothing in `x.client.js` mentions City Power.

What would still have to change is everything after storage. The extractor, the graph types, the linker, and the UI assume an electricity outage. A water post stored by this poller would be read by the electricity prompt.

---

## 5. Raw source / provider abstractions

What exists:

| Concept | Where | What it actually means |
|---|---|---|
| Platform | `SourcePlatform` enum: only `X` | The social network, not the utility |
| Account | `SourceAccount` | One X user, optionally tied to a `Municipality` |
| Municipality | `Municipality` (`code` unique, e.g. `JOHANNESBURG`, `TSHWANE`) | A metro. Regions, accounts, localities, nodes, and outages point at it |
| Utility display | `UTILITIES` in `api/src/modules/api/municipality-scope.js` | Hard-coded map from municipality code to display name, phone numbers, website, and `areas: 'sdc' \| 'region'` |
| Network / service type | **Does not exist** | There is no `ELECTRICITY` / `WATER`, no `utilityType`, no `serviceType` |

The incident model assumes every incident is an electricity outage. The table is named `Outage`. `OutageKind` is only `UNPLANNED` or `PLANNED`. `InfrastructureType` is a closed electricity list (`SDC`, `SUBSTATION`, `FEEDER`, `DISTRIBUTOR`, `TRANSFORMER`, `MINI_SUBSTATION`, `CABLE`, `SWITCHING_STATION`, `KIOSK`, `LINE`, `CIRCUIT`, `OTHER`). `Locality.electricitySupplier` is an electricity supply-area label from the Johannesburg GIS import.

`OTHER` is not a water type. It is the bucket for a name the electricity reader could not classify (a street read once as a cable and once as "other").

### City Power hard-coding that matters for a second service

| File | Symbol | What is hard-coded | Significance |
|---|---|---|---|
| `api/src/modules/ai/prompt.js` | `BASE_PROMPT`, `UTILITY_HINTS` | "municipal electricity utility", SDC rules, City Power and Tshwane electricity hints | **High.** This is the reading |
| `api/src/modules/ai/extraction.schema.js` | `ENTITY_TYPES`, `entities` description | "City Power infrastructure"; electricity entity types | **High.** Structured output cannot name a reservoir |
| `api/src/modules/review/verifier.js` | system string | "tracker of City Power (Johannesburg) outages" | **Medium.** Verifier is off by default and Tshwane-blind |
| `api/src/config/env.js` | `X_SOURCE_ACCOUNT_*` defaults | City Power's X user id and handle, used only to bootstrap an empty `SourceAccount` table | **Low** once accounts exist |
| `api/src/modules/api/municipality-scope.js` | `UTILITIES` | City Power and City of Tshwane names, phones, `areas` | **Medium.** A third utility needs a row here for copy and insights grouping |
| `api/src/modules/outages/scoring.js` | SDC bonus/penalty | `sdcName` match is +0.05; mismatch is −0.3 | **Medium.** Water has no SDC |
| `api/src/lib/fault-category.js` | cause buckets | cable, theft, transformer, overload, isolation | **Medium.** Insights and labels |
| `client/src/lib/api.js` | `STATUS`, `ROLE` | "Power is out", "Power is back on" | **High** for UI |
| `client/src/components/MapView.jsx` | layer ids, hub diamonds, flow animation | One electricity map | **High** |
| `client/src/lib/hooks.js` | document title | "Gauteng power outages" | **Low** |
| `Locality.electricitySupplier` | column | City Power vs Eskom from CoJ GIS | **Medium.** Water supply is a different relation |

Municipality scoping (added so Johannesburg and Tshwane do not share a substation) is **not** a service-type abstraction. A Johannesburg Water account in the same municipality as City Power would still share `Municipality.code = JOHANNESBURG`. Same-named suburbs would match. Same-named assets would match only if they share `InfrastructureType` and `normalizedKey`. A reservoir named like a suburb is a locality hit, not an electricity node, unless the electricity reader invents a `SUBSTATION`.

---

## 6. Database / Prisma schema

There is no PostGIS. Geospatial data is `Locality.lat`, `Locality.lon`, and `Locality.boundary` (`Json`, GeoJSON polygon or multipolygon, WGS84).

### Posts and readings

- **`SourceAccount`.** `platform`, `externalId` unique, `displayName`, `municipalityId`, `active`.
- **`SourcePost`.** Unique `(platform, externalId)`. `sourceAccount` is the display name string, not a foreign key. `text`, `noteTweetText` (X long-post body), `conversationId`, `publishedAt`, `rawPayload` Json, `attachments` Json, `publicMetrics` Json, `processingStatus`.
- **`PostMedia`.** Unique `(postId, mediaKey)`. URL, type, width, height. No blob.
- **`PostExtraction`.** Unique `(postId, promptVersion)`. `result` Json is the Zod extraction (relevance, sdc, status, cause, entities, localities, faults, image_text, confidence, review_reason) plus `__reading`. `imageText` is also a column.
- **`PostSummary`.** Unique `(postId, faultIndex)`. One resident sentence. Survives a relink.
- **`ReadingRevision`.** Previous `result` Json when a re-read replaces one.
- **`IngestionState`.** One row per X user id. High-water and cursor.
- **`IngestionRun` / `IngestionRunPost`.** One fetch attempt and the posts it stored.

### Geography

- **`Municipality`.** `code` unique.
- **`Region`.** Unique `(municipalityId, code)`. Johannesburg uses letters, Tshwane uses 1–7.
- **`Locality`.** A suburb or township. Unique `(regionId, normalizedName)`. `municipalityId` for learned suburbs that have no region. `electricitySupplier`, `boundary` Json, `lat`/`lon`, `geoSource`, `sourceLabel` (`learned-from-posts` or a GIS label).
- **`LocalityAlias`.** Unique `(localityId, normalizedAlias)`. `confidence`, `status` (`KnowledgeLifecycle`).

### Infrastructure

- **`InfraNode`.** `type` (`InfrastructureType`), `name`, `normalizedKey`, `municipalityId`, `lifecycle`, `evidenceCount`, `firstSeenAt`, `lastSeenAt`. Unique `(type, normalizedKey, municipalityId)`. A partial unique index in the migration keeps `(type, normalizedKey)` unique where `municipalityId` is null. **No coordinates and no polygon.**
- **`NodeAlias`.** Unique `(nodeId, normalizedKey)`.
- **`InfraEdge`.** Primary key `(parentId, childId)`. Comment in the schema: parent supplies or contains the child. `evidenceCount`, `lastSeenAt`. No confidence column, no historical versions, no source-post id on the edge itself.
- **`NodeLocality`.** Primary key `(nodeId, localityId)`. `evidenceCount`, `lastSeenAt`.
- **`EvidenceContribution`.** Primary key `(postId, faultIndex, kind, refA, refB)`. This is the source reference for a learned fact.

### Outages (the incident)

- **`Outage`.** `kind`, `status`, `title`, `sdcName`, `cause`, `etaText`, `restorationPercent`, `primaryNodeId`, `municipalityId`, `retroactive`, `digest`, `startedAt`, `lastUpdateAt`, `restoredAt`, `scheduledStart`, `scheduledEnd`. Index `(status, lastUpdateAt desc)`.
- **`OutageNode`.** `(outageId, nodeId)`. An outage can name many assets.
- **`OutageLocality`.** `(outageId, localityId)` plus `restored` boolean. Many suburbs. Per-suburb restored flag.
- **`OutagePost`.** Primary key `(outageId, postId)`. `role` (`OPENED`, `UPDATE`, `RESTORATION`), `score`, `reasons` Json, `faultIndex`, `postedAt`, `effect` Json. The timeline is these rows in `postedAt` order. There is no separate status-history table. Current status is the fold of `effect`.
- **`LinkDecision`.** Unique `(postId, faultIndex)`. `outcome` (`LINKED`, `NEW`, `NEEDS_REVIEW`), `topScore`, `usedLlm`, `reason`, `candidates` Json (top five `{id, score, reasons}`).
- **`LinkOverride`.** A person's JOIN or SPLIT. Primary key `(postId, faultIndex)`. Points at posts, not outage ids, so a rebuild still applies it.

### Other

- **`ReviewItem`.** `reasons` Json `[{code, detail}]`, `priority`, `status` string (`OPEN` / `RESOLVED` / `DISMISSED`), `verifier` Json.
- **`CycleQuality`.** `summary`, `problems`, `posts`, `changedOutageIds` all Json.
- **`RetryAttempt`.** Tie-break and image retries.
- **`WorkLease` / `IngestionLease`.** Locks.
- **`PushDevice` / `PushSubscription` / `NotificationEvent`.** Phones follow localities.
- **`VerifierCall`.** Daily cap ledger.

`KnowledgeLifecycle` is `CANDIDATE`, `CONFIRMED`, `DISPUTED`, `REJECTED`, `RETIRED`. Nodes use it. Edges do not. `RETIRED` exists in the enum; the learning path does not expire an edge on a timer.

### A. Infrastructure graph

Yes. The graph is directed edges: asset A → asset B, stored as `InfraEdge(parentId, childId)`.

- Multiple parents and multiple children are allowed. The primary key is the pair, so one parent can have many children and one child can have many parents.
- Aliases: `NodeAlias`.
- Evidence: `evidenceCount` increments once per `EvidenceContribution`. The contribution row points at the source post and fault.
- Confidence: there is no 0–1 confidence on an edge. A node becomes `CONFIRMED` when `evidenceCount` reaches `CONFIRM_AT` (2) in `resolveNode`.
- History: an edge stores `lastSeenAt` and a count, not a list of versions. Removing the last contribution deletes the edge (`removeContributions`). There is no "this relationship was true until date D".
- The semantics of the edge are electricity containment or supply ("parent supplies/contains child"), decided by `pickParent` from `parent_name` on the extraction. There is no edge-type column, so `SUPPLIES` and `BYPASSES` cannot both exist as different relations between the same pair.

### B. Incident scope

An `Outage` can affect many suburbs (`OutageLocality`) and many assets (`OutageNode`) of different `InfrastructureType`s. Suburbs the GIS already knew are explicit matches. A name the GIS does not know is inserted by `learnLocality` with `sourceLabel: 'learned-from-posts'` and `regionId: null`. A post with no suburbs but a station whose name matches a suburb can use that suburb for scoring only (`suburbsNamedLikeStations`); it is not written as a stored locality of the outage. `OutageLocality.restored` distinguishes a suburb named as back on from one still affected. `digest: true` marks an outage that absorbed many nodes, and scoring then refuses to let it swallow unrelated single-fault posts (score capped at 0.3).

### C. What would block ELECTRICITY and WATER in one database

No migration is proposed here. The constraints are:

- One status enum for every outage (`OutageStatus`). Water states such as `LOW_PRESSURE` have nowhere to go without overloading `ACTIVE` or extending the enum.
- One closed `InfrastructureType` list. A reservoir would have to be `OTHER` or a new enum value. `OTHER` is already used for junk and streets, and minor types `CABLE`, `LINE`, and `OTHER` are deliberately merged when the name matches (`MINOR_TYPES`).
- One edge meaning. A bypass and a supply between the same two assets cannot both be stored.
- `Outage.sdcName`, `Locality.electricitySupplier`, extraction `sdc`, and fault categories are electricity fields with no parallel.
- Municipality is the isolation key. City Power and Johannesburg Water share Johannesburg, so they would share localities and, for `OTHER` or a colliding type, nodes.
- The linker loads every recent outage in the municipality. A water post and a power post about the same suburb would score on locality overlap.
- There is no column on `Outage` or `SourcePost` for service type.

---

## 7. Infrastructure learning

Entry point: `learnFromExtraction` in `api/src/modules/infrastructure/infrastructure.service.js`, called from `processPost` after a successful extraction.

Flow:

1. `resolveLocality` matches each locality name inside the post's municipality. Exact `localityKey`, then the key with a trailing "ext N" stripped, then fuzzy Dice similarity ≥ `FUZZY_LOCALITY` (0.92), then a single one-character edit. Ambiguous names prefer ids already on this post (`preferIds`).
2. If nothing matches and the name is not a street or a facility (`isNotSuburbName`), `learnLocality` inserts a `Locality` with `sourceLabel: 'learned-from-posts'` and the post's `municipalityId`.
3. `resolveNode` finds or creates an `InfraNode` of that type and `normalizedKey` (`infraKey` strips words like "substation"). Station types can fuzzy-match at 0.9. `CABLE`, `LINE`, and `OTHER` with the same name are one node. Scope is `municipalityId`, or the null-municipality namespace when the caller has no municipality.
4. Each new contribution increments `evidenceCount` and `lastSeenAt`. At 2, lifecycle moves from `CANDIDATE` to `CONFIRMED`.
5. `pickParent` chooses a parent only when the extraction gave `parent_name`. The edge is upserted. Repeated evidence increments `InfraEdge.evidenceCount`.
6. Each node is linked to the fault's localities through `NodeLocality`.
7. Every write is gated by `shouldCount`, which inserts `EvidenceContribution` and skips duplicates.

Conflict handling: a fuzzy match will not steal a name that already has its own node of a different station identity beyond the threshold. One-edit suburb matches require exactly one candidate. There is no human approval step before a node is created. The review queue can later flag `EQUIPMENT_IDENTITY` when a new station name is a near-typo of a known one (`review.service.js`).

Relationships do not expire. They disappear only when `removeContributions` runs (reprocess or repair) and the count hits zero. `RETIRED` is unused by this path.

Re-learning is idempotent: `tests/integration/graph.test.js` locks that.

Could this learn `reservoir → tower → supply zone → suburb` without a rewrite? **Partly.** The machinery (resolve by name, count evidence, store a directed edge, attach suburbs, remember the source post) is generic. The inputs are not. `parent_name` means "what fed or caused the electricity loss". Types are the electricity enum. Fuzzy merging of `CABLE`/`LINE`/`OTHER` would glue unrelated water names. A water graph needs its own types and its own parent rule, then it can call the same write path. It should not reuse `OTHER` or the electricity `parent_name` semantics.

`knowledgeContext` (`api/src/modules/infrastructure/knowledge-context.js`) injects names the graph already knows for the post's SDC into the Gemini user text, so the model reuses spellings. That hint is SDC-scoped.

---

## 8. AI / Gemini processing

| Item | Location |
|---|---|
| Provider | `generateJson` in `api/src/modules/ai/gemini.client.js` (`@google/genai`) |
| Model | `env.GEMINI_MODEL`, default `gemini-3.5-flash-lite` |
| Prompt | `buildSystemPrompt` / `buildUserText` in `prompt.js`. One prompt, plus a short per-account hint |
| Schema | `extractionSchema` (Zod) and `extractionJsonSchema` in `extraction.schema.js`. Gemini is asked for that JSON |
| Validation | Zod parse after the call. A schema failure is a failed extraction |
| Timeout | `AI_TIMEOUT_MS` default 90s |
| Thinking | `GEMINI_THINKING` `default` or `minimal` |
| Retries | Transient provider errors inside the tie-break (`retryTransient`). Image fetch retries 1.5s and 4s. Extraction itself is not retried inside `extractPost`; the post stays `PROCESSING_ERROR` and `processPending` will see it again |
| Images | Up to 4 inline base64 parts, not OCR text. The model writes `image_text` |
| Confidence | `result.confidence`. Below 0.75, or a non-null `review_reason`, contributes to `UNCERTAIN_READING` in the review queue. Low confidence on a forced re-read can be rejected (`extraction.service.js`) |
| Persistence | `PostExtraction.result` Json, plus columns `relevance`, `imageText`, token counts, `durationMs`, `error` |
| Caps | `GRIDWATCH_NO_AI=1` skips calls (repairs and replay). `GRIDWATCH_AI_ONLY=tiebreak` allows only the linker tie-break. `GRIDWATCH_AI_MAX_CALLS` stops a replay |
| Knowledge hint | `KNOWLEDGE_CONTEXT` default `on` |

There is **one extraction prompt**, not specialist prompts. The account hint is a paragraph, not a second schema. Deterministic code after the model:

- `statusFor` and `foldEffects` turn the reading into an outage status.
- `faultItems` splits a graphic into faults.
- `isPlanned` / `scheduleWindow` (`api/src/lib/schedule.js`) parse maintenance windows in Africa/Johannesburg.
- `categorize` (`api/src/lib/fault-category.js`) buckets `cause` for insights.
- The linker never trusts the model to pick the outage id except in the tie-break band.

Hallucination safeguards that exist: the prompt says to use only the post and images; locality fuzzy-match threshold 0.92; nodes are created from extracted names only; a digest that the model split into `faults[]` cannot collapse into one outage; the tie-break is shown candidate outages and must pick an id or "new".

A water-specific schema can reuse `generateJson`, image loading, `PostExtraction` storage, and the cycle. It cannot reuse `extractionSchema` or `BASE_PROMPT` as they are. The storage row is one extraction per `(postId, promptVersion)`. A second schema wants its own `promptVersion` (or a new table) so a water reading does not overwrite an electricity one. `processPost` would have to choose the schema from the account. That branch does not exist.

The tie-break prompt lives next to `askLlm` in `linker.service.js`. It is also about electricity outages.

---

## 9. Image / OCR pipeline

There is no OCR library.

1. X returns media in the tweet expansion. `persistPage` stores `PostMedia` (url, type, dimensions).
2. At read time, `loadImages` in `extraction.service.js` takes image media, at most 4.
3. `mediaUrl` allows only `https` hosts `twimg.com` or `*.twimg.com`, and sets `name=large` if no size is present.
4. `fetchImage` streams the body, aborts at 20 seconds, and refuses bodies over `MEDIA_MAX_BYTES` (default 10 MB). Redirects are errors.
5. Bytes become an inline base64 part `{ inlineData: { mimeType, data } }` on the Gemini request. Nothing is written to disk.
6. The model returns `image_text` (max 3000 characters in the schema description). That string is stored on `PostExtraction.imageText` and inside `result`.
7. Later schedule parsing (`anchoredSchedule`) reads `image_text` so a date heading on a graphic stays with the fault it sits above.
8. A 404 or network blip is transient (`isTransientImageError`). `retryImageFailures` tries again later. A wrong host, a 403, or an oversized image is not retried.
9. Deduplication is the post id, not a hash of the image. The same graphic posted twice is two posts.

This path is generic for any X account's images. The interpretation of the picture is entirely the electricity prompt. A Johannesburg Water graphic would be downloaded the same way and then read as a power outage unless the prompt changes.

---

## 10. Incident association

"Does this post belong to an existing outage?" is `linkPost` in `api/src/modules/outages/linker.service.js`. Scoring is pure and lives in `scoreCandidate` / `applyRevivalRule` in `scoring.js`.

Pseudocode:

```text
if a LinkDecision already exists for (post, fault): return it
if relevance is not OUTAGE, PLANNED_OUTAGE, RESTORATION, or UPDATE:
    record NEW "not linkable" and stop
candidates = outages in the time window, same municipality (null municipality is not a mismatch),
             overlapping a node, a neighbour node, a locality, or the conversation
score each:
    same thread                         +0.6
    planned vs unplanned                score 0, stop
    shared equipment, overlap-weighted  up to about +0.5
    else a graph neighbour              +0.3
    shared suburbs, fraction of the smaller set   up to +0.4
        conflicting equipment cuts that, unless every named suburb is already on the outage
    amended post within 12h with a shared suburb  +0.3
    digest outage                       cap 0.3
    same SDC                            +0.05
    different SDC and no shared node    −0.3
if the outage is STALE and quiet longer than OUTAGE_WINDOW_HOURS (72h):
    no shared equipment → score 0
    shared equipment    → cap just under LINK_HIGH_SCORE so only the tie-break may take it
    (STALE_REVIVAL_HOURS, default 240, bounds how long that equipment match is even offered)
sort by score, then stable id
if a LinkOverride exists: obey JOIN or SPLIT
else if top >= LINK_HIGH_SCORE (0.7) and not "maybe a new fault" and not a near-tie:
    link
else if top >= LINK_LOW_SCORE (0.35):
    ask Gemini (askLlm) to pick a candidate id or new
else:
    open a new outage, unless a digest rule refuses
```

`mayBeNewFault`: a fresh investigating report whose best match is only partly restored, and not the same thread, always goes to the tie-break. That is how a new fault on the same streets is kept off a 98% outage.

`tooCloseToCall`: two scores within a small margin also go to the tie-break, so sort order cannot decide.

Candidate loading (`loadCandidates`) does not return every outage. It returns outages touched since `postedAt - OUTAGE_WINDOW_HOURS` that share a node, a related node, a locality, or the conversation, and whose `municipalityId` is null or equal to the post's. Restored outages can still match inside the window; a restoration percent and status are then folded. A restoration with no match opens a restored outage (`retroactive: true`) instead of being dropped.

Multi-outage bulletins: if `result.faults` has items, `faultItems` yields one link per fault. Faults of one graphic are not allowed to share an outage (a quality check, and `fromDigest` drops the conversation id and filters out candidates this post already took).

A summary graphic that is one equipment headline can join that equipment's outage and must not open a new umbrella (`isDigest`, `pickHeadlineMatch`). A graphic the model failed to split, with many roots, records `NEW` with reason `digest post covering several faults: no outage created` and creates nothing. A fresh `OUTAGE` that names up to 8 co-affected points and an empty `faults[]` is one incident (Tshwane cascades). More than 8 without a split becomes `NEEDS_REVIEW`.

Unrelated outages are kept apart by: municipality filter, the 72-hour window, planned/unplanned mismatch, the digest cap, different-SDC penalty, conflicting-equipment penalty, the high-score bar, and the tie-break. They are **not** kept apart by service type.

The algorithm depends on electricity concepts in the SDC adjustment, in "shared node" meaning a substation or distributor, and in the tie-break prompt. Suburb overlap and the time window are not electricity-specific. A water post that only shares a suburb with a live power outage would enter the tie-break band (locality overlap alone can score 0.4, which is above `LINK_LOW_SCORE` 0.35).

Manual correction: `scripts/correct-link.js` writes `LinkOverride` and reprocesses. The linker honours it before scores. `scripts/restore-repair.js` undoes the snapshot.

---

## 11. Incident status state machine

Two layers.

**What the model is allowed to say** (`extraction.schema.js` `STATUSES`): `INVESTIGATING`, `CREW_DISPATCHED`, `REPAIRING`, `PARTIALLY_RESTORED`, `RESTORED`, `PLANNED`, `CANCELLED`, `UNKNOWN`.

**What an outage can be** (`OutageStatus`): `ACTIVE`, `PARTIALLY_RESTORED`, `RESTORED`, `STALE`, `CLOSED`, `PLANNED`, `CANCELLED`.

`statusFor` maps a reading onto the outage set:

- A restoration percent below 100 becomes `PARTIALLY_RESTORED` (or `ACTIVE` if the percent is 0), unless the headline is already `RESTORED`, `PLANNED`, or `CANCELLED`.
- Every suburb tagged `RESTORED` can force `RESTORED` when the headline is silent.
- Some suburbs restored forces `PARTIALLY_RESTORED` when the headline is silent.
- `PLANNED` and `CANCELLED` pass through.
- A later "still repairing" reading does not un-restore an outage that is already `RESTORED` or `PARTIALLY_RESTORED`.
- Anything else, including `INVESTIGATING` and `REPAIRING`, becomes `ACTIVE`. A `STALE` outage that receives news is live again because the fold writes `ACTIVE`.

`foldEffects` walks `OutagePost.effect` in `(postedAt, faultIndex, postId)` order. Later effects override status, percent, cause, eta, and SDC. Suburb restored flags use `suburbRestored`: an overall partial percent wins when every suburb was tagged restored. Equipment and suburbs are the union of effects. `startedAt` stays the earliest post. `restoredAt` is set when the fold first reaches `RESTORED`.

There is no unconfirmed-restoration state and no inferred restoration beyond the suburb-tag rule. `STALE` means "no news, outcome unknown", not resolved. `CLOSED` is housekeeping after `STALE` would have applied to an already restored or cancelled outage, or after a planned window ends. Nothing deletes an outage except a repair/reprocess that leaves it with no posts.

`OutageKind` is independent: `UNPLANNED` or `PLANNED`, from `isPlanned`. A planned/unplanned mismatch scores 0, so they never merge.

This is one universal electricity status set. `CREW_DISPATCHED` and `REPAIRING` are not even stored; both collapse to `ACTIVE`. Water states (`LOW_PRESSURE`, `NO_INCOMING_SUPPLY`, `BYPASS`, …) do not fit the enum or `statusFor`. A parallel status set would be a new field or a new enum, not a new label on `ACTIVE`.

---

## 12. Geography / Johannesburg GIS

A suburb is a `Locality`. Townships and extensions are not a separate model. An extension is either its own locality or an alias (`LocalityAlias`), depending on what the GIS builder emitted. `normalizedName` is `localityKey` (`api/src/lib/normalize.js`): lower case, punctuation stripped, "extension" collapsed to "ext".

Official identifiers: `Region.code` inside a municipality, plus `sourceLabel` / `sourceLine` from the import. There is no SG code column.

Coordinates: `lat` / `lon` floats. Polygon: `boundary` Json. No spatial index.

Import path:

- `docs/Gauteng/build_johannesburg_area_dataset.py` builds the CoJ CGIS extract (suburbs, City Power vs Eskom supply, depot boundaries). `docs/Gauteng/README_JOHANNESBURG_GRIDWATCH_DATASET.md` explains it. `README.md` still mentions `docs/Johannesburg/build_johannesburg_area_dataset.py`; that path does not exist.
- `npm run import:coj-gis` → `scripts/import-coj-geography.js` → `importGisAreas` in `api/src/lib/gis-import.js`.
- `npm run import:tshwane-gis` is the same function for the Tshwane builder (`docs/Tshwane/build_tshwane_area_dataset.py`). Tshwane has no electricity-supplier field.
- `npm run seed:geography` loads a text file (`data/johannesburg.txt` or `GEOGRAPHY_FILE`) through `api/src/lib/geography-seed.js` when the GIS import has not been run.

`importGisAreas` upserts municipalities, regions, localities, aliases, coordinates, and boundaries. It will not replace a parent suburb's unioned boundary with one extension's sliver.

Name resolution at read time is `resolveLocality` (section 7), not a spatial query. "Willowbrook" becomes `localityKey("Willowbrook")` and must hit `normalizedName` or an alias. Fuzzy match is string similarity, not distance. If several localities share a normalized name, `preferIds` (ids already chosen for this post) wins, otherwise the first candidate in the index. Municipality scope drops a locality known to belong to a different municipality.

Placement of a learned suburb with null coordinates is `placeLocalities`: OSM suburb dump for Johannesburg only, then Nominatim, rejected if outside the municipality's bounding box (`api/src/modules/geo/plausible.js`). A position inherited from a known suburb of the same municipality is allowed. Failed lookups set `geoSource: 'none'` and are skipped until a retry. The cycle places at most 8 per run.

The map receives points and, when present, `boundary` GeoJSON from `/v1/map`. The client does not re-query ArcGIS.

A derived water supply-zone polygon is **technically possible from data the stack already stores**, not from a function the server already exposes. Suburb polygons are GeoJSON in Postgres. The client already depends on `@turf/union`. Nothing in the API unions localities into a supply zone, and Postgres is not doing `ST_Union`. A script or a request-time Turf union over `Locality.boundary` could build one. Suburbs with `boundary: null` would be holes.

---

## 13. Infrastructure geography

Electricity equipment has **no coordinates and no polygon** on `InfraNode`.

Positions on the map are derived in `api/src/modules/geo/equipment-map.service.js` from the suburbs linked through `NodeLocality` (and from outage localities). A node can exist with no map position. Hubs are drawn as diamonds when that derivation succeeds (`/v1/map/infrastructure`, `/v1/map/node/:id`).

There is no admin UI for infrastructure. Nodes are created only by learning, except `scripts/merge-nodes.js`, which merges duplicates. Boundaries of "where this substation reaches" on the big map are not official polygons. `client/src/lib/coverage.js` (`estimateCoverage`) builds a Turf blob around the affected suburb points. The client test `client/tests/coverage.test.js` locks that geometry.

A reservoir or tower that needs a real point must gain a coordinate the electricity node does not have, or it must be attached to suburbs the way substations are and accept a derived dot.

---

## 14. API surface

Routes are all in `api/src/modules/api/routes.js`. There is no separate controller layer. Query validation is inline Zod. There is no HTTP cache. The client polls.

Municipality scope: `outageInMunicipality(code)` in `municipality-scope.js`. Omitted `municipality` means all.

| Route | Role | Filters / pagination | Response, in brief |
|---|---|---|---|
| `GET /health` | DB `SELECT 1` | | `{ ok: true }` |
| `GET /v1/outages` | List | `status`, `sdc`, `suburb`, `region`, `municipality`, `q`, `sort` (`updated`/`started`/`name`), `limit` (default 50, max 100), `offset` | `{ total, data: [shaped outage] }` |
| `GET /v1/outages/:id` | Detail and timeline | | Outage, suburbs, nodes, posts with `postUrl(account, externalId)`, summaries |
| `GET /v1/overview` | Home | `municipality` | Counts, by SDC, daily history, latest updates |
| `GET /v1/search` | Search box | `q`, `municipality` | `{ suburbs, equipment, outages }` capped (suburbs 7, equipment and outages 5) |
| `GET /v1/municipalities` | Switcher | | `code`, `name`, `utility`, `accounts`, `contact` from `UTILITIES` |
| `GET /v1/localities` | Suburb search helper | `q` | id, name, region, municipality |
| `GET /v1/localities/:id` | Suburb page | | boundary, supplier, nodes, `municipalityCode` |
| `GET /v1/localities/:id/outages` | Suburb's outages | | shaped outages |
| `GET /v1/localities/:id/history` | History | | `locality-history.service.js` |
| `GET /v1/network/sdcs` | Network home | `municipality` | SDC nodes and live counts |
| `GET /v1/map` | Map outages | `municipality` | Suburb points, optional boundary, live/partial/restored weights. **This is what the map calls** |
| `GET /v1/map/infrastructure` | Hub list | | Derived positions |
| `GET /v1/map/node/:id` | One hub and its flow | | Children, suburbs, links |
| `GET /v1/infrastructure` | Equipment search/list | `q`, type, `municipality` | Nodes |
| `GET /v1/infrastructure/:id` | Equipment page | | Node, aliases, edges, localities, outages |
| `GET /v1/stats` | Outage tab counts | `municipality` | Counts by status, active by SDC |
| `GET /v1/updates` | Home feed | `municipality` | `updates.service.js` |
| `GET /v1/changes` | Activity | `since`, `municipality` | Link decisions since a time |
| `GET /v1/posts`, `GET /v1/posts/daily` | Insights post panel | `municipality`, days | `post-activity.service.js` |
| `GET /v1/insights` | Insights | `days` (7/14/30), `municipality` | `insights.service.js` |
| `GET /v1/sync` | Freshness | | Last post, scheduler |
| `GET /v1/quality/status` | Public quality | | Latest `CycleQuality` summary |
| `GET/POST /v1/refresh` | Manual cycle | POST requires operator | `cycle.start('manual')` |
| `POST /v1/operator/session` | Cookie session | | `operator-auth.js` |
| `POST /admin/ingest`, `/admin/process`, `/admin/reprocess/:postId` | Operator | `requireOperator` | Direct service calls |
| `GET /admin/quality`, `GET/POST /admin/review` | Operator | | Quality rows and review queue |

`shapeOutage` adds `municipality`, `sdc`, status, percent, suburbs, and a primary node. Status strings in JSON are the `OutageStatus` enum, not sentences. The client maps them to "Power is out".

Push routes live in `api/src/modules/push/push.routes.js`.

The map's three calls are `GET /v1/map`, `GET /v1/map/infrastructure`, and `GET /v1/map/node/:id`. Overview also calls `/v1/map` and `/v1/overview`.

Responses assume electricity naming: `sdc`, equipment `type` values, and outage statuses. They do not assume the words "City Power" in the JSON. That string is added by the client from `utility`.

---

## 15. Frontend architecture

Stack and routes are in section 1 and the route table below. State is React context plus local `useState`. There is no Redux. Server data is `useApi` in `client/src/lib/api.js` (`fetch` to `VITE_API_URL + path`). Municipality is `MunicipalityProvider` in `client/src/lib/municipality.jsx`: `localStorage` key `gridwatch:municipality`, and `withMunicipality` appends `?municipality=`. `useUtility` picks the display name and phone numbers for the selected metro, or for the outage's own metro on a detail page.

| Path | Component | Job |
|---|---|---|
| `/` | `views/Overview.jsx` | "Is your power out?", embedded map, feed |
| `/outages` | `views/Outages.jsx` | Status tabs, SDC filter, `region` query |
| `/outages/:id` | `views/OutageDetail.jsx` | Timeline, progression, X links |
| `/map` | `views/MapPage.jsx` | Full map |
| `/insights` | `views/Insights.jsx` | Causes, day grid, area table |
| `/network`, `/network/:id` | `views/Network.jsx`, `views/NodeDetail.jsx` | SDC list and equipment |
| `/suburb/:id` | `views/Suburb.jsx` | One suburb |
| `/planned` | `views/Planned.jsx` | Planned list |
| `/activity` | `views/Activity.jsx` | `WhatChanged` |
| `/about` | `views/About.jsx` | How it works, per-utility phones |

Map library and layers: section 16. Markers are suburb dots (clustered) and equipment diamonds. Polygons are `Locality.boundary` plus the Turf coverage blob. Colours are CSS variables `--live`, `--partial`, `--good`, `--plan`.

Search overlay: `components/SearchBox.jsx`, opened from `Root.jsx` with `/` or Ctrl/Cmd+K.

Hard-coded power copy is widespread. The important files are `client/src/lib/api.js` (`STATUS`, `ROLE`), `views/Overview.jsx`, `views/MapPage.jsx`, `views/Network.jsx`, `views/About.jsx`, `components/AreaAnswer.jsx`, `components/MyArea.jsx`, `views/OutageDetail.jsx`, `views/NodeDetail.jsx`. Examples: "Power is out", "Power is back on", "Power network", "How power flows here". The footer says the site is not affiliated with City Power or the City of Tshwane. `useUtility` already replaced the old single "City Power" string in phones and "view on X", but the nouns "power" and "substation" remain.

Mobile: under 760px a bottom nav replaces the header nav (`Root.jsx`, `app.css`). Under 860px the overview stacks the map above the list. MapLibre handles touch. `cooperativeGestures` is on for the small equipment map (`NodeReach.jsx`).

---

## 16. Map layer architecture

`MapView` (`client/src/components/MapView.jsx`) builds one MapLibre style on load. Layer ids are fixed:

| Source | Layers | Shown when |
|---|---|---|
| `coverage` | fill, outline | outages mode, estimated blob |
| `suburb-boundaries` | fill, outline | a point has `boundary` |
| `pts` | clusters, dots, labels | `layers.outages` |
| `hubs` | diamond symbols | `layers.equipment` |
| `flow-lines`, `flow-pulses` | animated lines | a hub is selected |

`MapPage` has two modes, not a layer list: outages (`/v1/map`) and infrastructure (`?view=infrastructure` or `?hub=`). The prop is `{ outages: true, equipment: mode === 'infrastructure' }`. There is no per-layer registry, no service key, and no second style.

Clustering is MapLibre `cluster: true`, radius 44, max zoom 11, only on suburb points.

Adding Electricity and Water as peer layers does **not** fit the current map without a refactor. Municipality scoping would filter both, but the sources, colours, legends, and endpoints are one electricity picture. A second page that copies `MapPage` would still need its own payload. The natural change is a service dimension on `/v1/map` and a real layer list inside `MapView`, which is a refactor of this component, not a new entry in an existing list.

---

## 17. Search

`GET /v1/search` in `routes.js`:

- Suburbs: `Locality.canonicalName` contains the query, optionally in the municipality, with region.
- Equipment: `InfraNode.name` contains the query, municipality-scoped, excluding nothing by type.
- Outages: `Outage.title` contains the query, municipality-scoped, newest `lastUpdateAt` first.

The client (`SearchBox.jsx`) debounces 160ms, requires 2 characters, and routes a suburb to `/suburb/:id`, an outage to `/outages/:id`, and equipment to `/network/:id`. The outages page has a separate `q` on `GET /v1/outages` that also matches suburb name and node name.

There is no address or street search.

Search is type-aware only in the sense of three buckets. It is not service-aware. A node named "Honeydew Reservoir" would appear under equipment if an `InfraNode` with that name existed, using the same `contains` query. "Eikenhof" or "Palmiet" would appear as suburbs if those localities exist, or as equipment if learned as nodes. No extra index is required. What does not exist is a type filter that could hide substations when the user is looking for reservoirs.

---

## 18. Scheduled jobs

All of these run inside the API process. There is no external cron in the repo. `SCHEDULER=off` disables all three (used by `npm run dev` in local notes and by scripts that must not poll).

| Job | Code | Cadence | Lock | Retries |
|---|---|---|---|---|
| Fetch and process | `fetchSchedule` → `cycle.runNow('scheduler')` | `X_POLL_INTERVAL_MINUTES` (default 5) after the previous tick ends | `withLease` pipeline lock. A second tick no-ops | Next interval. Tie-break and image retries are inside the cycle |
| Stale sweep | `sweepSchedule` → `sweepStaleOutages` | Hourly, and once at startup. Also inside each cycle | Same lease. If the lease is busy the startup/hourly sweep logs and skips; the in-cycle sweep is under the lease already | Next hour, and every cycle |
| Push | `notifySchedule` → `runNotifications` | 60 seconds, only if `PUSH_ENABLED=on` | None (reads only) | Next minute. `PUSH_DRY_RUN=on` logs instead of calling Expo |

Not scheduled: GIS import, geocode backfill beyond 8 suburbs per cycle, historical CSV import, relink, reread. Those are CLIs.

A Johannesburg Water poll of the same X account style would be another `SourceAccount` on the existing fetch tick, not a new operating-system cron. A poll of a non-X portal would be a new stage beside `ingestNewPosts`, still inside `cycle.work`, or a second scheduler started from `server.js` if it must not hold the pipeline lease for long.

---

## 19. Backfill and reprocessing

| Need | Tool |
|---|---|
| Store historical posts from a CSV | `scripts/import-csv.js` |
| Poll whatever X still returns above the high-water mark | `npm run ingest` (`scripts/ingest.js`), optional `--process` |
| Process stored but unread posts | `npm run process` |
| Wipe learned graph and outages, replay stored readings, no new Gemini calls | `scripts/process.js --reset --confirm` or `npm run relink` (`scripts/relink.js --confirm`) |
| Re-link specific posts from stored readings | `scripts/reprocess.js`. `--reextract` calls Gemini again. `--preview` does not write |
| Re-read posts whose prompt stamp is stale | `npm run reread` |
| Rebuild from a snapshot with a tie-break cap | `scripts/rebuild-history.js` |
| Apply one corrected link and keep it across rebuilds | `scripts/correct-link.js`. Undo: `scripts/restore-repair.js` |
| Re-learn geography | `npm run import:coj-gis`, `npm run import:tshwane-gis`, `npm run seed:geography` |
| Re-place suburbs | `npm run geocode` |
| Fill `municipalityId` from post evidence | `scripts/backfill-municipality.js --apply` |
| Merge duplicate nodes or suburbs | `scripts/merge-nodes.js`, `scripts/merge-locality.js` |
| Measure a replay without touching live data | `scripts/replay-eval.js` copies the live DB to a throwaway database |

`PostExtraction` is kept across a relink, so a water bootstrap that only needs new grouping can replay readings. A water bootstrap that needs a different reading must `reread` or `reextract`, which spends Gemini calls and writes a new `promptVersion` row rather than destroying the old one (unique on post plus version).

---

## 20. Testing

Unit tests (`npm test` in `api/`, Vitest, no database), the ones a water port should mirror:

| File | Locks |
|---|---|
| `api/tests/unit/scoring.test.js` | Candidate scores, stale revival, equipment vs suburb |
| `api/tests/unit/tie-margin.test.js` | Near-ties go to the tie-break |
| `api/tests/unit/status.test.js` | `statusFor` and multi-fault graphics |
| `api/tests/unit/schedule.test.js` | Planned windows |
| `api/tests/unit/insights.test.js` | Insights windows and area grouping |
| `api/tests/unit/geocode.test.js` | Municipality bounding boxes |
| `api/tests/unit/quality.test.js` | Disposition checks and the review-queue check |
| `api/tests/unit/x-client.test.js` | X retries, `fetch` stubbed |
| `api/tests/unit/image-retry.test.js` | Trusted image hosts and retries |

Integration (`npm run test:integration`) creates `gridwatch_test_<timestamp>` via `api/tests/integration/global-setup.js`, migrates, and truncates between tests (`db.js`).

| File | Locks |
|---|---|
| `api/tests/integration/linking.test.js` | The real associate-or-create path, including multi-fault graphics, tie-break cache, corrections, Tshwane cascades |
| `api/tests/integration/graph.test.js` | Learning is idempotent; cable/line folding |
| `api/tests/integration/ingestion.test.js` | High-water mark and single-flight fetch |
| `api/tests/integration/extraction.test.js` | Reading atomicity and rejected re-reads |
| `api/tests/integration/api.test.js` | HTTP shape, operator auth, map, insights |

AI is mocked. Integration tests `vi.mock` `gemini.client.js` or replace `extractPost` with a `readings` Map. They do not call Gemini. `tests/setup-env.js` sets a fake `GEMINI_API_KEY` if needed.

Golden files in `api/tests/golden/`:

- `links.json` is the tuning set for pairwise F1 (`scripts/eval.js`).
- `holdout-0910.json` through `holdout-0915.json` must not be tuned on.
- `corrections.json` is appended by `correct-link.js`.
- `states.json` is final status, kind, and window.
- `cases-0921.json` is a regression set.

`scripts/eval-all.js` reports reading rate, coverage, pairwise F1, corrections, and final state. `scripts/replay-eval.js` replays history on a copy of the live database.

Client: `client/tests/coverage.test.js` only. `client/scripts/nav-test.mjs` is a manual headless Chrome smoke test. There is no Playwright suite.

`api/audit/` holds characterization tests (`ingestion-audit.test.js` and others) run with their own Vitest config. They are not part of `npm test`.

A water implementation should add: a unit test for any new score or status function, an integration case in the style of `linking.test.js` (two posts, mocked reading, assert one outage or two), and a golden pair if a human correction is the spec.

---

## 21. Observability

Logging is pino. HTTP access lines are pino-http. There is no Sentry, no metrics scrape, and no dashboard in the repo.

Health: `GET /health` runs `SELECT 1`.

Ingestion health: `ingestionStatus` (high-water, incomplete flag, unprocessed count) is used by `scripts/audit.js`. Each fetch writes `IngestionRun` (`SUCCEEDED`, `FAILED`, `RATE_LIMITED`) with page and insert counts.

AI failures: `PostExtraction.status = FAILED` and `error`. The post becomes `PROCESSING_ERROR` and is eligible again. Tie-break failures become `RetryAttempt` or `LinkDecision.outcome = NEEDS_REVIEW`.

A post that was fetched but landed on the wrong outage is diagnosed from the database, not from a trace UI:

1. `npm run batch` (`scripts/batch-report.js`) prints the reading, the link outcome, the outage, and 15 invariant checks for the latest fetches.
2. `LinkDecision.reason`, `topScore`, `usedLlm`, and `candidates` are the scoring explanation.
3. `PostExtraction.result` is the raw model JSON.
4. `OutagePost.effect` is what that fault contributed.
5. `npm run review` lists `ReviewItem` rows. `NEW_NEAR_ACTIVE` means a new outage was opened beside a live one that shares a suburb or a node.
6. `npm run quality` is the last cycle's `CycleQuality`.
7. `npm run audit` exits 1 on contradictions, stuck posts, or an unhealthy ingestion checkpoint.

Operator HTTP: `/admin/quality`, `/admin/review`, `/admin/reprocess/:postId`, behind `requireOperator`.

---

## 22. Deployment

The repo does not define production deployment.

Not present: Dockerfile, docker-compose, `.github/workflows`, Cloud Run config, fly.toml, render.yaml, Railway, Procfile, a staging/prod split.

What exists is a local process:

- API: `node src/server.js` (`npm start`), port `PORT` (default 4000).
- Client: Vite dev server, proxying to the API. Production build is `vite build` static files. Where those files are hosted is not in the repo.
- Database: Postgres indicated only by `DATABASE_URL`.
- Secrets: `.env` on the API, not committed. `OPERATOR_TOKEN` gates paid routes.
- Scheduler: inside the API process. One replica should run it. A second replica would also start schedulers; the lease stops two fetches from writing at once, but both would still wake.

A new X account fits the existing process with no new service. A new non-X poller fits as another function called from `cycle.work` or another `createScheduler` in `server.js`, same pattern as the sweep.

---

## 23. Environment variables

Names only. Values that are defaults of behaviour are noted. No secrets.

**Database.** `DATABASE_URL`. Tests also use `TEST_DATABASE_SERVER_URL`, `GW_TEST_DATABASE_NAME`.

**X.** `X_API_BEARER_TOKEN`, `X_SOURCE_ACCOUNT_ID` (default City Power's numeric id, bootstrap only), `X_SOURCE_ACCOUNT_NAME` (default `CityPowerJhb`), `X_INCLUDE_REPLIES`, `X_MAX_PAGES_PER_RUN`, `X_POLL_INTERVAL_MINUTES`.

**Gemini.** `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_THINKING`, `AI_PROMPT_VERSION`, `AI_TIMEOUT_MS`, `KNOWLEDGE_CONTEXT`.

**Process flags not in the Zod schema.** `SCHEDULER`, `LOG_LEVEL`, `GRIDWATCH_NO_AI`, `GRIDWATCH_AI_ONLY`, `GRIDWATCH_AI_MAX_CALLS`, `TIEBREAK_CACHE_FILE`, `TIEBREAK_RETRY_DELAYS_MS`, `GEOGRAPHY_FILE`.

**Linking and lifecycle.** `LINK_HIGH_SCORE`, `LINK_LOW_SCORE`, `OUTAGE_WINDOW_HOURS` (default 72), `OUTAGE_AUTOCLOSE_HOURS` (default 48), `STALE_REVIVAL_HOURS` (default 240), `MEDIA_MAX_BYTES`.

**Operator and HTTP.** `OPERATOR_TOKEN`, `REFRESH_TOKEN` (deprecated alias), `OPERATOR_SESSION_HOURS`, `ALLOW_LOCAL_OPERATOR`, `CORS_ALLOWED_ORIGINS`, `PORT`, `NODE_ENV`, `REFRESH_BUTTON`, `REFRESH_COOLDOWN_SECONDS`, `REFRESH_MAX_POSTS`.

**Push.** `PUSH_ENABLED`, `PUSH_DRY_RUN`, `EXPO_ACCESS_TOKEN`.

**Verifier.** `VERIFIER_ENABLED`, `VERIFIER_MAX_CALLS_PER_DAY`, `VERIFIER_SAMPLE_RATE`.

**Client.** `VITE_API_URL`.

**Maps / GIS.** No tile API key. The basemap URL is hard-coded in `MapView.jsx`. GIS imports read local files, not an env var, except `GEOGRAPHY_FILE` for the text seed.

Provider accounts are **rows in `SourceAccount`**, not one env var per utility. The env defaults only seed the first account when the table is empty. Extra accounts are not selected by environment.

---

## 24. Existing documentation

| Path | What it is good for |
|---|---|
| `README.md` | How to migrate, seed, run the API and client, and the list of check commands (`batch`, `quality`, `review`, `audit`, `eval:all`) |
| `CLAUDE.md` | How to investigate a bad post and the rule that a fix needs a regression test. Describes two utilities already |
| `docs/ENGINE_REVIEW_2026-09-21.md` | Linking and ingestion review |
| `docs/ENGINE_FOLLOWUP_2026-09-22.md` | Quality, review, and retry follow-up |
| `docs/ENGINE_AUDIT_2026-09-23.md` | Why municipality identity was added (same name in two cities) |
| `docs/API_AUDIT.md` | Older API findings. Many were remediated; do not treat open items as current without reading the code |
| `docs/CLAUDE_CODE_API_FIX_PROMPT.md` | The remediation prompt for that audit, not a description of today's code |
| `docs/Gauteng/GRIDWATCH_GAUTENG_EXPANSION_RESEARCH.md` | Research on other Gauteng electricity utilities and their GIS. Electricity, not water |
| `docs/Gauteng/README_JOHANNESBURG_GRIDWATCH_DATASET.md` | How the CoJ locality/supply extract is built |
| `api/tests/golden/README.md` | Holdout vs tuning vs regression |

`README.md` still introduces the product as City Power Johannesburg only. The code polls every active `SourceAccount`. `README.md` points the GIS builder at `docs/Johannesburg/`; the file is `docs/Gauteng/build_johannesburg_area_dataset.py`.

---

## 25. Constraints a water implementation must respect

| Severity | Where | Why it matters |
|---|---|---|
| **HIGH** | `prompt.js` `BASE_PROMPT`, `extraction.schema.js` `ENTITY_TYPES` and `STATUSES` | Every post is read as an electricity outage. A water notice would become a fake substation outage or `IRRELEVANT` |
| **HIGH** | `OutageStatus` + `statusFor` + client `STATUS` | One electricity lifecycle. Water operating states do not map onto `ACTIVE` / `PARTIALLY_RESTORED` / `RESTORED` without lying |
| **HIGH** | `InfrastructureType` and `InfraEdge` with no relation kind | Reservoirs, towers, and bypasses have no type and no edge label. `OTHER` is already a junk drawer and is merged with cables and lines |
| **HIGH** | `linkPost` / `loadCandidates` scoped only by municipality and suburb/node overlap | Johannesburg Water and City Power share the municipality and the suburbs. They would steal each other's outages |
| **HIGH** | `MapView.jsx` fixed sources and `MapPage` two modes | A water layer is not a toggle that already exists |
| **MEDIUM** | `municipality-scope.js` `UTILITIES`, insights `areaOf` | Display and grouping know two electricity utilities. A service dimension is missing, so "Johannesburg" cannot mean both power and water |
| **MEDIUM** | `Locality.electricitySupplier` | Supply-area attribution is an electricity string, not a generic "who serves this suburb for this service" |
| **MEDIUM** | `scoring.js` SDC bonus, `Outage.sdcName`, network page `/v1/network/sdcs` | The area hierarchy is City Power's service centre. Water's supply zone is a different parent |
| **MEDIUM** | `fault-category.js` and insights | Cause buckets and the area table assume electrical faults |
| **MEDIUM** | `verifier.js` prompt | Hard-coded to City Power. Unsafe to turn on for a second service without a rewrite |
| **LOW** | Env default X account | Only matters on an empty database |
| **LOW** | Client footer and about copy | Strings, now partly driven by `useUtility` |

Geography is the piece that is already reusable: `Locality`, `Region`, boundaries, and `resolveLocality` do not care why a suburb was named. Ingestion of a second X account is also already reusable.

---

## 26. What to reuse

| Component | Path | Generic? | Reuse |
|---|---|---|---|
| X poller and checkpoint | `ingestion.service.js`, `x.client.js`, `IngestionState` | Any X user | **Direct reuse.** New `SourceAccount` row |
| Media download | `extraction.service.js` `fetchImage` / `loadImages` | Any twimg URL | **Direct reuse** |
| Gemini JSON caller | `gemini.client.js` `generateJson` | Schema is an argument | **Direct reuse** with a new schema |
| Extraction prompt and schema | `prompt.js`, `extraction.schema.js` | Electricity | **Unsuitable** as-is. New prompt, new schema, new `promptVersion` |
| Lease, cycle, retry, quality record | `cycle.js`, `lease.js`, `quality.js` | The stages are electricity-specific in what they call, the runner is not | **Small extension** if water is another account on the same cycle; **significant** if water must not share the link stage |
| Suburb resolution and GIS polygons | `resolveLocality`, `gis-import.js`, `Locality.boundary` | Service-agnostic | **Direct reuse** |
| Geocoder | `geocode.service.js` | Municipality boxes | **Direct reuse** for learned water suburb names |
| Graph write path | `resolveNode`, `shouldCount`, `EvidenceContribution` | Types and parent rules are electricity | **Significant extension** (types, edge kind) then reuse the counter |
| Linker scoring time window and suburb overlap | `scoring.js` | The SDC term is not generic | **Significant extension.** Do not point water posts at `loadCandidates` until outages are tagged by service |
| Timeline fold | `outage-state.js` `foldEffects` | Assumes the electricity status set | **Significant extension** for new states; the "store an effect, fold in time order" idea is the right one to keep |
| Manual correction and snapshots | `correct-link.js`, `LinkOverride`, `repair.js` | Post-shaped | **Small extension** once water incidents are the same `Outage` row or a parallel one |
| Review queue | `review.service.js` | Rules mention SDC, equipment typos, suburb overlap | **Small extension** for new reason codes |
| Map rendering shell | `MapView.jsx` | One electricity scene | **Significant extension** or a second view |
| API route style and municipality filter | `routes.js`, `municipality-scope.js` | Municipality, not service | **Small extension** to add a service filter beside `municipality` |
| Push | `notify.service.js` | Follows localities and electricity status changes | **Significant extension** |
| Tests and golden files | `tests/integration/linking.test.js`, `tests/golden` | Pattern | **Direct reuse** of the pattern, not of the electricity fixtures |

---

## 27. Likely extension points

These are the places the current architecture already has a seam. They are not a plan.

| Seam | Module | Why this is the seam |
|---|---|---|
| Another X account | `SourceAccount` plus `seed-source-account.js` | The poller already loops active accounts. This is how Tshwane was added |
| Per-account reading | `buildSystemPrompt(sourceAccountName)` and `PostExtraction.promptVersion` | A hint map and a version key already exist. A water account needs its own hint and its own schema, not a paragraph appended to the electricity rules |
| Service on the outage | There is no column. The closest analogue is `Outage.municipalityId`, set from the opening account in `commitLink` | Municipality was added so two cities do not share incidents. A service id is the same kind of scope, and `loadCandidates` is the function that would have to honour it |
| Asset types | `InfrastructureType` and `resolveNode` | New types belong in the enum and in `resolveNode`'s station-vs-minor rules. Do not overload `OTHER` |
| Edge meaning | `InfraEdge` has no type column | Any water relation that is not "parent contains child" needs a discriminator on this table or a new table. The evidence counter can stay |
| Status fold | `statusFor` / `foldEffects` | New states belong here, next to the existing map from reading-status to outage-status, not in the React layer |
| Map payload | `GET /v1/map` and `MapView` sources | The client only knows how to draw what this endpoint returns. A water layer starts by extending this payload or adding a sibling route, then teaching `MapView` a third source |
| Copy | `useUtility` and `UTILITIES` | Phones and utility names already switch by municipality. Service-specific sentences ("power" vs "water") need a similar lookup, which does not exist yet |
| Area grouping | `areaOf` in `insights.service.js` | City Power groups by `sdcName`, Tshwane by GIS region, because `UTILITIES[code].areas` says so. A water zone would be a third `areas` mode |

A large new "incident platform" beside `Outage` is not justified by the code. The tables already separate source posts, readings, graph, and incidents. The missing dimension is service, in the same place municipality was added.

---

## 28. Questions the codebase cannot answer

- Where production runs, how many API replicas exist, and whether `SCHEDULER=off` is set on some of them. None of that is in the repo.
- Whether a hosted Postgres has extensions installed. The schema does not use PostGIS, but the server might still have it.
- The live set of `SourceAccount` rows and whether Johannesburg Water's X account is already known to anyone operationally. The code can store it; it does not name it.
- Which CoJ layers a water supply zone should be built from. The Python builder documents electricity supply and suburb polygons, not reservoir catchments.
- Whether Johannesburg Water publishes a machine-readable outage feed besides X. This repository only implements X.
- Token budgets and Gemini spend caps in production beyond `REFRESH_MAX_POSTS` and `GRIDWATCH_AI_MAX_CALLS` (the latter is a script flag, not a server setting).
- The contents of `OPERATOR_TOKEN` and the X bearer token. They are not in source.

---

## 29. Reading list

1. `api/prisma/schema.prisma` — every table a water incident would sit beside or collide with.
2. `api/src/modules/processing/cycle.js` — the only pipeline. A new source has to enter here or beside it.
3. `api/src/server.js` — schedulers and the fact that they are in-process.
4. `api/src/modules/ingestion/ingestion.service.js` — multi-account fetch, high-water mark, deduplication.
5. `api/src/modules/ingestion/x.client.js` — the actual X request.
6. `api/src/modules/ai/prompt.js` — the electricity reading rules and the per-account hint seam.
7. `api/src/modules/ai/extraction.schema.js` — the JSON the rest of the system trusts.
8. `api/src/modules/ai/extraction.service.js` — images, Gemini call, `PostExtraction` write.
9. `api/src/modules/processing/processor.service.js` — `processPost` order: extract, learn, link, faults.
10. `api/src/modules/infrastructure/infrastructure.service.js` — `resolveNode`, `resolveLocality`, `learnFromExtraction`, evidence counts.
11. `api/src/modules/outages/linker.service.js` — `linkPost`, candidate loading, tie-break, digest rules.
12. `api/src/modules/outages/scoring.js` — the numbers behind a link.
13. `api/src/modules/outages/outage-state.js` — `statusFor` and `foldEffects`.
14. `api/src/modules/api/municipality-scope.js` — how a municipality becomes a filter and a display name. The pattern a service scope would follow.
15. `api/src/modules/api/routes.js` — every public endpoint, including `/v1/map` and `/v1/search`.
16. `api/src/lib/gis-import.js` — how suburb polygons land in `Locality.boundary`.
17. `api/src/modules/geo/geocode.service.js` — placing a name that was not in the GIS extract.
18. `api/src/modules/geo/equipment-map.service.js` — why equipment dots are derived from suburbs.
19. `api/src/modules/review/review.service.js` — what "this link looks wrong" means today.
20. `api/src/config/env.js` — every validated knob, including the 72-hour window.
21. `client/src/components/MapView.jsx` — the layer list a water toggle does not yet have.
22. `client/src/views/MapPage.jsx` — outages mode vs infrastructure mode.
23. `client/src/lib/api.js` — status sentences and the fetch helper.
24. `client/src/lib/municipality.jsx` — the global area switch.
25. `api/tests/integration/linking.test.js` — the regression style a water link rule needs.
26. `api/tests/golden/README.md` — which labelled sets may be tuned on.
27. `docs/ENGINE_AUDIT_2026-09-23.md` — why municipality identity exists, which is the closest previous "second source" change.
28. `CLAUDE.md` — how a bad live post is traced and corrected without a schema change.

---

## 30. Final architecture summary

**1. How does GridWatch work today?**  
An in-process scheduler polls every active X account, stores posts, sends each new post and its images to Gemini, learns electricity equipment and suburb links from that JSON, then either attaches the post to a recent outage or opens one. The outage's status is the fold of each post's effect in time order. Express serves that to a React map.

**2. Where is City Power or electricity hard-coded?**  
In the extraction prompt and schema, the infrastructure enum, outage statuses, SDC scoring, fault categories, the verifier prompt, and the client sentences and map layers. Fetching, municipality filters, and suburb geometry are not hard-coded to one account. Two electricity utilities (City Power and City of Tshwane) already share this electricity model.

**3. Which parts are already generic?**  
The X poller and checkpoint, image download, `generateJson`, suburb identity and polygons, the lease and cycle runner, evidence counts, link overrides, and the municipality filter on API routes.

**4. What data model represents infrastructure?**  
`InfraNode` (typed name, no coordinates) and `InfraEdge` (untyped parent → child, with an evidence count). Suburbs attach via `NodeLocality`. Source posts attach via `EvidenceContribution`.

**5. How does infrastructure learning work?**  
`learnFromExtraction` resolves names within a municipality, creates a node on first sight, confirms it at two independent posts, and writes an edge only when the extraction supplied `parent_name`. Repeats increment counts once per post fault. Edges do not expire.

**6. How does geography resolution work?**  
A string is normalized and matched to `Locality.normalizedName` or an alias, fuzzily above 0.92, inside the post's municipality. Known suburbs come from the CoJ or Tshwane GIS import, including GeoJSON boundaries. Unknown names are learned and later geocoded against OSM or Nominatim inside a bounding box.

**7. How does incident association work?**  
`linkPost` scores recent same-municipality outages on thread, equipment, neighbouring equipment, and suburb overlap, with a 72-hour window. At or above 0.7 it links. Between 0.35 and 0.7 Gemini breaks the tie. Below that it opens a new outage. Planned work never merges with unplanned work. A person's `LinkOverride` wins over the score.

**8. How does the frontend map consume the data?**  
`MapPage` loads `GET /v1/map` for clustered suburb dots and boundaries, or `GET /v1/map/infrastructure` and `GET /v1/map/node/:id` for derived equipment diamonds and animated feeder lines. `MapView` has a fixed set of sources. The municipality dropdown is a query parameter, not a service switch.

**9. What are the safest extension points for Johannesburg Water?**  
Add the account on `SourceAccount` (already how a second feed works). Add a service scope next to `municipalityId` before any water post is allowed into `loadCandidates`. Give water its own prompt, schema, and `promptVersion`. Extend `InfrastructureType` and edge meaning rather than using `OTHER`. Extend `/v1/map` and `MapView` together when there is something to draw. Keep `Locality` as the shared suburb layer.

**10. What are the biggest architectural risks?**  
Linking on shared suburbs inside one municipality, so a water post closes or extends a power outage. Reading water graphics with the electricity prompt, which will invent substations. Collapsing water assets into `InfrastructureType.OTHER`, which is merged with cables and lines. Pretending water operating states are `ACTIVE` and `PARTIALLY_RESTORED`. And teaching `MapView` a second service by copying the component instead of giving it a layer list, which would leave two maps to maintain.
