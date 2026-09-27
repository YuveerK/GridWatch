import { placeTone } from './status.js';

/** Live areas for the map. A boundary is used when the API sent one; otherwise a point. */
export function areasToGeoJSON(outages) {
  const features = [];
  for (const outage of outages ?? []) {
    for (const place of outage.places ?? []) {
      if (place.lat == null || place.lon == null) continue;
      const tone = placeTone(
        { status: outage.status, service: outage.service ?? 'ELECTRICITY', waterState: outage.waterState },
        Boolean(place.restored),
      );
      features.push({
        type: 'Feature',
        properties: {
          outageId: outage.id,
          title: outage.title ?? '',
          status: outage.status,
          service: outage.service ?? 'ELECTRICITY',
          waterState: outage.waterState ?? '',
          name: place.name,
          tone,
          inferred: place.inferred ? 1 : 0,
        },
        geometry: place.boundary?.type ? place.boundary : { type: 'Point', coordinates: [place.lon, place.lat] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
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
