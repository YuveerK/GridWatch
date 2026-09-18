# GridWatch

Tracks City Power (Johannesburg) outages from their posts on X.

## Run locally

```
cd api && npm install && cp data/.env .env   # needs DATABASE_URL, GEMINI_API_KEY, X_API_BEARER_TOKEN
npx prisma migrate deploy
SCHEDULER=off npm start          # API on :4000 (omit SCHEDULER=off to poll X every few minutes)
cd ../client && npm install && npm run dev   # UI on :5173, proxies /v1 to the API
```

Useful scripts (in `api/`): `npm run ingest -- --process` (fetch new posts and process them),
`npm run process -- --reset` (replay everything from cached extractions), `npm run eval` (linking accuracy on the hand-labelled set in `tests/golden/links.json`).
