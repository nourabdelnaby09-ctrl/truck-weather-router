import math
import time
from datetime import datetime, timedelta, timezone
from decimal import InvalidOperation
from hashlib import sha256

import requests
from django.conf import settings
from django.core.cache import cache
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

RISK_ORDER = {"Low": 1, "Moderate": 2, "High": 3, "Severe": 4, "No Travel": 5}
WEATHER_UNAVAILABLE_MESSAGE = (
    "Weather forecasts are temporarily unavailable. Check your connection and try again; "
    "no route risk estimate was generated."
)


class WeatherProviderUnavailable(Exception):
    pass


class ForecastOutOfRange(ValueError):
    pass


def haversine_miles(a, b):
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 3958.7613 * 2 * math.asin(math.sqrt(h))


def geocode(value):
    response = requests.get(
        "https://nominatim.openstreetmap.org/search",
        params={"q": value, "format": "json", "limit": 1},
        headers={"User-Agent": "TruckWeatherRouter/1.0"},
        timeout=12,
    )
    response.raise_for_status()
    data = response.json()
    if not data:
        raise ValueError(f"No location found for: {value}")
    return [float(data[0]["lat"]), float(data[0]["lon"]), data[0]["display_name"]]


def classify_condition(wind, rain, snow, load_lbs):
    levels = []
    if wind is not None:
        if wind >= 55:
            levels.append("No Travel")
        elif wind >= 45:
            levels.append("No Travel" if load_lbs > 30000 else "Severe")
        elif wind >= 35:
            levels.append("Severe" if load_lbs > 40000 else "High")
        elif wind >= 25:
            levels.append("Moderate")
        else:
            levels.append("Low")
    if rain is not None:
        if rain > 1:
            levels.append("No Travel")
        elif rain >= 0.50:
            levels.append("Severe")
        elif rain >= 0.25:
            levels.append("High")
        elif rain >= 0.10:
            levels.append("Moderate")
        else:
            levels.append("Low")
    if snow is not None:
        if snow > 3:
            levels.append("No Travel")
        elif snow >= 2:
            levels.append("Severe")
        elif snow >= 1:
            levels.append("High")
        elif snow >= 0.5:
            levels.append("Moderate")
        else:
            levels.append("Low")
    levels = levels or ["Low"]
    return max(levels, key=lambda level: RISK_ORDER[level])


def fetch_weather_forecast(params):
    for attempt in range(2):
        try:
            response = requests.get(
                "https://api.open-meteo.com/v1/forecast",
                params=params,
                timeout=(5, 15),
            )
            response.raise_for_status()
            return response.json()
        except (requests.Timeout, requests.ConnectionError) as exc:
            if attempt == 1:
                raise WeatherProviderUnavailable(WEATHER_UNAVAILABLE_MESSAGE) from exc
            time.sleep(0.25)
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code >= 500 and attempt == 0:
                time.sleep(0.25)
                continue
            raise WeatherProviderUnavailable(WEATHER_UNAVAILABLE_MESSAGE) from exc


def weather_target(at_time):
    return at_time.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def weather_cache_key(lat, lon, at_time):
    target = weather_target(at_time)
    return "weather:" + sha256(
        f"{lat:.2f}:{lon:.2f}:{target.isoformat()}".encode()
    ).hexdigest()


def hourly_index(hourly, at_time):
    times = hourly.get("time", [])
    if not times:
        raise ValueError("Weather provider returned no hourly forecast.")
    target_naive = weather_target(at_time).replace(tzinfo=None)
    differences = []
    forecast_hours = []
    for index, timestamp in enumerate(times):
        try:
            forecast_time = datetime.fromisoformat(timestamp)
        except ValueError:
            continue
        forecast_hours.append(forecast_time)
        differences.append((abs((forecast_time - target_naive).total_seconds()), index))
    if not differences:
        raise ValueError("Weather provider returned invalid hourly timestamps.")
    if forecast_hours and not forecast_hours[0] <= target_naive <= forecast_hours[-1]:
        raise ForecastOutOfRange(
            "The requested trip time is outside the available 7-day forecast. "
            "Choose an earlier departure or a smaller forecast offset."
        )
    return min(differences)[1]


def weather_from_hourly(hourly, index, elevation=None):
    def value(name):
        values = hourly.get(name, [])
        return values[index] if index < len(values) and values[index] is not None else 0

    return {
        "temperature": value("temperature_2m"),
        "rain": value("rain"),
        "snow": value("snowfall"),
        "wind": value("wind_speed_10m"),
        "elevation": elevation,
    }


def weather_at(lat, lon, at_time):
    cache_key = weather_cache_key(lat, lon, at_time)
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    forecast = fetch_weather_forecast(
        {
            "latitude": lat,
            "longitude": lon,
            "hourly": "temperature_2m,precipitation,rain,snowfall,wind_speed_10m",
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",
            "timezone": "UTC",
            "forecast_days": 7,
        }
    )
    result = weather_from_hourly(
        forecast.get("hourly", {}),
        hourly_index(forecast.get("hourly", {}), at_time),
        forecast.get("elevation"),
    )
    cache.set(cache_key, result, 60 * 60)
    return result


def interpolate_geometry(coordinates, total_meters, interval_miles):
    if not coordinates:
        return []
    total_distance_miles = total_meters / 1609.344
    segment_lengths = [
        haversine_miles([first[1], first[0]], [second[1], second[0]]) * 1609.344
        for first, second in zip(coordinates, coordinates[1:])
    ]
    geometry_distance = sum(segment_lengths)
    distance_scale = total_meters / geometry_distance if geometry_distance else 0
    sampled = [{
        "lat": coordinates[0][1],
        "lon": coordinates[0][0],
        "distance": 0,
        "progress": 0,
    }]
    distance_meters = 0
    next_sample = interval_miles * 1609.344
    for first, second, geometry_segment in zip(coordinates, coordinates[1:], segment_lengths):
        segment = geometry_segment * distance_scale
        segment_start = distance_meters
        while next_sample < segment_start + segment and next_sample < total_meters:
            fraction = 0 if segment == 0 else min(1, max(0, (next_sample - segment_start) / segment))
            lon = first[0] + (second[0] - first[0]) * fraction
            lat = first[1] + (second[1] - first[1]) * fraction
            progress = next_sample / total_meters if total_meters else 1
            sampled.append({"lat": lat, "lon": lon, "distance": next_sample / 1609.344, "progress": progress})
            next_sample += interval_miles * 1609.344
        distance_meters += segment

    if total_distance_miles > sampled[-1]["distance"]:
        sampled.append({
            "lat": coordinates[-1][1],
            "lon": coordinates[-1][0],
            "distance": total_distance_miles,
            "progress": 1,
        })
    return sampled


def parse_datetime(value):
    if not isinstance(value, str):
        raise ValueError("Datetime values must be ISO 8601 strings.")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def checkpoint_weather(points, load_lbs, forecast_hour=0):
    checkpoints = []
    for point in points:
        arrival = parse_datetime(point["arrival"]) + timedelta(hours=forecast_hour)
        raw = weather_at(float(point["lat"]), float(point["lon"]), arrival)
        checkpoints.append({
            **point,
            "arrival": arrival.isoformat(),
            "risk": classify_condition(raw["wind"], raw["rain"], raw["snow"], load_lbs),
            "wind": raw["wind"],
            "rain": raw["rain"],
            "snow": raw["snow"],
            "temperature": raw["temperature"],
            "elevation": raw.get("elevation"),
        })
    return checkpoints


def summarize_roads(route):
    names = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            name = (step.get("name") or "").strip()
            if name and (not names or names[-1] != name):
                names.append(name)
    if not names:
        return "Road names unavailable"
    summary = " → ".join(names[:4])
    return f"{summary} → …" if len(names) > 4 else summary


def corridor_cells(geometry, radius_miles=25, step_deg=0.25, limit=500):
    """Grid of cell centres within `radius_miles` of a GeoJSON [lon, lat] line."""
    route_points = [(float(point[1]), float(point[0])) for point in geometry]
    if not route_points:
        return []

    # Subsample long geometries so nearest-distance checks stay cheap.
    stride = max(1, len(route_points) // 80)
    samples = route_points[::stride]
    if samples[-1] != route_points[-1]:
        samples.append(route_points[-1])

    padding = radius_miles / 69.0
    lat_min = min(point[0] for point in route_points) - padding
    lat_max = max(point[0] for point in route_points) + padding
    lon_min = min(point[1] for point in route_points) - padding
    lon_max = max(point[1] for point in route_points) + padding

    cells = []
    lat = math.floor(lat_min / step_deg) * step_deg
    while lat <= lat_max:
        lon = math.floor(lon_min / step_deg) * step_deg
        while lon <= lon_max:
            centre = (round(lat, 3), round(lon, 3))
            if any(haversine_miles(centre, point) <= radius_miles for point in samples):
                cells.append(centre)
            lon += step_deg
        lat += step_deg

    if len(cells) > limit:
        keep = max(1, len(cells) // limit)
        cells = cells[::keep][:limit]
    return cells


def batch_weather_at(cells, at_time, load_lbs):
    """One Open-Meteo request for all cells; results cached per cell/hour."""
    if not cells:
        return []
    forecast = fetch_weather_forecast(
        {
            "latitude": ",".join(f"{lat:.3f}" for lat, _ in cells),
            "longitude": ",".join(f"{lon:.3f}" for _, lon in cells),
            "hourly": "temperature_2m,precipitation,rain,snowfall,wind_speed_10m",
            "wind_speed_unit": "mph",
            "precipitation_unit": "inch",
            "timezone": "UTC",
            "forecast_days": 7,
        }
    )
    forecasts = forecast if isinstance(forecast, list) else [forecast]
    target = weather_target(at_time)
    results = []
    for (lat, lon), single in zip(cells, forecasts):
        hourly = single.get("hourly", {})
        weather = weather_from_hourly(hourly, hourly_index(hourly, at_time), single.get("elevation"))
        results.append({
            "lat": lat,
            "lon": lon,
            "risk": classify_condition(weather["wind"], weather["rain"], weather["snow"], load_lbs),
            "wind": weather["wind"],
            "rain": weather["rain"],
            "snow": weather["snow"],
        })
        cache.set(weather_cache_key(lat, lon, target), weather, 60 * 60)
    return results


@csrf_exempt
@require_POST
def plan_route(request):
    try:
        import json
        body = json.loads(request.body or "{}")
        origin = geocode(body["origin"])
        destination = geocode(body["destination"])
        load_lbs = float(body["loadWeight"])
        interval = int(body.get("intervalMiles", 25))
        if interval not in (10, 25, 50):
            interval = 25
        departure = parse_datetime(body["departure"])

        coordinates_for_route = [
            (origin[1], origin[0]),
            (destination[1], destination[0]),
        ]
        midpoint_lon = (origin[1] + destination[1]) / 2
        midpoint_lat = (origin[0] + destination[0]) / 2
        detours = [
            [(origin[1], origin[0]), (midpoint_lon - 0.20, midpoint_lat + 0.20), (destination[1], destination[0])],
            [(origin[1], origin[0]), (midpoint_lon + 0.20, midpoint_lat - 0.20), (destination[1], destination[0])],
        ]
        route_requests = [coordinates_for_route, *detours]
        routes = []
        seen_distance = set()
        for route_coordinates in route_requests:
            route_url = settings.ROUTING_API_URL + "/" + ";".join(
                f"{lon},{lat}" for lon, lat in route_coordinates
            )
            route_response = requests.get(
                route_url,
                params={"alternatives": "true", "steps": "true", "geometries": "geojson", "overview": "full"},
                headers={"User-Agent": "TruckWeatherRouter/1.0"},
                timeout=20,
            )
            route_response.raise_for_status()
            for candidate in route_response.json().get("routes", []):
                distance_key = round(candidate["distance"] / 1609.344)
                if distance_key not in seen_distance:
                    seen_distance.add(distance_key)
                    routes.append(candidate)
                if len(routes) == 3:
                    break
            if len(routes) == 3:
                break
        if not routes:
            return JsonResponse({"error": "No routes found."}, status=404)

        results = []
        for route_index, route in enumerate(routes, start=1):
            duration_seconds = route["duration"]
            distance_miles = route["distance"] / 1609.344
            coordinates = route["geometry"]["coordinates"]
            points = interpolate_geometry(coordinates, route["distance"], interval)
            severe_miles = 0
            high_miles = 0
            no_travel_miles = 0
            weighted_risk = 0
            measured_miles = 0

            arrivals = [
                {**point, "arrival": (departure + timedelta(seconds=duration_seconds * point["progress"])).isoformat()}
                for point in points
            ]
            checkpoints = checkpoint_weather(arrivals, load_lbs)
            for checkpoint_index, point in enumerate(checkpoints):
                risk = point["risk"]
                next_distance = checkpoints[checkpoint_index + 1]["distance"] if checkpoint_index + 1 < len(checkpoints) else distance_miles
                segment_miles = max(0, next_distance - point["distance"])
                # Spec: Severe and No Travel miles both count as Severe miles.
                if risk in ("Severe", "No Travel"):
                    severe_miles += segment_miles
                if risk == "No Travel":
                    no_travel_miles += segment_miles
                if risk == "High":
                    high_miles += segment_miles
                weighted_risk += RISK_ORDER[risk] * segment_miles
                measured_miles += segment_miles

            average_risk = weighted_risk / measured_miles if measured_miles else 1
            results.append({
                "id": route_index,
                "name": f"Route {route_index}",
                "roadSummary": summarize_roads(route),
                "distanceMiles": round(distance_miles, 1),
                "durationSeconds": round(duration_seconds),
                "eta": (departure + timedelta(seconds=duration_seconds)).isoformat(),
                "geometry": coordinates,
                "checkpoints": checkpoints,
                "severeMiles": round(severe_miles, 1),
                "highMiles": round(high_miles, 1),
                "noTravelMiles": round(no_travel_miles, 1),
                "averageRisk": round(average_risk, 2),
            })

        results.sort(key=lambda r: (
            r["severeMiles"],
            r["highMiles"],
            r["averageRisk"],
            r["durationSeconds"],
        ))
        for index, route in enumerate(results, start=1):
            route["recommended"] = index == 1

        return JsonResponse({
            "origin": {"lat": origin[0], "lon": origin[1], "name": origin[2]},
            "destination": {"lat": destination[0], "lon": destination[1], "name": destination[2]},
            "routes": results,
        })
    except ForecastOutOfRange as exc:
        return JsonResponse({"error": str(exc)}, status=422)
    except WeatherProviderUnavailable as exc:
        return JsonResponse({"error": str(exc)}, status=503)
    except (KeyError, ValueError, InvalidOperation, requests.RequestException) as exc:
        return JsonResponse({"error": str(exc)}, status=400)


@csrf_exempt
@require_POST
def heatmap(request):
    try:
        import json
        body = json.loads(request.body or "{}")
        forecast_hour = int(body.get("forecastHour", 0))
        if not 0 <= forecast_hour <= 48:
            raise ValueError("forecastHour must be between 0 and 48.")
        load_lbs = float(body["loadWeight"])
        routes = body["routes"]
        if not isinstance(routes, list) or len(routes) > 3:
            raise ValueError("routes must be a list of at most three routes.")

        forecast_routes = []
        for route in routes:
            points = route["checkpoints"]
            if not isinstance(points, list) or len(points) > 500:
                raise ValueError("Each route must contain a list of at most 500 checkpoints.")
            forecast_routes.append({
                "id": route["id"],
                "checkpoints": checkpoint_weather(points, load_lbs, forecast_hour),
            })
        return JsonResponse({"forecastHour": forecast_hour, "routes": forecast_routes})
    except ForecastOutOfRange as exc:
        return JsonResponse({"error": str(exc)}, status=422)
    except WeatherProviderUnavailable as exc:
        return JsonResponse({"error": str(exc)}, status=503)
    except (KeyError, TypeError, ValueError, InvalidOperation, requests.RequestException) as exc:
        return JsonResponse({"error": str(exc)}, status=400)


@csrf_exempt
@require_POST
def corridor(request):
    """Canvas heatmap source: a risk grid within 25 mi of one route."""
    try:
        import json
        body = json.loads(request.body or "{}")
        forecast_hour = int(body.get("forecastHour", 0))
        if not 0 <= forecast_hour <= 48:
            raise ValueError("forecastHour must be between 0 and 48.")
        load_lbs = float(body["loadWeight"])
        geometry = body["geometry"]
        if not isinstance(geometry, list) or len(geometry) < 2:
            raise ValueError("geometry must be a GeoJSON coordinate array.")
        target = parse_datetime(body["departure"]) + timedelta(hours=forecast_hour)
        cells = corridor_cells(geometry)
        return JsonResponse({
            "hour": forecast_hour,
            "cells": batch_weather_at(cells, target, load_lbs),
        })
    except ForecastOutOfRange as exc:
        return JsonResponse({"error": str(exc)}, status=422)
    except WeatherProviderUnavailable as exc:
        return JsonResponse({"error": str(exc)}, status=503)
    except (KeyError, TypeError, ValueError, InvalidOperation, requests.RequestException) as exc:
        return JsonResponse({"error": str(exc)}, status=400)
