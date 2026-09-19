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

## The map

The Map page and the "Where it reaches" panel on equipment pages show suburbs as dots at their centre. They are approximate: City Power names suburbs, not streets or cable routes, so the map says "roughly here".

Suburb positions come from free OpenStreetMap data (suburb areas first, then the Nominatim geocoder) and are stored on each suburb. New suburbs appear as posts are read, so run this now and then (it only places suburbs that have no position yet, about 1 request a second):

```
cd api
npm run geocode
```

Suburbs that fail (typos in City Power's posts, private complexes) stay off the map and are counted as "could not be placed". Map tiles come from OpenFreeMap, which is free and needs no key.

## Keeping readings fresh

Every post is read once by Gemini and the result is stored. Each stored reading remembers which instructions (`prompt.js`) and model produced it. If you edit the instructions or change the model, `npm run audit` shows how many readings are now out of date, and this re-reads only those (with a backup, a spend cap and progress; a failed re-read keeps the old reading):

```
cd api
npm run reread            # re-read stale posts only (about $0.002 per post)
node scripts/process.js --reset   # then rebuild the outages from the fresh readings
npm run geocode           # place any newly learned suburbs on the map
```

Backups are written to `api/data/backups/` (not committed). To undo a re-read: `npm run reread -- --restore=data/backups/<file>.json`, then rebuild.

### Map data sources

- **Suburb outlines** are Statistics South Africa's Census 2011 sub-places (free public data). They are matched to our suburbs by name, and where the name differs, by the outline the suburb's map pin falls inside (marked as approximate). The simplified file the map uses is `api/data/boundaries/jhb-subplaces.json`. To rebuild it: download `Subplace.zip` from https://github.com/j-norwood-young/SA-Maps (Git LFS), unzip it, then `cd api && node scripts/build-boundaries.js path/to/SP_SA_2011.shp`. The 2011 data predates newer townships, so those have no outline (they still get their pin).
- **Equipment positions are inferred.** City Power publishes no coordinates for its equipment, so each substation, switching station or distributor is drawn at the centre of the suburbs its posts tie it to. The connections (which suburbs it feeds) are real; the marker position is not. Suburbs implausibly far from the rest are left out of the animation.
