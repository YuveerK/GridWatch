# Guided review rollout: 5 October 2026

The local Windows workspace is ready. Double-click [Start-GridWatch.cmd](../../Start-GridWatch.cmd), then open **http://localhost:4000/review**. The built client and API share one foreground window; Ctrl+C stops the app. Automatic fetching is paused in this launcher. Use **Fetch latest posts** when you choose to ingest new utility posts.

## Completed rollout

- Stopped the existing API watch process after checking no pipeline lease was active.
- Created and verified a PostgreSQL custom-format backup before migration.
- Regenerated the normal Prisma client successfully and applied `zz3_guided_review` to the existing `grid-watch` database.
- Fixed the bounded backfill to include diagnostics that had not entered the old queue. Preserved legacy decisions only where original evidence and processing still support them; retained previous notes in the action journal when a concern needed rechecking.
- Imported 65 current review flags and carried forward 22 evidence-verified historical acknowledgements. The queue merges signals concerning the same subject.
- Compared all 3,627 stored posts with current diagnostic findings: **zero missing and zero unindexed findings**.
- Recorded a new stored-evidence quality check covering all posts and 5,078 fault dispositions. Every expected fault has an accepted disposition. The check made **zero provider calls and zero incident writes**, retained ingestion timestamps and explicitly reports unresolved concerns.
- Enabled `REVIEW_CORRECTIONS_ENABLED=on`, `SERVE_WEB_CLIENT=on` and `HOST=127.0.0.1` in this machine's ignored `api/.env`. Retained its existing local operator access, AI budgets and self-correction shadow setting.
- Added optional built-client hosting without changing other deployments' default API behavior. A single foreground launcher replaces the need to run separate API and UI terminals for ordinary use.

## Current inbox

- 65 cases need an operator decision.
- 0 cases are waiting automatically.
- 1 case needs engineering: Cydna (Houghton Estate, Norwood) has a partial-restoration status that conflicts with its stored named-area state. Its case includes nine original utility posts, available image evidence, accepted fault sections, incident timeline and a complete investigation brief. It was triaged for investigation; no incident state was patched.
- 26 cases are visible in history, including carried-forward decisions and resolved operational incidents.

The stored database passes **81/81 correction labels**, **17/17 final-state labels** and **3/3 Water regression cases**. This includes existing human overrides and must not be described as unassisted engine accuracy. The independent audit still reports the Cydna inconsistency and 1,794 older model/instruction stamps. Those warnings were retained; no bulk AI rereading was performed.

## Validation and preservation

- 575 API unit tests passed.
- Full integration suite: 311 tests passed. Follow-up whole-incident handoff and guided-review acceptance suite: 35 tests passed.
- 25 client tests passed, and the production build passed (existing chunk-size warning only).
- Real browser verification passed against the local stored data at desktop and narrow widths, including exact queue counts, local operator access, enabled controls, original evidence, whole-incident engineering evidence, deep links and provider-free preview.
- Browser verification made no action writes or checkpoint changes. Fixture browser coverage also checks errors, expired sessions, keyboard navigation, unavailable images and correction preview/apply.
- Logical rows were compared against the pre-migration archive. Source posts, outages, timeline contributions, outage equipment/areas, human link overrides and notification events are unchanged.
- The latest-post checkpoint SHA256 remains `82ec04d82da62652aa39eacef27023ee19cc8f51c36e02591e07712c59400284`.
- Temporary browser/server/test processes were closed and disposable test databases removed. No project process is left running. Existing database services were retained.

## Backup

Backup location: `C:\dev_zone\GridWatch\api\data\backups\guided-review-rollout-2026-10-05T00-38-07-976Z\database.dump`.

Archive size: 7033925 bytes. It includes an archive contents listing, baseline counts and the pre-rollout API configuration in the same ignored backup folder. Do not restore the old archive over newer human corrections without first saving those newer records.

See [the operator and deployment guide](../GUIDED_REVIEW.md) for normal review actions, guarded undo, engineering handoff and rollout on another deployment.
