import { describe, expect, it } from "vitest";

import { downsampleGeometry, toLeafletPositions } from "./geometry.js";

describe("downsampleGeometry", () => {
  it("keeps short lines unchanged", () => {
    const line = [[0, 0], [1, 1], [2, 2]];
    expect(downsampleGeometry(line, 400)).toBe(line);
  });

  it("caps long lines and preserves both endpoints", () => {
    const line = Array.from({ length: 1000 }, (_, index) => [index, index]);
    const result = downsampleGeometry(line, 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result[0]).toEqual(line[0]);
    expect(result[result.length - 1]).toEqual(line[line.length - 1]);
  });
});

describe("toLeafletPositions", () => {
  it("swaps GeoJSON lon/lat into Leaflet lat/lon", () => {
    expect(toLeafletPositions([[-87.6, 41.8], [-87.5, 41.9]])).toEqual([
      [41.8, -87.6],
      [41.9, -87.5],
    ]);
  });
});
