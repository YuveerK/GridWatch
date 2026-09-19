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

## Fetching the latest posts

The **Refresh / Fetch latest posts** button (header and overview) pulls new posts from X, reads them and updates the site.
It is an operator tool for now. Settings in `api/.env`:

| Setting | Default | What it does |
|---|---|---|
| `REFRESH_BUTTON` | `on` | `off` hides the button and blocks the endpoint (use this once the scheduler is running). |
| `REFRESH_COOLDOWN_SECONDS` | `60` | Minimum wait between manual fetches (a failed attempt can be retried at once). |
| `REFRESH_MAX_POSTS` | `200` | Most posts read per click, to cap spend. Click again if it says more are waiting. |
| `REFRESH_TOKEN` | unset | If set, the API requires this in an `x-refresh-token` header. |

To use the scheduler instead, start the API without `SCHEDULER=off`; it runs the same single-flight cycle every few minutes.

X fetches leave out replies by default (`X_INCLUDE_REPLIES=off`). They are City Power answering individual customers, which is never outage news, and X charges per post returned.
