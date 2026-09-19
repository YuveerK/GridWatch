# Audit regression map

The 25 characterization tests from `api/audit/` asserted the *defective* behaviour found by the API audit. They were
replaced by tests that assert the *desired* behaviour, most of them against a real (throw-away) PostgreSQL database.

| Original characterization test | Desired-behaviour test |
|---|---|
| A01 admin processing runs without the token | `integration/api.test.js` › A01 (all admin/refresh routes 401 without credentials; token, session, origin, CORS) |
| A02 partial ingestion advances since_id | `integration/ingestion.test.js` › A02 (mark stays, cursor resumes, token-expiry fallback, incomplete status) |
| A03 concurrent acquirers both pass | `integration/ingestion.test.js` › A03 "two simultaneous runs"; `integration/lease.test.js` |
| A03 setup errors never release the lease | `integration/ingestion.test.js` › "releases the lease even when setup fails" |
| A04 outage commits before decision write fails | `integration/linking.test.js` › A04 "a failure while writing the decision undoes the outage…" |
| A05 later fault rejection / retry skips faults | `integration/linking.test.js` › A05 "fault 0 succeeds, fault 1 fails…" |
| A05 review faults collapsed to NEW / RELEVANT | `integration/linking.test.js` › A05 "a fault that needs review keeps the post flagged" |
| A06 reprocess leaves old links | `integration/linking.test.js` › A06 (idempotent reprocess, moved fault, removed restoration) |
| A07 older post moves lastUpdateAt back | `integration/linking.test.js` › A07/A08 "a late older post…", "a post from before an outage opened…" |
| A08 (three cases) | `integration/linking.test.js` › A07/A08 "full restoration clears an earlier 48%…", "a restoration with no outage opens a RESTORED outage…" |
| A09 planned closure ignores schedule | `integration/linking.test.js` › A09; `unit/schedule.test.js` |
| A10 failures omitted from counts / cooldown after paid work | `unit/cycle.test.js` (counts, cooldown kept after paid work, exact cap) |
| A11 latest update overwritten by older | `integration/api.test.js` › A11 |
| A12 pagination / malformed JSON | `integration/api.test.js` › A12 |
| A13 CORS blocks the operator header | `integration/api.test.js` › A01 "CORS: the allowlisted origin gets credentials…" |
| A14 same-name equipment overwritten | `integration/graph.test.js` › A14 |
| A15 obsolete summary / summaries change on failed save | `integration/extraction.test.js` › A15 |
| A16 zero limit removes the cap | `integration/linking.test.js` › "processPending limits and backlog"; `unit/scheduler.test.js` |
| A19 restored suburb reported live | `integration/api.test.js` › A19 |
| A20 cached tie-break switches outages | `integration/linking.test.js` › A20 |

`api/audit/read-only-data-check.mjs` is unchanged: a read-only diagnostic for the live database.
