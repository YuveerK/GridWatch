# Review of the GridWatch mobile overhaul

**Review date:** 28 September 2026  
**Baseline:** `01e1615` plus the original mobile UI audit dated 27 September  
**Reviewed version:** Current uncommitted mobile working-tree changes  
**Verdict:** A useful first implementation, with meaningful improvements, but not ready for final acceptance. Correct the data-state regressions before further cosmetic work.

## 1. Assessment

Grok has improved the app beyond a palette change. The new colors are more readable, the launcher branding now relates to GridWatch, the Outages controls are less scattered, and Incident detail has a more useful title and latest-update section. Quiet-hour wording, closed-versus-restored semantics, and restored-place map metadata were corrected. These changes should be retained.

However, the implementation has only partially delivered the original brief. Request guards were added without consistently binding displayed content to the active request scope. Partial-success handling was introduced without preserving the meaning of cached data. Several new controls are present without complete behavior. The result is a better foundation with significant unfinished reliability and interaction work.

My recommendation is **a focused corrective pass, followed by a visual finishing pass—not another wholesale rewrite**. The highest-value improvements now are trustworthy offline behavior, stable results during navigation/filtering, genuinely functional map controls, and stronger prioritization of the user's next action.

### Scope and confidence

- Reviewed the changed mobile source, styles, assets, navigation, state, data helpers, tests, and lint configuration against the original audit.
- Read relevant API responses and notification behavior to check the mobile contract. There are other uncommitted API/client changes; their authorship cannot be established from this working tree, and this is not an audit of the entire backend or web client.
- Viewed the new launcher and monochrome icon assets. The blue A has been replaced by a warm amber pulse mark. Native launcher masking and installed splash behavior were not tested.
- The available computer/browser inventory returned no apps or browsers. No rendered mobile screens, native gestures, accessibility service output, or real push delivery were observed. Layout concerns below are source-derived risks unless stated otherwise.
- Three defects were reproduced using **actual screen callback bodies**, extracted with the TypeScript AST and executed with controlled API/storage/state adapters. This checks callback behavior, not native rendering or React scheduling.
- No application source was changed during this review. Deliverables are this report, a corrective handoff prompt, and a standalone audit reproduction script.

## 2. Validation performed

| Check | Result | What it establishes |
|---|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` in `mobile/` | Pass | Current TypeScript contracts compile. |
| `npm run lint` in `mobile/` | Pass | The newly added ESLint configuration runs without reported errors. |
| `npm test` in `mobile/` | 13/13 pass | Existing pure status, geography, and quiet-hour helper cases pass. |
| `git diff --check -- mobile` | Pass | No reported patch whitespace errors. |
| Audit reproductions | Three defects confirmed | R01, R02, and R03 below. |
| Device, native map, push delivery, screen-reader checks | Not performed | A remaining acceptance requirement, not an implied pass. |

The tests increased from 9 to 13, but still do not exercise screen loading, offline recovery, pagination transitions, notification synchronization, or sheet accessibility. Passing them does not contradict the defects below.

Reproduce the audit evidence from the repository root:

```powershell
node docs/audits/mobile-review-repros-2026-09-28.mjs
```

This script intentionally asserts the current defective outcomes. It is an audit artifact, not the desired permanent regression suite. After fixes, replace these expectations with tests for correct behavior in the application test suite.

## 3. Changes worth keeping

- **Contrast:** `faint` changed from `#737B88` to `#97A4B5`. Its calculated contrast is now 7.54:1 on the page, 6.71:1 on cards, and 5.76:1 on raised surfaces. The previous values were 4.61, 4.35, and 4.00 respectively. These solid-color combinations now exceed the 4.5:1 normal-text reference threshold. This does not validate every tinted, disabled, or composited state. [WCAG contrast reference](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
- **Branding:** The launcher and monochrome artwork now use a pulse identity. The in-app mark still uses an Ionicons pulse inside a rounded square, so exact shape consistency remains a finishing task.
- **Onboarding:** Manual suburb selection is primary, location is secondary, and the detected suburb requires confirmation.
- **Outages:** Sort and service centre moved to an Apply/Reset sheet. “Finished” no longer promises that every closed incident is restored.
- **Incident detail:** Large place title, latest update, original wording expansion, larger source-link targets, and separate restored localities are improvements. Reversing the timeline is consistent with the API's ascending response order.
- **Truthful states:** Following no longer automatically says alerts are on. Quiet hours correctly describe suppression rather than delayed delivery. The misleading universal repair rail was removed.
- **Map metadata:** Place identity, inferred status, restoration flag, and update time now survive into selection.
- **Following:** Edit mode replaces permanently prominent Unfollow buttons. Requests are bounded to four suburb workers, rather than launching all 40 service requests at once.
- **Tooling:** Lint is now configured and passing. Keep the added helper tests while expanding coverage to the changed behavior.

## 4. Findings requiring correction

**Priority:** P1 = fix before accepting/releasing this overhaul; P2 = complete in the next finishing pass. “Introduced” means the current diff introduced the mechanism. “Incomplete” means the original issue remains partly unresolved.

### R01 — P1: Partial service failure is saved as an empty successful result

**Evidence:** `mobile/app/(tabs)/index.tsx:47`, especially the cache payload at line 56 and fallback at line 60. **Introduced; reproduced.**

When power succeeds and water fails, the on-screen water state is initially `error`, but the cache stores `water: []`. On a later fully offline load, that same cache is restored as `{ kind: 'ok', rows: [] }`. `areaHeadline()` then reports **“No interruption reported.”** A previously cached water incident is also overwritten by that empty array.

**Reproduction result:** `cachedWaterRecords: 0`, `offlineWaterKind: "ok"`, `offlineWaterLabel: "No interruption reported"` after starting with a known cached water incident and making the water request fail.

**Correction:** Persist each service independently with explicit success/error/unknown state, source time, and saved time. Update only successful results. On partial failure, retain an older successful result as stale or show unavailable when none exists. Do not manufacture empty arrays for failed requests. Version or migrate the cache shape so old partial caches cannot be mistaken for known-empty data.

**Acceptance:** A failed service can never become a “no reports” result through caching. A later offline load preserves its previous incident or explicitly says unavailable.

### R02 — P1: Following's offline cache fallback no longer runs for network failure

**Evidence:** `mobile/app/(tabs)/following/index.tsx:27`, `:40`, `:56`, `:60`. **Introduced; reproduced.**

`Promise.allSettled()` converts rejected requests into error units. The outer load therefore resolves normally and writes those error units to the cache. The cache-read fallback is only inside the effect's `.catch()`, so ordinary offline failures never reach it. A useful saved list is replaced with “Unavailable” records.

The load also resets every row to Checking and waits for all workers to finish before showing any successful row. A slow request delays all visible successes; Retry reloads the whole list rather than just the failed unit.

**Reproduction result:** `reachesCatchFallback: false`, displayed power “Unavailable,” and cached water state `error` when all service requests reject.

**Correction:** Load and validate last-known successful values first. Merge each suburb/service result independently as it finishes. Preserve successful values and their ages across errors. Keep previous content visible during refresh and retry the affected suburb/service. Add a finite request timeout/cancellation policy so a stalled request cannot block completion forever.

**Acceptance:** With 20 saved suburbs, successful rows appear progressively; one failure does not hide other successes; offline launch shows saved values with ages; error results do not erase good cache entries.

### R03 — P1: Scope changes plus pagination can permanently mix services

**Evidence:** `mobile/app/(tabs)/outages/index.tsx:83`, `:99`, `:145`, `:199`; related old-feature display in `mobile/app/(tabs)/map/index.tsx:28`. **Incomplete original fix, with a reproduced pagination failure.**

The generation guard blocks late responses only after a newer request begins. It does not bind existing rows to the current service/filter. Switching from Power to Water keeps Power rows visible. The footer still offers Show more based on the old row count and total.

If Show more is pressed while the new first page is loading, it requests Water with the old offset, increments the same generation counter, and supersedes Water's first-page request. Its response appends Water rows to the existing Power rows. The first page of Water is then ignored.

**Reproduction result:** requests at offsets `[0, 30]`, final services `["ELECTRICITY", "WATER"]`, 31 rows, and the new Water first page absent.

Map has the simpler related issue: Power features remain selectable under the Water selector while the new request is pending. Status counts in Outages likewise remain from the previous service until replaced, and pull-to-refresh no longer refreshes stats.

**Correction:** Give results a query key containing service/status/sort/query/centre. Only render or paginate data matching that key. Separate first-page/reset request identity from page append requests. Block duplicate pagination and pagination during query replacement, use the new query's offset, and deduplicate appended IDs. Retain data only for same-query refresh, with visible refresh state. Refresh scoped counts as well.

**Acceptance:** Repeat service/filter changes with reordered responses and Show more presses. No mixed-service rows, skipped first pages, stale-scope markers, or old-service counts may appear as current results.

### R04 — P1: Detail-page request guards were removed

**Evidence:** `mobile/app/outage/[id].tsx:24`; `mobile/app/suburb/[id].tsx:29`. **Introduced regression; source-confirmed race path.**

The original effects used a cleanup `live` flag. The new reusable `load()` callbacks have no cancellation, request identity, or cleanup invalidation. If a mounted route's ID changes while an earlier request is pending, the old response can overwrite the new detail. Incident detail also retains the old outage while fetching the new ID.

**Correction:** Scope detail state by ID and request generation; invalidate on ID changes and unmount. Clear/hide previous-ID content; preserve it only for same-ID refresh. Reset ID-specific expansion state such as `openPost`. Apply the same rules to success, catch, and finally handlers.

**Acceptance:** Start A, change the mounted route to B, resolve B, then A. The final screen and its actions still refer to B. A late failed A request must not replace successful B with an error.

### R05 — P1: Map legend is positioned over the new toolbar

**Evidence:** `mobile/app/(tabs)/map/index.tsx:71`, `:209`, `:221`. **Introduced layout conflict; calculated from source, not a screenshot.**

The service segment is about 52 units tall, followed by an 8-unit gap and a toolbar at least 48 units tall. The legend remains absolutely positioned at `top: 72` relative to the entire screen. It therefore begins inside the toolbar's vertical band and can cover Show my area/Show all. Five 40-unit legend controls plus padding/gaps occupy roughly 252 vertical units. The overlay is also rendered above the fallback list, where it can cover rows.

**Correction:** Give the map canvas its own `flex: 1` container and position overlays inside that container below the toolbar. Use a compact Layers button or collapsible legend. In fallback mode, render filters in normal document flow rather than as a map overlay. Reserve attribution space and verify hit targets with an actual device.

**Acceptance:** Controls do not overlap at 360-unit width or large text, and all fallback rows remain reachable and readable.

### R06 — P2: “Show all” does not reliably control the camera

**Evidence:** `mobile/app/(tabs)/map/index.tsx:76`; `mobile/src/components/MapCanvas.tsx:43`. **New incomplete control.**

Show all only calls `setFocus(null)`. After manually panning the default map, focus is already null, so this changes neither state nor the camera key. From a saved-area focus, it returns to a hardcoded Johannesburg centre/zoom rather than fitting the displayed incidents. Repeating Show my area after panning away can similarly leave the same key unchanged.

**Correction:** Use the installed MapLibre camera ref methods for explicit commands. The local `Camera.tsx` exposes `jumpTo`, `easeTo`, and `fitBounds`; implement against that installed API rather than an old example. Fit visible geometry with padding for controls/panel. Provide a defined default for no results. Disable/remove camera controls in list fallback.

**Acceptance:** Every press works after arbitrary panning. Show all fits currently visible results, including incidents outside central Johannesburg. Reduced motion uses an immediate or appropriate reduced transition.

### R07 — P2: Map controls exceed or duplicate the available data

**Evidence:** `mobile/src/lib/geo.js:27`, `:39`; `mobile/src/components/MapCanvas.tsx:49`; `api/src/modules/api/routes.js:26`, `:480`. **New and pre-existing contract gaps.**

- Planned is now an interactive layer switch, but `/v1/map` returns only ACTIVE and PARTIALLY_RESTORED incidents. The control cannot reveal planned work from this endpoint.
- Each bounded suburb now generates both a polygon and a centre point. Selection maps every returned hit directly to a choice without deduplicating `(outageId, placeId)`. A native hit containing both geometries can show the same incident twice. This requires native hit-test verification, but the missing deduplication is explicit.
- There is no distinct state for no returned incidents versus all layers hidden. A blank map/list leaves the user to infer what happened.

**Correction:** Remove/disable unsupported layers with accurate scope text, or explicitly add and test the required API behavior. Deduplicate selection choices by incident/place, then show genuine distinct incidents. Add no-results and all-layers-hidden messages with Reset layers. Preserve place-specific restored and inferred metadata.

**Acceptance:** Every enabled category can correspond to actual API data; one incident/place yields one choice; zero visible results have an explanation.

### R08 — P2: Picker results remain actionable while the query changes

**Evidence:** `mobile/app/(tabs)/outages/search.tsx:40`, `:67`, `:96`. **Incomplete.**

The phase model fixes premature “No matches,” but starting another valid query sets loading without clearing or hiding `hits`. Picker `data` is still the old hits, so a user can select a suburb from the previous query. General search hides its groups during loading, making the two modes inconsistent. The error state says Try again but offers no retry control. Following from a result has no busy guard, permitting concurrent subscription mutations.

**Correction:** Render selectable hits only when their query key matches the current successful query. Add Retry for the same query, selection busy state, and clear error/save feedback. Do not force users to edit a valid query just to retry it.

**Acceptance:** Delayed second queries never leave old results selectable. One tap starts one follow operation. Search failure recovers with Retry.

### R09 — P1: Notification settings still lack reliable synchronization and recovery

**Evidence:** `mobile/src/state/app.tsx:93`, `:195`, `:201`, `:224`; `mobile/app/(tabs)/following/quiet.tsx:17`. **Mostly inherited/incomplete; new busy-state failure is introduced.**

There is better wording and a richer status enum, but the underlying mutation flow remains fragile:

- Multiple follow/remove/undo/quiet operations can issue whole-list subscription replacements concurrently. An older request can finish last and restore an obsolete server subscription list.
- Unfollow handles only push-disabled/503 errors; ordinary network failures are swallowed. The suburb disappears locally while remote notifications can continue, with no pending-sync indication.
- Permission/channel operations occur outside the guarded token/register blocks. If they reject, Quiet hours never reaches `setBusy(false)` because its save handler lacks `try/finally`.
- There is no visible retry-registration action or settings action for denied permission. Resuming the app only updates the clock; it does not reconcile changed permission/subscription state.
- The enabled message exposes “Messages use power wording, including for water notices.” This acknowledges a backend defect but is not a finished service capability policy.

**Correction:** Serialize/coalesce synchronization of the latest desired preferences; reject obsolete results and keep a pending-sync state on failure. Distinguish local save, remote subscription sync, permission, and supported service capabilities. Always clear busy flags in finally and expose recovery actions. Decide whether to fix service-aware backend messages or restrict the UI promise to verified alert coverage; do not imply that a disclaimer makes incorrect notifications acceptable.

**Acceptance:** Rapid follow/unfollow/undo ends with the server matching the final local list. Offline removal visibly remains pending. Permission/channel rejection returns the UI to an actionable state. A retry or app resume reconciles current preferences without duplicate prompts.

### R10 — P2: Sheets and long labels need a complete accessibility pass

**Evidence:** `mobile/app/(tabs)/outages/index.tsx:204`, `:267`; map selection panel at `map/index.tsx:227`; `mobile/src/components/ui.tsx` styles. **Incomplete; device validation required.**

The filter modal supports Android `onRequestClose` and respects reduced motion, which are good. It lacks a visible Close control, explicit safe-area padding, vertical scrolling/max height, and deliberate focus restoration. The map panel likewise has no bounded vertical scroll for long content. Long place text in horizontal incident/map headers lacks a clear flex-shrink/wrapping allocation. Pill content has no constrained text layout. Several targets remain below the report's 48-unit product target (service segments 44; map legend 40).

**Correction:** Add a visible close action, safe-area-aware bounded scroll content, appropriate accessibility focus behavior, and robust text allocation. Verify controls at 200% text size and with a keyboard open. Retain the existing Android close handler; React Native documents its platform role in [Modal](https://reactnative.dev/docs/modal).

**Acceptance:** Close/Apply remain reachable on small phones and large text; long suburb/status names wrap without covering adjacent controls; focus returns to the invoking control.

### R11 — P2: Suburb detail still loses both services when one fails

**Evidence:** `mobile/app/suburb/[id].tsx:33`. **Incomplete original requirement.**

Suburb detail still uses one `Promise.all` for identity, electricity, and water. A water failure replaces the whole page with a failure screen even if identity and electricity succeeded. Home now handles settled service results independently, but both Home and Following still wait for all participating promises before publishing success.

**Correction:** Treat identity and each service as independent data units. A known suburb can show successful power information while water is unavailable. Use per-unit retry, finite request duration, and progressive rendering. The no-report state must follow a successful empty response only.

**Acceptance:** Inject a water error or stalled water request. Power becomes usable without waiting for or requiring water success.

### R12 — P2: General suburb browsing lost its normal entry point

**Evidence:** `mobile/app/(tabs)/outages/_layout.tsx`; all `/outages/search` callers in Home/Following pass `pick=area` or `pick=follow`. **Introduced discoverability regression.**

The general search screen was improved with grouped results, but removing the Outages header search leaves no normal in-app action opening that mode. Inline Outages search filters incidents only. A user cannot directly search and inspect an arbitrary suburb through general search without going through a save/follow workflow or an incident's area links.

**Correction:** Add one clearly named Browse suburbs/search entry, or explicitly let the picker open suburb details without forcing a save. Keep its purpose distinct from filtering the incident list; do not reintroduce two unlabeled identical search actions.

**Acceptance:** From a main tab, inspect another suburb without changing My area or Following, and return to the previous state.

## 5. Visual and product enhancements

These are design recommendations, not claims about unobserved rendered screens. Prioritize them after R01–R05/R09.

### E01 — Make My area the distinctive centre of the app

Home currently has the new palette but still reads as a wordmark, title, two generic panels, and list. The status cards no longer contain service glyphs and are not actionable. `width < 520` makes them stack on most phones, increasing the distance to actual incidents.

Use a strong location selector with a small place icon and change affordance. Give each service a recognizable glyph and concise status row. On ordinary phones, prefer two compact stacked **rows** inside one well-composed status section; use taller cards only where content/width supports them. Keep status and explanation from merely repeating the same sentence. Add a clear route from the service summary to the appropriate local detail. Preserve truthful neutral no-report styling.

**Target:** At 360×800 and default text, place, both service conditions, freshness, and the beginning of the first incident are visible. Large text should reflow naturally rather than meet an arbitrary fold target.

### E02 — Put restoration estimate/schedule before equipment detail

Incident detail now surfaces the latest update, but still puts Cause, Equipment, and Service centre before Estimate and Timing (`outage/[id].tsx:94–119`). This does not match the original information priority.

Use: **place/status → latest update → ETA or planned window → timing/affected areas → update history → cause/equipment**. Keep secondary facts in a compact disclosure when long. Omit boilerplate empty equipment/cause sections where they add no useful information. Show estimate copy appropriate to active/planned/finished states; a restored incident does not need a prominent “No restoration time was reported” panel.

### E03 — Make the Outages header shorter through contextual explanations

The new sheet is a good change, but a persistent multi-sentence note now explains both status-count scope and Finished semantics above every list. Move detailed explanations into an accessible information control; use a short “All power incidents” count caption. Explain Finished only when selected. Add a clear-search control and show the active centre name after Apply, not only “Filters 1.”

Keep the result count accurate during errors; do not combine stale totals with empty rows. Refresh list and count data together where appropriate.

### E04 — Finish the shared component system

`space` exists but is not used consistently; shared UI still lacks reusable state views, freshness labels, and a service-status component. Styles and error flows are duplicated across routes.

Extract only recurring behavior: `ServiceStatus`, `LoadState`, `Freshness`, `NotificationStatus`, `AccessibleSheet`, and consistent buttons. Avoid a large generic design-system rewrite. Standardize metadata size, section spacing, title roles, and primary/secondary action placement. Ensure Water-specific primary actions can use water identity without changing severity colors.

### E05 — Remove developer-oriented prose from normal use

Use specific, actionable language: “Saved on this phone. Alerts couldn't sync. Retry.” A permanent statement about incorrect power wording belongs in a known-issues record while service-aware delivery is fixed or unsupported coverage is withheld. Keep uncertainty explanations concise and adjacent to the relevant state instead of repeating broad caution on every screen.

Suburb detail also still repeats its name in the navigator and large body title. Use a contextual back header and a single prominent place title.

### E06 — Improve Quiet hours beyond the old stepper

The switch and truthful timezone/copy are useful. The hour controls still require repeated plus/minus taps. Use a compact whole-hour selection sheet/wheel that matches the existing integer-hour API. Clear the prior saved message whenever draft values change, indicate unsaved changes, and prevent a previous “Saved” message from describing a new unsaved selection. Use finally for busy recovery.

### E07 — Give Following a more useful information balance

For an empty list, lead with Add a suburb and a concise benefit. Put alert configuration/quiet settings after the primary task or behind a compact settings row. For populated lists, show compact Power/Water statuses, per-unit freshness, and an obvious navigation affordance. At large font scale, stack the service summaries instead of permanently forcing two columns.

Undo should handle capacity and sync errors visibly rather than clearing its banner before the result is known. Keep the useful edit-mode removal pattern.

### E08 — Finish brand consistency without adding visual noise

Keep the amber pulse direction. Use the same pulse path/proportions in launcher, splash, and in-app mark, adapted to the required mask rather than substituting a different library glyph. Verify adaptive icon masking and monochrome output on device. Keep the canvas restrained; use one strong status/location composition per screen rather than more gradients and decorative charts.

Do not add a light theme, extra tab, historical chart, or notification inbox merely to make the app feel fuller. Complete the existing experience first.

## 6. Original audit completion map

“Implemented” means the described source correction is present, not that native QA passed. “Largely” still requires the stated finishing work.

| Original ID | Assessment | Remaining work |
|---|---|---|
| U01 Hierarchy/surfaces | Partial | Home composition, repeated panels, consistent component roles. |
| U02 Brand mismatch | Largely implemented | One exact mark; native launcher/splash verification. |
| U03 Duplicate titles | Partial | Suburb title still repeated. |
| U04 Outages controls | Largely implemented | Sheet accessibility, contextual notes, visible applied centre. |
| U05 Dense incident rows | Largely implemented | Long-label reflow, richer distinct incident context when needed. |
| U06 Following versus alerts | Implemented in presentation | Synchronization reliability remains R09. |
| U07 Quiet-hour promise | Implemented | Save failure/draft feedback, improved hour selection. |
| U08 Place-level map status | Largely implemented | Native selection deduplication and map QA. |
| U09 Async scope correctness | Incomplete | R03/R04; guards alone do not protect displayed scope. |
| U10 Search states | Partial | Stale actionable picker rows, retry/busy state. |
| U11 Following partial failures | Partial, with regression | R02: cache is overwritten and fallback is bypassed. |
| U12 Common data states | Incomplete | R01/R02/R11; no shared state component contract. |
| U13 Map panel/fallback | Partial | Static panel and Close improved; R05–R07/R10 remain. |
| U14 Unfollow dominance | Largely implemented | Undo errors, sync feedback, large-text layout. |
| U15 Incident hierarchy | Partial | ETA still follows secondary equipment facts. |
| U16 Closed versus restored | Implemented | Retain the corrected semantics and tests. |
| U17 Accessibility | Partial | Solid text contrast improved; modal focus/reflow/targets need QA. |
| U18 Quiet-hour controls/buttons | Partial | Busy contract exists; exception recovery and direct hour selection unfinished. |
| U19 Responsive layout | Partial | Reading width and Home stacking added; Following/map/pills need testing. |
| U20 Notification capability | Partial | More accurate registration language, but service-aware delivery and recovery remain unresolved. |

## 7. Recommended implementation sequence

1. **Repair cache semantics:** R01/R02. Define one versioned per-service last-success model and migrate old data conservatively. Add failure/offline regressions before styling it.
2. **Repair query identity and pagination:** R03/R04/R08. Separate query replacement from refresh and page append; validate delayed/reordered responses.
3. **Reconcile notification preferences:** R09. Serialize latest-desired-state sync, expose errors/retry, and always release busy state.
4. **Finish map and filtering interaction:** R05–R07/R10. Fix overlay containment and camera commands, align layers to API scope, deduplicate picks, and verify native behavior.
5. **Complete primary information hierarchy:** R11/R12 and E01–E07. Preserve partial successes, restore browsing, promote estimates, and reduce explanatory clutter.
6. **Final brand/accessibility pass:** E08, device screenshots, screen-reader checks, safe areas, large text, and reduced motion.

Keep the Expo 57/React Native 0.86 stack. Use [matching Expo documentation](https://docs.expo.dev/versions/v57.0.0/) and installed dependency types when changing native interfaces. An upgrade or navigation replacement is not needed for these corrections.

## 8. Acceptance tests for the next pass

| Scenario | Required behavior |
|---|---|
| Power success, Water failure, then full offline | Water remains stale/unknown, never becomes a successful empty result. |
| Following offline with existing successful cache | Last-known values remain visible with saved ages; cache is retained. |
| One followed suburb slow/failing | Other completed units render immediately and remain usable. |
| Power → Water while Show more is pressed | Only Water pages for the current query survive; no skipped first page. |
| Filter/search change during pagination | Old pages cannot append; duplicate pagination cannot duplicate IDs. |
| Mounted detail A → B with A resolving last | B stays visible, including its title, source links, and follow actions. |
| Picker query A → B, delayed B | A results cannot be selected as B results. |
| Follow/remove/undo with reordered network completions | Server eventually matches the final local desired list. |
| Offline unfollow | Visible pending-sync state; no false claim that server removal succeeded. |
| Native permission/channel call rejects during Save | Save stops being busy and presents actionable feedback. |
| Manual map pan, repeated Show all/My area | Camera responds every time; all results fit with overlay padding. |
| Polygon + point hit for one incident/place | Exactly one selection choice; distinct incidents remain selectable. |
| No data versus all map layers hidden | Distinct messages and relevant recovery/reset action. |
| Filters/map selection with 200% font size | Close, Apply, and View incident remain reachable. |
| Browse another suburb | No need to change saved area or follow it. |

Capture representative phone and tablet screenshots for Home, Outages, Incident, Suburb, Following, Quiet hours, Search, Map, and failure/offline states. Label fixtures. Test actual native map and notification routes separately from web fallback. Preserve the test/lint/typecheck passes and report unverified capabilities explicitly.

No project servers were started during this review. Do not leave temporary servers or builds running in background terminals after the corrective work.
