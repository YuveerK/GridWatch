# GridWatch mobile corrective pass

Read `docs/MOBILE_UI_REVIEW_2026-09-28.md` and the original `docs/MOBILE_UI_AUDIT_2026-09-27.md`. Implement the follow-up review's corrections and enhancements in the existing mobile app. Preserve the useful new palette, branding direction, quieter incident cards, filter sheet, truthful quiet-hour copy, and map restoration metadata.

This is a corrective/finishing pass, not another rewrite. Read `mobile/AGENTS.md`, keep routes in the existing `mobile/app/`, preserve the four tabs, and use Expo SDK 57 documentation and the installed MapLibre API types. The working tree includes unrelated API/client changes: do not discard, overwrite, or casually incorporate those into this task.

Start with the reproduced defects:

1. **R01:** Home converts a failed service into an empty cached array, which later displays “No interruption reported.” Store successful service results independently with explicit state and timestamps; retain prior good data on failure; version/migrate cache conservatively.
2. **R02:** Following's allSettled path resolves on network failure and overwrites its cache with error rows, so the catch-only offline fallback never runs. Merge per-unit results with last-known good cache, render progressively, and retry failed units.
3. **R03:** Old query rows remain visible and pageable. Switching service while pressing Show more can mix services and drop the new first page. Bind data to a complete query key, separate reset/refresh/page loading, prevent obsolete/duplicate appends, and refresh counts appropriately.

The audit reproduction script is `docs/audits/mobile-review-repros-2026-09-28.mjs`. It extracts current callback bodies and intentionally asserts the buggy outcomes; it is diagnostic evidence, not the desired permanent tests. Add normal regression tests asserting correct behavior after the fixes.

Then complete R04–R12 from the review:

- Reinstate ID/request cleanup guards in detail pages.
- Move the map legend into the canvas coordinate space; use a compact layer control and a normal-flow fallback list.
- Implement camera commands with installed camera refs, including repeatable Show all and Show my area. Show all fits visible results.
- Align available map layers with the actual API; deduplicate polygon/point selection by incident/place; distinguish no results from hidden layers.
- Hide stale picker results, add retry and follow busy states, and restore an accessible general suburb-browsing entry point.
- Serialize/coalesce latest notification preferences, expose pending/offline synchronization, handle exceptions with finally, and add recovery actions. Handle service-aware notification support honestly instead of making a permanent backend-defect disclaimer the product experience.
- Make sheets safe-area-aware, scrollable at large text, visibly closable, and accessible; constrain long horizontal labels.
- Let Suburb detail show successful services independently when another fails.

Apply enhancements E01–E08: make Home a distinctive compact status overview; promote ETA/schedule above equipment; shorten persistent list explanations; consolidate repeated state/freshness components; improve quiet-hour selection and unsaved feedback; balance Following around saved places; unify the exact pulse mark.

Do not fabricate production data, ETAs, repair milestones, supported push capabilities, or native verification. Do not expand into new tabs, authentication, charts, or a backend notification queue. If service-aware push requires backend changes, isolate and justify them explicitly.

Run TypeScript, lint, and tests. All three passed at review time, with 13 helper tests, despite the reproduced defects. Add meaningful coverage for cache failure, query/pagination changes, stale detail responses, and preference synchronization. Follow the acceptance matrix in the review and capture real phone/tablet screenshots where a renderer/device is available. Report visual/native areas that remain unverified.

Finish with R01–R12 and E01–E08 addressed/deferred status, test results, device evidence, remaining limitations, and confirmation that any temporary project processes started for the work have been stopped. Do not leave projects running in background terminals.
