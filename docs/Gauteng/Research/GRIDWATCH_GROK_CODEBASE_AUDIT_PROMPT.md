# GridWatch Codebase Audit for Johannesburg Water Integration

## Purpose

Inspect the **entire GridWatch codebase** and produce a detailed technical overview that another engineer can use to design a Johannesburg Water integration that fits the existing architecture cleanly.

**Do not implement anything yet. Do not modify production code.**

The goal is to understand exactly how GridWatch currently works so that a later implementation plan can extend it from electricity outages into water outages without duplicating existing systems, breaking abstractions, or inventing architecture that is already present.

The final output should be written to:

`GRIDWATCH_CODEBASE_OVERVIEW_FOR_WATER.md`

Be concrete. Reference **real file paths, model names, function names, services, routes, database tables/models, cron jobs, queues, API clients, frontend components, environment variables, tests, and deployment configuration** wherever possible.

If something does not exist, say so explicitly.

---

# Product Context

GridWatch currently tracks power outages in Johannesburg.

At a high level, it:

- fetches posts from City Power's X/Twitter account;
- processes the posts;
- handles text and image-based posts;
- extracts outage information;
- associates posts with suburbs and infrastructure;
- groups related posts into incidents/outage timelines;
- stores infrastructure knowledge such as substations/distributors where possible;
- learns relationships from incoming posts;
- uses Johannesburg geography data to resolve affected areas;
- exposes the resulting information to a frontend/map.

The planned next major feature is **Johannesburg Water**.

The likely water topology will include entities such as:

```text
Rand Water
    ↓
bulk supply / booster system
    ↓
Johannesburg Water infrastructure
    ├── reservoir
    ├── tower
    ├── pump station
    ├── direct feed
    ├── meter / bulk connection
    └── bypass / temporary routing
            ↓
        supply zone
            ↓
      suburb / township
```

Examples of water-specific relationships may include:

```text
SUPPLIES
PUMPS_TO
DIRECTLY_SUPPLIES
FEEDS
SERVES
UPSTREAM_OF
DOWNSTREAM_OF
BYPASSES
BACKFEEDS
```

Do **not** design these yet. The purpose of this audit is to determine how the existing codebase would accommodate them.

---

# 1. Repository Structure

Start with a concise tree/overview of the repository.

Identify:

- backend applications;
- frontend applications;
- shared packages;
- database / Prisma location;
- scripts;
- workers;
- cron/scheduled tasks;
- ingestion services;
- AI services;
- geography/GIS code;
- test directories;
- infrastructure/deployment configuration;
- documentation relevant to GridWatch architecture.

For each major directory, explain its purpose.

Example format:

```text
/api
  /src/modules/incidents
  /src/modules/geography
/web
/packages/...
```

Do not dump every file. Focus on architecture-relevant files.

---

# 2. Technology Stack

Document the actual stack found in the repository.

Include:

- backend framework;
- frontend framework;
- language(s);
- ORM/database;
- database extensions such as PostGIS if present;
- queue/job system;
- scheduler/cron mechanism;
- hosting/deployment platform;
- caching;
- AI providers/models;
- OCR/image-processing libraries;
- X/Twitter API client/library;
- mapping library;
- GIS/spatial libraries;
- validation libraries;
- testing frameworks;
- logging/monitoring/error tracking.

Cite the files that prove each item, such as:

- `package.json`
- Prisma schema
- Dockerfiles
- deployment files
- environment config
- source imports

---

# 3. Current End-to-End City Power Pipeline

Trace a City Power post through the entire system.

I need the real execution path from:

```text
X/Twitter
→ fetch
→ raw storage
→ media/image handling
→ OCR if applicable
→ AI extraction
→ deterministic processing
→ geography resolution
→ infrastructure resolution
→ incident association
→ timeline creation/update
→ persistence
→ API
→ frontend/map
```

For every stage identify:

1. file path;
2. service/function/class name;
3. inputs;
4. outputs;
5. database models touched;
6. whether execution is synchronous or asynchronous;
7. error/retry behaviour;
8. important configuration.

If multiple code paths exist, explain when each one is used.

This is one of the most important sections.

---

# 4. X / Twitter Ingestion

Find exactly how City Power posts are fetched.

Document:

- service/client;
- polling frequency;
- scheduler;
- API endpoint/provider;
- pagination;
- since-id / cursor behaviour;
- duplicate prevention;
- rate-limit handling;
- raw response storage;
- media URL handling;
- quote tweets/replies/reposts treatment;
- backfill support;
- retry handling;
- how already-processed posts are detected.

Include the relevant database fields.

Also tell me whether the ingestion layer is:

- City-Power-specific;
- generic enough for another X account such as `@JHBWater`;
- partially generic;
- or tightly coupled.

Explain what would have to change to ingest a second provider/account.

Do not implement it.

---

# 5. Raw Source / Provider Abstractions

Determine whether GridWatch already has abstractions for concepts such as:

```text
provider
utility
source
social account
municipality
network type
service type
```

Search for enums/models such as:

```text
CITY_POWER
ELECTRICITY
UTILITY
PROVIDER
SOURCE
NETWORK
```

Explain whether the current data model assumes that **all incidents are electricity incidents**.

Identify every place where City Power is hard-coded.

For each hard-coded location, provide:

- file path;
- symbol/function;
- what is hard-coded;
- how significant it is.

This will help determine whether Johannesburg Water should be added as another provider or whether a higher-level `utilityType` / `serviceType` abstraction is required.

---

# 6. Database / Prisma Schema

Give a detailed overview of all models relevant to:

- posts;
- source posts;
- incidents;
- incident updates;
- timelines;
- suburbs;
- geographic areas;
- infrastructure;
- infrastructure aliases;
- infrastructure relationships;
- source evidence;
- AI extraction;
- media;
- OCR;
- association decisions;
- confidence scores;
- status history;
- provider/source information.

For each relevant model:

- model name;
- important fields;
- relations;
- indexes;
- uniqueness constraints;
- enums;
- geospatial fields;
- JSON fields and their structure if discoverable.

Then specifically answer:

### A. Infrastructure graph

Does the current database already support:

```text
Asset A → relationship → Asset B
```

or is infrastructure represented differently?

Can one infrastructure asset have:

- multiple upstream assets;
- multiple downstream assets;
- aliases;
- historical relationships;
- confidence/evidence;
- source references?

### B. Incident scope

Can an incident currently affect:

- multiple suburbs;
- multiple infrastructure assets;
- different levels of infrastructure;
- inferred vs explicitly mentioned areas?

### C. Multi-utility support

What schema assumptions would block:

```text
ELECTRICITY
WATER
```

from coexisting?

Do **not** suggest migrations yet. Just describe the current state and constraints.

---

# 7. Infrastructure Learning

GridWatch's infrastructure-learning capability is very important.

Find all code responsible for discovering or learning relationships between:

- suburbs;
- substations;
- distributors/feeders;
- other electricity infrastructure.

Document:

- extraction prompt/schema;
- normalization;
- alias handling;
- database write path;
- confidence logic;
- relationship deduplication;
- conflict handling;
- whether repeated evidence increases confidence;
- whether relationships retain evidence/source-post IDs;
- whether a human review mechanism exists;
- whether relationships can expire/change over time.

Give the exact files and functions.

Also explain whether the learning system is generic enough that it could eventually learn:

```text
Rand Water system → JW reservoir
reservoir → tower
reservoir → reservoir
reservoir → supply zone
supply zone → suburb
```

without rewriting the whole system.

---

# 8. AI / Gemini Processing

Inspect all AI-related code.

Document:

- provider(s);
- actual model names;
- where prompts live;
- extraction schemas;
- structured-output handling;
- retry logic;
- validation;
- fallbacks;
- token/context management;
- images sent directly to the model vs OCR text;
- confidence handling;
- post-processing;
- hallucination safeguards;
- how extraction results are persisted.

List the main AI prompts and their purpose.

Tell me whether there is currently:

- one monolithic extraction prompt;
- multiple specialist prompts;
- rule-based preprocessing before AI;
- deterministic validation after AI.

I specifically need to know how easy it would be to introduce a **water-specific extraction schema** while reusing the same pipeline.

---

# 9. Image / OCR Pipeline

GridWatch may receive source updates published as images.

Trace the complete media-processing path.

Find use of tools/libraries such as:

```text
Sharp
Tesseract
OCR
Gemini Vision
image preprocessing
```

Document:

- image download;
- storage;
- preprocessing;
- resizing/cropping;
- OCR;
- OCR confidence;
- image + text combination;
- AI invocation;
- deduplication;
- failure behaviour.

Explain whether this is generic source-media infrastructure or specifically tied to City Power.

---

# 10. Incident Association Engine

This section is critical.

Find the logic that determines:

> "Does this new post belong to an existing outage or create a new incident?"

Document the full association algorithm.

Include:

- relevant files/functions;
- candidate incident selection;
- geography matching;
- infrastructure matching;
- time-window matching;
- semantic/AI matching;
- status matching;
- scoring;
- thresholds;
- duplicate-update detection;
- merge logic;
- split/segmentation logic;
- rules around restored incidents;
- handling of multi-outage bulletins.

Explain how the system prevents unrelated outages from being merged.

Also explain whether association is currently dependent on electricity-specific concepts.

---

# 11. Incident Status State Machine

Find how GridWatch determines incident state.

Document:

- status enum(s);
- transitions;
- restoration detection;
- reopening behaviour;
- partial restoration;
- unconfirmed restoration;
- inferred restoration;
- stale incidents;
- automatic closing;
- latest-status calculation.

Reference exact code.

This matters because water will likely need states such as:

```text
LOW
CRITICAL
EMPTY
NO_INCOMING_SUPPLY
NO_PUMPING
BYPASS
THROTTLED
LOW_PRESSURE
NO_SUPPLY
RECOVERING
RESTORED
```

Do not implement those.

Instead tell me whether the existing incident/status architecture can support service-specific statuses or assumes a single universal electricity status set.

---

# 12. Geography / Johannesburg GIS

Provide a deep overview of GridWatch's geography system.

Document:

- suburb model;
- township/extension model if separate;
- aliases;
- official identifiers;
- latitude/longitude;
- polygons;
- PostGIS usage;
- ArcGIS source data;
- import scripts;
- matching logic;
- fuzzy-name resolution;
- spatial queries;
- centroid logic;
- map geometry returned to frontend.

Identify exactly where the City of Johannesburg ArcGIS/CGIS data lives or is imported from.

Explain how GridWatch currently maps a source statement such as:

```text
"Willowbrook"
```

to the correct internal geographic entity.

Also explain whether a **derived water supply-zone polygon** could technically be produced from a union of existing township/suburb geometries using the current stack.

Do not implement it.

---

# 13. Infrastructure Geography

Explain how physical electricity infrastructure is currently located.

For substations/distributors/etc:

- are coordinates stored?
- are polygons stored?
- where do coordinates come from?
- can an infrastructure node exist without coordinates?
- does the map display infrastructure nodes?
- are infrastructure boundaries derived?
- is there an admin/import process?

This helps determine how to represent water reservoirs, towers and pumping stations.

---

# 14. API Surface

List the backend API endpoints relevant to:

- incidents;
- timelines;
- suburbs;
- search;
- maps;
- infrastructure;
- system status;
- live outages;
- source posts.

For each:

- route;
- controller;
- service;
- response shape;
- filters;
- pagination;
- caching.

Identify which APIs the frontend map actually calls.

Explain whether responses currently assume electricity-specific naming/statuses.

---

# 15. Frontend Architecture

Find the pages/components responsible for:

- main GridWatch map;
- outage cards;
- suburb search;
- incident detail/timeline;
- filters;
- markers;
- polygons;
- status colours/icons;
- infrastructure display.

For each important component include its exact path.

Explain:

- state management;
- API client layer;
- map library;
- marker generation;
- polygon rendering;
- clustering;
- filtering;
- URL routing;
- mobile behaviour if obvious.

Identify all places where UI copy or components are hard-coded around:

```text
power
electricity
City Power
substation
restored
```

Do not redesign the UI yet.

---

# 16. Map Layer Architecture

Determine whether the map already supports multiple layers.

For example:

```text
incidents
suburbs
regions
infrastructure
outage polygons
```

Explain how layers are:

- defined;
- toggled;
- styled;
- fetched;
- rendered;
- filtered.

I want to know whether adding:

```text
Electricity
Water
```

as service layers fits naturally into the current map architecture or would require refactoring.

---

# 17. Search

Inspect GridWatch search.

Can users search:

- suburbs;
- infrastructure;
- incidents;
- addresses?

Document the relevant files and database queries.

Explain whether search is type-aware and whether new water infrastructure names such as:

```text
Honeydew Reservoir
Brixton Tower
Eikenhof
Palmiet
```

could be indexed using the current mechanism.

---

# 18. Scheduled Jobs / Workers

List **every scheduled/background task** relevant to GridWatch.

For each give:

- job name;
- code path;
- cadence;
- trigger mechanism;
- purpose;
- retries;
- concurrency/locking;
- hosting environment.

Examples may include:

- X polling;
- incident reconciliation;
- stale incident cleanup;
- AI processing;
- geography imports;
- historical backfills;
- source reprocessing.

This is necessary to decide where future Johannesburg Water polling should live.

---

# 19. Backfill / Reprocessing Capabilities

Determine whether GridWatch can:

- fetch historical posts;
- reprocess existing posts;
- rerun AI extraction;
- rebuild associations;
- rebuild incidents;
- rebuild infrastructure relationships;
- re-import geography;
- migrate learned data.

Document available scripts/endpoints/jobs.

This will matter because the Johannesburg Water integration may require historical notices to bootstrap the water infrastructure graph.

---

# 20. Testing

Describe the current testing strategy.

Include:

- unit tests;
- integration tests;
- end-to-end tests;
- fixtures;
- mocked X posts;
- AI mocking;
- database testing;
- geography tests;
- incident-association regression tests.

Identify the most important existing test suites that a water implementation should mirror.

Give exact file paths.

---

# 21. Observability

Document:

- logging;
- Sentry/error tracking;
- metrics;
- ingestion health;
- AI failures;
- failed posts;
- dead-letter/retry mechanisms;
- admin/debug endpoints;
- dashboards if defined in repo.

Explain how an engineer currently diagnoses:

> "This post was fetched but did not appear in the correct incident."

---

# 22. Deployment / Infrastructure

Document the actual deployment architecture.

Include:

- services;
- containers;
- Cloud Run or equivalent;
- scheduler;
- database;
- secrets;
- build process;
- CI/CD;
- environments;
- staging/prod differences if visible.

List the relevant configuration files.

Explain where a new polling job or ingestion source would most naturally run based on the existing deployment.

---

# 23. Environment Variables

List relevant environment variables **by name only**.

Do not output secret values.

Group them by purpose:

- database;
- X API;
- Gemini/AI;
- storage;
- maps/GIS;
- scheduling;
- frontend;
- monitoring.

Also note whether provider/account configuration is environment-driven or hard-coded.

---

# 24. Existing Documentation

Find documentation related to:

- architecture;
- outage ingestion;
- incident association;
- geography;
- infrastructure learning;
- AI extraction;
- deployment.

Summarize each useful document and give its path.

If documentation conflicts with implementation, explicitly say so and treat the code as authoritative.

---

# 25. Technical Debt / Coupling Relevant to Water

Without proposing a full solution yet, identify architectural constraints that the water implementation must respect.

Classify each as:

```text
LOW
MEDIUM
HIGH
```

Examples:

- City Power account hard-coded deep in business logic;
- incident model assumes electricity;
- status enum is globally electricity-specific;
- infrastructure types are fixed;
- geography is reusable;
- AI pipeline is reusable;
- frontend is tightly coupled to power terminology.

For each issue provide:

- severity;
- exact code locations;
- why it matters for Johannesburg Water.

Do not rank general code quality. Only include issues relevant to extending GridWatch to multiple municipal services.

---

# 26. Reusable Components for Johannesburg Water

Identify the existing components that should almost certainly be reused rather than rebuilt.

Examples:

```text
source ingestion framework
media downloader
OCR
AI wrapper
geography resolver
incident association
timeline storage
GIS polygons
map rendering
scheduled polling
source evidence
infrastructure aliases
```

For each component:

- exact path;
- what it currently does;
- how generic it is;
- likely level of reuse:
  - direct reuse;
  - small extension;
  - significant extension;
  - unsuitable.

Do not implement changes.

---

# 27. Likely Extension Points

Based strictly on the existing architecture, identify the **natural extension points** where Johannesburg Water support would plug in.

For example:

```text
provider adapter
utility/service enum
new parser
source account configuration
asset-type expansion
status adapter
new map layer
```

This is not yet the implementation plan.

I only want:

- the most likely extension point;
- its current file/module;
- why that point is appropriate.

Avoid speculative large refactors unless the current architecture clearly requires them.

---

# 28. Questions the Codebase Cannot Answer

Create a section containing anything that remains unknown after inspecting the repository.

Examples:

- production-only scheduler configuration not checked into source;
- undocumented external database;
- secret configuration;
- missing GIS dataset;
- operational process handled manually.

Do not guess.

---

# 29. Recommended Files for the Next Engineer to Read

At the end, give me a prioritized reading list of approximately **15–30 files** that would let another engineer understand the codebase quickly enough to design the water integration.

For each file include a one-sentence reason.

Example:

```text
1. api/prisma/schema.prisma
   Core incident, geography and infrastructure data model.

2. api/src/modules/incidents/association.service.js
   Determines whether new source posts belong to existing incidents.
```

---

# 30. Final Architecture Summary

Finish with a concise but technically detailed summary answering these questions:

1. **How does GridWatch work today?**
2. **Where is City Power/electricity hard-coded?**
3. **Which parts are already generic?**
4. **What data model currently represents infrastructure?**
5. **How does infrastructure learning work?**
6. **How does geography resolution work?**
7. **How does incident association work?**
8. **How does the frontend map consume the data?**
9. **What are the safest extension points for Johannesburg Water?**
10. **What are the biggest architectural risks when adding a second utility/service?**

---

# Required Output Quality

The report must be detailed enough that an engineer who has **never seen the GridWatch repository** can write a codebase-specific implementation plan without opening every file again.

Prefer statements such as:

> `api/src/modules/incidents/association.service.js` exports `associatePostWithIncident()`. It first selects candidate incidents by X/Y/Z, then scores suburb and infrastructure overlap...

over vague statements such as:

> "There is an incident association service."

Where possible include short pseudocode explaining important flows.

Do **not** paste large source-code blocks.

Do **not** expose secret values.

Do **not** modify the codebase.

Do **not** start implementing Johannesburg Water.

Your only deliverable is:

`GRIDWATCH_CODEBASE_OVERVIEW_FOR_WATER.md`
