# Loom Walkthrough Script (5–10 minutes)

Record with both servers running locally (or against the deployed API):
```bash
python backend/manage.py runserver
cd frontend && npm run dev
```
Open http://localhost:5173. Keep `views.py`, `src/lib/risk.js`, `src/lib/risk.test.js`, GitHub repo and README in other tabs. Free Loom caps screen recordings at 5 minutes — target ~4:45 and cut the repo tour if needed.

## 0:00–0:35 — Problem & one-line answer
> "This app answers two questions for a truck driver: *should I roll, and when?* It compares three routes, checks weather at checkpoints along each one, applies wind/rain/snow and load rules, and recommends the lowest-risk route."

Show the form: origin, destination, departure, load weight, 10/25/50 mi interval.

## 0:35–1:15 — Architecture
Draw or say:
- React SPA → `POST /api/routes/` → Django
- Django → Nominatim (places), OSRM (3 routes), Open-Meteo (hourly weather)
- All risk scoring and ranking live in `src/lib/risk.js`; the UI never re-derives risk.
- No keys in the frontend; SQLite only holds Django internals.

## 1:15–3:15 — Live demo (most important)
1. Click **Compare routes** (default Chicago → Detroit).
2. Show **three polylines**, the recommended one emphasized.
3. Point at a route card: distance, drive time, arrival, Severe* miles, High miles, average risk, ranking reason.
4. Explain the `*` — Severe includes No Travel miles, per spec.
5. Click a checkpoint marker: ETA, distance, wind/rain/snow, risk badge.
6. Click **Preview No-Travel demo**: dark red marker, popup says *SIMULATED — NOT LIVE WEATHER*. Say explicitly: "This is a sandbox preview; real scoring never uses it."
7. Drag the **0–48h slider** slowly: show checkpoint colors and the canvas corridor heat layer updating; mention 100 ms debounce, ±1h prefetch and cell/hour caching.
8. Toggle a couple of toolbar chips (Temp, Wind, Alerts, Legend) — keep it quick.

## 3:15–4:15 — Risk rules in code
Open `src/lib/risk.js`:
- `RISK_THRESHOLDS` table mirrors the spec rows exactly.
- `worstLevel()` — worst of wind/rain/snow wins.
- `windLevel()` — load rules only escalate; 45–54 mph + >30,000 lb → No Travel.
- `rankRoutes()` — Severe → High → weighted average risk → time, no composite score.

## 4:15–4:40 — Tests
Run:
```bash
cd frontend && npm test
python ../backend/manage.py test
```
Say: "36 frontend tests cover every threshold boundary and both load edges; 11 Django tests cover interpolation, caching, UTC matching, ranking and the corridor batch endpoint."

## 4:40–5:00 — Repo & close
Show GitHub repo, two commits per step, `render.yaml` / SnapDeploy Dockerfiles, and README. Close with:
- GitHub: https://github.com/nourabdelnaby09-ctrl/truck-weather-router
- API: https://truck-weather-router-c9820.containers.snapdeploy.app
- Frontend redeploy pending; README documents current status.

## If you have more time (up to 10 min)
- Show `interpolate_geometry()` and explain `progress` → ETA.
- Show `batch_weather_at()` — one Open-Meteo call for the whole grid.
- Show `CorridorHeatLayer` — canvas, rAF redraw, no marker flood.
- Explain 422 (outside forecast) and 503 (provider down with one retry).
