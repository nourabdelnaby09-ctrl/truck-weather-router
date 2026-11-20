import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.heat";
import "./styles.css";

const configuredApiUrl = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000";
const API_URL = /^https?:\/\//.test(configuredApiUrl) ? configuredApiUrl : `https://${configuredApiUrl}`;

const RISK_COLORS = {
  Low: "#22a06b",
  Moderate: "#f5bd32",
  High: "#ed8936",
  Severe: "#dc3545",
  "No Travel": "#7a1f25",
};
const RISK_STRENGTH = {
  Low: 0.16,
  Moderate: 0.34,
  High: 0.53,
  Severe: 0.76,
  "No Travel": 1,
};
let radarTimestampCache = null;
let radarTimestampRequest = null;

function fetchRadarTimestamp() {
  if (!radarTimestampRequest) {
    radarTimestampRequest = fetch("https://api.rainviewer.com/public/weather-maps.json")
      .then((response) => {
        if (!response.ok) throw new Error("Radar unavailable");
        return response.json();
      })
      .then((data) => {
        const past = data?.radar?.past;
        if (!Array.isArray(past) || !past.length) throw new Error("Radar unavailable");
        const newest = past.reduce((latest, frame) => (
          Number(frame.time) > Number(latest.time) ? frame : latest
        ));
        if (!Number.isFinite(Number(newest.time))) throw new Error("Radar unavailable");
        radarTimestampCache = newest.time;
        return radarTimestampCache;
      });
  }
  return radarTimestampCache ? Promise.resolve(radarTimestampCache) : radarTimestampRequest;
}

function formatCheckpointLabels(point, mapLayers) {
  const labels = [];
  if (mapLayers.temp && Number.isFinite(point.temperature)) {
    labels.push(`${Math.round(point.temperature * 9 / 5 + 32)}°F`);
  }
  if (mapLayers.wind && Number.isFinite(point.wind)) {
    labels.push(`${Math.round(point.wind)} mph`);
  }
  if (mapLayers.rain && Number.isFinite(point.rain)) {
    labels.push(`${Number(point.rain).toFixed(2)} in/hr rain`);
  }
  if (mapLayers.snow && Number.isFinite(point.snow)) {
    labels.push(`${Number(point.snow).toFixed(2)} in/hr snow`);
  }
  if (mapLayers.elevation && Number.isFinite(point.elevation)) {
    labels.push(`${Math.round(point.elevation)} m`);
  }
  return labels;
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `${hours ? `${hours}h ` : ""}${minutes}m`;
}

function formatLocalDateTime(date) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
}

function FitRoutes({ routes, origin, destination }) {
  const map = useMap();
  useEffect(() => {
    const points = [
      ...(origin ? [[origin.lat, origin.lon]] : []),
      ...(destination ? [[destination.lat, destination.lon]] : []),
      ...routes.flatMap((route) => route.geometry.map(([lon, lat]) => [lat, lon])),
    ];
    if (points.length) {
      map.fitBounds(points, { padding: [35, 35] });
    }
  }, [map, routes, origin, destination]);
  return null;
}

function RiskHeatLayer({ routes }) {
  const map = useMap();
  const heatPoints = useMemo(() => routes.flatMap((route) => {
    const checkpoints = route.checkpoints;
    const points = [];
    for (let index = 0; index < checkpoints.length; index += 1) {
      const current = checkpoints[index];
      const strength = RISK_STRENGTH[current.risk] ?? RISK_STRENGTH.Low;
      const next = checkpoints[index + 1];
      if (!next) {
        points.push([current.lat, current.lon, strength]);
        continue;
      }

      const segmentMiles = Math.max(0, next.distance - current.distance);
      const subdivisions = Math.max(1, Math.ceil(segmentMiles / 5));
      const nextStrength = RISK_STRENGTH[next.risk] ?? RISK_STRENGTH.Low;
      for (let step = 0; step < subdivisions; step += 1) {
        const progress = step / subdivisions;
        points.push([
          current.lat + (next.lat - current.lat) * progress,
          current.lon + (next.lon - current.lon) * progress,
          strength + (nextStrength - strength) * progress,
        ]);
      }
    }
    return points;
  }), [routes]);

  useEffect(() => {
    if (!heatPoints.length) return undefined;
    const layer = L.heatLayer(heatPoints, {
      radius: 25,
      blur: 20,
      maxZoom: 12,
      max: 1,
      minOpacity: 0.2,
      gradient: {
        0.15: RISK_COLORS.Low,
        0.34: RISK_COLORS.Moderate,
        0.53: RISK_COLORS.High,
        0.76: RISK_COLORS.Severe,
        1: RISK_COLORS["No Travel"],
      },
    }).addTo(map);
    return () => map.removeLayer(layer);
  }, [heatPoints, map]);

  return null;
}

function WeatherToolbar({
  mapLayers,
  setMapLayers,
  radarLoading,
  radarError,
  alertCheckpoints,
  forecastHour,
}) {
  const chips = [
    ["weather", "☂", "Weather"],
    ["temp", "°", "Temp"],
    ["wind", "↗", "Wind"],
    ["rain", "▤", "Rain"],
    ["snow", "❄", "Snow"],
    ["elevation", "⌁", "Elevation"],
    ["alerts", "!", "Alerts"],
    ["legend", "◉", "Legend"],
  ];

  function toggle(key) {
    setMapLayers((current) => ({ ...current, [key]: !current[key] }));
  }

  return (
    <div className="weather-toolbar-wrap">
      <div className="weather-toolbar" role="toolbar" aria-label="Map weather layers">
        {chips.map(([key, icon, label]) => {
          const disabled = key === "weather" && (radarLoading || Boolean(radarError));
          return (
            <button
              type="button"
              key={key}
              className={`weather-chip${mapLayers[key] ? " active" : ""}`}
              aria-pressed={mapLayers[key]}
              disabled={disabled}
              onClick={() => toggle(key)}
              title={key === "weather" && radarLoading ? "Loading radar" : undefined}
            >
              <span className="weather-chip-icon" aria-hidden="true">{icon}</span>
              <span>{label}</span>
              {key === "alerts" && <span className="alert-count">{alertCheckpoints.length}</span>}
            </button>
          );
        })}
      </div>
      {radarLoading && <p className="radar-note">Loading radar…</p>}
      {radarError && <p className="radar-note error">{radarError}</p>}
      {(mapLayers.alerts || mapLayers.legend) && (
        <div className="toolbar-popovers">
          {mapLayers.alerts && (
            <section className="toolbar-popover alerts-popover" aria-label="Route weather alerts">
              <strong>Severe weather alerts ({alertCheckpoints.length})</strong>
              {alertCheckpoints.length ? (
                <ul>
                  {alertCheckpoints.map((point, index) => (
                    <li key={`${point.distance}-${point.arrival}-${index}`}>
                      <b>{point.risk}</b> · mi {Number(point.distance).toFixed(1)} · {new Date(point.arrival).toLocaleString()}
                    </li>
                  ))}
                </ul>
              ) : <p>No severe or no-travel checkpoints for this route.</p>}
            </section>
          )}
          {mapLayers.legend && (
            <section className="toolbar-popover legend-popover" aria-label="Weather risk legend">
              <strong>Weather risk</strong>
              <div className="toolbar-risk-legend">
                {Object.entries(RISK_COLORS).map(([label, color]) => (
                  <span key={label}><i style={{ backgroundColor: color }} />{label}</span>
                ))}
              </div>
              <p>Lighter = lower risk, darker = severe / no travel; orange ring = possible ice.</p>
            </section>
          )}
        </div>
      )}
      <span className="sr-only">Forecast offset: {forecastHour} hours</span>
    </div>
  );
}

function App() {
  const [form, setForm] = useState({
    origin: "Chicago, IL",
    destination: "Detroit, MI",
    departure: formatLocalDateTime(new Date(Date.now() + 3600000)),
    loadWeight: 35000,
    intervalMiles: 25,
  });
  const [data, setData] = useState(null);
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [forecastHour, setForecastHour] = useState(0);
  const [forecastRoutes, setForecastRoutes] = useState(null);
  const [forecastError, setForecastError] = useState("");
  const [forecastLoading, setForecastLoading] = useState(false);
  const [mapLayers, setMapLayers] = useState({
    weather: false,
    temp: false,
    wind: false,
    rain: false,
    snow: false,
    elevation: false,
    alerts: false,
    legend: false,
  });
  const [radarTimestamp, setRadarTimestamp] = useState(radarTimestampCache);
  const [radarLoading, setRadarLoading] = useState(!radarTimestampCache);
  const [radarError, setRadarError] = useState("");

  useEffect(() => {
    let active = true;
    fetchRadarTimestamp()
      .then((timestamp) => {
        if (active) setRadarTimestamp(timestamp);
      })
      .catch(() => {
        if (active) {
          setRadarError("Radar unavailable");
          setMapLayers((current) => ({ ...current, weather: false }));
        }
      })
      .finally(() => {
        if (active) setRadarLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!data || forecastHour === 0) {
      setForecastRoutes(null);
      setForecastError("");
      setForecastLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setForecastLoading(true);
      setForecastError("");
      try {
        const response = await fetch(`${API_URL}/api/heatmap/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            forecastHour,
            loadWeight: form.loadWeight,
            routes: activeRoutes.map((route) => ({
              id: route.id,
              checkpoints: route.checkpoints.map(({ lat, lon, arrival, distance, progress }) => ({
                lat, lon, arrival, distance, progress,
              })),
            })),
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load forecast");
        setForecastRoutes(payload.routes);
      } catch (err) {
        if (err.name !== "AbortError") setForecastError(err.message);
      } finally {
        if (!controller.signal.aborted) setForecastLoading(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [data, forecastHour, form.loadWeight]);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/plan-route/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, departure: new Date(form.departure).toISOString() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to plan route");
      setData(payload);
      setSelectedRouteId(payload.routes.find((route) => route.recommended)?.id ?? payload.routes[0]?.id ?? null);
      setForecastHour(0);
      setForecastRoutes(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  const activeRoutes = data?.routes || [];
  const displayedRoutes = activeRoutes.map((route) => {
    const forecastRoute = forecastRoutes?.find((item) => item.id === route.id);
    return forecastRoute ? { ...route, checkpoints: forecastRoute.checkpoints } : route;
  });
  const selectedRoute = displayedRoutes.find((route) => route.id === selectedRouteId)
    || displayedRoutes.find((route) => route.recommended)
    || displayedRoutes[0];
  const alertCheckpoints = selectedRoute?.checkpoints.filter(
    (point) => point.risk === "Severe" || point.risk === "No Travel",
  ) || [];

  return (
    <main>
      <header>
        <div className="brand-mark">T</div>
        <div>
          <p className="eyebrow">Dispatch intelligence</p>
          <h1>Weather-Aware Truck Routing</h1>
        </div>
      </header>

      <section className="workspace">
        <aside>
          <form onSubmit={submit}>
            <label>Origin
              <input value={form.origin} onChange={(e) => update("origin", e.target.value)} required />
            </label>
            <label>Destination
              <input value={form.destination} onChange={(e) => update("destination", e.target.value)} required />
            </label>
            <label>Departure
              <input type="datetime-local" value={form.departure} onChange={(e) => update("departure", e.target.value)} required />
            </label>
            <label>Load weight
              <div className="input-unit">
                <input type="number" min="1" value={form.loadWeight} onChange={(e) => update("loadWeight", e.target.value)} required />
                <span>lb</span>
              </div>
            </label>
            <fieldset>
              <legend>Checkpoint interval</legend>
              {[10, 25, 50].map((interval) => (
                <button type="button" key={interval} className={form.intervalMiles === interval ? "active" : ""} onClick={() => update("intervalMiles", interval)}>
                  {interval} mi
                </button>
              ))}
            </fieldset>
            <button className="primary" type="submit" disabled={loading}>
              {loading ? "Analyzing routes…" : "Compare routes"}
            </button>
            {error && <p className="error">{error}</p>}
          </form>

          {activeRoutes.length > 0 && (
            <div className="route-list">
              {activeRoutes.map((route) => (
                <button
                  type="button"
                  key={route.id}
                  className={`route-card${route.id === selectedRoute?.id ? " selected" : ""}`}
                  aria-pressed={route.id === selectedRoute?.id}
                  onClick={() => setSelectedRouteId(route.id)}
                >
                  <div className="route-heading">
                    <strong>{route.name}</strong>
                    <div className="route-badges">
                      {route.recommended && <span>Recommended</span>}
                      {route.id === selectedRoute?.id && <span className="selected-badge">Selected</span>}
                    </div>
                  </div>
                  <div className="metrics">
                    <span><b>{route.distanceMiles}</b> mi</span>
                    <span><b>{formatDuration(route.durationSeconds)}</b> ETA</span>
                  </div>
                  <p className="road-summary">{route.roadSummary}</p>
                  <div className="risk-summary">
                    <span>Severe <b>{route.severeMiles} mi</b></span>
                    <span>High <b>{route.highMiles} mi</b></span>
                    <span>No Travel <b>{route.noTravelMiles} mi</b></span>
                    <span>Avg risk <b>{route.averageRisk}</b></span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="map-panel">
          <WeatherToolbar
            mapLayers={mapLayers}
            setMapLayers={setMapLayers}
            radarLoading={radarLoading}
            radarError={radarError}
            alertCheckpoints={alertCheckpoints}
            forecastHour={forecastHour}
          />
          <MapContainer center={[41.8781, -87.6298]} zoom={7} scrollWheelZoom>
            <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            {mapLayers.weather && radarTimestamp && (
              <TileLayer
                url={`https://tilecache.rainviewer.com/v2/radar/${radarTimestamp}/256/{z}/{x}/{y}/2/1_1.png`}
                opacity={0.55}
                zIndex={2}
                attribution="Radar: RainViewer"
              />
            )}
            {data && <FitRoutes routes={activeRoutes} origin={data.origin} destination={data.destination} />}
            {activeRoutes.map((route) => {
              const isSelected = route.id === selectedRoute?.id;
              return (
              <Polyline
                key={route.id}
                positions={route.geometry.map(([lon, lat]) => [lat, lon])}
                pathOptions={{ color: isSelected ? "#235dbe" : "#8a96a8", weight: isSelected ? 7 : 4, opacity: isSelected ? 0.95 : 0.55 }}
                eventHandlers={{ click: () => setSelectedRouteId(route.id) }}
              >
                <Popup>
                  <strong>{route.name}</strong><br />
                  {route.distanceMiles} mi · {formatDuration(route.durationSeconds)}<br />
                  Severe: {route.severeMiles} mi · No Travel: {route.noTravelMiles} mi
                </Popup>
              </Polyline>
              );
            })}
            {selectedRoute && <RiskHeatLayer routes={[selectedRoute]} />}
            {selectedRoute?.checkpoints.map((point, index) => (
              <CircleMarker
                key={`${selectedRoute.id}-${index}`}
                center={[point.lat, point.lon]}
                radius={7}
                pathOptions={{
                  color: point.temperature <= 2 && (point.rain > 0 || point.snow > 0) ? "#f28c28" : "#fff",
                  fillColor: RISK_COLORS[point.risk],
                  fillOpacity: 0.9,
                  weight: point.temperature <= 2 && (point.rain > 0 || point.snow > 0) ? 3 : 2,
                }}
              >
                {formatCheckpointLabels(point, mapLayers).length > 0 && (
                  <Tooltip permanent direction="top" offset={[0, -8]} className="checkpoint-label">
                    {formatCheckpointLabels(point, mapLayers).join(" · ")}
                  </Tooltip>
                )}
                <Popup>
                  <strong>{point.risk}</strong><br />
                  ETA: {new Date(point.arrival).toLocaleString()}<br />
                  Wind: {Math.round(point.wind)} mph · Rain: {point.rain} in/hr · Snow: {point.snow} in/hr
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>

          {activeRoutes.length > 0 && (
            <div className="forecast-control">
              <div>
                <span>Forecast corridor</span>
                <b>{forecastLoading ? "Updating…" : `+${forecastHour} hr`}</b>
              </div>
              <input aria-label="Forecast hour offset" type="range" min="0" max="48" value={forecastHour} onChange={(e) => setForecastHour(Number(e.target.value))} />
              {forecastError && <p className="error">{forecastError}</p>}
              <div className="legend">
                {Object.entries(RISK_COLORS).map(([label, color]) => (
                  <span key={label}><i style={{ background: color }} />{label}</span>
                ))}
              </div>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
