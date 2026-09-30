# GridWatch mobile — corrective pass re-review

**Date:** 28 September 2026  
**Scope:** Current mobile working tree, compared with the preceding review's R01–R12 and E01–E08.  
**Verdict:** Substantially improved. The main cache corruption and service-switch list-pagination defects are corrected in the checked paths. A smaller set of important synchronization, freshness, and map-state issues still prevents full acceptance.

## What was checked

I read the revised screens, shared UI, new cache/query/synchronization helpers, notification state, and new tests. I checked the notification backend's message contract and the map data flow where relevant. Unrelated API/web changes are outside this review.

The changes remain uncommitted against the same repository HEAD (`01e1615`), so this report identifies the current implementation rather than attributing every working-tree edit to a particular author.

| Validation | Result |
|---|---|
| Mobile TypeScript, `tsc --noEmit` | Pass |
| Mobile lint, `npm run lint` | Pass |
| Mobile tests, `npm test` | **21/21 pass**, up from 13 |
| `git diff --check -- mobile` | Pass |
| Independent callback/helper checks | Original fixes verified; four remaining failures reproduced |
| Rendered UI, native map, real push, screen readers | Not verified; available computer inventory still contains no apps/browsers |

No application code was changed or project servers started during this review. The new files are this report and the audit check script.

Run the independent checks from the repository root:

```powershell
node docs/audits/mobile-pass2-checks-2026-09-28.mjs
```

The script extracts actual current callbacks through the TypeScript AST, injects controlled API/storage/state adapters, and imports the real helpers. It does not simulate a native renderer or all React lifecycle behavior. Assertions marked `FIX VERIFIED` check corrections; assertions marked `CONFIRMED REMAINING` deliberately demonstrate current defects. Convert the latter into normal expected-correctness tests when fixing them.

## Confirmed improvements

1. **Failed services are no longer cached as successful empty arrays.** The version-2 area cache retains last-known successful service data and migrates ambiguous old empty arrays to unknown. A failed water request preserves a known water incident.
2. **Following preserves remembered successful statuses after failures.** It seeds from cache, merges outcomes, updates completed suburbs progressively, and limits concurrency. It no longer routinely overwrites good offline data with error rows.
3. **Changing the incident-list query clears old rows and blocks append during replacement.** The independent callback check confirmed that Power rows are removed and Show more cannot append until the new Water first page resolves.
4. **Detail-route request guards are restored.** Incident and Suburb requests check generation tokens and invalidate them on cleanup. Incident ID changes clear old content and expansion state.
5. **Suburb services load independently.** A failed/stalled water request no longer rejects the successful electricity section. Identity and each service have their own state and retry action.
6. **Map layout is better structured.** The legend is now a collapsible control inside the map stage; fallback filters render in normal flow. This corrects the earlier source-level toolbar overlap.
7. **Camera controls issue explicit commands.** Commands have unique IDs, allowing repeated actions after manual panning. Unsupported Planned filtering was removed, and duplicate polygon/point selections are collapsed by incident/place.
8. **Search and navigation improved.** Results are checked against the displayed query, Retry exists, follow selection is guarded against duplicate operations, and general browsing is reachable from Outages again.
9. **The requested content hierarchy is closer.** Home has compact service rows and a place selector; Incident places estimate/timing ahead of equipment; Suburb no longer duplicates its title in the navigation bar.
10. **Quiet hours and shared controls improved.** Whole-hour selection replaces repeated steppers; unsaved changes are tracked; Save releases its busy state in finally. Filter/hour panels have Close controls and safe-area padding. Service selectors now meet the 48-unit target. The wordmark uses the actual branded image.

These corrections are worth keeping. The next pass should finish the remaining cases, not rebuild the design again.

## Remaining findings

P1 means correct before accepting the overhaul. P2 means a meaningful remaining usability/reliability issue for the finishing pass. The numbering below is new (`S01` onward); it does not replace the historical review IDs.

### S01 — P1: Offline status age is reset to “just now”

**Location:** `mobile/app/(tabs)/index.tsx:67`; the banner renders the resulting `cachedAt` value.  
**Evidence:** Reproduced with the actual Home load callback.

The cache helper correctly preserves each service's previous `savedAt`, but Home ignores that age for the banner and calls:

```ts
setCachedAt(next.power.stale || next.water.stale ? Date.now() : null);
```

The banner then says the status was saved “just now,” even when the last successful data is a day old. Refreshing offline keeps moving this displayed age forward. Although the cache container was rewritten now, that is not a useful freshness statement about the status inside it. The individual service rows only say “saved”; their preserved `savedAt` values are not displayed.

**Reproduction:** Both cached services were last successful 24 hours ago. The callback retained those timestamps but assigned a current-time banner timestamp.

**Required correction:** Display per-service last-success age, using the preserved `savedAt` and source timestamp where available. Keep “last attempted refresh” separate. A shared banner can say “Showing saved status,” while each service says when it was saved; do not choose a single recent timestamp that misrepresents another stale service. Legacy data without a trustworthy time should say age unknown.

**Acceptance:** Repeated offline refreshes never make old data appear newly obtained. Mixed fresh Power/stale Water shows the two ages accurately. Apply the same saved-age presentation to Following, which stores `savedAt` but still renders only “saved.”

### S02 — P2: Refresh still races with Show more

**Location:** `mobile/app/(tabs)/outages/index.tsx:119`, `:124`, `:131`, `:272`.  
**Evidence:** Reproduced with the actual list load callback. The old cross-service replacement defect is fixed; this is the remaining same-query refresh path.

`replacing.current` is true only for `mode === 'replace'`. Refresh sets it false and leaves `loading` false, so Show more remains available. An append started during refresh captures the same query sequence as the refresh. Both responses are accepted.

If append completes first, its page is added and then silently discarded when refresh replaces rows. In the opposite order, response cleanup can release the shared paging lock while another request remains in flight. The sequence token does not distinguish these concurrent operations.

**Reproduction:** Start with 30 rows, begin refresh, then append. Both offsets 0 and 30 are requested. Resolve append first and refresh last: the appended page disappears.

**Required correction:** Block append while any first-page reload is in progress, including refresh. Keep existing same-query rows visible but disable/hide Show more until refresh finishes. Give page operations appropriate identities/locks so one request cannot release another's state. Preserve current rows on a transient same-query refresh failure and explain their age instead of clearing them unnecessarily.

**Acceptance:** Test both response orders, rapid repeated presses, and refresh failure. No accepted page disappears because of a late refresh; no duplicate append starts; loading indicators describe the actual outstanding work.

### S03 — P1: Startup bypasses the notification synchronization queue

**Location:** `mobile/src/state/app.tsx:160–163`; queued user operations begin around `:215`.  
**Evidence:** Reproduced using the real `syncAlerts()` function with controlled registration timing and the real queue.

The app becomes ready before its initial notification synchronization finishes. Startup then calls `syncAlerts(loaded.following, loaded.quiet, false)` directly, outside `queue.current.run(...)`. Meanwhile the user can remove a suburb or change quiet hours through queued operations.

If startup's registration request is slow, a newer removal can finish first. Startup then resumes and replaces subscriptions using its old snapshot, re-subscribing the removed suburb. Its final alert-status result can also overwrite newer state.

**Reproduction:** Startup captured `[removed-suburb]` and paused at registration. A queued removal synchronized `[]`. Startup resumed; final server subscriptions became `[removed-suburb]` again.

**Required correction:** Route startup, resume, retry, follow, unfollow, and quiet-setting synchronization through one reconciler. Read the latest desired preferences when a queued job actually starts; guard status application against obsolete preference versions. Persist/derive pending state from the desired-versus-acknowledged preferences rather than only the last result enum.

**Related incompleteness:**

- Startup failure does not set `pendingSync`, so the new Retry banner can be absent after a failed launch reconciliation.
- Most paths set pending only for `failed`; a 503/unavailable result can leave a server removal unsynchronized without a pending-removal indication.
- Native permission/token calls and push API requests still have no finite deadline. One stalled queued task can block every later edit. The read-only `withTimeout()` helper is not used here and explicitly does not cancel underlying work; simply wrapping mutations with it would not guarantee server ordering. Handle cancellation/unknown mutation outcomes and reconcile the latest desired state after recovery.
- There is still no direct notification-settings action when permission is denied.

**Acceptance:** Start with an intentionally slow launch sync, remove a suburb, change quiet hours, and resume the app. The eventual server state must match the final local preferences. Repeat with startup failure and a stalled request; recovery must remain available and not silently report completion.

### S04 — P1: Old-service map features remain selectable during a switch

**Location:** `mobile/app/(tabs)/map/index.tsx:33`, `:54–68`.  
**Evidence:** Reproduced with the actual map load callback.

The list has improved query-replacement handling, but the map still renders `visiblePlaces(outages, layers)` from the previous service while the new request loads. `load()` clears selections, not `outages`. Power features remain visible and selectable beneath a selected Water control until Water finishes.

**Reproduction:** Seed a Power feature, call the Water load, hold its response. The Power feature remains in rendered input. Only resolving Water replaces it.

**Required correction:** Store a service/query key with the map result and render only matching-scope features. Hide/clear old data immediately for a scope switch; retain it only for an explicitly labeled same-service refresh. Ignore stale map-selection and Show my area results too. Test native and fallback modes.

**Acceptance:** A delayed Water request never leaves a Power marker or fallback row actionable as current Water content.

### S05 — P1: Alert capability wording was broadened without fixing service support

**Location:** `mobile/src/lib/alerts.js:5`; `mobile/app/suburb/[id].tsx` followed-status text; `api/src/modules/push/events.js:23–35`.  
**Evidence:** Source-confirmed contract mismatch; actual device delivery not tested.

The previous wording about power-formatted messages has been replaced by the unconditional “Alerts are on for followed suburbs.” The backend still hardcodes power titles and City Power attribution; the notification sender has not gained service-aware message composition. Removing the developer-oriented wording did not resolve the underlying capability problem.

Successful device/subscription registration does not establish correct Water alert support or delivery. The UI should not imply that both displayed services have verified, correctly labeled alerts simply because registration succeeded.

**Required correction:** Either implement and test service-aware notification composition/routing as an explicitly scoped backend correction, or restrict displayed capability and actual delivery to supported services. Use a truthful registration state while delivery coverage remains unverified. Do not restore a permanent technical disclaimer as the solution.

**Acceptance:** A water notice can never generate a power-outage title or incorrect City Power attribution. The UI accurately describes which service alerts are supported. Confirm actual native registration, delivery, and notification navigation separately.

### S06 — P2: Map bounds and empty/error states remain incomplete

**Locations:** `mobile/src/lib/geo.js:75`; `mobile/src/components/MapCanvas.tsx:37`; `mobile/app/(tabs)/map/index.tsx:149`, `:210`.  
**Evidence:** Source-confirmed behavior; native framing remains unverified.

- `placesBounds()` only considers centre coordinates. It ignores the polygon/MultiPolygon boundaries actually drawn. A single large suburb returns zero-extent bounds at its centre; Show all does not necessarily show the whole affected shape.
- Camera padding is fixed and does not reserve space for an open selection panel, which can occupy up to 52% of the map stage.
- `allHidden` checks whether every possible layer is off. If only Live data exists and Live is hidden while empty categories remain on, the map says “No incidents to show” rather than “No incidents match these layers,” without the expected reset action.
- Fallback “No incidents” does not exclude `error`; after a failed request it can appear alongside “No connection.” Retry is inside the native-only toolbar, leaving fallback without a direct retry.

**Required correction:** Calculate bounds from drawn geometry, with a sensible padded point-only fallback and zoom cap. Account for the visible panel when fitting, or close it on Show all. Distinguish API-empty, filters-empty, and request-failed states. Put Retry where both native and fallback can use it.

**Acceptance:** Fit one large polygon, a MultiPolygon, a single point, and dispersed suburbs; verify framing. Hide the only category containing data, then test offline fallback: each state must have accurate copy and the appropriate recovery action.

## Additional finishing work

These should not trigger another redesign, but they remain relevant to the original acceptance criteria:

- **Home does not yet render independent successful requests progressively.** It waits for Power, Water, and sync to all settle. A fast Power result can wait up to the 20-second timeout for Water or feed metadata. Following improves progression across suburbs but still waits for both services within each suburb. Suburb detail now implements the desired independent pattern.
- **Cache I/O should not gate useful network results.** Home reads cache before starting requests and awaits `writeCache` before applying successful results. Storage rejection is swallowed by the caller and can leave checking/old states indefinitely. Render validated network success regardless of a cache-write failure, and handle cache-read failure as cache unavailable.
- **Following's targeted retry seeds the target with loading units**, temporarily hiding its remembered successful service until the requests settle. Preserve that service while retrying its failed counterpart. Show saved ages, and make retry available for stale units as well as wholly unavailable ones.
- **Applied-centre text now lives inside the Filters button** beside the search field. A long centre name or large font can consume the search width because the button lacks a constrained label layout. Prefer a compact Filters button plus a wrapping applied-filter chip below it. This is a layout risk requiring rendering, not an observed screenshot defect.
- **Focus management needs real accessibility verification.** Filter close calls focus restoration immediately after hiding the modal; opening focus and other sheets' focus restoration are not consistently handled. The new safe-area/max-height/scrolling work is useful, but it is not a screen-reader sign-off.
- **The shared state/freshness components remain unfinished.** New pure helpers are valuable; repeated loading/error/freshness presentation is still embedded in routes. Consolidate only where it prevents inconsistencies such as S01.

## Status of the previous review

| Previous finding | Current assessment |
|---|---|
| R01 Partial cache becomes empty success | **Core defect fixed**, independently checked. S01 is a remaining freshness-presentation defect. |
| R02 Following destroys offline cache | **Core defect fixed**, helper behavior checked and integration reviewed. Saved ages/per-service progression remain. |
| R03 Query switch + pagination mixes services | **Original replacement scenario fixed**, callback checked. Refresh overlap remains S02; map scope remains S04. |
| R04 Detail request guards removed | **Fixed in source.** Device navigation/lifecycle check still required. |
| R05 Map legend overlaps toolbar | **Corrected in source structure.** Native size/hit-test confirmation still required. |
| R06 Camera controls ineffective | **Mostly corrected.** Explicit repeatable commands added; geometry/panel fitting remains S06. |
| R07 Unsupported/duplicate map controls | **Planned and duplicate-choice issues fixed.** Empty/error-state cases remain S06. |
| R08 Stale picker results and no retry | **Main query/result and retry issues fixed.** Busy guard exists; visible per-row busy feedback could improve. |
| R09 Notification synchronization/recovery | **Not complete.** Startup bypass, stalled queue, pending-state gaps, and coverage remain S03/S05. |
| R10 Accessible sheets/long labels | **Improved**, with visible Close, bounded scroll, safe areas, and better label shrinking. Native accessibility still unverified. |
| R11 Suburb loses both services on one error | **Fixed in source.** Independent requests/states/retries added. |
| R12 General browsing lost entry point | **Fixed.** Outages now exposes Suburbs browsing. |

Enhancement progress: E01 Home composition, E02 incident priority, E03 shorter list notes, E06 hour selection, E07 Following balance, and E08 mark consistency have clear implementation changes. E04 reusable state/freshness presentation remains partial. E05 simpler customer wording is improved in places but cannot be considered complete while S05 is unresolved.

## Recommended final corrective pass

1. Fix **S03 and S05** together: one reliable preference reconciler and an explicit, truthful notification service contract.
2. Fix **S01 and S04**: status freshness and service identity must remain trustworthy while offline or switching views.
3. Fix **S02 and S06**: serialize first-page refresh versus pagination; finish map fitting/recovery behavior.
4. Add integration-level tests around actual controllers/hooks, not only helper functions. The current helper tests are useful but do not cover the startup bypass, callback overlap, or UI timestamp assignment found here.
5. Run native visual/accessibility acceptance: phone and tablet layouts, long names, large text, modal focus, map gestures/framing, and real notification delivery. Capture evidence before claiming the whole overhaul is complete.

Suggested handoff: **“Keep the current design and fix S01–S06 in this pass-2 report. Use the audit script to reproduce the remaining paths, then add permanent expected-correctness regression tests. Do not treat helper-test passes as full UI/native validation. Finish the listed cache/error recovery details and provide actual device evidence where available.”**

The work is much closer to the brief. The remaining task is a focused reliability and native-verification pass, with only small layout refinements needed—not a fresh UI overhaul.
