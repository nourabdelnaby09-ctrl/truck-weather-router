import { describe, expect, it } from "vitest";

import {
  RISK_ORDER,
  classifyCondition,
  rankRoutes,
  windLevel,
} from "./risk.js";

const calm = (wind, rain = 0, snow = 0, load = 20000) => (
  classifyCondition(wind, rain, snow, load)
);

describe("exact wind thresholds", () => {
  it.each([
    [24.9, "Low"],
    [25, "Moderate"],
    [34.9, "Moderate"],
    [35, "High"],
    [44.9, "High"],
    [45, "Severe"],
    [54.9, "Severe"],
    [55, "No Travel"],
  ])("%s mph -> %s", (mph, expected) => {
    expect(calm(mph)).toBe(expected);
  });
});

describe("exact rain thresholds", () => {
  it.each([
    [0.09, "Low"],
    [0.1, "Moderate"],
    [0.249, "Moderate"],
    [0.25, "High"],
    [0.499, "High"],
    [0.5, "Severe"],
    [1.0, "Severe"],
    [1.01, "No Travel"],
  ])("%s in/hr -> %s", (rain, expected) => {
    expect(calm(0, rain)).toBe(expected);
  });
});

describe("exact snow thresholds", () => {
  it.each([
    [0.49, "Low"],
    [0.5, "Moderate"],
    [0.99, "Moderate"],
    [1.0, "High"],
    [1.99, "High"],
    [2.0, "Severe"],
    [3.0, "Severe"],
    [3.01, "No Travel"],
  ])("%s in/hr -> %s", (snow, expected) => {
    expect(calm(0, 0, snow)).toBe(expected);
  });
});

describe("load rules", () => {
  it("45-54 mph with exactly 30,000 lb stays Severe", () => {
    expect(calm(46, 0, 0, 30000)).toBe("Severe");
  });
  it("45-54 mph above 30,000 lb becomes No Travel", () => {
    expect(calm(46, 0, 0, 30001)).toBe("No Travel");
  });
  it("35-44 mph with exactly 40,000 lb stays High", () => {
    expect(calm(36, 0, 0, 40000)).toBe("High");
  });
  it("35-44 mph above 40,000 lb becomes Severe", () => {
    expect(calm(36, 0, 0, 40001)).toBe("Severe");
  });
  it(">=55 mph is No Travel for any load", () => {
    expect(calm(55, 0, 0, 1)).toBe("No Travel");
  });
  it("escalation never downgrades an already higher level", () => {
    expect(RISK_ORDER[windLevel(55, 1)]).toBeGreaterThanOrEqual(RISK_ORDER["No Travel"]);
    expect(calm(46, 1.5, 0, 1)).toBe("No Travel");
  });
});

describe("ranking", () => {
  const route = (id, checkpoints, distanceMiles = 100, durationSeconds = 3600) => ({
    id,
    name: `Route ${id}`,
    checkpoints,
    distanceMiles,
    durationSeconds,
  });
  const cp = (distance, risk, wind = 0, rain = 0, snow = 0) => ({
    distance,
    wind,
    rain,
    snow,
    risk,
  });

  it("counts No Travel miles as Severe miles", () => {
    const ranked = rankRoutes([
      route(1, [cp(0, "Low"), cp(100, "Low")]),
      route(2, [cp(0, "No Travel", 55), cp(100, "Low")]),
    ], 20000);
    expect(ranked[0].id).toBe(1);
    expect(ranked[1].severeMiles).toBe(100);
  });

  it("uses segment-mile-weighted average risk, then time", () => {
    const ranked = rankRoutes([
      route(1, [cp(0, "Moderate", 25), cp(100, "Low")]),
      route(2, [cp(0, "High", 35), cp(100, "Low")], 100, 3000),
    ], 20000);
    expect(ranked[0].id).toBe(1);
    expect(ranked[0].averageRisk).toBeLessThan(ranked[1].averageRisk);
  });

  it("marks exactly one recommended route", () => {
    const ranked = rankRoutes([
      route(1, [cp(0, "Low"), cp(100, "Low")], 100, 4000),
      route(2, [cp(0, "Low"), cp(100, "Low")], 100, 3000),
    ], 20000);
    expect(ranked.filter((r) => r.recommended)).toHaveLength(1);
    expect(ranked[0].id).toBe(2);
  });
});
