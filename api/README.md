# GridWatch API

The backend is a plain JavaScript ESM modular monolith built with Express,
Prisma, and PostgreSQL. The frontend is intentionally outside this
implementation.

## Local setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL`, `GEMINI_API_KEY`, and
   X credentials when live ingestion is enabled.
2. Generate the Prisma client with `npm run prisma:generate`.
3. Check the schema and migration state with `npm run prisma:validate` and
   `npx prisma migrate status`.
4. Start the API with `npm start`.

The default port is `4000`. Health endpoints are `/api/health` and
`/api/health/worker`.

## Database

The first migration preserves the existing `public.SourcePost` table and adds
processing, geography, infrastructure, knowledge, and incident tables. New
environments should run `npx prisma migrate deploy`; an existing database with
the retained `SourcePost` table must be baselined against
`202609180001_init_backend` before normal deploys.

## Bootstrap data

The supplied files are `data/data-1789693588210.csv` and the raw
`data/johannesburg.txt`. The geography seeder accepts that raw format directly;
no restructuring is needed. This database already contains the 683 historical
`SourcePost` rows, so run only:

```powershell
npm run seed:geography
```

Both bootstrap operations are idempotent and print a JSON report. Historical
importing is available for a fresh database and never calls X.

## Processing

The scheduler polls every ten minutes when `X_SOURCE_ACCOUNT_ID` is configured.
It persists source posts before processing, then performs media/OCR, Gemini
extraction, knowledge reconciliation, and incident association. Posts can be
reprocessed through `POST /api/admin/posts/:id/reprocess` without another X
request.

## Tests

```powershell
npm test
node tests/integration/api.smoke.js
```

The unit tests cover normalization, extraction validation, and X request
construction. The smoke script exercises the API against the configured local
database.

## One-post media backfill test

To exercise the stored-post pipeline without calling X, select the first
stored post with a photo attachment and run:

```powershell
npm run backfill:test:media -- --force
```

The script materializes the attachment into `PostMedia`, runs OCR, Gemini
extraction, knowledge reconciliation, and incident association, and emits one
JSON log per stage. Use `--dry-run` to inspect the selected post without
changing the database, or `--post-id=<id>` to select a specific post.
