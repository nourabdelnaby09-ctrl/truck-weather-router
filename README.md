# Weather-Aware Truck Routing

A React + Django decision tool that compares three driving routes and recommends the one with the lowest weather risk for a given load and departure time.

## Links

- **Source:** https://github.com/nourabdelnaby09-ctrl/truck-weather-router
- **Deployed API:** https://truck-weather-router-c9820.containers.snapdeploy.app
- **Deployed frontend:** https://truck-weather-frontend-c9820.containers.snapdeploy.app (needs a fresh redeploy — see [Deployment](#deployment))
- **Loom walkthrough:** pending a share URL — recording outline in `LOOM_SCRIPT.md`

---

## Architecture

```
Browser (React + Vite)
  │
  ├─ form: origin, destination, departure, load, interval (10/25/50)
  │
  ├─ POST /api/routes/  ───────────────┐
  ├─ POST /api/heatmap/ (slider)       │
  └─ POST /api/corridor/ (slider)      │
                                       ▼
                            Django (plain views)
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
   Nominatim                     OSRM directions               Open-Meteo hourly
   (geocoding)                   (3 route options)             (wind/rain/snow/temp)
                                                                    │
                                                     risk.js (single source of truth
                                                     for UI classification + ranking)
                                                                    │
                                          canvas corridor grid + checkpoint markers
```

**Backend:** Django 5, `django-cors-headers`, `requests`, SQLite (Django internals only — no trip data is stored). Gunicorn in production.
**Frontend:** React 19, Vite, Leaflet / react-leaflet, plain CSS. No component library, no new UI dependencies.
**External APIs:** all free, no keys in the frontend. Nominatim (geocoding), OSRM demo server (routing), Open-Meteo (weather), RainViewer (radar tiles).

---

## How each spec rule maps to code

| Spec requirement | Where it lives |
|---|---|
| Four on-screen inputs + 10/25/50 interval selector | `frontend/src/main.jsx` form state and fieldset; default 25 |
| Exactly 3 route options | `backend/routing/views.py` → `plan_route()` (direct + 2 via-waypoint variants, deduped by distance) |
| Checkpoints every 10/25/50 mi, origin + destination always included | `interpolate_geometry()` |
| ETA per checkpoint from router duration | `arrival = departure + duration × progress` in `plan_route()` |
| Hourly weather at checkpoint ETA | `weather_at()` (nearest UTC hour, 7-day forecast) |
| Wind / rain / snow thresholds | `RISK_THRESHOLDS` in `frontend/src/lib/risk.js` (named table) and `classify_condition()` in `views.py` |
| Load rules (escalation only) | `windLevel()` in `risk.js`; wind branch of `classify_condition()` in `views.py` |
| Worst-of-three classification | `worstLevel()` in `risk.js`; `max(..., key=RISK_ORDER)` in `views.py` |
| Ranking: Severe → High → weighted avg risk → time | `rankRoutes()` in `risk.js`; `results.sort(...)` in `views.py` |
| 0–48h slider, 100 ms debounce, ±1h prefetch | `main.jsx` slider effect |
| Corridor grid within ~25 mi, canvas overlay, cached by cell/hour | `/api/corridor/` + `corridor_cells()` + `batch_weather_at()`; `CorridorHeatLayer` in `main.jsx` |
| Loading/error states | `loading`, `error`, `forecastLoading/Error`, `corridorLoading`, `radarLoading/Error` |

Tests: `npm test` (vitest, `src/lib/*.test.js`) and `python backend/manage.py test` (Django).

---

## Assumptions

- **Severe miles include No Travel miles.** The spec says both count as Severe; `noTravelMiles` is still returned for context but is not a separate ranking key.
- **Average risk is weighted by segment miles** (risk level number × segment length ÷ total measured miles), not a mean of checkpoints.
- A checkpoint's risk applies to the segment **from that checkpoint to the next one**; the final checkpoint covers the remaining distance to the destination.
- ETA is derived from the router's **total duration** and linear `progress` along the scaled polyline, then snapped to the nearest forecast hour. The router does not return per-segment durations on the demo OSRM endpoint, so a flat proportion is used.
- Open-Meteo is called with `timezone=UTC`; naive `datetime-local` input is treated as UTC.
- Weather and corridor cells are cached **1 hour per rounded coordinate/hour**, per process (LocMemCache). Cache is lost on restart.
- The corridor grid uses a 0.25° step (~17–25 mi depending on latitude), max 500 cells, filtered to within 25 mi of the route.
- The optional **"Preview No-Travel demo"** button is a labeled sandbox marker only. It never enters risk scoring or the API response.

---

## API

### `POST /api/routes/` (alias: `/api/plan-route/`)
Request:
```json
{"origin":"Chicago, IL","destination":"Detroit, MI","departure":"2026-11-26T08:00:00Z","loadWeight":35000,"intervalMiles":25}
```
Response: origin/destination + `routes[]` with `id`, `name`, `roadSummary`, `distanceMiles`, `durationSeconds`, `eta`, `geometry` (GeoJSON coordinate array), `checkpoints[]`, `severeMiles`, `highMiles`, `noTravelMiles`, `averageRisk`, `recommended`.

### `POST /api/heatmap/`
Shifts each checkpoint's arrival by `forecastHour` (0–48) and returns recomputed risk.

### `POST /api/corridor/`
Request adds `geometry` and `departure`; returns `{hour, cells:[{lat,lon,risk,wind,rain,snow}]}` for the canvas heatmap.

Error codes: `400` bad input · `404` no routes · `422` trip outside 7-day forecast · `503` weather provider unavailable.

---

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python backend/manage.py migrate
python backend/manage.py test
python backend/manage.py runserver        # http://127.0.0.1:8000
```

```bash
cd frontend
npm install
npm test
npm run dev                               # http://localhost:5173
```

Configuration via env: `DJANGO_SECRET_KEY`, `DJANGO_DEBUG`, `DJANGO_ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`, `ROUTING_API_URL`, `VITE_API_URL`.

---

## Deployment

Deployed on **SnapDeploy** using two free containers:

| Container | Branch | Root directory | Build | Env |
|---|---|---|---|---|
| `truck-weather-router-c9820` (API) | `master` | `/` | root `Dockerfile` → Gunicorn | Django env vars |
| `truck-weather-frontend-c9820` (SPA) | `frontend-deploy` | `frontend` | `frontend/Dockerfile` → nginx | `VITE_API_URL` |

Backend is live and verified (`POST /api/routes/` returns 3 routes). The frontend container currently serves Django after an auto-redeploy and needs a fresh redeploy with root directory `frontend`; a dedicated `frontend/Dockerfile` has been added for that purpose. `render.yaml` is also included as an alternative blueprint.

Rate limits: the OSRM demo server and Nominatim are for evaluation traffic and may rate-limit. Set `ROUTING_API_URL` to a production OSRM-compatible service before serving real traffic.

---

## Loom walkthrough

See `LOOM_SCRIPT.md` for a minute-by-minute script covering the live demo, risk rules, ranking, heatmap slider, tests and repository.
