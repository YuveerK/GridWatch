# GridWatch data inputs

The supplied historical export is `data-1789693588210.csv`. The existing
`SourcePost` table is already populated, so the historical importer is
optional and should only be run when bootstrapping another database. It is
idempotent on `(platform, externalId)` and preserves raw payload fields.

The supplied Johannesburg geography is the raw human-maintained
`johannesburg.txt` file. It mixes one-locality-per-line sections, comma-
separated paragraphs, and Region E ward notes. `npm run seed:geography` parses
that format directly, normalizes labels, records source line numbers, reports
cross-region collisions, and does not require the file to be restructured.

For other environments, the geography seeder also accepts JSON containing an
array of `{ "code", "name", "localities" }` objects. Each locality may be a
string or `{ "name": "...", "aliases": [] }`.
