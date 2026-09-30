# GridWatch mobile overhaul — implementation handoff

Paste this prompt into Grok 4.7 High Fast with repository access and attach/read `docs/MOBILE_UI_AUDIT_2026-09-27.md`.

---

Implement the GridWatch mobile UI overhaul specified in `docs/MOBILE_UI_AUDIT_2026-09-27.md`. Treat the report as the design and acceptance brief. Produce a working React Native application, not only a concept, plan, or renamed color palette.

Read `mobile/AGENTS.md` and the relevant source before editing. The app is under `mobile/`; its actual Expo Router route root is `mobile/app/`. Keep that route root and the four existing tabs: My area, Outages, Map, Following. The repository uses npm and Expo SDK 57. Read the matching official Expo docs before changing Expo/React Native APIs. Preserve the current stack unless a specific requirement justifies an SDK-compatible dependency.

The audit was source-based: rendered device screenshots were unavailable. Confirm layout and interaction findings in a runnable environment, and capture real before/after screens. Do not claim device, map, push, or accessibility validation unless you actually performed it. Never leave projects running in background terminals when finished.

Design direction: a polished local utility dashboard with deep ink surfaces, warm amber power identity, cyan water identity, expressive place names, readable status, and compact incident summaries. Keep Hanken Grotesk and restrained JetBrains Mono. Establish a coherent GridWatch mark across launcher/splash/in-app surfaces; the existing launcher icon is a mismatched blue A. Use clear hierarchy and distinct screen compositions. Avoid making every element a rounded bordered card. Keep decorative motion and gradients restrained.

Implement in this order:

1. Correct trust and state issues: following is separate from alerts being enabled; quiet hours skip notifications rather than queue them; map selection must preserve restored/inferred place context; stale asynchronous responses must not overwrite the current service/suburb/query; Closed must not silently mean confirmed Restored.
2. Build semantic design tokens and shared buttons, headers, service/status components, freshness labels, notice banners, loading/empty/error states, and compact incident cards. Buttons need disabled/busy feedback and accessible targets.
3. Redesign first-use and saved My area, Outages and its filter sheet, suburb picker/general search, and Incident detail using the screen specifications in the audit.
4. Redesign Suburb detail, Following, alert status, and Quiet hours. Handle partial data failures, the 20-suburb limit, local save versus remote sync, and Johannesburg timezone accurately.
5. Refine Map with meaningful loading/error/fallback states, place-specific selection context, usable map controls, non-overlapping overlays, and either a real accessible sheet or an honest static selection panel.
6. Finish branding, not-found states, responsive/tablet behavior, large text, reduced motion, screen-reader behavior, and verification.

Specific requirements:

- Make suburb, service condition, evidence/freshness, and next action immediately apparent.
- Replace the Outages stack of search/status/sort/centre controls with a compact hierarchy and a filter sheet; preserve all filtering and pagination capabilities.
- Use task-specific suburb-only pickers for `pick=area` and `pick=follow`. Distinguish search waiting/loading/empty/error/success; clear stale error messages.
- Show independent Power/Water outcomes. A failed water request or feed-time request must not discard successfully fetched power information.
- Give failed detail screens Retry and a useful back path. Do not display an empty-success message while data is loading or unavailable.
- Place latest source information and ETA/schedule before secondary equipment detail. Do not create unsupported repair milestones or infer an ETA.
- Replace prominent repeated Unfollow buttons with a suitable secondary action; keep row navigation obvious and accessible.
- Preserve existing status semantics: no reported outage is not confirmed supply; water recovery/low pressure/bypass/normal-unconfirmed must not become green/restored. Keep named versus possible impact distinct.
- Carry place restoration and inferred metadata into the map selection model. Distinguish a restored suburb from a wider active incident.
- Do not imply both services have verified push delivery: the backend notification message builder currently uses power/City Power copy. Represent verified capability honestly; flag backend delivery changes separately.
- Keep whole-hour quiet settings compatible with the existing API. Explain that notifications suppressed during the window are not sent later; handle equal start/end consistently with backend behavior.
- Aim for 48×48 logical-unit interactive wrappers, readable text contrast, and reflow at large text sizes. Preserve safe areas and map attribution.
- Use existing API fields. Mock/fixture data is only for tests or explicitly labeled previews, never a successful production fallback.
- Keep backend scope limited to what is necessary and explicitly justified. Do not implement new notification queues, authentication, community reporting, prediction features, or extra tabs as incidental work.

The report includes exact file targets, findings U01–U20, design tokens, per-screen content order, state contracts, and a verification matrix. Follow those details and use judgment for minor layout choices. Do not stop after redesigning only the home screen.

Run typecheck, lint, and tests. Baseline was typecheck pass and 9/9 tests pass; lint setup was absent and could not complete in the audit environment. Configure and validate lint if needed. Add focused behavioral regression coverage for changed state logic and map semantics. Verify native map and notification behavior on supported native builds when available, and clearly report any unverified areas.

Finish with:

- A concise account of the implemented changes and files.
- A checklist mapping U01–U20 to addressed/deferred status with reasons.
- Test/lint/typecheck results and actual device verification performed.
- Before/after screenshots or their repository paths, with fixture states labeled.
- Remaining limitations or backend follow-ups, without claiming unsupported features work.
- Confirmation that temporary project processes started for this task have been stopped.

---
