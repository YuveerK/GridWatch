# GridWatch — Johannesburg Water Integration Implementation Plan

**Status:** Implementation specification  
**Target:** GridWatch codebase described on `main` commit `5934cf1`  
**Date:** 24 September 2026  
**Primary objective:** Add Johannesburg Water as a first-class GridWatch service while preserving the existing electricity pipeline and using the existing Johannesburg geography, X ingestion, AI/media pipeline, incident engine, infrastructure graph, API, and map wherever safe.

---

# 1. Executive summary

GridWatch already has most of the difficult platform pieces required for Johannesburg Water:

- multi-account X ingestion;
- durable X cursors and deduplication;
- image download and Gemini multimodal extraction;
- municipality-scoped geography;
- official Johannesburg suburb polygons;
- infrastructure nodes and directed edges;
- evidence counting;
- incident association;
- ordered incident timelines;
- reprocessing and correction tools;
- a React/MapLibre frontend.

However, **water must not simply be added as another active X account and allowed through the existing processing path**.

The current code assumes that every processed post represents an electricity incident. In particular:

- the Gemini prompt and schema are electricity-specific;
- `InfrastructureType` is electricity-specific;
- `InfraEdge` has no relationship type;
- `OutageStatus` is an electricity-oriented universal state;
- incident candidates are separated by municipality but **not by service**;
- Johannesburg Water and City Power share the same municipality and suburb names;
- the frontend map has one electricity scene rather than a generic layer registry.

If `@JHBWater` is activated before service isolation is implemented, a water post mentioning a suburb such as Willowbrook, Honeydew or Randburg can become a candidate for a live City Power outage in the same suburb.

Therefore the first implementation rule is:

> **Introduce a service dimension and enforce it at persistence, extraction, infrastructure learning, candidate loading, APIs and map queries before processing any Johannesburg Water post.**

The recommended implementation keeps the existing `Outage` model rather than creating a separate water incident platform. The current architecture already separates source posts, readings, infrastructure, incidents and geography cleanly enough. The missing dimension is service.

---

# 2. Source documents used for this plan

## 2.1 GridWatch codebase audit

This plan is based on the Grok/Cursor audit of GridWatch at commit `5934cf1`.

The important current architecture is:

```text
X
→ SourcePost / PostMedia
→ Gemini PostExtraction
→ infrastructure learning
→ incident linking
→ OutagePost effect
→ foldEffects
→ Outage
→ Express API
→ React + MapLibre
```

Important existing files:

```text
api/prisma/schema.prisma

api/src/server.js
api/src/modules/processing/cycle.js
api/src/modules/processing/processor.service.js

api/src/modules/ingestion/ingestion.service.js
api/src/modules/ingestion/x.client.js

api/src/modules/ai/gemini.client.js
api/src/modules/ai/prompt.js
api/src/modules/ai/extraction.schema.js
api/src/modules/ai/extraction.service.js

api/src/modules/infrastructure/infrastructure.service.js
api/src/modules/infrastructure/knowledge-context.js

api/src/modules/outages/linker.service.js
api/src/modules/outages/scoring.js
api/src/modules/outages/outage-state.js

api/src/modules/api/routes.js
api/src/modules/api/municipality-scope.js

api/src/lib/gis-import.js
api/src/modules/geo/equipment-map.service.js

client/src/components/MapView.jsx
client/src/views/MapPage.jsx
client/src/lib/api.js
client/src/lib/municipality.jsx
```

Do not assume file contents have remained unchanged after commit `5934cf1`. Before editing a file, inspect its current version.

---

## 2.2 Official Johannesburg Water / Rand Water sources

Use official sources as the static topology authority wherever possible.

### Johannesburg Water reservoir supply zones

Official page:

https://www.johannesburgwater.co.za/towers-and-reservoirs-2/

The table provides, per reservoir/zone:

- zone / reservoir name;
- served suburbs/extensions;
- number of stands;
- capacity in kL;
- average annual daily demand (AADD);
- nominal storage hours.

This is a strong source for:

```text
RESERVOIR → SERVES → LOCALITY
```

and for asset metadata.

### Johannesburg Water tower supply zones

Official page:

https://www.johannesburgwater.co.za/johannesburg-water-towers/

The table provides equivalent mappings for towers.

Use it for:

```text
TOWER → SERVES → LOCALITY
```

### Direct feeds

Examples:

https://www.johannesburgwater.co.za/linbro-park-direct-feed/

https://www.johannesburgwater.co.za/marlboro-direct-feed/

The Linbro Park and Marlboro pages expose Rand Water connection identifiers such as:

```text
RW1399 / RW5628
```

This supports explicit topology such as:

```text
RAND_WATER_CONNECTION
→ DIRECTLY_SUPPLIES
→ DIRECT_FEED
→ SERVES
→ LOCALITY
```

### Johannesburg Water system pages

Examples:

https://www.johannesburgwater.co.za/sandton/

https://www.johannesburgwater.co.za/sandton-systems/

https://www.johannesburgwater.co.za/soweto/

These pages identify which reservoirs, towers and direct feeds belong to broader JW operating systems.

Use them for system membership and discovery, not blindly as precise hydraulic flow direction unless the page explicitly states direction.

### Johannesburg Water systems updates

Official archive:

https://www.johannesburgwater.co.za/media/media-statement/systems-update/

This is useful for historical topology evidence and operational vocabulary.

Examples in official updates include:

- reservoir low / critically low / empty;
- tower stable / improving;
- outlets partially open;
- poor pressure;
- no water;
- throttling;
- bypass;
- systems recovering.

### Rand Water planned maintenance and upstream mapping

Official May 2026 Johannesburg Water notice:

https://www.johannesburgwater.co.za/wp-content/uploads/2026/05/RW-planned-maintenance-to-impact-JW-systems_May2026.NS_.pdf

It explicitly maps upstream Rand Water systems such as:

```text
Palmiet
Eikenhof
Zwartkopjes
```

to downstream Johannesburg Water systems/assets.

This should be used as curated evidence for upstream graph relationships.

### Rand Water bulk infrastructure

Official Rand Water information:

https://www.randwater.co.za/aboutus.php

Rand Water identifies major purification and booster infrastructure including:

```text
Vereeniging
Zuikerbosch
Zwartkopjes
Palmiet
Eikenhof
Mapleton
```

### Official live communications

Johannesburg Water identifies `@JHBWater` as an official X/Twitter source:

https://www.johannesburgwater.co.za/daily-water-notices/

Initial live ingestion should use the existing X pipeline before adding website ingestion.

---

# 3. Product goal

A resident should eventually be able to select **Water** in GridWatch and understand:

```text
1. Is my suburb currently affected?
2. Is it no water, low pressure, constrained supply, or recovering?
3. What Johannesburg Water asset/system supplies my area?
4. What upstream asset caused or contributed to the problem?
5. What has Johannesburg Water said so far?
6. Is restoration confirmed, or is the system merely recovering?
7. Which effects are officially confirmed and which are inferred from the network?
```

Example future output:

```text
Willowbrook

Water
Johannesburg Water

Supply:
Boschkop / Honeydew system

Current incident:
Low pressure / constrained supply

Upstream:
Honeydew Reservoir

Latest update:
Reservoir levels improving. System recovering.

Confirmed affected:
Willowbrook
Honeydew Manor
...

Potential downstream impact:
...

Source:
Johannesburg Water
```

GridWatch must never present topology-based inference as if Johannesburg Water explicitly confirmed it.

---

# 4. Non-goals for the first implementation

Do not attempt to build all of the following in the first release:

- exact underground pipe GIS;
- valve-level hydraulic simulation;
- pressure modelling;
- customer-specific service lines;
- a full digital twin;
- PostGIS migration;
- Redis / queues / new worker architecture;
- automatic ingestion of every Johannesburg Water PDF;
- WhatsApp scraping;
- Facebook scraping;
- predictive reservoir depletion;
- exact time-to-restoration modelling;
- automatic tanker routing.

The first useful version only needs:

```text
official static topology
+
live official notices
+
incident timelines
+
service-aware map
```

---

# 5. Architectural principles

## 5.1 Electricity must remain unchanged

The safest implementation is additive.

Existing electricity rows should migrate to:

```text
serviceType = ELECTRICITY
```

and current electricity behaviour should remain functionally identical.

All existing unit, integration and golden tests must stay green before water is enabled.

---

## 5.2 Service is a first-class scope

Municipality is not enough.

Johannesburg contains:

```text
City Power          → ELECTRICITY
Johannesburg Water  → WATER
```

Every stage that currently relies on municipality identity must be checked for service identity as well.

At minimum:

```text
SourceAccount
SourcePost
Outage
InfraNode
candidate loading
API filtering
search
map
```

must know the service.

---

## 5.3 Share geography, not incidents

The same `Locality` should be reused for:

```text
Willowbrook
Honeydew
Randburg
Bryanston
Soweto
...
```

A locality is geographic truth.

Do **not** create separate `WaterLocality` and `ElectricityLocality` models.

Instead:

```text
Locality
  ↑
  ├── electricity incidents/assets
  └── water incidents/assets
```

This is one of the strongest existing parts of GridWatch.

---

## 5.4 Reuse the ingestion and Gemini transport

Do not write a second X poller.

The existing poller already processes every active `SourceAccount`.

Do not write another Gemini HTTP wrapper.

`generateJson()` already accepts structured JSON.

What changes is the service-specific prompt/schema and the interpretation of the result.

---

## 5.5 Do not overload `OTHER`

Water assets must not be written as:

```text
InfrastructureType.OTHER
```

The existing electricity code intentionally merges some `CABLE`, `LINE` and `OTHER` identities.

Doing this for water would contaminate the infrastructure graph.

---

## 5.6 Separate incident lifecycle from water operating condition

Keep the concept:

```text
Is this incident active/restored/closed?
```

separate from:

```text
What is the water system currently doing?
```

For example:

```text
incident lifecycle = ACTIVE
water state        = RECOVERING
```

when pumping has resumed but customer supply has not fully recovered.

Do not mark the incident `RESTORED` merely because an upstream pump restarted.

---

# 6. Proposed schema evolution

Modify:

```text
api/prisma/schema.prisma
```

Create a normal Prisma migration.

Names below are recommended. If the current schema has naming constraints that make a different name cleaner, preserve the semantics.

---

## 6.1 Add `ServiceType`

```prisma
enum ServiceType {
  ELECTRICITY
  WATER
}
```

Do not use municipality as a proxy for service.

---

## 6.2 `SourceAccount.serviceType`

Add:

```prisma
serviceType ServiceType @default(ELECTRICITY)
```

Existing rows migrate to electricity.

Johannesburg Water will be:

```text
municipality = JOHANNESBURG
serviceType  = WATER
platform     = X
displayName  = JHBWater
```

The existing City Power row remains:

```text
municipality = JOHANNESBURG
serviceType  = ELECTRICITY
```

---

## 6.3 Persist service on `SourcePost`

Recommended:

```prisma
serviceType ServiceType @default(ELECTRICITY)
```

Why persist it rather than resolving it from `SourceAccount` every time:

- `SourcePost.sourceAccount` is currently a display-name string rather than the account foreign key;
- historical posts should retain the service they were ingested as;
- later account renames/config changes must not alter old posts;
- reprocessing becomes deterministic.

During ingestion copy:

```text
SourceAccount.serviceType
→ SourcePost.serviceType
```

Backfill existing posts as `ELECTRICITY`.

---

## 6.4 Add service to `Outage`

Add:

```prisma
serviceType ServiceType @default(ELECTRICITY)
```

Add indexes appropriate to existing queries, likely including:

```text
(serviceType, status, lastUpdateAt)
(municipalityId, serviceType, lastUpdateAt)
```

The critical invariant is:

> An outage candidate must have the same `serviceType` as the source post.

---

## 6.5 Add service to `InfraNode`

Add:

```prisma
serviceType ServiceType @default(ELECTRICITY)
```

Update node uniqueness so identities are service scoped.

Conceptually:

```text
(serviceType, type, normalizedKey, municipalityId)
```

This prevents a future water `OTHER`/name collision even if type logic changes.

Update the partial unique index for null municipality in the same way.

---

## 6.6 Extend `InfrastructureType`

Keep all current electricity values.

Add explicit water values such as:

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

Do not remove or rename electricity values in the first migration.

`WATER_OTHER` must be separate from electricity `OTHER`.

---

## 6.7 Give `InfraEdge` a relationship type

Current graph semantics are an unlabeled:

```text
parent → child
```

Water requires different relationships.

Add:

```prisma
enum InfrastructureRelationType {
  LEGACY_PARENT
  SUPPLIES
  PUMPS_TO
  DIRECTLY_SUPPLIES
  FEEDS
  PART_OF
  UPSTREAM_OF
  BYPASSES
  BACKFEEDS
}
```

Use `LEGACY_PARENT` for migrated electricity edges unless the existing meaning can be deterministically classified.

Add:

```prisma
relationType InfrastructureRelationType @default(LEGACY_PARENT)
```

Change the unique/primary identity from:

```text
(parentId, childId)
```

to:

```text
(parentId, childId, relationType)
```

This allows:

```text
A SUPPLIES B
A BYPASSES B
```

to coexist if official evidence supports both.

Do not infer inverse edges into the database unless needed. The query layer can infer:

```text
SUPPLIES => downstream
```

from direction.

---

## 6.8 Improve edge provenance

The current post-learning evidence path already has `EvidenceContribution`.

Keep it.

For official static topology imports, do **not** invent fake X posts.

Add a small provenance model for imported official facts.

Recommended:

```prisma
enum KnowledgeSourceType {
  OFFICIAL_WEB
  OFFICIAL_DOCUMENT
  MANUAL_CURATED
}

model KnowledgeSource {
  id          String @id @default(cuid())
  sourceType  KnowledgeSourceType
  title       String?
  url         String
  publishedAt DateTime?
  fetchedAt   DateTime @default(now())
  metadata    Json?
}

model InfrastructureEvidence {
  id           String @id @default(cuid())
  sourceId     String
  nodeId       String?
  parentId     String?
  childId      String?
  localityId   String?
  relationType InfrastructureRelationType?
  evidenceKind String
  metadata     Json?

  // relations...
}
```

The exact shape can be simplified, but the important rule is:

> Official page/document evidence must remain traceable to the source that created the topology fact.

Do not hide imported relationships behind an unexplained `evidenceCount = 2`.

Existing `EvidenceContribution` should continue to represent facts learned from `SourcePost`.

---

## 6.9 Optional real/derived geometry on `InfraNode`

The current `InfraNode` has no position or polygon.

Add optional fields:

```prisma
lat       Float?
lon       Float?
boundary  Json?
geoSource String?
```

This is useful beyond water.

Behaviour:

1. If an asset has official/curated coordinates, use them.
2. Otherwise keep the current derived equipment position from linked localities.
3. For a reservoir/tower/direct-feed service area, `boundary` can contain a **derived** union of served `Locality.boundary` geometries.
4. Mark this clearly:

```text
geoSource = "derived-from-localities"
```

Do not label the derived polygon an official hydraulic pressure-zone boundary.

---

## 6.10 Add relation semantics to `NodeLocality`

Recommended:

```prisma
enum NodeLocalityRelationType {
  ASSOCIATED
  SERVES
}

relationType NodeLocalityRelationType @default(ASSOCIATED)
```

Existing electricity rows become `ASSOCIATED`.

Official water topology imports use:

```text
SERVES
```

Live water evidence can reinforce those same relations.

If changing the primary key is required to permit multiple relationship types, use:

```text
(nodeId, localityId, relationType)
```

If the code never needs two simultaneous relation types for the same pair, keep the current key and update the relation type in place.

---

# 7. Water operational state

Do not replace `OutageStatus`.

Keep the existing lifecycle:

```text
ACTIVE
PARTIALLY_RESTORED
RESTORED
STALE
CLOSED
PLANNED
CANCELLED
```

Add a water-specific state, nullable for electricity:

```prisma
enum WaterOperationalState {
  NORMAL
  STABLE
  CONSTRAINED
  LOW
  CRITICAL
  EMPTY
  NO_INCOMING_SUPPLY
  NO_PUMPING
  PUMPING_REDUCED
  OUTLET_CLOSED
  PARTIAL_SUPPLY
  LOW_PRESSURE
  NO_SUPPLY
  BYPASS
  THROTTLED
  RECOVERING
  UNKNOWN
}

waterState WaterOperationalState?
```

It is acceptable for multiple source phrases to map to the same canonical state.

Examples:

```text
"critically low"                → CRITICAL
"reservoir is empty"            → EMPTY
"no inflow / no incoming water" → NO_INCOMING_SUPPLY
"no pumping"                    → NO_PUMPING
"outlets partially opened"      → PARTIAL_SUPPLY
"poor pressure"                 → LOW_PRESSURE
"throttled to 90%"              → THROTTLED
"system is recovering"          → RECOVERING
"supplying normally"            → NORMAL
```

Important:

```text
pumping resumed
```

must usually map to:

```text
Outage.status = ACTIVE
waterState    = RECOVERING
```

until customer restoration is explicitly confirmed.

---

# 8. Service-aware processing registry

The current extraction path has one electricity prompt/schema.

Do not fill `prompt.js` with a giant `if WATER` block.

Create a simple service reader registry.

Recommended new files:

```text
api/src/modules/ai/readers/electricity.reader.js
api/src/modules/ai/readers/water.reader.js

api/src/modules/ai/prompts/electricity.prompt.js
api/src/modules/ai/prompts/water.prompt.js

api/src/modules/ai/schemas/electricity-extraction.schema.js
api/src/modules/ai/schemas/water-extraction.schema.js

api/src/modules/ai/reader-registry.js
```

The exact directory can be adjusted to the existing style.

Concept:

```js
readerFor(ServiceType.ELECTRICITY)
readerFor(ServiceType.WATER)
```

A reader supplies:

```text
buildSystemPrompt()
buildUserText()
zodSchema
jsonSchema
promptVersion
normaliseReading()
```

`gemini.client.js` remains generic.

`extraction.service.js` continues handling:

- image loading;
- Gemini call;
- timeout;
- persistence;
- retries;
- token counts;
- prompt stamps.

It should obtain the correct reader using `post.serviceType`.

Electricity behaviour should be moved with minimal semantic edits and locked by current tests.

---

# 9. Johannesburg Water extraction schema

Create a dedicated schema.

The goal is not to make Gemini model the entire hydraulic network. It should read what the notice actually says.

Recommended high-level result:

```json
{
  "relevance": "INTERRUPTION | PLANNED_MAINTENANCE | SYSTEM_UPDATE | RESTORATION | INFORMATIONAL | IRRELEVANT",
  "kind": "UNPLANNED | PLANNED",
  "water_state": "CRITICAL",
  "cause": "Poor incoming supply from Rand Water",
  "eta_text": null,
  "restoration_percent": null,
  "systems": [],
  "entities": [],
  "localities": [],
  "relationships": [],
  "faults": [],
  "image_text": "",
  "confidence": 0.94,
  "review_reason": null
}
```

---

## 9.1 Water entity types

The AI schema should allow only explicit water entities:

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
OTHER_WATER_INFRASTRUCTURE
```

Also allow `operator`:

```text
JOHANNESBURG_WATER
RAND_WATER
UNKNOWN
```

Do not ask Gemini to classify suburbs as infrastructure.

---

## 9.2 Explicit relationships

Allow the reading to report relationships only when the notice makes them reasonably explicit:

```json
{
  "from": "Palmiet",
  "to": "Sandton System",
  "type": "SUPPLIES",
  "confidence": 0.9
}
```

Allowed types:

```text
SUPPLIES
PUMPS_TO
DIRECTLY_SUPPLIES
PART_OF
UPSTREAM_OF
BYPASSES
BACKFEEDS
```

The prompt must say:

> Do not invent a relationship merely because two assets appear in the same notice.

Static official topology remains the stronger authority.

---

## 9.3 Locality state

A locality can carry a status from the notice:

```json
{
  "name": "Willowbrook",
  "impact": "NO_SUPPLY | LOW_PRESSURE | AFFECTED | RESTORED | UNKNOWN"
}
```

This should map to existing `OutageLocality.restored` plus any new impact metadata required for water.

---

## 9.4 Multi-system notices

Johannesburg Water publishes bulletins covering many systems.

Use `faults[]` similarly to existing electricity digest handling.

Each fault should contain enough information to link independently:

```text
assets
systems
localities
water_state
cause
eta
```

Do not create one giant Johannesburg-wide water incident from a daily system-status bulletin.

---

# 10. Water prompt rules

The water system prompt should explicitly teach the model the difference between:

```text
supply restored
vs
pumping restored
vs
levels improving
vs
system recovering
```

Required rules:

1. **Never mark restored solely because pumping resumed.**
2. **Never mark restored solely because a reservoir level improved.**
3. "Supplying normally" is strong restoration/normal evidence.
4. "System recovering" is `RECOVERING`.
5. "Poor pressure expected" is still an active customer impact.
6. "Outlets partially open" is not full restoration.
7. "Critically low" / "empty" describe system state and may imply customer impact only if the notice says customers are affected or supply is constrained.
8. Separate multiple reservoirs/towers when a bulletin gives distinct conditions for each.
9. Preserve percentages and capacity/level text in structured detail where present.
10. Do not infer an upstream topology relationship unless the post says one asset feeds/supplies/depends on another.
11. Use the provided known-water-network context to normalize names, not to invent impacts.
12. Treat Rand Water and Johannesburg Water as different operators.

---

# 11. Knowledge context for water

Current `knowledge-context.js` is SDC-scoped.

Refactor it so the concept is:

```text
known infrastructure relevant to this service + municipality + mentioned areas
```

Electricity can keep existing SDC behaviour.

Water context can include:

- known reservoirs;
- towers;
- direct feeds;
- systems;
- aliases;
- upstream/downstream relationships;
- official supply-zone locality names.

Keep context bounded.

Do not dump the entire Johannesburg water graph into every Gemini request.

Possible water selection:

```text
1. exact/fuzzy asset names appearing in text;
2. assets serving mentioned localities;
3. one-hop parents/children of those assets;
4. known aliases.
```

---

# 12. Static Johannesburg Water network dataset

Build the water graph before turning on live ingestion.

This prevents the AI from being responsible for discovering known published topology.

---

## 12.1 Builder

Follow the existing geography-builder pattern.

Recommended file:

```text
docs/Gauteng/build_johannesburg_water_dataset.py
```

Output:

```text
api/data/johannesburg-water/network.json
api/data/johannesburg-water/match-report.json
```

If the existing Python GIS builders use a standard geometry/parser stack, reuse it.

Do not introduce PostGIS merely for this feature.

---

## 12.2 Dataset shape

Example:

```json
{
  "generatedAt": "...",
  "sources": [...],
  "assets": [
    {
      "key": "jw:honeydew-reservoir",
      "name": "Honeydew Reservoir",
      "type": "RESERVOIR",
      "operator": "JOHANNESBURG_WATER",
      "capacityKl": 28600,
      "aaddKlDay": 30553,
      "storageHours": 22,
      "sourceUrls": [...]
    }
  ],
  "assetLocalities": [
    {
      "assetKey": "jw:honeydew-reservoir",
      "localityName": "HONEY PARK EXT.20",
      "relation": "SERVES",
      "sourceUrl": "..."
    }
  ],
  "relationships": [
    {
      "from": "rw:palmiet",
      "to": "jw:sandton-system",
      "type": "SUPPLIES",
      "sourceUrl": "..."
    }
  ]
}
```

Do not require every asset to have coordinates.

---

## 12.3 Metadata

Water asset-specific metadata does not need dedicated Prisma columns for every metric.

Use a generic JSON metadata field on `InfraNode` if one does not already exist:

```json
{
  "capacityKl": 28600,
  "aaddKlDay": 30553,
  "storageHours": 22,
  "stands": 15224,
  "rwConnections": ["RW1399", "RW5628"]
}
```

Recommended schema addition:

```prisma
metadata Json?
```

This keeps infrastructure extensible.

Do not put incident state in asset metadata.

---

## 12.4 Locality matching

Use existing normalization rules first.

For each official JW suburb/extension:

1. `localityKey`;
2. exact `Locality.normalizedName`;
3. alias;
4. extension-normalized match;
5. carefully bounded fuzzy match.

Generate a report:

```text
MATCHED
ALIAS_MATCH
FUZZY_MATCH
AMBIGUOUS
NOT_FOUND
```

Do not silently create new `Locality` rows from a static web typo.

Unmatched names must appear in:

```text
match-report.json
```

for manual review.

---

## 12.5 Official-data aliases

Create a small curated alias file if required:

```text
api/data/johannesburg-water/aliases.json
```

Examples can handle publication spelling differences such as:

```text
Blairgowrie / Blaigowrie
Randjieslaagte / Randjieslagte
```

Do not globally merge two names unless the CoJ geography proves they refer to the same locality.

---

## 12.6 Derived supply-zone polygons

For each reservoir/tower/direct feed that has `SERVES` localities with boundaries:

```text
collect Locality.boundary
→ union geometries
→ save derived boundary on InfraNode.boundary
```

Set:

```text
geoSource = derived-from-localities
```

The UI must label these as an **estimated/derived service area**, not an official pressure-zone polygon.

If an extension has no boundary, record that in the import report.

Do not create a convex hull across missing data that makes large unsupported areas appear supplied.

Prefer a union of known polygons.

---

# 13. Water network importer

Recommended:

```text
api/scripts/import-jw-network.js
```

Responsibilities:

1. Load generated JSON.
2. Resolve Johannesburg municipality.
3. Upsert water `InfraNode`s with `serviceType = WATER`.
4. Store operator and metadata.
5. Upsert aliases.
6. Upsert typed `InfraEdge`s.
7. Resolve official localities.
8. Upsert `NodeLocality(..., SERVES)`.
9. Persist official provenance.
10. Store derived boundaries where generated.
11. Print a deterministic summary.

Example output:

```text
Assets:
  created: 42
  updated: 6

Relationships:
  created: 73
  updated: 4

Locality mappings:
  matched: 812
  aliases: 61
  ambiguous: 4
  missing: 17
```

The command should fail non-zero if ambiguous mappings exceed a small threshold unless explicitly run with a review/allow flag.

Add a dry run:

```text
node scripts/import-jw-network.js --dry-run
```

---

# 14. Processing changes

Modify:

```text
api/src/modules/processing/processor.service.js
```

Current:

```text
extract
→ learn
→ link
```

Keep that order.

Pass `serviceType` through explicitly.

Conceptually:

```js
const reader = readerFor(post.serviceType)

const extraction = await extractPost(post, reader)

const facts = await learnFromExtraction({
  post,
  extraction,
  serviceType: post.serviceType
})

const decision = await linkPost({
  post,
  extraction,
  facts,
  serviceType: post.serviceType
})
```

Avoid global mutable "current service" state.

---

# 15. Water infrastructure learning

Refactor:

```text
api/src/modules/infrastructure/infrastructure.service.js
```

The generic reusable pieces are:

- name normalization;
- node creation/upsert;
- aliases;
- locality resolution;
- evidence contribution idempotency;
- edge upsert;
- node-locality association.

Service-specific pieces should be isolated.

Recommended:

```text
normalization profile
allowed types
minor-type merge rules
relationship extraction
confirmation rules
```

Do not let water use electricity's:

```text
CABLE / LINE / OTHER merge
```

rules.

---

## 15.1 Water node confirmation

Static official-import nodes should be treated as confirmed based on provenance.

Live-only discovered water nodes can use the existing evidence threshold:

```text
CANDIDATE
→ 2 independent evidence contributions
→ CONFIRMED
```

Do not count two faults extracted from the same source post as two independent official observations unless that is already the existing evidence definition.

---

## 15.2 Relationship evidence

For live posts:

```text
EvidenceContribution
```

continues preventing retry inflation.

For official imported pages:

```text
InfrastructureEvidence
```

provides source provenance.

A relationship can therefore show:

```text
Official Johannesburg Water page
+
3 later source-post confirmations
```

without pretending they are the same evidence type.

---

# 16. Incident candidate isolation — mandatory before enabling water

Modify:

```text
api/src/modules/outages/linker.service.js
```

Specifically candidate loading.

Current candidate scope includes municipality, time and overlap.

Add:

```text
candidate.serviceType === post.serviceType
```

as a hard filter.

Do this before scoring.

Do not use a score penalty for different service.

A water incident and electricity incident are not competing candidates.

---

## 16.1 Add a regression test first

Before enabling `@JHBWater`, add an integration test equivalent to:

```text
Given:
  live City Power ELECTRICITY outage affecting Willowbrook

When:
  Johannesburg Water WATER post says Willowbrook has no water

Then:
  candidate loading returns no electricity outage
  a separate WATER outage is created
```

This test is a release gate.

---

# 17. Water incident scoring

Keep the existing scoring engine structure.

Extract generic components where useful:

```text
same thread
time window
locality overlap
shared infrastructure
related infrastructure
planned-vs-unplanned
```

Do not reuse SDC scoring for water.

Recommended service dispatch:

```js
scoreCandidate({
  serviceType,
  ...
})
```

or:

```text
scoreElectricityCandidate
scoreWaterCandidate
```

with shared helpers.

---

## 17.1 Suggested initial water score signals

These values should be tuned using real water post history, not treated as final truth.

Start conservatively.

```text
same conversation/thread                         +0.60

same explicit water asset                       up to +0.55

one-hop graph relationship
(reservoir ↔ tower / system ↔ reservoir etc.)   +0.30

shared affected localities                      up to +0.35

same explicit named water system                +0.15

planned vs unplanned mismatch                   hard reject

conflicting explicit root asset                 -0.30

digest / multi-system bulletin                  same defensive cap pattern
```

Do not allow locality overlap alone to confidently link if two different water assets are explicitly named.

Water networks frequently have adjacent/overlapping service impacts.

---

## 17.2 Tie-break prompt

The existing tie-break is electricity-specific.

Add a water tie-break prompt.

Give the model:

- the new post reading;
- top candidate water incidents only;
- named water assets;
- systems;
- localities;
- timing;
- current water state;
- one-hop graph relationships.

It must choose:

```text
candidate id
or
NEW
```

It must not be allowed to choose an electricity incident because those should never be candidates.

---

# 18. Water timeline fold

Modify:

```text
api/src/modules/outages/outage-state.js
```

Keep the existing effect-fold architecture.

This is good design and should be reused.

Recommended:

```text
foldElectricityEffects()
foldWaterEffects()
```

with shared timeline ordering helpers.

The persisted `OutagePost.effect` can remain JSON and contain service-specific fields.

---

## 18.1 Water restoration rules

Examples:

### Case A

```text
"Rand Water pumping has resumed."
```

Result:

```text
lifecycle: ACTIVE
waterState: RECOVERING
```

unless the same notice explicitly confirms customer supply restored.

### Case B

```text
"Reservoir levels are improving and outlets are partially open."
```

Result:

```text
lifecycle: ACTIVE or PARTIALLY_RESTORED
waterState: PARTIAL_SUPPLY / RECOVERING
```

depending on explicit customer restoration.

### Case C

```text
"Water supply has been restored to all affected areas."
```

Result:

```text
lifecycle: RESTORED
waterState: NORMAL
restoredAt: source-post timestamp
```

### Case D

```text
"Some areas restored; high-lying areas still have low pressure."
```

Result:

```text
lifecycle: PARTIALLY_RESTORED
waterState: LOW_PRESSURE or RECOVERING
```

### Case E

```text
"System is stable and supplying normally."
```

Strong evidence for:

```text
RESTORED / NORMAL
```

if there is an existing incident.

---

# 19. Stale behaviour

The existing stale sweep can be reused initially.

Do not automatically call a water incident restored because it disappeared from updates.

Existing meaning:

```text
STALE = no recent information, outcome unknown
```

is appropriate for water too.

Later water-specific thresholds can be tuned if the update cadence differs significantly.

---

# 20. Explicit vs inferred impact

This is important for the network map.

A topology inference is not an official outage confirmation.

Add a basis field to outage-locality associations.

Recommended:

```prisma
enum ImpactBasis {
  EXPLICIT_SOURCE
  INFERRED_TOPOLOGY
}
```

Add to `OutageLocality` with existing rows defaulting to:

```text
EXPLICIT_SOURCE
```

If a locality is first inferred and later explicitly named, upgrade it to:

```text
EXPLICIT_SOURCE
```

Never downgrade explicit to inferred.

The same idea can be applied to `OutageNode` if useful.

---

# 21. Downstream impact propagation

Do this only after the confirmed water incident pipeline works.

Given:

```text
Palmiet
  → Sandton System
  → Illovo Reservoir
  → served localities
```

an upstream incident can calculate potential downstream impacts.

Do not automatically change those suburbs to confirmed `NO_SUPPLY`.

Recommended propagation rules:

1. Traverse only edges whose type implies water flow/supply.
2. Limit depth.
3. Stop at contradictory explicit evidence.
4. Record inferred basis.
5. Keep inferred impacts visually distinct.
6. Never use inferred localities to close an incident.
7. Be conservative with bypass/backfeed edges.

UI copy:

```text
Confirmed affected
```

versus:

```text
Potential downstream impact based on known supply network
```

---

# 22. API service scope

Create:

```text
api/src/modules/api/service-scope.js
```

or extend the existing municipality-scope module cleanly.

Add query support:

```text
?service=ELECTRICITY
?service=WATER
```

During migration, preserve the current UI by defaulting omitted service to:

```text
ELECTRICITY
```

until the new frontend always sends a service parameter.

Do not suddenly make existing `/v1/outages` return mixed power and water incidents to an old client.

---

# 23. API endpoints to update

Review all of these from `routes.js`:

```text
GET /v1/outages
GET /v1/outages/:id
GET /v1/overview
GET /v1/search
GET /v1/municipalities
GET /v1/localities/:id
GET /v1/localities/:id/outages
GET /v1/network/sdcs
GET /v1/map
GET /v1/map/infrastructure
GET /v1/map/node/:id
GET /v1/infrastructure
GET /v1/infrastructure/:id
GET /v1/stats
GET /v1/updates
GET /v1/changes
GET /v1/posts
GET /v1/posts/daily
GET /v1/insights
GET /v1/sync
```

Not every endpoint must support water in the first release.

Minimum public water set:

```text
/v1/outages
/v1/outages/:id
/v1/search
/v1/map
/v1/map/infrastructure
/v1/map/node/:id
/v1/infrastructure
/v1/infrastructure/:id
/v1/updates
/v1/stats
```

---

# 24. Utility/service metadata

`municipality-scope.js` currently maps municipality → electricity utility information.

Refactor the configuration concept to:

```text
municipality + service
```

Example:

```js
JOHANNESBURG: {
  ELECTRICITY: {
    utility: "City Power",
    ...
  },
  WATER: {
    utility: "Johannesburg Water",
    ...
  }
}
```

Tshwane can initially expose only electricity until a Tshwane water integration exists.

Avoid introducing a full database provider model solely for display copy in this phase.

---

# 25. Search

Update `/v1/search` results to include:

```text
serviceType
```

for:

- infrastructure;
- incidents.

Localities remain service-neutral.

The client should route:

```text
Honeydew Reservoir
```

to the network detail with:

```text
service=WATER
```

or infer the service from the returned node.

When the Water service is active, default search result ranking should prefer:

```text
water infrastructure
water incidents
shared localities
```

and not flood the list with substations.

---

# 26. Map architecture refactor

Modify:

```text
client/src/components/MapView.jsx
client/src/views/MapPage.jsx
```

Do not copy the entire map into `WaterMap.jsx`.

The current fixed-source map should become service/layer aware.

---

## 26.1 Add a service selector

Recommended UI:

```text
Electricity | Water
```

Add `All` only after both individual modes are stable.

Persist selection similarly to municipality:

```text
gridwatch:service
```

Create a small:

```text
ServiceProvider / useService
```

or equivalent context following `MunicipalityProvider`.

Default to electricity for existing users.

---

## 26.2 Layer registry

Refactor fixed booleans such as:

```js
{ outages: true, equipment: ... }
```

into a layer configuration.

Concept:

```js
{
  service: "WATER",
  layers: {
    incidents: true,
    infrastructure: true,
    supplyZones: true,
    inferredImpact: true
  }
}
```

Do not make MapLibre style state depend on duplicated component trees.

---

## 26.3 Water layers

Suggested water scene:

### Confirmed incident layer

- affected locality polygons/points;
- no-supply/low-pressure/recovering state.

### Infrastructure layer

Different marker types:

```text
reservoir
tower
pump station
direct feed
Rand Water bulk/booster asset
system
```

### Supply-area layer

Derived reservoir/tower/direct-feed boundary.

### Inferred-impact layer

Clearly visually different from confirmed outage geography.

Never use the same visual treatment for inferred and explicit impact.

---

# 27. Infrastructure map service

Modify:

```text
api/src/modules/geo/equipment-map.service.js
```

Position priority:

```text
1. InfraNode.lat/lon when known
2. centroid/derived position from InfraNode.boundary
3. existing derived position from NodeLocality
4. no marker
```

This preserves electricity behaviour and allows real water asset coordinates later.

---

# 28. Node detail

Update:

```text
client/src/views/NodeDetail.jsx
```

Water node detail should support:

```text
Honeydew Reservoir

Operator:
Johannesburg Water

Type:
Reservoir

Capacity:
28,600 kL

Average demand:
30,553 kL/day

Nominal storage:
22 hours

Serves:
...

Upstream:
...

Downstream:
...

Current incidents:
...
```

Show metrics only when present in `InfraNode.metadata`.

Do not show electricity-only language such as "How power flows here".

Use:

```text
Network relationships
```

or service-aware copy.

---

# 29. Resident-facing incident language

Refactor `client/src/lib/api.js` status copy.

Current electricity sentences such as:

```text
Power is out
Power is back on
```

need service-aware equivalents.

Examples:

```text
ELECTRICITY ACTIVE
→ Power is out

WATER ACTIVE + NO_SUPPLY
→ Water supply is interrupted

WATER ACTIVE + LOW_PRESSURE
→ Low water pressure

WATER ACTIVE + CRITICAL
→ Water system critically constrained

WATER ACTIVE + RECOVERING
→ Water supply is recovering

WATER RESTORED
→ Water supply restored
```

Do not expose internal enum names directly.

---

# 30. Overview/home page

Update:

```text
client/src/views/Overview.jsx
```

When service is Water:

- heading should ask about water rather than power;
- the embedded map should query water;
- latest updates should be water updates;
- counts should be water incidents;
- utility contact details should be Johannesburg Water.

Do not redesign the whole site in the first pass.

---

# 31. Network page

The current route:

```text
/network
```

is SDC-oriented.

Refactor it to a service-neutral network view.

Electricity:

```text
SDCs / substations / distributors
```

Water:

```text
water systems / reservoirs / towers / direct feeds
```

Do not force water assets into an SDC list.

Potential first water grouping:

```text
Sandton
Midrand
Randburg/Roodepoort
Soweto
Commando
Lenasia
Ennerdale/Orange Farm
Central systems
```

Only use names supported by official data.

---

# 32. Johannesburg Water X account

After service isolation, schema, water reader, linker and tests are complete:

1. Resolve the official numeric X user id for `@JHBWater`.
2. Seed a `SourceAccount`:
   - platform `X`;
   - municipality Johannesburg;
   - service `WATER`;
   - display name `JHBWater`;
   - initially inactive.
3. Run a controlled manual ingestion.
4. Inspect readings/link decisions.
5. Enable continuous polling only after quality is acceptable.

Recommended extension to:

```text
api/scripts/seed-source-account.js
```

so it accepts:

```text
--service WATER
```

Do not hard-code Johannesburg Water's account ID into `env.js`.

---

# 33. Shadow rollout

Before public display:

- ingest a bounded set of recent `@JHBWater` posts;
- process them as `WATER`;
- keep frontend water mode hidden behind a flag if necessary;
- run batch reports and review queue;
- manually inspect at least:
  - planned maintenance;
  - reservoir low;
  - tower low;
  - no water;
  - low pressure;
  - recovery;
  - full restoration;
  - daily multi-system bulletin;
  - image-only notice;
  - Rand Water upstream reference.

Add:

```text
WATER_FEATURE_ENABLED
```

only if a release flag is operationally useful. The account's `active` flag can control ingestion separately.

---

# 34. Website ingestion — second live source, not first milestone

Johannesburg Water has an official systems-update archive.

The initial implementation should ship on X first because the current ingestion engine already supports it.

After X is stable, add website ingestion.

Do not force a website into the X cursor model.

Recommended architecture:

```text
source adapter
  ├── X adapter
  └── Johannesburg Water web adapter
```

The common result should be a normalized source item that becomes `SourcePost`.

Potential future enum:

```text
SourcePlatform {
  X
  WEB
}
```

For web pages:

```text
externalId = canonical URL or stable page id
publishedAt = notice timestamp
text = extracted notice body
rawPayload = page metadata
```

Deduplication can continue using:

```text
(platform, externalId)
```

Use the systems-update archive:

https://www.johannesburgwater.co.za/media/media-statement/systems-update/

Do not implement brittle scraping until fixtures and parser tests exist.

---

# 35. Rand Water live source — later phase

Static Rand Water topology can be seeded immediately.

Live Rand Water notices should be a later source.

Why:

- an upstream Rand Water event can affect many municipalities, not only Johannesburg;
- it requires careful propagation semantics;
- it should not create false confirmed local outages.

When implemented:

```text
source service = WATER
operator = RAND_WATER
municipality may be null / regional
```

Then derive Johannesburg downstream risks using graph edges.

Do not fabricate Johannesburg Water confirmation from a Rand Water notice.

---

# 36. Push notifications

Do not enable water push notifications in the first backend commit.

Current push behaviour follows locality and electricity status changes.

Before enabling water push:

- subscriptions need a service dimension;
- notification text needs service-specific copy;
- inferred impacts must not trigger the same alert as confirmed outages;
- recovery vs restored must be handled correctly.

Recommended:

```text
PushSubscription.serviceType
```

with existing subscriptions migrated to `ELECTRICITY`.

---

# 37. Insights

Do not block the first water release on a complete insights redesign.

The existing:

```text
fault-category.js
SDC area grouping
```

is electricity-specific.

For the first release:

- hide unsupported water insight panels;
- or expose a minimal water view.

Later water categories may include:

```text
BURST_PIPE
PLANNED_MAINTENANCE
RAND_WATER_CONSTRAINT
POWER_FAILURE
PUMP_FAILURE
RESERVOIR_LOW
HIGH_DEMAND
VALVE_OPERATION
INFRASTRUCTURE_TIE_IN
UNKNOWN
```

Do not reuse electrical `TRANSFORMER`, `CABLE`, etc.

---

# 38. Testing plan

Water must be introduced with regression tests before live activation.

---

## 38.1 Existing suite must remain green

Run:

```text
api unit tests
api integration tests
golden/eval suite
client coverage test
audit/quality checks where practical
```

No existing electricity golden fixture should change merely because `ServiceType` was added.

---

## 38.2 Schema/migration tests

Verify:

```text
existing SourceAccount → ELECTRICITY
existing SourcePost    → ELECTRICITY
existing Outage        → ELECTRICITY
existing InfraNode     → ELECTRICITY
existing InfraEdge     → LEGACY_PARENT
```

No null service rows after migration.

---

## 38.3 Mandatory cross-service test

Add to:

```text
api/tests/integration/linking.test.js
```

Case:

```text
City Power outage in Willowbrook
+
Johannesburg Water no-water notice in Willowbrook
=
two incidents
```

The water post must never see the electricity outage as a candidate.

---

## 38.4 Water linking tests

Add:

### Same reservoir

```text
Honeydew Reservoir critically low
→ later update Honeydew levels improving
```

Expected:

```text
one WATER outage
```

### Same suburb, conflicting reservoirs

Two notices affect the same suburb but explicitly name different unrelated root assets.

Expected:

```text
do not high-confidence link on locality alone
```

### Parent/child infrastructure

```text
Sandton System constrained
→ Illovo Reservoir update
```

Expected:

```text
graph relationship contributes to score
```

but does not force a link if evidence conflicts.

### Multi-system bulletin

One image/text bulletin with multiple distinct systems.

Expected:

```text
faults[] split
no umbrella Johannesburg-wide outage
```

### Planned vs unplanned

Expected hard separation.

---

## 38.5 Water state tests

Add a dedicated unit file, e.g.:

```text
api/tests/unit/water-status.test.js
```

Cases:

```text
pumping resumed              → RECOVERING, not RESTORED
reservoir improving          → RECOVERING
supplying normally           → NORMAL / RESTORED
poor pressure remains        → active
all affected areas restored  → RESTORED
some restored                → PARTIALLY_RESTORED
no new update past threshold → STALE
```

---

## 38.6 Static import tests

Use small HTML/data fixtures.

Test:

- reservoir parsing;
- tower parsing;
- direct-feed RW connection parsing;
- locality normalization;
- alias resolution;
- ambiguous locality reporting;
- derived polygon union;
- idempotent re-import;
- provenance retained.

---

## 38.7 API tests

Extend:

```text
api/tests/integration/api.test.js
```

Test:

```text
/v1/outages?service=WATER
/v1/outages?service=ELECTRICITY
/v1/map?service=WATER
/v1/search?q=Honeydew&service=WATER
```

Electricity results must not leak into water queries.

---

# 39. Reprocessing and bootstrap

Existing reprocessing tools are valuable.

Do not run a global electricity reset merely to bootstrap water.

Add service filters to replay/reprocess tools where needed.

Examples:

```text
--service WATER
```

Useful scripts to extend:

```text
scripts/process.js
scripts/reprocess.js
scripts/relink.js
scripts/batch-report.js
scripts/audit.js
```

The default behaviour without `--service` should remain current/backward compatible.

---

# 40. Observability

Pino remains sufficient for the first version.

Add structured fields:

```text
serviceType
sourceAccount
postId
outageId
waterState
```

to relevant processing logs.

Update batch-report output to show service prominently.

Add audit invariants:

```text
water post linked to electricity outage => FATAL
electricity post linked to water outage => FATAL
water InfraNode with electricity-only type => problem
WATER outage with SDC-only assumptions => problem
```

These checks will catch cross-service contamination quickly.

---

# 41. Implementation phases

Do these in order.

---

## Phase 0 — Characterise current electricity behaviour

Before schema changes:

- run current unit/integration tests;
- run evaluation/golden suite;
- save baseline results;
- inspect current migration status;
- confirm production migration process.

No feature code.

### Exit criterion

Current main is understood and green.

---

## Phase 1 — Add service identity

Implement:

- `ServiceType`;
- service on `SourceAccount`;
- service on `SourcePost`;
- service on `Outage`;
- service on `InfraNode`;
- migration/backfill;
- candidate hard filter;
- API service helper;
- basic service field in JSON.

Do **not** enable water ingestion yet.

### Exit criteria

- all old tests green;
- cross-service integration test green;
- existing frontend still behaves exactly as electricity.

This is the most important phase.

---

## Phase 2 — Infrastructure model extensions

Implement:

- water infrastructure enum values;
- edge relationship type;
- node metadata;
- optional node geometry;
- NodeLocality relation;
- official topology provenance model;
- importer primitives.

### Exit criteria

Can manually create:

```text
Palmiet
→ SUPPLIES
→ Sandton System
→ SUPPLIES
→ Illovo Reservoir
→ SERVES
→ Locality
```

without abusing `OTHER`.

---

## Phase 3 — Static Johannesburg Water topology

Implement:

```text
build_johannesburg_water_dataset.py
import-jw-network.js
official-source provenance
locality match report
derived polygons
```

Import reservoirs, towers, direct feeds and curated upstream relationships.

### Exit criteria

For a sample suburb, the database can answer:

```text
Which known Johannesburg Water assets serve this locality?
```

and for a sample asset:

```text
Which localities does it serve?
What is upstream/downstream?
Which official source established this?
```

---

## Phase 4 — Water reader

Implement:

- service reader registry;
- water prompt;
- water schema;
- prompt version;
- water knowledge context;
- water extraction tests.

Do not yet publish incidents publicly.

### Exit criteria

Representative `@JHBWater` posts produce correct structured readings without invented electrical infrastructure.

---

## Phase 5 — Water linker and state fold

Implement:

- water scoring;
- water tie-break;
- water state fold;
- multi-system split;
- explicit/inferred impact basis.

### Exit criteria

Historical/manual water fixtures link into sensible timelines.

Critical:

```text
pumping restored != customer supply restored
```

must be locked by tests.

---

## Phase 6 — API

Implement:

- `service` query;
- water outage response;
- water infrastructure response;
- water map payload;
- search service;
- service-aware utility metadata.

### Exit criteria

The backend can fully serve a water UI without affecting electricity responses.

---

## Phase 7 — Frontend

Implement:

- service context;
- Electricity/Water selector;
- service-aware copy;
- map layer registry;
- water infrastructure markers;
- water service-area boundaries;
- water timeline state;
- search routing;
- water network detail.

### Exit criteria

User can switch between electricity and water in Johannesburg without page reload/data contamination.

---

## Phase 8 — Controlled `@JHBWater` ingestion

Seed the account inactive.

Run manual ingestion against a bounded recent set.

Inspect:

```text
PostExtraction
LinkDecision
ReviewItem
Outage
OutagePost.effect
InfraNode/Edge
```

Fix regressions with tests.

Then activate polling.

### Exit criterion

Water mode reliably follows current Johannesburg Water updates.

---

## Phase 9 — Topology inference

Add downstream impact propagation.

Keep inferred and confirmed geography distinct.

### Exit criterion

An upstream incident can show potential downstream areas without claiming official outage confirmation.

---

## Phase 10 — Website ingestion

Add official Johannesburg Water systems-update website as a second source after X is stable.

### Exit criterion

Website and X duplicates converge onto the same water incident without duplicate timelines.

---

# 42. Files likely to be modified

Backend:

```text
api/prisma/schema.prisma
api/src/modules/processing/processor.service.js

api/src/modules/ingestion/ingestion.service.js

api/src/modules/ai/extraction.service.js
api/src/modules/ai/knowledge-context or equivalent
api/src/modules/ai/reader-registry.js                 NEW
api/src/modules/ai/prompts/water.prompt.js            NEW
api/src/modules/ai/schemas/water-extraction.schema.js NEW

api/src/modules/infrastructure/infrastructure.service.js

api/src/modules/outages/linker.service.js
api/src/modules/outages/scoring.js
api/src/modules/outages/outage-state.js

api/src/modules/api/routes.js
api/src/modules/api/municipality-scope.js
api/src/modules/api/service-scope.js                  NEW

api/src/modules/geo/equipment-map.service.js

api/scripts/seed-source-account.js
api/scripts/import-jw-network.js                      NEW

docs/Gauteng/build_johannesburg_water_dataset.py      NEW
```

Tests:

```text
api/tests/unit/water-status.test.js                   NEW
api/tests/unit/water-extraction.test.js               NEW or equivalent
api/tests/integration/linking.test.js
api/tests/integration/graph.test.js
api/tests/integration/api.test.js
api/tests/integration/ingestion.test.js
```

Frontend:

```text
client/src/lib/api.js
client/src/lib/municipality.jsx
client/src/lib/service.jsx                            NEW

client/src/components/MapView.jsx
client/src/components/SearchBox.jsx

client/src/views/Overview.jsx
client/src/views/MapPage.jsx
client/src/views/Outages.jsx
client/src/views/OutageDetail.jsx
client/src/views/Network.jsx
client/src/views/NodeDetail.jsx
client/src/views/Suburb.jsx
client/src/views/About.jsx
```

This list is intentionally conservative. Inspect the current call graph before editing.

---

# 43. Files that should remain largely reusable

Avoid unnecessary rewrites of:

```text
api/src/modules/ingestion/x.client.js
api/src/modules/ai/gemini.client.js
api/src/modules/coordination/lease.js
api/src/lib/scheduler.js
api/src/db/prisma.js
api/src/lib/gis-import.js
```

These are already service-neutral or close to it.

---

# 44. Important implementation traps

## Trap 1 — Activating the account too early

Do not add active `@JHBWater` ingestion before service-aware extraction and linking exist.

---

## Trap 2 — Using municipality to represent service

Both utilities are Johannesburg.

Municipality cannot distinguish water from electricity.

---

## Trap 3 — Reusing the electricity prompt with a water hint

A short account hint is not enough.

Water requires a separate schema and interpretation rules.

---

## Trap 4 — Mapping reservoir to `OTHER`

Never do this.

Create real water infrastructure types.

---

## Trap 5 — Treating every Johannesburg Water system bulletin as one incident

Split multi-system notices into `faults[]`.

---

## Trap 6 — Closing when pumping resumes

Water system recovery can take hours after pumping restarts.

Use `RECOVERING`.

---

## Trap 7 — Presenting a derived service polygon as official

The geometry is:

```text
union of officially listed served locality polygons
```

not Johannesburg Water's hydraulic zone boundary.

Label it appropriately.

---

## Trap 8 — Letting topology inference trigger confirmed outage alerts

Inference is useful but must remain visibly and structurally different from explicit source evidence.

---

## Trap 9 — Copying MapView

Refactor layers once.

Do not maintain separate electricity and water map engines.

---

## Trap 10 — Large generic-platform rewrite

Do not turn this into a multi-utility SaaS rewrite.

Implement the missing `serviceType` seam and reuse the existing architecture.

---

# 45. Acceptance criteria for first public Water release

The first public release is complete when all of the following are true.

## Data isolation

- [ ] Every post has a service.
- [ ] Every incident has a service.
- [ ] Every infrastructure node has a service.
- [ ] Water candidate loading can never return electricity incidents.
- [ ] Electricity candidate loading can never return water incidents.

## Static network

- [ ] Reservoirs imported.
- [ ] Towers imported.
- [ ] Known direct feeds imported.
- [ ] Official locality mappings imported.
- [ ] Rand Water/JW upstream relationships have provenance.
- [ ] Import is idempotent.
- [ ] Ambiguous/unmatched localities are reported.

## Extraction

- [ ] Water has its own prompt.
- [ ] Water has its own schema.
- [ ] Images are correctly processed through the existing Gemini media path.
- [ ] Multi-system notices split correctly.
- [ ] No electricity infrastructure is hallucinated into water readings.

## Incident state

- [ ] No supply supported.
- [ ] Low pressure supported.
- [ ] Reservoir/tower constrained states supported.
- [ ] Recovering supported.
- [ ] Partial restoration supported.
- [ ] Full restoration requires explicit evidence.
- [ ] Stale remains "unknown outcome".

## API

- [ ] `/v1/outages?service=WATER`
- [ ] `/v1/map?service=WATER`
- [ ] water infrastructure API
- [ ] water search
- [ ] electricity queries remain unchanged

## Frontend

- [ ] Electricity/Water switch.
- [ ] Water-specific resident copy.
- [ ] Water incident markers/polygons.
- [ ] Water infrastructure layer.
- [ ] Reservoir/tower/direct-feed details.
- [ ] Derived zones labelled as derived.
- [ ] Inferred impacts visibly different from confirmed impacts.

## Quality

- [ ] Existing electricity tests green.
- [ ] Cross-service regression test green.
- [ ] Water linker integration tests green.
- [ ] Water state tests green.
- [ ] Manual inspection of representative JHBWater posts completed.

---

# 46. Recommended first coding task

Do **not** begin with scraping Johannesburg Water.

Begin with:

> **Phase 1: introduce `ServiceType` end-to-end and prove that two incidents in the same Johannesburg suburb cannot cross-link when one is ELECTRICITY and one is WATER.**

Suggested first PR:

```text
feat: add utility service identity and isolate incident linking
```

Scope:

1. Prisma `ServiceType`.
2. Backfill existing data to `ELECTRICITY`.
3. Add service to `SourceAccount`, `SourcePost`, `Outage`, `InfraNode`.
4. Copy service during ingestion.
5. Carry service through processing.
6. Hard-filter candidates by service.
7. Add `service` API filter but keep electricity default.
8. Add cross-service regression tests.
9. No Johannesburg Water account activation yet.
10. No UI redesign yet.

This establishes the architectural safety boundary on which every later water feature depends.

---

# 47. Recommended second coding task

Suggested second PR:

```text
feat: add water infrastructure graph types and official topology importer
```

Scope:

1. Add water `InfrastructureType`s.
2. Add `InfrastructureRelationType`.
3. Add asset metadata.
4. Add optional asset geometry.
5. Add official knowledge provenance.
6. Build Johannesburg Water dataset.
7. Import reservoirs/towers/direct feeds.
8. Match served localities.
9. Produce match report.
10. Add graph/import tests.

No live water incidents yet.

---

# 48. Recommended third coding task

Suggested third PR:

```text
feat: add Johannesburg Water extraction and incident engine
```

Scope:

1. Reader registry.
2. Water prompt/schema.
3. Water knowledge context.
4. Water infrastructure learning.
5. Water candidate scoring.
6. Water tie-break.
7. Water state fold.
8. Historical fixtures.
9. Review/audit rules.

Only after this should the JHBWater source account be activated.

---

# 49. Final target architecture

```text
                               GRIDWATCH
                                   │
                     ┌─────────────┴─────────────┐
                     │                           │
               ELECTRICITY                     WATER
                     │                           │
               SourceAccount                SourceAccount
              City Power / CoT              JHBWater
                     │                           │
                     └─────────────┬─────────────┘
                                   │
                        shared X ingestion
                                   │
                              SourcePost
                           serviceType tagged
                                   │
                         service reader registry
                         /                     \
             electricity extraction         water extraction
                         \                     /
                          shared Gemini transport
                                   │
                           structured reading
                                   │
                     ┌─────────────┴─────────────┐
                     │                           │
                infrastructure               incident
                   learning                   linker
                     │                           │
         service-aware infrastructure       service-filtered
                knowledge graph              candidates
                     │                           │
                     └─────────────┬─────────────┘
                                   │
                              OutagePost
                                 effect
                                   │
                           service state fold
                                   │
                                Outage
                                   │
                   shared Johannesburg Locality GIS
                                   │
                        service-aware Express API
                                   │
                          React + MapLibre layers
                     /                              \
            Electricity map                      Water map
```

Water topology:

```text
Rand Water treatment / booster infrastructure
                    │
                    ▼
       bulk system / connection / meter
                    │
                    ▼
          Johannesburg Water system
                    │
          ┌─────────┼───────────┐
          ▼         ▼           ▼
     reservoir    tower     direct feed
          │         │           │
          └─────────┴─────┬─────┘
                          ▼
                     Localities
                          │
                          ▼
                       Resident
```

The most important architectural outcome is not simply "GridWatch also tracks water."

It is:

> **GridWatch becomes a service-aware municipal infrastructure graph in which electricity and water share geography and platform infrastructure while keeping their sources, assets, operating states and incidents correctly isolated.**

That gives the product a clean path to add other Gauteng municipal services later without sacrificing the accuracy of the current City Power engine.
