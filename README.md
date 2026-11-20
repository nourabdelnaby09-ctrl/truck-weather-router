# Weather-Aware Truck Routing

React + Django application that compares three driving routes and evaluates weather risk along each route.

## Features

- Geocoding and routing with public OpenStreetMap APIs
- Open-Meteo hourly weather forecasts
- 10, 25, or 50 mile route checkpoint sampling
- Wind, rain, snow, and truck-load-aware risk classification
- Road-name summaries for each route option
- Route ranking by No Travel miles, severe miles, high miles, average risk, then travel time
- Interactive route map with a continuous risk-weighted weather heat layer
- 0–48 hour forecast slider, backed by up to 7 forecast days

## Run locally

### Backend

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python backend/manage.py migrate
python backend/manage.py runserver
```

The API is available at `http://127.0.0.1:8000/api/plan-route/`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## Configuration

No API keys are required for the default public providers:

- Nominatim geocoding
- OSRM routing
- Open-Meteo weather

The default OSRM demo server is intended for limited evaluation and can rate-limit traffic. For hosted use, set `ROUTING_API_URL` to a production OSRM-compatible routing service endpoint. Set `DJANGO_ALLOWED_HOSTS` and `CORS_ALLOWED_ORIGINS` in production.

## API

- `POST /api/plan-route/` geocodes the trip, samples route checkpoints, and scores weather.
- `POST /api/heatmap/` accepts `{ "forecastHour": 0, "loadWeight": 35000, "routes": [...] }` using the route/checkpoint data returned by the planning endpoint. `forecastHour` shifts each checkpoint's arrival time from 0 to 48 hours; the frontend updates checkpoint markers and the continuous corridor heat layer.

Weather responses are cached in-process for one hour. The cache is per application process and is cleared on restart.

## Deploying to Render

The root `render.yaml` defines a Django API service and a Vite static site. Set a generated `DJANGO_SECRET_KEY` and deploy the blueprint. The frontend is configured to call the API service; Django only allows the configured Render frontend origin. Configure `ROUTING_API_URL` to a production routing provider before serving public traffic. SQLite is ephemeral on Render, so configure a managed database before adding persistent application data.

Loom walkthrough link: pending a share URL.
