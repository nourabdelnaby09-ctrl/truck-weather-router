// Pure risk and ranking logic. No React imports. Single source of truth for
// checkpoint risk classification and route recommendation.

export const RISK_ORDER = Object.freeze({
  Low: 1,
  Moderate: 2,
  High: 3,
  Severe: 4,
  "No Travel": 5,
});

// Named constant table mirroring the assessment spec exactly.
// Ranges are [min, max) except the final band, which is unbounded.
export const RISK_THRESHOLDS = Object.freeze({
  windMph: Object.freeze([
    Object.freeze({ min: 55, level: "No Travel" }),
    Object.freeze({ min: 45, level: "Severe" }),
    Object.freeze({ min: 35, level: "High" }),
    Object.freeze({ min: 25, level: "Moderate" }),
    Object.freeze({ min: 0, level: "Low" }),
  ]),
  rainInHr: Object.freeze([
    Object.freeze({ min: 1.0, exclusive: true, level: "No Travel" }),
    Object.freeze({ min: 0.5, level: "Severe" }),
    Object.freeze({ min: 0.25, level: "High" }),
    Object.freeze({ min: 0.1, level: "Moderate" }),
    Object.freeze({ min: 0, level: "Low" }),
  ]),
  snowInHr: Object.freeze([
    Object.freeze({ min: 3.0, exclusive: true, level: "No Travel" }),
    Object.freeze({ min: 2.0, level: "Severe" }),
    Object.freeze({ min: 1.0, level: "High" }),
    Object.freeze({ min: 0.5, level: "Moderate" }),
    Object.freeze({ min: 0, level: "Low" }),
  ]),
});

export function worstLevel(levels) {
  return levels.reduce((worst, level) => (
    RISK_ORDER[level] > RISK_ORDER[worst] ? level : worst
  ), "Low");
}

function baseLevel(value, table) {
  for (const band of table) {
    const above = band.exclusive ? value > band.min : value >= band.min;
    if (above) return band.level;
  }
  return "Low";
}

// Load rules can only escalate a wind classification, never downgrade it.
export function windLevel(windMph, loadLbs) {
  const base = baseLevel(windMph, RISK_THRESHOLDS.windMph);
  let level = base;
  if (windMph >= 55) level = "No Travel";
  if (windMph >= 45 && windMph < 55 && loadLbs > 30000) level = "No Travel";
  if (windMph >= 35 && windMph < 45 && loadLbs > 40000) level = "Severe";
  return worstLevel([base, level]);
}

export function classifyCondition(windMph, rainInHr, snowInHr, loadLbs) {
  return worstLevel([
    windLevel(windMph, loadLbs),
    baseLevel(rainInHr, RISK_THRESHOLDS.rainInHr),
    baseLevel(snowInHr, RISK_THRESHOLDS.snowInHr),
  ]);
}

// Recompute risk from raw weather values so the UI never trusts a second source.
export function withRisk(checkpoints, loadLbs) {
  return checkpoints.map((point) => ({
    ...point,
    risk: classifyCondition(
      Number(point.wind) || 0,
      Number(point.rain) || 0,
      Number(point.snow) || 0,
      Number(loadLbs) || 0,
    ),
  }));
}

export function scoreRoute(route, loadLbs) {
  const checkpoints = withRisk(route.checkpoints || [], loadLbs);
  const totalMiles = Number(route.distanceMiles) || 0;
  let severeMiles = 0;
  let highMiles = 0;
  let noTravelMiles = 0;
  let weightedRisk = 0;
  let measuredMiles = 0;

  checkpoints.forEach((point, index) => {
    const next = checkpoints[index + 1];
    const segment = Math.max(
      0,
      next ? Number(next.distance) - Number(point.distance) : totalMiles - Number(point.distance),
    );
    if (point.risk === "Severe") severeMiles += segment;
    if (point.risk === "High") highMiles += segment;
    if (point.risk === "No Travel") noTravelMiles += segment;
    weightedRisk += RISK_ORDER[point.risk] * segment;
    measuredMiles += segment;
  });

  // Spec: Severe + No Travel miles both count as Severe miles.
  const combinedSevereMiles = severeMiles + noTravelMiles;
  const averageRisk = measuredMiles > 0 ? weightedRisk / measuredMiles : 1;

  return {
    ...route,
    checkpoints,
    severeMiles: Number(combinedSevereMiles.toFixed(1)),
    highMiles: Number(highMiles.toFixed(1)),
    noTravelMiles: Number(noTravelMiles.toFixed(1)),
    averageRisk: Number(averageRisk.toFixed(2)),
  };
}

// Lexicographic ranking in the exact spec order. No composite score.
export function rankRoutes(routes, loadLbs) {
  return routes
    .map((route) => scoreRoute(route, loadLbs))
    .sort((a, b) => (
      a.severeMiles - b.severeMiles
      || a.highMiles - b.highMiles
      || a.averageRisk - b.averageRisk
      || a.durationSeconds - b.durationSeconds
    ))
    .map((route, index) => ({
      ...route,
      recommended: index === 0,
      rank: index + 1,
      reason: rankingReason(route),
    }));
}

function rankingReason(route) {
  if (route.severeMiles > 0) return `Fewest severe miles (${route.severeMiles} mi)`;
  if (route.highMiles > 0) return `Fewest high-risk miles (${route.highMiles} mi)`;
  if (route.averageRisk > 1) return `Lowest average risk (${route.averageRisk})`;
  return `Shortest travel time (${Math.round(route.durationSeconds / 60)} min)`;
}
