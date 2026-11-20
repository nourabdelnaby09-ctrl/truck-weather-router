from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import requests
from django.core.cache import cache
from django.test import Client, SimpleTestCase
from django.test.utils import override_settings

from .views import (
    ForecastOutOfRange,
    WEATHER_UNAVAILABLE_MESSAGE,
    WeatherProviderUnavailable,
    classify_condition,
    haversine_miles,
    interpolate_geometry,
    summarize_roads,
    weather_at,
)


class RoutingUnitTests(SimpleTestCase):
    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def test_interpolation_partitions_route_distance_without_overshooting(self):
        coordinates = [[0, 0], [1, 0]]
        total_meters = haversine_miles([0, 0], [0, 1]) * 1609.344

        checkpoints = interpolate_geometry(coordinates, total_meters, 25)
        segment_miles = [
            checkpoints[index + 1]["distance"] - point["distance"]
            for index, point in enumerate(checkpoints[:-1])
        ]
        segment_miles.append(total_meters / 1609.344 - checkpoints[-1]["distance"])

        self.assertEqual(checkpoints[0]["distance"], 0)
        self.assertEqual(checkpoints[-1]["progress"], 1)
        self.assertAlmostEqual(sum(segment_miles), total_meters / 1609.344)
        self.assertTrue(all(segment >= 0 for segment in segment_miles))

    def test_no_travel_wind_is_classified_and_reported(self):
        self.assertEqual(classify_condition(46, 0, 0, 35000), "No Travel")

    def test_road_summary_skips_empty_and_consecutive_duplicate_names(self):
        summary = summarize_roads({
            "legs": [{
                "steps": [
                    {"name": "I-90"},
                    {"name": "I-90"},
                    {"name": ""},
                    {"name": "I-94"},
                    {"name": "US-12"},
                    {"name": "M-14"},
                    {"name": "I-96"},
                ]
            }]
        })

        self.assertEqual(summary, "I-90 → I-94 → US-12 → M-14 → …")

    @patch("routing.views.weather_at")
    @patch("routing.views.requests.get")
    @patch("routing.views.geocode")
    def test_plan_route_counts_the_final_checkpoint_segment(self, geocode, get_route, get_weather):
        origin = [0, 0, "Origin"]
        destination = [0, 1, "Destination"]
        geocode.side_effect = [origin, destination]
        distance_meters = haversine_miles([0, 0], [0, 1]) * 1609.344

        class RouteResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "routes": [
                        {
                            "distance": distance_meters,
                            "duration": 3600,
                            "geometry": {"coordinates": [[0, 0], [1, 0]]},
                            "legs": [{
                                "steps": [{"name": "I-90"}, {"name": "I-94"}],
                            }],
                        },
                        {
                            "distance": distance_meters + 1000,
                            "duration": 3700,
                            "geometry": {"coordinates": [[0, 0], [1, 0]]},
                            "legs": [{"steps": [{"name": "US-12"}]}],
                        },
                    ]
                }

        get_route.return_value = RouteResponse()
        get_weather.return_value = {
            "wind": 46,
            "rain": 0,
            "snow": 0,
            "temperature": 10,
        }
        client = Client()
        response = client.post(
            "/api/plan-route/",
            data={
                "origin": "Origin",
                "destination": "Destination",
                "departure": "2026-01-01T10:00:00-05:00",
                "loadWeight": 35000,
                "intervalMiles": 50,
            },
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        routes = response.json()["routes"]
        self.assertEqual([route["id"] for route in routes], [1, 2])
        self.assertEqual([route["name"] for route in routes], ["Route 1", "Route 2"])
        self.assertEqual(routes[0]["roadSummary"], "I-90 → I-94")
        self.assertEqual(routes[1]["roadSummary"], "US-12")
        route = routes[0]
        self.assertEqual(route["noTravelMiles"], route["distanceMiles"])
        self.assertEqual(route["checkpoints"][0]["arrival"], "2026-01-01T10:00:00-05:00")
        self.assertEqual(route["checkpoints"][-1]["progress"], 1)

    @patch("routing.views.requests.get")
    def test_weather_is_cached_and_forecast_is_matched_in_utc(self, get):
        class Response:
            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "hourly": {
                        "time": ["2026-01-01T10:00", "2026-01-01T11:00"],
                        "temperature_2m": [4, 5],
                        "rain": [0, 0],
                        "snowfall": [0, 0],
                        "wind_speed_10m": [20, 50],
                    }
                }

        get.return_value = Response()
        local_time = datetime(2026, 1, 1, 13, tzinfo=timezone(timedelta(hours=3)))

        first = weather_at(41.8, -87.6, local_time)
        second = weather_at(41.8, -87.6, local_time)

        self.assertEqual(first["wind"], 20)
        self.assertEqual(second, first)
        get.assert_called_once()
        self.assertEqual(get.call_args.kwargs["params"]["timezone"], "UTC")
        self.assertEqual(get.call_args.kwargs["params"]["forecast_days"], 7)

    @patch("routing.views.requests.get")
    def test_weather_rejects_trip_times_after_the_available_forecast(self, get):
        class Response:
            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "hourly": {
                        "time": ["2026-01-01T10:00", "2026-01-01T11:00"],
                        "temperature_2m": [4, 5],
                        "rain": [0, 0],
                        "snowfall": [0, 0],
                        "wind_speed_10m": [20, 20],
                    }
                }

        get.return_value = Response()

        with self.assertRaises(ForecastOutOfRange):
            weather_at(41.8, -87.6, datetime(2026, 1, 1, 12, tzinfo=timezone.utc))

    @override_settings(ROUTING_API_URL="https://routing.example/route/v1/driving/")
    @patch("routing.views.weather_at")
    @patch("routing.views.requests.get")
    @patch("routing.views.geocode")
    def test_route_uses_configured_routing_endpoint(self, geocode, get_route, get_weather):
        geocode.side_effect = [[0, 0, "Origin"], [0, 1, "Destination"]]
        distance_meters = haversine_miles([0, 0], [0, 1]) * 1609.344

        class RouteResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "routes": [{
                        "distance": distance_meters,
                        "duration": 3600,
                        "geometry": {"coordinates": [[0, 0], [1, 0]]},
                    }]
                }

        get_route.return_value = RouteResponse()
        get_weather.return_value = {
            "wind": 10,
            "rain": 0,
            "snow": 0,
            "temperature": 10,
        }
        response = Client().post(
            "/api/plan-route/",
            data={
                "origin": "Origin",
                "destination": "Destination",
                "departure": "2026-01-01T10:00:00Z",
                "loadWeight": 35000,
                "intervalMiles": 50,
            },
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(
            get_route.call_args.args[0].startswith(
                "https://routing.example/route/v1/driving/"
            )
        )

    @patch("routing.views.time.sleep")
    @patch("routing.views.requests.get")
    def test_weather_retries_a_transient_connection_timeout(self, get, sleep):
        class Response:
            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "hourly": {
                        "time": ["2026-01-01T10:00"],
                        "temperature_2m": [4],
                        "rain": [0],
                        "snowfall": [0],
                        "wind_speed_10m": [20],
                    }
                }

        get.side_effect = [requests.ConnectTimeout("temporary timeout"), Response()]

        result = weather_at(41.8, -87.6, datetime(2026, 1, 1, 10, tzinfo=timezone.utc))

        self.assertEqual(result["wind"], 20)
        self.assertEqual(get.call_count, 2)
        self.assertEqual(get.call_args.kwargs["timeout"], (5, 15))
        sleep.assert_called_once_with(0.25)

    @patch("routing.views.weather_at", side_effect=WeatherProviderUnavailable(WEATHER_UNAVAILABLE_MESSAGE))
    @patch("routing.views.requests.get")
    @patch("routing.views.geocode")
    def test_plan_route_reports_weather_provider_outage_as_service_unavailable(
        self, geocode, get_route, get_weather
    ):
        geocode.side_effect = [[0, 0, "Origin"], [0, 1, "Destination"]]
        distance_meters = haversine_miles([0, 0], [0, 1]) * 1609.344

        class RouteResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "routes": [{
                        "distance": distance_meters,
                        "duration": 3600,
                        "geometry": {"coordinates": [[0, 0], [1, 0]]},
                    }]
                }

        get_route.return_value = RouteResponse()
        response = Client().post(
            "/api/plan-route/",
            data={
                "origin": "Origin",
                "destination": "Destination",
                "departure": "2026-01-01T10:00:00Z",
                "loadWeight": 35000,
                "intervalMiles": 50,
            },
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"], WEATHER_UNAVAILABLE_MESSAGE)
        get_weather.assert_called_once()

    @patch("routing.views.weather_at")
    def test_heatmap_shifts_checkpoint_time_and_classifies_load(self, get_weather):
        get_weather.return_value = {
            "wind": 46,
            "rain": 0,
            "snow": 0,
            "temperature": 10,
        }
        client = Client()
        response = client.post(
            "/api/heatmap/",
            data={
                "forecastHour": 2,
                "loadWeight": 35000,
                "routes": [{
                    "id": 1,
                    "checkpoints": [{
                        "lat": 41.8,
                        "lon": -87.6,
                        "arrival": "2026-01-01T10:00:00+00:00",
                        "distance": 0,
                        "progress": 0,
                    }],
                }],
            },
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        point = response.json()["routes"][0]["checkpoints"][0]
        self.assertEqual(point["risk"], "No Travel")
        self.assertEqual(point["arrival"], "2026-01-01T12:00:00+00:00")
        self.assertEqual(get_weather.call_args.args[2], datetime(2026, 1, 1, 12, tzinfo=timezone.utc))
