// Pure geometry helpers for rendering performance. No React imports.

// Leaflet only needs enough vertices to preserve the road shape on screen.
// Keeping at most `maxPoints` vertices avoids re-rendering thousands of
// coordinates every time the dashboard state changes.
export function downsampleGeometry(coordinates, maxPoints = 400) {
  if (!Array.isArray(coordinates) || coordinates.length <= maxPoints) {
    return coordinates || [];
  }
  const last = coordinates.length - 1;
  const stride = Math.ceil(last / (maxPoints - 1));
  const result = [];
  for (let index = 0; index <= last; index += stride) {
    result.push(coordinates[index]);
  }
  if (result[result.length - 1] !== coordinates[last]) {
    result.push(coordinates[last]);
  }
  return result;
}

// GeoJSON [lon, lat] -> Leaflet [lat, lon].
export function toLeafletPositions(coordinates) {
  return downsampleGeometry(coordinates).map(([lon, lat]) => [lat, lon]);
}
