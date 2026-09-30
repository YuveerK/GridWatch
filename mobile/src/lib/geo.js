import { placeTone, statusMeta } from './status.js';

/** Live areas for the map. A known boundary is the highlighted shape. The suburb centre is always a dot on top of it. */
export function areasToGeoJSON(outages) {
  const features = [];
  for (const outage of outages ?? []) {
    for (const place of outage.places ?? []) {
      if (place.lat == null || place.lon == null) continue;
      const tone = placeTone(
        { status: outage.status, service: outage.service ?? 'ELECTRICITY', waterState: outage.waterState },
        Boolean(place.restored),
      );
      const properties = {
        outageId: outage.id,
        placeId: place.id ?? '',
        title: outage.title ?? '',
        status: outage.status,
        service: outage.service ?? 'ELECTRICITY',
        waterState: outage.waterState ?? '',
        name: place.name,
        tone,
        restored: place.restored ? 1 : 0,
        inferred: place.inferred ? 1 : 0,
        updatedAt: outage.lastUpdateAt ?? '',
      };
      if (place.boundary?.type === 'Polygon' || place.boundary?.type === 'MultiPolygon') {
        features.push({ type: 'Feature', properties, geometry: place.boundary });
      }
      features.push({
        type: 'Feature',
        properties,
        geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** What the map legend can show or hide. Possible impact is inferred, so it is not the incident's own tone. */
/** Layers the live map can actually show. Planned work is not on /v1/map. */
export const MAP_LAYERS = [
  { id: 'live', label: 'Live', tone: 'live' },
  { id: 'partial', label: 'Limited', tone: 'partial' },
  { id: 'good', label: 'Restored here', tone: 'good' },
  { id: 'possible', label: 'Possible impact', tone: 'idle' },
];

export function mapLayerFor(outage, place) {
  if (place?.inferred) return 'possible';
  const tone = placeTone(
    { status: outage?.status, service: outage?.service ?? 'ELECTRICITY', waterState: outage?.waterState },
    Boolean(place?.restored),
  );
  if (tone === 'good') return 'good';
  if (tone === 'partial') return 'partial';
  if (tone === 'plan') return 'plan';
  return 'live';
}

/** One choice per incident and place, even when the hit includes both a polygon and a centre dot. */
export function uniqueSelections(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items ?? []) {
    if (!item?.outageId) continue;
    const key = `${item.outageId}\0${item.placeId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function pushCoord(coords, lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  coords.push([lon, lat]);
}

function walkPositions(positions, coords) {
  for (const pair of positions ?? []) pushCoord(coords, pair?.[0], pair?.[1]);
}

function walkGeometry(geometry, coords) {
  if (!geometry) return;
  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates ?? []) walkPositions(ring, coords);
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates ?? []) {
      for (const ring of polygon ?? []) walkPositions(ring, coords);
    }
  } else if (geometry.type === 'Point') {
    pushCoord(coords, geometry.coordinates?.[0], geometry.coordinates?.[1]);
  }
}

/** [west, south, east, north] covering drawn boundaries and centre points, or null when nothing is drawn. */
export function placesBounds(outages) {
  const coords = [];
  for (const outage of outages ?? []) {
    for (const place of outage.places ?? []) {
      walkGeometry(place?.boundary, coords);
      if (place?.lon != null && place?.lat != null) pushCoord(coords, place.lon, place.lat);
    }
  }
  if (!coords.length) return null;
  const lons = coords.map((coord) => coord[0]);
  const lats = coords.map((coord) => coord[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** Fit a real extent. A single point or a zero-size shape uses a capped zoom instead of an empty bounds box. */
export function frameForPlaces(outages) {
  const bounds = placesBounds(outages);
  if (!bounds) return null;
  const [west, south, east, north] = bounds;
  if (east - west < 0.01 && north - south < 0.01) {
    return { kind: 'center', center: [(west + east) / 2, (south + north) / 2], zoom: 13 };
  }
  return { kind: 'fit', bounds };
}

/** Drop places whose legend layer is off. A missing layer stays shown. */
export function visiblePlaces(outages, enabled = {}) {
  return (outages ?? [])
    .map((outage) => ({
      ...outage,
      places: (outage.places ?? []).filter((place) => enabled[mapLayerFor(outage, place)] !== false),
    }))
    .filter((outage) => outage.places.length > 0);
}

/** Place status and the wider incident, kept separate when a suburb is restored or only inferred. */
export function selectionSentence(item) {
  const incident = statusMeta(item.status, item.service, item.waterState);
  if (item.restored) {
    return { label: 'Restored here', long: `This place is marked restored. The wider incident is still “${incident.label}”.`, tone: 'good', icon: 'check' };
  }
  if (item.inferred) {
    return { label: 'Possible impact', long: `${incident.long} This place was inferred from equipment. The notice did not name it.`, tone: incident.tone, icon: incident.icon };
  }
  return incident;
}

function distance2(lat, lon, suburb) {
  return (suburb.lat - lat) ** 2 + (suburb.lon - lon) ** 2;
}

/** The tracked suburb closest to a GPS fix, or null when none is near enough to trust. */
export function nearestSuburb(suburbs, lat, lon) {
  let best = null;
  let bestD = 0.6 ** 2;
  for (const suburb of suburbs ?? []) {
    if (suburb?.lat == null || suburb?.lon == null) continue;
    const d = distance2(lat, lon, suburb);
    if (d < bestD) {
      best = suburb;
      bestD = d;
    }
  }
  return best;
}
