# GridWatch mobile UI audit and redesign specification

**Date:** 27 September 2026  
**Audience:** Product owner and Grok 4.7 High Fast implementation agent  
**Scope:** `mobile/`, with a limited read of notification backend behavior to verify customer-facing promises.

## 1. Executive assessment

GridWatch has useful functionality and a sensible starting palette, but its visual system does not give enough emphasis to the information people open an outage app to find: **what is happening in my suburb, how current is that information, and what should I open next?**

The current implementation repeats dark bordered rectangles, small uppercase labels, circular icons, and full-width buttons across most screens. Information density varies, but the visual rhythm changes very little. This makes the app feel like a collection of forms and data cards rather than a finished local utility service.

The recommended direction is **a calm, distinctive local utility dashboard**: deep ink surfaces, warm amber for power, cyan for water, large readable place names, compact incident summaries, and a clear distinction between service identity, incident severity, and evidence quality. Keep the existing typography and improve its application. Prioritize composition and interactions before decorative effects.

The overhaul must also correct several trust problems. Following a suburb does not guarantee alerts are enabled. Quiet hours currently skip notifications rather than queue them. A green map area can open an incident-level outage message because place-specific restoration information is lost. These are part of the UI brief, not optional cosmetic cleanup.

### Evidence and limitations

- Reviewed all eight main screen implementations, navigation layouts, shared UI, theme, state, API types, status helpers, geographic helpers, caching, and existing tests.
- Visually inspected `mobile/assets/images/icon.png`: it shows a blue Expo-style A on a pale construction-grid background, not the amber GridWatch pulse identity used inside the app.
- This is a **source-based UI/UX audit**, not a completed device usability study. The temporary Expo web server started, but the available browser tool reported that no browser was available. No rendered screen screenshots were obtained. The temporary server was stopped.
- Layout crowding, text wrapping, gesture behavior, native map rendering, and screen-reader behavior require device verification. Where relevant, the report describes them as risks rather than observed device failures.
- TypeScript check passed. All 9 mobile tests passed. Lint was attempted but could not complete: no ESLint configuration exists, and Expo's attempted automatic configuration failed with network `EACCES`.
- No application implementation was changed during this audit.

References use repository-relative paths and current source line anchors. Anchors may move during implementation.

## 2. What should remain

1. **Four destinations:** My area, Outages, Map, Following. They reflect distinct tasks and do not need a new navigation architecture.
2. **Separate power and water semantics.** `statusMeta()` already distinguishes water recovery from confirmed restoration. Preserve that distinction.
3. **Honest absence language.** “No outage reported” is useful; “Everything is working” would make a claim the data cannot support.
4. **Named versus possible impact.** The suburb detail separates explicitly named suburbs from equipment-based associations. Keep this distinction visible.
5. **Source timeline and original-post links.** These are core credibility features.
6. **Hanken Grotesk, JetBrains Mono, Ionicons, Expo Router, and MapLibre.** The current tools can support a much better result without wholesale replacement.
7. **Local preferences and saved-data fallback.** Improve their presentation and error handling rather than removing them.

## 3. Prioritized findings

Priority definitions: **P0** = misleading information that must be corrected before shipping the redesign; **P1** = core overhaul work; **P2** = polish after the primary flows work. Confidence is source-confirmed unless explicitly described as a device risk or design judgment.

| ID | Priority | Finding and evidence | Required outcome |
|---|---|---|---|
| U01 | P1 | Repeated low-contrast card treatments flatten hierarchy. `src/theme.ts`; `src/components/ui.tsx:176`; screen-local styles. | Introduce a small set of distinct surfaces: hero, normal panel, list row, and overlay. Use spacing and typography to group information; avoid enclosing every fact in a card. |
| U02 | P1 | Brand mismatch: launcher icon is a blue A; `Wordmark()` uses an amber pulse square. `assets/images/icon.png`; `src/components/ui.tsx:79`; `app.json`. | Apply one GridWatch mark to launcher, adaptive foreground/monochrome assets, splash, favicon, and in-app identity. Inspect the other image assets before replacing them. |
| U03 | P1 | Header duplication consumes attention: navigator titles plus large body titles/eyebrows on Following, Quiet hours, and Outages; My area adds a wordmark below the navigator. | Define one title hierarchy per screen. Main tabs use a compact branded/context header and one body title. Detail screens retain a useful back header. |
| U04 | P1 | Outages puts service selector, status chips, search, sort chips, and potentially many centre chips before results. `app/(tabs)/outages/index.tsx:12–22`, header JSX. | Keep service, search, and primary status selection visible. Move sort and centre to a filter sheet with active-filter count and reset. Measure first-result visibility on a small phone. |
| U05 | P1 | An incident row can contain place, title, municipality/equipment, suburb count, centre, schedule/ETA, post count, summary, status, age, and meter. `src/components/ui.tsx:114`. | Create a compact, predictable summary that foregrounds place, status, update age, and one useful supporting fact. Keep full detail on incident pages. |
| U06 | P0 | Suburb detail says “Alerts are on for this suburb” solely from membership in `following`. It does not use `alerts`. `app/suburb/[id].tsx:71`; `src/state/app.tsx:79`. | Treat saved/followed state and alert-registration state independently. Use “Following” for local membership; show alerts enabled/unavailable/checking separately. |
| U07 | P0 | Quiet hours promises notifications “wait until this window ends.” Backend skips recipients inside the window and records the event; it does not queue those messages for later. `app/(tabs)/following/quiet.tsx:29`; `api/src/modules/push/notify.service.js:70`; `events.js:39`. | Replace promise with “Notifications are paused during these hours. Missed notifications are not sent later.” Label Johannesburg time (UTC+2). Do not build a queue as part of a UI-only overhaul. |
| U08 | P0 | Map rendering respects `place.restored`, but GeoJSON does not preserve that boolean and `Selection` omits restoration/inference metadata. `selectionSentence()` then uses overall incident status. `src/lib/geo.js:4`; `src/components/MapCanvas.tsx:9,93`. | Carry place ID, restored flag, inferred flag, and update time into selection. Explain both place status and wider incident status when different. Show “Possible impact” for inferred areas. |
| U09 | P0 | Async race risks: Outages and Map loads lack request-identity guards; changing service/filters can let an older response overwrite newer results. Existing rows/map features remain while service changes. My area has a similar risk when changing suburb. | Key displayed data by request scope. Ignore/cancel obsolete results. Never show electricity incidents as the current water result, or an old suburb's status under a new suburb name. Reproduce with delayed responses. |
| U10 | P1 | Search renders “No matches” whenever there are no hits and 2+ characters, including during debounce/loading. Error note is not cleared on later successful searches. Picker modes still include incident hits. `app/(tabs)/outages/search.tsx:104`. | Implement idle/loading/success-empty/error states. In area/follow picker mode return/render suburbs only and use a task-specific title and placeholder. |
| U11 | P1 | Following fetches both services for every suburb in one outer `Promise.all` (up to 40 requests). One failure discards the whole new result; with no cache, rows can remain “Checking…” after loading stops. `app/(tabs)/following/index.tsx:20`. | Track per-suburb/per-service outcomes, show available successes, bound concurrency, and give failed rows a retry action. Do not add a backend batch endpoint unless separately justified. |
| U12 | P1 | Loading/failure handling is inconsistent: spinners, plain text, no retry on detail pages, no map loading indicator, no cache age in saved-status banners. Suburb detail still renders empty lists and follow UI while loading or after failure. | Add shared loading, empty, error, and stale patterns. Do not show “no incidents” or allow following a placeholder “Suburb” when data failed to load. |
| U13 | P1 | Map sheet has a decorative drag handle but no implemented drag gesture. No explicit dismiss control. Legend and error share `top:72`; fallback mentions a “development build.” `app/(tabs)/map/index.tsx:136`. | Use a real accessible sheet or a clearly static panel without a fake handle. Add Close, Retry, meaningful fallback copy, and non-overlapping map overlays. |
| U14 | P1 | Following gives every suburb a large Unfollow button, while navigation is attached only to the suburb's Text. `app/(tabs)/following/index.tsx`. | Make the primary row/card an accessible navigation target. Put removal in a compact labeled menu or edit mode, with undo feedback. |
| U15 | P1 | Incident detail emphasizes a generic status headline, tiny uppercase place, a universal three-step rail, and a four-tile fact grid before source updates. `app/outage/[id].tsx:37–76`. | Make the place and latest substantive update prominent. Give ETA/schedule appropriate emphasis. Replace the universal rail with status-appropriate presentation. |
| U16 | P0 | `progressStep()` treats CLOSED as restored; list filter “Restored” includes CLOSED. Planned/cancelled/stale incidents also receive the same Reported/Under way/Restored rail. `src/lib/status.js:83`; `app/(tabs)/outages/index.tsx:15`. | Keep “Closed” and “Restored” visually distinct unless the API contract explicitly guarantees equivalence. Label a combined filter “Finished,” or separate the states. Never infer repair milestones from a generic active status. |
| U17 | P1 | Faint text is too weak on some actual surfaces; small chips/text links have undersized targets. `src/theme.ts`; UI and detail screen styles. | Meet contrast and touch-target criteria below. Give Change, source links, header icons, chips, and dismiss buttons full touch wrappers and accessibility roles. |
| U18 | P1 | Quiet-hour steppers require repeated taps; screen is a non-scrollable View; buttons have no busy/disabled contract. `app/(tabs)/following/quiet.tsx`; `src/components/ui.tsx:158`. | Use accessible hour selection with an enable switch, clear summary, scroll-safe layout, and saved/busy/error states. Prevent duplicate submissions across all async buttons. |
| U19 | P2 | Responsive behavior is limited: paired status cards always remain side by side; no tablet width system despite `supportsTablet:true`; long button text uses `flexShrink:0`. | Collapse paired cards at narrow effective widths/large font scale; wrap labels; constrain tablet reading width. Verify safe-area and keyboard behavior on devices. |
| U20 | P1 | Alert capability is compressed into a boolean and one generic message. Backend message builder currently hardcodes power/City Power wording. `src/state/app.tsx:79`; `api/src/modules/push/events.js:25–35`. | Do not promise fully working power-and-water alerts based only on successful registration. Audit delivery service coverage separately; show only verified capabilities and distinguish denial, registration failure, and service unavailability where known. |

### Measured contrast

Calculated from the exact solid sRGB tokens in `src/theme.ts`:

| Text and background | Approximate ratio | Interpretation |
|---|---:|---|
| `faint #737B88` on `page #090B0E` | 4.61:1 | Passes the 4.5:1 normal-text threshold, narrowly. |
| `faint #737B88` on `card #10131A` | 4.35:1 | Below 4.5:1. |
| `faint #737B88` on `cardRaised #171C25` | 4.00:1 | Below 4.5:1. |

This is specifically a text contrast finding, not a claim that every border must meet the text threshold. Recheck status-tinted backgrounds and selected controls after implementation. The reference threshold is [WCAG contrast minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

## 4. Proposed visual system

### Personality and composition

The app should feel local, reliable, and immediately legible. Make the saved suburb and service condition the memorable visual elements. Introduce a restrained GridWatch pulse/grid motif on onboarding and branding, not behind incident text or as a fake live visualization.

Use one expressive element per screen: a strong suburb header, differentiated service status panels, a well-composed incident hero, or the map itself. Let lists be quieter. Do not spread large gradients, shadows, glass effects, and glowing borders across every component.

### Design tokens

These are proposed starting values, not verified final colors. Test every final foreground/background combination.

| Role | Proposed value / rule |
|---|---|
| Canvas | `#0B1016` |
| Normal surface | `#141D28` |
| Elevated surface | `#1D2A38` |
| Primary text | `#F5F3ED` |
| Secondary text | `#B6C0CD` |
| Tertiary text | `#97A4B5`; reserve for metadata, not critical status |
| Power identity | `#F4BE58` |
| Water identity | `#6DD5F2` |
| Active disruption | `#FF7969` |
| Partial/recovering | `#F3BE63` |
| Explicitly restored | `#62D5AD` |
| Planned | `#A1BFFF` |
| Unknown/stale/no report | neutral `#A7B2C2`, with distinct words/icons |
| Borders | subtle decorative separator token; stronger control-boundary token where needed |
| Spacing | 4, 8, 12, 16, 20, 24, 32, 40 logical units |
| Corners | 12 controls, 16 list cards, 20 panels, 24 hero/sheets, 999 pills |
| Screen padding | 20 standard; 16 on narrow screens; 24+ on tablets |
| Reading width | approximately 640 logical units for single-column tablet content; map can fill available space |

Keep semantic naming separate: `service.power` and `status.partial` may be visually related but must not be the same conceptual token. Selected Water controls use water identity; an active water outage remains red/orange according to its status. Green is reserved for explicitly restored data, never successful API fetches or absence of notices.

### Typography

| Use | Family / size / line height |
|---|---|
| Place/primary screen title | Hanken bold, 30–34 / 36–40 |
| Hero condition | Hanken bold, 24–28 / 30–34 |
| Section title | Hanken semibold or bold, 20 / 26 |
| Incident title | Hanken semibold, 17–18 / 23–24 |
| Body | Hanken medium, 16 / 23–24 |
| Supporting content | Hanken medium, 14 / 20 |
| Metadata / badges | Hanken semibold, 12–13 / 17–18 |
| Short numeric/time display | JetBrains Mono, 12–14; use sparingly |

Avoid uppercase for long place names and explanatory text. Use sentence case. Let long titles wrap naturally. Essential status labels must remain readable at large font settings; do not shrink type to force a two-column layout.

### Component inventory

Create reusable components outside the route tree, with clear responsibilities:

- `ScreenHeader`: title, optional context, one trailing action; no repeated title below it.
- `LocationSelector`: place name, location icon, change affordance; entire control tappable.
- `ServiceSegment`: existing Power/Water behavior with selected semantics and generous target size.
- `ServiceStatusCard`: service icon/name, status, one explanatory line, freshness/evidence as appropriate; explicit loading/unavailable state.
- `IncidentCard`: compact and featured variants sharing content semantics.
- `StatusBadge`: word + icon + tone. A colored dot alone is insufficient.
- `FreshnessLabel`: source update time, with separate cached-at information when relevant.
- `NoticeBanner`: info/warning/error/offline variants and optional action.
- `Button` and `IconButton`: primary/secondary/quiet/destructive variants; disabled, busy, pressed, accessible label, multiline support.
- `StateView` and structural skeletons: loading, no reports, no results, offline, unavailable, not found.
- `FilterSheet`, `MapSelectionPanel`, `FollowingRow`, `NotificationStatus`, and `TimelineEvent`.

Do not create a generic abstraction for every View. Start with components that occur repeatedly or own a meaningful interaction/state contract.

## 5. Screen-by-screen specification

### A. My area — first use

**Current:** Good initial question, but the privacy explanation/card competes with selection. “Use my suburb” does not clearly describe a location-permission action. There is little distinctive product identity.

**Proposed order:**

1. Compact GridWatch identity.
2. Headline: “Power and water updates for your suburb.”
3. Short support copy: “See reported interruptions and the latest updates.”
4. Small custom pulse/location graphic, or an elegant icon composition. Decorative; no fake incident statistics.
5. Primary: **Choose my suburb**. Opens suburb-only picker.
6. Secondary: **Use my location**. Requests permission only when tapped.
7. One concise privacy explanation: “We use your location once to suggest a suburb.” Avoid absolute “stays on this phone” claims without checking the platform geocoding implementation.

When location finds a candidate, let the user confirm the suggested suburb before saving it. The existing nearest-suburb heuristic uses a loose coordinate-distance bound; it is not evidence of an exact address match. Keep manual selection available after denial, error, or uncertain match.

**Acceptance:** Both selection actions visible on a small phone at normal text size; busy location action cannot be invoked repeatedly; denial ends in a usable manual path.

### B. My area — saved suburb

**Proposed order:**

1. Compact app identity/context.
2. Large suburb name in a location selector.
3. Freshness line describing feed time precisely; cached age displayed separately when offline.
4. Power and Water status cards; side by side only when both fit comfortably.
5. “Latest incidents” with total relevant count.
6. Most relevant incident card, followed by remaining current incidents.
7. Quiet supporting explanation of what a notice does and does not confirm.

Service cards show a service glyph, status words, and concise explanation. They should open the corresponding section of suburb detail or a filtered list with reliable parameters. Do not make them appear tappable until that destination works.

Use pull-to-refresh plus a small accessible refresh action. Remove the permanent large Refresh button as the main visual endpoint. If one service fails, retain the successful service and label the other unavailable. A `/sync` failure must not throw away both successful status requests.

For zero reports, show “No current notices name this suburb” with neutral styling. For planned-only data, display planned interruption clearly rather than suggesting an outage is happening now. Never infer “all clear” from an empty response.

### C. Outages

**Proposed order:** Single title → service segment → search field plus Filters button → compact status row → result count → incident list.

Primary statuses can be Active, Planned, Finished, More; More contains No recent update and All. Preserve access to every existing status. If “Finished” includes CLOSED/CANCELLED, make that explicit and keep individual row labels accurate. Counts from `api.stats()` are service-wide; do not present them as filtered search counts.

Filter sheet contains sort, electricity service centre, reset, and Apply. Draft sheet edits become active together on Apply. Show a small active-filter count. Clear electricity-only filters on water selection. The search icon in the navigator currently opens a second search experience; remove the duplication or label its distinct purpose clearly.

**Incident-card content order:**

1. Service icon when needed, place/title, compact status badge.
2. One latest-summary sentence, maximum two lines in standard size.
3. One supporting fact: schedule for planned work, ETA when supplied, otherwise affected-suburb count.
4. “Updated …” and navigation affordance.

Use a slim status accent or tinted badge, not a solid red card. A restoration meter appears only when the API supplies a valid percentage and its meaning is clear; label it as reported restoration, not time remaining. Do not synthesize percentages.

**Acceptance:** At normal font size on a representative 360×800 logical-unit viewport, aim to show the first complete compact incident before scrolling. Preserve readable reflow at larger text sizes rather than forcing this target. Keep pagination, filters, and list position functional.

### D. Search and suburb selection

Give modes explicit titles: **Choose my suburb**, **Add a suburb**, or **Search GridWatch**. Area/follow modes show suburb results only, with municipality for disambiguation. General search separates Suburbs and Incidents with headings; include service context.

Model idle (under two characters), debouncing/searching, results, successful no results, and failed request separately. Clear previous error notes when a new search starts. Results must correspond to the current query. Add clear-search control and keyboard behavior that keeps results and selection reachable.

Copy examples: “Enter at least 2 characters”; “No suburbs found for ‘…’”; “Search is unavailable. Try again.” Do not use implementation prose such as “Incidents open on top of this tab.”

Following from search must confirm the save on the destination screen. Alert failure must not be lost because the picker navigates away immediately.

### E. Incident detail

**Proposed order:**

1. Back header with service context.
2. Large meaningful place or incident title, status badge, and scope such as “and 4 other suburbs” when valid.
3. Latest update summary and when it was posted.
4. ETA or planned schedule panel. If no ETA, say “No restoration estimate reported.” Do not show a made-up countdown.
5. Compact started/updated information, then affected suburbs.
6. Update timeline, newest first with explicit dates available.
7. Cause and equipment as secondary sections, collapsible when long.

Treat planned/cancelled/stale/closed states on their own terms. Planned work needs date/time, cancellation needs a cancellation message, and stale needs an uncertainty message. A generic active outage does not prove technicians are on site or repairs are underway. Remove the three-step rail unless every displayed milestone is backed by data.

Preserve original-post links. Label a summary as a summary when appropriate; provider/source names must come from trustworthy data, not a universal City Power label applied to water. Source identity is not fully represented in current mobile timeline types, so avoid inventing accounts.

Add Retry for failure and a clear route back to Outages for missing incidents. Consider native Share as P2, only after determining a valid canonical/deep link; do not share the development LAN API address.

### F. Suburb detail

Show suburb name once, municipality, and compact Follow/Following control. Lead with power and water status and reported incidents. Put notification capability in a distinct status row, rather than making it the page's main hero.

Clearly separate **Reported for this suburb** and **Possible nearby impact**. Use neutral/dashed or otherwise differentiated treatment for inferred associations, with the existing explanation about equipment links. Do not count possible incidents as confirmed local outages.

Loading and failure are separate screens/sections; hide empty-success messages and disable follow actions until the actual suburb identity is loaded. Handle the 20-suburb limit with an actionable message leading to Following.

### G. Following and notification settings

Use one header with count and Add action. Place a compact alert-status panel beneath it, then the followed suburbs. Show both services in each row using concise readable labels. Let the main row open suburb detail. Place Unfollow in an overflow menu or edit mode; provide undo where feasible.

Show each service as loaded/stale/unavailable rather than leaving “Checking…” indefinitely. Keep successful suburbs usable when another request fails. Persist known statuses without implying they are fresh.

Distinguish these concepts: saved on this phone, notification permission, registration/subscription synchronization, and server alert availability. Extend the current state contract where needed; do not derive all these from one boolean. Successful registration is not evidence that a push was delivered.

Move Quiet hours into a settings row. In the empty state, emphasize Add a suburb, not a warning and two equally prominent settings buttons. Do not introduce an inbox tab: the current API does not provide an alert-history inbox.

### H. Quiet hours

Use an enable switch, From and Until hour fields, short explanatory copy, timezone, and a readable summary such as “22:00–06:00, Johannesburg time.” Keep hour precision; the existing API stores integer hours, so do not present minute precision that cannot be saved.

Use a native/accessibly implemented hour selector after checking SDK-compatible options. Keep a scroll-safe fallback. Define equal start/end clearly: backend currently treats equal hours as no quiet window; prevent ambiguous enabled settings or explicitly normalize them to off.

Primary action: Save changes, with busy/disabled state. After saving, distinguish “Saved on this phone” from “Alert settings synchronized.” Current `setQuiet()` updates local preference even if remote registration fails; the success message must reflect that.

### I. Map

Let the map own the screen, with a compact service selector and useful controls. Add “Show my area” when a saved suburb can be resolved, and “Show all”/fit results. Do not request precise location automatically to support map browsing.

Position legend, loading/error banner, and selection panel so they do not overlap. Preserve map attribution. The legend must explain every displayed semantic category, including restored and inferred when present. Low opacity alone is not sufficient explanation of possible impact.

Selected place panel: place name → place-specific status → wider incident context → freshness → evidence label → View incident. Include Close. If multiple incidents affect the same location, provide a way to choose among them rather than always selecting the first feature silently.

Use a real sheet only if gestures, scrolling, dismissal, focus, and Android back are implemented. Otherwise ship a polished static panel without a drag handle. Web/native-map failure should say “Map unavailable. Browse affected areas below,” with Retry where useful. A consumer error message should not instruct someone to obtain a development build.

## 6. Shared interaction and accessibility requirements

- Design all interactive wrappers for at least **48×48 logical units** as the product target, including small icon controls. This is a chosen mobile usability target, not a claim that WCAG mandates 48. WCAG's web minimum uses 24 CSS pixels with exceptions; see [target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- Normal text contrast at least 4.5:1; large text at least 3:1. Test actual composited status tints. Critical controls must remain distinguishable against adjacent surfaces.
- Status uses words and icons in addition to color. Selection uses an explicit selected state and visible treatment.
- Give pressable text proper roles/labels, concise contextual accessibility names, and sufficient targets. Avoid duplicate announcements of decorative icons.
- VoiceOver/TalkBack reading order should follow place → service/status → freshness → next action. Sheets require accessible close and sensible focus restoration.
- Support large text without clipped pill labels, off-screen Save actions, or horizontal scrolling through core content. Test 100%, 150%, and 200% text scaling where supported.
- Respect reduced motion. Use brief state transitions, approximately 120–180 ms for press feedback and 180–250 ms for surface changes. No perpetual pulsing “live” dot: this app does not establish a continuous real-time feed.
- Existing Reanimated/Gesture Handler can support motion; new animation dependencies are unnecessary. Haptics are optional P2 and need SDK-compatible installation if added.
- Refresh maintains visible data and distinguishes stale from loading. Full-page spinners are reserved for cases without usable content; structural placeholders should match the final layout.
- Provide explicit retry actions. Clear obsolete errors after success. Ensure relative timestamps update when the app resumes instead of remaining frozen until unrelated state changes.

## 7. State and data contracts

Model screen state explicitly rather than inferring it from empty arrays:

| State | Presentation |
|---|---|
| Initial loading | Structural placeholder; no “no reports” claims. |
| Successful content | Normal data and source freshness. |
| Successful empty | Correct contextual message: no reports versus no filter matches. |
| Refreshing with existing data | Retain correct-scope data and show a small refresh indicator. |
| Offline with cache | Cached content plus visible saved time and retry. |
| Failed without cache | Unavailable message and retry; no healthy/empty-success status. |
| Partial success | Available service/suburb remains usable; failed unit has its own state. |
| Service/suburb/query change | Skeleton or correctly keyed cache; never label previous-scope content as new data. |
| Permission denied | Explain the unavailable feature and offer an alternative/action. |
| Notification sync failed | Preserve the followed suburb; show that alerts are not confirmed enabled. |

Keep API source-update time distinct from local cache `savedAt`. Do not use a fresh network fetch time to imply that an old provider notice is fresh. “Live” should mean active incidents in this product, not a guarantee of real-time telemetry.

## 8. File-level implementation plan

| Phase | Files / components | Work and completion gate |
|---|---|---|
| 1: Trust and data states | `src/state/app.tsx`, `src/lib/status.js`, `src/lib/geo.js`, affected screens | Fix U06–U09, U16; guard request races; correct quiet-hour copy; represent notification status honestly. Add behavioral regressions. |
| 2: Foundation | `src/theme.ts`, `src/components/ui.tsx`, new component files, `src/navigation.ts`, layouts | Introduce semantic tokens, buttons, headers, badges, state views. Establish one title hierarchy; preserve routes and safe areas. |
| 3: Primary flows | `app/(tabs)/index.tsx`, `outages/index.tsx`, `outages/search.tsx`, `app/outage/[id].tsx` | Redesign home, list, picker, and incident detail; add filtering sheet and compact rows; verify their complete journeys. |
| 4: Saved places | `app/suburb/[id].tsx`, `following/index.tsx`, `following/quiet.tsx` | Redesign following, per-service failures, alert status, and hour selection. Verify local/remote save feedback and limits. |
| 5: Geography | `app/(tabs)/map/index.tsx`, `src/components/MapCanvas.tsx`, `src/lib/geo.js` | Fix place-level semantics, map states, selection panel, controls, and accessible fallback; test on a native development build. |
| 6: Brand and verification | `assets/images/*`, `app.json`, `app/+not-found.tsx`, tests/tooling as needed | Replace mismatched branding, finish empty/not-found states, audit contrast/text scaling, capture screenshots, and clean up temporary servers. |

The actual route root is **`mobile/app/`**, although `mobile/AGENTS.md` generically describes `src/app/`. Preserve the existing working route root; do not relocate routes as incidental cleanup.

Installed stack: Expo `~57.0.25`, React Native `0.86.3`, React `19.2.3`. Check [Expo SDK 57 documentation](https://docs.expo.dev/versions/v57.0.0/) before touching version-sensitive APIs. Use the repository's npm workflow and `npx expo install` for compatible additions. Do not downgrade or switch router implementations based on older examples.

No backend schema changes are required for the main visual overhaul. Richer notification delivery capabilities, queued quiet-hour notifications, and service-aware backend messages are separate backend work if requested. The UI must accurately reflect existing capabilities meanwhile.

## 9. Verification and definition of done

### Required fixtures and journeys

Use deterministic test fixtures or local test data, never fake successful production responses:

1. First launch; manual suburb selection; location denial; location suggestion confirmation.
2. Saved suburb with active power outage and no reported water interruption.
3. Water LOW_PRESSURE, RECOVERING, BYPASS, STABLE, and NORMAL remain unconfirmed/partial, not green restoration.
4. Planned incident with schedule; incident with no ETA; restored, closed, cancelled, stale, and unknown status.
5. Named versus inferred suburb; restored locality within a still-active wider incident; multiple incidents at one map location.
6. Offline with cached data; offline without cache; one service fails; one of 20 followed suburbs fails.
7. Rapid service/filter/query changes with deliberately reordered responses; only current-scope results render.
8. Search idle/loading/no results/error/success; error clears after successful retry; picker excludes incidents.
9. Follow success with push denied, unavailable server, and registration failure; 20-item limit; unfollow and feedback.
10. Quiet hours off, overnight window, equal hours, local save plus remote failure, and explicit UTC+2 label.
11. Notification deep link into incident, ordinary back navigation, tab state restoration, unavailable map, and missing incident.
12. Long suburb names, long status labels, long ETA strings, 30+ incident rows, and a long source timeline.

### Device and presentation review

- Inspect narrow Android, typical Android, and iPhone layouts; include a small viewport such as 360×800 and a representative iPhone size such as 390×844 logical units. These are test targets, not previously observed screenshots.
- Inspect at least one tablet because the app declares tablet support.
- Verify native map interactions in a development build. The web fallback cannot prove native map correctness.
- Test normal/large font settings, keyboard visible, safe-area bottom inset, VoiceOver/TalkBack, reduced motion, and Android back/dismissal.
- Capture before/after images for every main screen plus loading, empty, offline, and failure examples. Label fixture data clearly.
- Check measured contrast, touch wrappers, consistent spacing, and actual first-result visibility.
- Retain service semantics, named/inferred distinctions, pagination, source links, local preferences, and existing route behavior.

### Engineering checks

Run mobile typecheck, lint, and tests. Configure lint deliberately if still absent, then report its result; do not describe a failed setup attempt as a passing lint check. Extend tests for new state/behavior rather than superficial style snapshots. In particular add regressions for map restoration metadata, obsolete-request handling, search loading versus empty, notification-copy truthfulness, and status-appropriate incident presentation.

Audit baseline: `tsc --noEmit` passed; `npm test` passed 9/9; `expo lint` blocked by missing configuration and setup network failure. Existing tests primarily protect pure status/geography helpers and do not establish UI accessibility or native rendering quality.

Do not leave the API, Expo, web preview, or another project process running in a background terminal when finished. Stop only processes started for this work.

## 10. Release boundary

The first implementation should deliver the full visual system across all existing screens, correct misleading state/copy, and complete the main phone journeys. It should not expand into authentication, a social feed, crowd reporting, predicted ETAs, load-shedding schedules, paid map migration, or a notification inbox without a separate product decision.

The visual result is successful when a person can identify their suburb, each service's reported condition, the age and certainty of the information, and the next useful action immediately—and the screens feel intentionally composed rather than uniformly boxed.
