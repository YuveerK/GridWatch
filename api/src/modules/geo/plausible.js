// A geocoder can return a real place that is not the one City Power meant ("Willowbrook" exists in more than one part of
// the city). Suburbs belong to a numbered region, and regions are compact, so a position far from where the region's other
// suburbs are is almost certainly the wrong place with the right name.

const R = 6371;
const rad = (x) => (x * Math.PI) / 180;

export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Roughly which town each municipality's numbered/lettered region is in: a hint that turns "Willowbrook" into
 * "Willowbrook, Roodepoort". Keyed by municipality code first since regions are only unique within one municipality
 * (Johannesburg's "A" and a future municipality's "A" are different places). */
export const REGION_TOWN = {
  JOHANNESBURG: { A: 'Midrand', B: 'Randburg', C: 'Roodepoort', D: 'Soweto', E: 'Sandton', F: 'Johannesburg', G: 'Orange Farm' },
};

export const REGION_RADIUS_KM = 12; // how far from the middle of its region a suburb may be
export const NEIGHBOUR_KM = 4; // ...unless another suburb of the same region is this close (regions have outlying edges)
const MIN_POINTS = 8; // with fewer placed suburbs we do not know the region's shape yet, so nothing is rejected

/**
 * Is this position believable for a suburb of a region, given the positions of that region's other suburbs?
 * regionPoints: [{ lat, lon }]. Unknown regions, or ones with too few placed suburbs, are never rejected.
 */
export function isPlausible(pos, regionPoints) {
  if (!pos || !regionPoints || regionPoints.length < MIN_POINTS) return true;
  const centre = { lat: median(regionPoints.map((p) => p.lat)), lon: median(regionPoints.map((p) => p.lon)) };
  if (distanceKm(centre, pos) <= REGION_RADIUS_KM) return true;
  return regionPoints.some((p) => distanceKm(p, pos) <= NEIGHBOUR_KM);
}
