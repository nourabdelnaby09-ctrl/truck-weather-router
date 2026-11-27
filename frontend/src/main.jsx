import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import L from "leaflet";
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { rankRoutes, withRisk } from "./lib/risk.js";
import { toLeafletPositions } from "./lib/geometry.js";
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
const WIND_DEMO_POINT = {
  lat: 41.14,
  lon: -104.82,
  place: "Cheyenne, Wyoming",
  wind: 55,
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
      ...routes.flatMap((route) => toLeafletPositions(route.geometry)),
    ];
    if (points.length) {
      map.fitBounds(points, { padding: [35, 35] });
    }
  }, [map, routes, origin, destination]);
  return null;
}

function WindDemoFocus({ active }) {
  const map = useMap();
  useEffect(() => {
    if (active) {
      map.flyTo([WIND_DEMO_POINT.lat, WIND_DEMO_POINT.lon], 7);
    }
  }, [active, map]);
  return null;
}

function CorridorHeatLayer({ cells }) {
  const map = useMap();

  useEffect(() => {
    if (!cells?.length) return undefined;
    const paneName = "corridorHeat";
    if (!map.getPane(paneName)) {
      map.createPane(paneName);
      map.getPane(paneName).style.zIndex = 350;
    }
    const canvas = L.DomUtil.create("canvas", "corridor-heat-layer");
    const size = map.getSize();
    canvas.width = size.x;
    canvas.height = size.y;
    map.getPane(paneName).appendChild(canvas);

    let frame = 0;
    const draw = () => {
      frame = 0;
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
      L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
      const radius = Math.max(7, Math.min(28, 22 - map.getZoom()));
      context.globalAlpha = 0.42;
      // One path per risk color: fewer canvas state changes per redraw.
      Object.keys(RISK_COLORS).forEach((level) => {
        const group = cells.filter((cell) => cell.risk === level);
        if (!group.length) return;
        context.fillStyle = RISK_COLORS[level];
        context.beginPath();
        group.forEach((cell) => {
          const point = map.latLngToContainerPoint([cell.lat, cell.lon]);
          context.moveTo(point.x + radius, point.y);
          context.arc(point.x, point.y, radius, 0, 2 * Math.PI);
        });
        context.fill();
      });
      context.globalAlpha = 1;
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(draw);
    };
    map.on("moveend zoomend resize", schedule);
    schedule();

    return () => {
      map.off("moveend zoomend resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
      canvas.remove();
    };
  }, [cells, map]);

  return null;
}

const LAYER_ICONS = {
  weather: ["M7 16h10a4 4 0 0 0 .3-8 5.5 5.5 0 0 0-10.6 1.2A3.4 3.4 0 0 0 7 16Z", "M8 19v2", "M12 19v2", "M16 19v2"],
  temp: ["M14 14V5a2 2 0 0 0-4 0v9a4 4 0 1 0 4 0Z", "M12 9v6"],
  wind: ["M3 8h11a3 3 0 1 0-3-3", "M3 12h15a3 3 0 1 1-3 3", "M3 16h7"],
  rain: ["M7 15h10a4 4 0 0 0-.4-8 5.5 5.5 0 0 0-10.2 1.4A3.4 3.4 0 0 0 7 15Z", "M8 18l-1 3", "M12 18l-1 3", "M16 18l-1 3"],
  snow: ["M7 15h10a4 4 0 0 0-.4-8 5.5 5.5 0 0 0-10.2 1.4A3.4 3.4 0 0 0 7 15Z", "M12 18v4", "M10 20l4-4", "M14 20l-4-4"],
  elevation: ["M3 19l6-10 4 6 2-3 6 7H3Z", "M7 11l2-2 3 4"],
  alerts: ["M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9", "M10 21h4", "M12 3v2"],
  legend: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 11v5", "M12 8h.01"],
};

function LayerIcon({ name }) {
  return (
    <svg className="weather-chip-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {(LAYER_ICONS[name] || LAYER_ICONS.weather).map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
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
    ["temp", "Temp"],
    ["wind", "Wind"],
    ["rain", "Rain"],
    ["snow", "Snow"],
    ["elevation", "Elevation"],
    ["alerts", "Alerts"],
    ["legend", "Legend"],
  ];

  function toggle(key) {
    setMapLayers((current) => Object.fromEntries(
      Object.keys(current).map((layer) => [layer, layer === key && !current[layer]]),
    ));
  }

  return (
    <div className="weather-toolbar-wrap">
      <div className="weather-toolbar" role="toolbar" aria-label="Map weather layers">
        <span className="weather-toolbar-title">
          <LayerIcon name="weather" />
          <span>Weather</span>
        </span>
        {chips.map(([key, label]) => {
          return (
            <button
              type="button"
              key={key}
              className={`weather-chip${mapLayers[key] ? " active" : ""}${key === "legend" ? " mobile-only-layer" : ""}`}
              aria-pressed={mapLayers[key]}
              onClick={() => toggle(key)}
            >
              <LayerIcon name={key} />
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

const RouteLine = memo(function RouteLine({ route, isSelected, onSelect }) {
  const positions = useMemo(() => toLeafletPositions(route.geometry), [route.geometry]);
  return (
    <Polyline
      positions={positions}
      pathOptions={{
        color: isSelected ? "#235dbe" : "#8a96a8",
        weight: isSelected ? 7 : 4,
        opacity: isSelected ? 0.95 : 0.55,
      }}
      eventHandlers={{ click: () => onSelect(route.id) }}
    >
      <Popup>
        <strong>{route.name}</strong><br />
        {route.distanceMiles} mi · {formatDuration(route.durationSeconds)}<br />
        Severe: {route.severeMiles} mi · No Travel: {route.noTravelMiles} mi
      </Popup>
    </Polyline>
  );
});

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
  const [appliedHour, setAppliedHour] = useState(0);
  const [forecastAppliedAnnouncement, setForecastAppliedAnnouncement] = useState("");
  const [forecastRoutes, setForecastRoutes] = useState(null);
  const [forecastError, setForecastError] = useState("");
  const [forecastLoading, setForecastLoading] = useState(false);
  const [corridorCells, setCorridorCells] = useState([]);
  const [corridorLoading, setCorridorLoading] = useState(false);
  const corridorCache = useRef(new Map());
  const [windDemo, setWindDemo] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const drawerRef = useRef(null);
  const [toolsScrollTop, setToolsScrollTop] = useState(0);
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
  const previewTime = new Date(
    new Date(form.departure).getTime() + forecastHour * 3600000,
  ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  useEffect(() => {
    if (!mobileToolsOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setMobileToolsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileToolsOpen]);

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
    if (!data || appliedHour === 0) {
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
            forecastHour: appliedHour,
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
    }, 100);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [data, appliedHour, form.loadWeight]);

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
      setAppliedHour(0);
      setForecastAppliedAnnouncement("");
      setForecastRoutes(null);
      corridorCache.current.clear();
      setCorridorCells([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  // Single source of truth: all risk levels and ranking come from src/lib/risk.js.
  const activeRoutes = useMemo(
    () => rankRoutes(data?.routes || [], Number(form.loadWeight) || 0),
    [data, form.loadWeight],
  );
  const displayedRoutes = activeRoutes.map((route) => {
    const forecastRoute = forecastRoutes?.find((item) => item.id === route.id);
    return forecastRoute
      ? { ...route, checkpoints: withRisk(forecastRoute.checkpoints, Number(form.loadWeight) || 0) }
      : route;
  });
  const selectedRoute = displayedRoutes.find((route) => route.id === selectedRouteId)
    || displayedRoutes.find((route) => route.recommended)
    || displayedRoutes[0];
  const alertCheckpoints = selectedRoute?.checkpoints.filter(
    (point) => point.risk === "Severe" || point.risk === "No Travel",
  ) || [];

  // Corridor grid: debounce 100ms, cache by (cell batch, hour), prefetch ±1 hour.
  useEffect(() => {
    if (!selectedRoute || appliedHour === 0) {
      setCorridorCells([]);
      setCorridorLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    const cacheKey = (hour) => `${selectedRoute.id}:${form.loadWeight}:${form.departure}:${hour}`;
    const hours = [appliedHour - 1, appliedHour, appliedHour + 1]
      .filter((hour) => hour >= 0 && hour <= 48);
    const missing = hours.filter((hour) => !corridorCache.current.has(cacheKey(hour)));

    const timer = window.setTimeout(async () => {
      setCorridorLoading(true);
      try {
        await Promise.all(missing.map(async (hour) => {
          const response = await fetch(`${API_URL}/api/corridor/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              forecastHour: hour,
              loadWeight: Number(form.loadWeight) || 0,
              departure: new Date(form.departure).toISOString(),
              geometry: selectedRoute.geometry,
            }),
          });
          if (!response.ok) return;
          const payload = await response.json();
          corridorCache.current.set(cacheKey(hour), payload.cells);
        }));
        if (!controller.signal.aborted) {
          setCorridorCells(corridorCache.current.get(cacheKey(appliedHour)) || []);
        }
      } catch (err) {
        if (err.name !== "AbortError") setCorridorCells([]);
      } finally {
        if (!controller.signal.aborted) setCorridorLoading(false);
      }
    }, 100);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [selectedRoute, appliedHour, form.loadWeight, form.departure]);

  function applyForecast() {
    setAppliedHour(forecastHour);
    setForecastAppliedAnnouncement(`Forecast applied at ${previewTime}`);
  }

  return (
    <main
      className={mobileToolsOpen ? "mobile-tools-open" : undefined}
      style={{ "--tools-lift": `${Math.min(toolsScrollTop, 180)}px` }}
    >
      <header>
        <div className="brand-mark"><img src="/truck-logo.png" alt="TruckWeather logo" /></div>
        <div>
          <p className="eyebrow">Dispatch intelligence</p>
          <h1>Weather-Aware Truck Routing</h1>
        </div>
      </header>

      {mobileToolsOpen && (
        <button
          type="button"
          className="mobile-tools-backdrop"
          aria-label="Close tools"
          onClick={() => setMobileToolsOpen(false)}
        />
      )}
      <button
        type="button"
        className="mobile-tools-toggle"
        aria-label={mobileToolsOpen ? "Close tools" : "Open tools"}
        aria-expanded={mobileToolsOpen}
        aria-controls="mobile-tools-drawer"
        onClick={() => setMobileToolsOpen((open) => !open)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      <section className="workspace">
        <aside
          id="mobile-tools-drawer"
          ref={drawerRef}
          onScroll={(event) => setToolsScrollTop(event.currentTarget.scrollTop)}
        >
          <form onSubmit={submit}>
            <label>Origin
              <input value={form.origin} onChange={(e) => update("origin", e.target.value)} required />
            </label>
            <label>Destination
              <input value={form.destination} onChange={(e) => update("destination", e.target.value)} required />
            </label>
            <label>Departure
              <input className="departure-input" type="datetime-local" value={form.departure} onChange={(e) => update("departure", e.target.value)} required />
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
            <button
              className="demo-button"
              type="button"
              aria-pressed={windDemo}
              onClick={() => setWindDemo((active) => !active)}
            >
              {windDemo ? "Hide No-Travel demo" : "Preview No-Travel demo"}
            </button>
            <p className="demo-note">Simulated 55 mph wind at Cheyenne, Wyoming; not a live forecast.</p>
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
                    <span><b>{formatDuration(route.durationSeconds)}</b> drive</span>
                    <span>Arrive <b>{new Date(route.eta).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b></span>
                  </div>
                  <p className="road-summary">{route.roadSummary}</p>
                  <div className="risk-summary">
                    <span>Severe* <b>{route.severeMiles} mi</b></span>
                    <span>High <b>{route.highMiles} mi</b></span>
                    <span>Avg risk <b>{route.averageRisk}</b></span>
                  </div>
                  <p className="rank-reason">{route.reason}</p>
                </button>
              ))}
            </div>
          )}

          {activeRoutes.length > 0 && (
            <div className="forecast-control">
              <div className="forecast-heading">
                <span>Forecast corridor · +{forecastHour} hr ({previewTime})</span>
                <div className="forecast-status">
                  {forecastHour !== appliedHour ? (
                    <span className="forecast-preview-badge">Preview — not applied</span>
                  ) : (
                    <b>{forecastLoading || corridorLoading ? "Updating…" : `Applied +${appliedHour} hr`}</b>
                  )}
                </div>
              </div>
              <input
                aria-label="Forecast hour offset"
                aria-valuetext={`${previewTime}, ${forecastHour} hours later`}
                type="range"
                min="0"
                max="48"
                value={forecastHour}
                onChange={(e) => setForecastHour(Number(e.target.value))}
              />
              <button
                className="apply-forecast"
                type="button"
                aria-label={`Apply forecast at ${previewTime}`}
                disabled={forecastHour === appliedHour}
                onClick={applyForecast}
              >
                {forecastHour === appliedHour ? `Applied +${appliedHour} hr` : "Apply forecast"}
              </button>
              <span className="sr-only" role="status" aria-live="polite">{forecastAppliedAnnouncement}</span>
              {forecastError && <p className="error">{forecastError}</p>}
              <div className="legend">
                {Object.entries(RISK_COLORS).map(([label, color]) => (
                  <span key={label}><i style={{ background: color }} />{label}</span>
                ))}
              </div>
            </div>
          )}
        </aside>

        <section className="map-panel">
          <MapContainer center={[41.8781, -87.6298]} zoom={7} scrollWheelZoom>
            <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <WindDemoFocus active={windDemo} />
            {mapLayers.weather && radarTimestamp && (
              <TileLayer
                url={`https://tilecache.rainviewer.com/v2/radar/${radarTimestamp}/256/{z}/{x}/{y}/2/1_1.png`}
                opacity={0.55}
                zIndex={2}
                maxNativeZoom={7}
                attribution="Radar: RainViewer"
              />
            )}
            {data && <FitRoutes routes={activeRoutes} origin={data.origin} destination={data.destination} />}
            {activeRoutes.map((route) => (
              <RouteLine
                key={route.id}
                route={route}
                isSelected={route.id === selectedRoute?.id}
                onSelect={setSelectedRouteId}
              />
            ))}
            <CorridorHeatLayer cells={corridorCells} />
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
            {windDemo && (
              <CircleMarker
                center={[WIND_DEMO_POINT.lat, WIND_DEMO_POINT.lon]}
                radius={12}
                pathOptions={{
                  color: "#7a1f25",
                  fillColor: RISK_COLORS["No Travel"],
                  fillOpacity: 1,
                  weight: 4,
                }}
              >
                <Tooltip permanent direction="top" offset={[0, -10]} className="demo-marker-label">
                  DEMO · NO TRAVEL
                </Tooltip>
                <Popup>
                  <strong>SIMULATED DEMO — NOT LIVE WEATHER</strong><br />
                  {WIND_DEMO_POINT.place}<br />
                  Wind: {WIND_DEMO_POINT.wind} mph<br />
                  Risk: No Travel
                </Popup>
              </CircleMarker>
            )}
          </MapContainer>
        </section>
      </section>
      <WeatherToolbar
        mapLayers={mapLayers}
        setMapLayers={setMapLayers}
        radarLoading={radarLoading}
        radarError={radarError}
        alertCheckpoints={alertCheckpoints}
        forecastHour={forecastHour}
      />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
