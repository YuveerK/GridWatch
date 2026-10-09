# Guided review implementation verification

The operator workflow is implemented at `/review` and `/review/:caseId`, including guided association and reading corrections. Correction writes default to disabled pending the deployed-data coverage comparison in [the rollout guide](../GUIDED_REVIEW.md).

## Verification

- API unit suite: 46 files, 575 tests passed.
- Full API integration suite: 20 files, 306 tests passed on a disposable PostgreSQL database.
- Follow-up integration checks after the final media safeguard and public count change: guided review and public API suites, 60 tests passed. Final guided review rerun after enriching preview evidence: 31 tests passed.
- Client tests: 25 passed. Production build passed; the existing chunk-size warning remains.
- Real Edge browser checks passed against fixture APIs at desktop and narrow widths: all-service inbox, source health, candidate selection, source images unavailable, correction preview/apply, readable forms, keyboard navigation, errors/loading and expired sessions.
- Browser screenshots are in the ignored `client/test-artifacts/` folder; the browser harness always closes its temporary fixture server and isolated browser.
- `git diff --check` passed.

Acceptance cases exercise merged signals, blocked records without flags, service isolation, exact totals, source health and freshness, read-only browsing/previews, evidence-version acknowledgements, duplicate submissions, stale and busy requests, validation rollback, interrupted recovery, guarded undo and undo rejection journaling. They also cover stable segmentation and chronological rebuilds, preserving siblings, two faults from one post in one incident, missing/cyclic anchors, Water customer-restoration safeguards, staged rereads, operator protection and no historical notification replay.

## Cached chronological replay

The unassisted provider-free replay processed 3,627 cached utility posts in a disposable database and dropped it afterward. It completed but did not satisfy all golden labels:

- Accepted reading coverage: 3,352/3,352 eligible posts (100%).
- Fault disposition coverage: 4,053/4,803 (84.4%).
- Correction association labels: 43/81.
- Final-state labels: 14/17.

This benchmark excludes saved human decisions and paid ambiguity resolution. Existing baseline reports also contain unresolved correction labels. Its failures remain engine investigation work; passing repair tests does not establish that automatic historical matching is correct. The review inbox must continue to expose those unresolved faults.

## Deployment boundary

No live database migration, live outage repair, deployment or latest-post checkpoint update was performed. The migration chain was validated on disposable test databases. Existing uncommitted engine/self-correction work was retained. An existing Windows process locked the default Prisma engine DLL during generation; the isolated Prisma client generated successfully, and the updated schema worked in the database suites. During rollout, stop the API, regenerate its client, apply migrations, backfill and compare deployed queue coverage before enabling correction writes.

Temporary verification processes and disposable databases were closed or removed. Existing user processes were left alone.

## Subsequent local rollout

The user subsequently authorized rollout. See [the rollout record](guided-review-rollout-2026-10-05.md) for the applied migration, backup, case import, enabled controls and live-data browser verification. The deployment boundary above describes the earlier implementation stage.
