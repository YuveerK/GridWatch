import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-csp-worker.js?url';
import { useEffect, useRef, useState } from 'react';

// serve the map's background worker as its own file: the inline version stalls under Vite's dev server
maplibregl.setWorkerUrl(workerUrl);

const STYLE = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const JHB = [28.03, -26.18];
const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];
const EMPTY = { type: 'FeatureCollection', features: [] };

function useIsDark() {
  const read = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(read());
    mq.addEventListener('change', on);
    return () => {
      obs.disconnect();
      mq.removeEventListener('change', on);
    };
  }, []);
  return dark;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const colors = () => ({
  live: css('--live') || '#d03b3b',
  partial: css('--partial') || '#ec835a',
  good: css('--good') || '#0ca30c',
  plan: css('--plan') || '#2a78d6',
  idle: css('--idle') || '#898781',
  brand: css('--brand') || '#2a78d6',
  ink: css('--ink') || '#111',
  card: css('--card') || '#fff',
});

/** A small diamond marker for equipment, drawn once per colour. */
function hubImage(fill, ring, size = 44) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const m = size / 2;
  const r = size * 0.3;
  g.beginPath();
  g.moveTo(m, m - r);
  g.lineTo(m + r, m);
  g.lineTo(m, m + r);
  g.lineTo(m - r, m);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = size * 0.09;
  g.strokeStyle = ring;
  g.stroke();
  return g.getImageData(0, 0, size, size);
}

/** Quadratic curve between two [lon, lat] points, sampled. `bend` sets how far it arcs. */
function curve(a, b, bend, n = 26) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1e-9;
  const cx = (a[0] + b[0]) / 2 - (dy / len) * len * bend;
  const cy = (a[1] + b[1]) / 2 + (dx / len) * len * bend;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
  }
  return pts;
}
const ease = (t) => 1 - (1 - t) ** 3;
const at = (pts, u) => {
  const f = Math.max(0, Math.min(1, u)) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  const k = f - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k];
};

/**
 * The map. Everything is data in, events out:
 *  regions   GeoJSON outlines, each feature with { id, name, tone, affected, dim, label, center }
 *  points    one dot per suburb: { id, name, lat, lon, tone, groups[], dim, inferred, note }
 *  hubs      equipment at its inferred position: { id, name, type, lon, lat, live, served }
 *  flow      { key, origin, edges[{from,to,kind,live}] } -> animated "power flow"; null for none
 *  focus     { key, bounds } -> fly to these bounds
 *  layers    { regions, outages, equipment }
 * Suburb positions are centres and outlines are Stats SA's 2011 sub-places; the page explains this in words.
 */
export default function MapView({ regions = EMPTY, points = [], hubs = [], flow = null, focus = null, layers = { regions: true, outages: true, equipment: false }, selectedHub = null, onPickSuburb, onPickHub, onClear, height = 460, cooperative = false, label = 'Map' }) {
  const box = useRef(null);
  const mapRef = useRef(null);
  const readyRef = useRef(false);
  const latest = useRef({});
  latest.current = { regions, points, hubs, flow, focus, layers, selectedHub, onPickSuburb, onPickHub, onClear };
  const dark = useIsDark();
  const raf = useRef(0);
  const framed = useRef(false);
  const [ready, setReady] = useState(0);

  const setData = (id, data) => mapRef.current?.getSource(id)?.setData(data);
  const pointCollection = () => {
    const c = colors();
    return {
      type: 'FeatureCollection',
      features: latest.current.points.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { id: p.id, name: p.name, note: p.note ?? '', tone: p.tone, color: c[p.tone] ?? c.idle, inferred: p.inferred ? 1 : 0, dim: p.dim ? 1 : 0, groups: `|${(p.groups ?? []).join('|')}|` },
      })),
    };
  };
  const regionCollection = () => {
    const c = colors();
    const feats = latest.current.regions.features ?? [];
    return { type: 'FeatureCollection', features: feats.map((f) => ({ ...f, properties: { ...f.properties, color: c[f.properties.tone] ?? c.idle, affected: f.properties.affected ? 1 : 0, dim: f.properties.dim ? 1 : 0 } })) };
  };
  const labelCollection = () => ({
    type: 'FeatureCollection',
    features: (latest.current.regions.features ?? [])
      .filter((f) => f.properties.center && f.properties.label)
      .map((f) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: f.properties.center }, properties: { name: f.properties.label, affected: f.properties.affected ? 1 : 0, dim: f.properties.dim ? 1 : 0 } })),
  });
  const hubCollection = () => ({
    type: 'FeatureCollection',
    features: latest.current.hubs.map((h) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
      properties: { id: h.id, name: h.name, type: h.type, live: h.live ? 1 : 0, served: h.served ?? 0, selected: h.id === latest.current.selectedHub ? 1 : 0 },
    })),
  });

  const fitTo = (bounds, opts = {}) => {
    const map = mapRef.current;
    if (!map || !bounds) return;
    map.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 700, ...opts });
  };

  const applyLayers = () => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const { layers: l, selectedHub: sel, flow: fl } = latest.current;
    const vis = (ids, on) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
    vis(['regions-fill', 'regions-line', 'regions-hover', 'region-labels'], l.regions);
    vis(['cluster-halo', 'cluster', 'cluster-count', 'dots-halo', 'dots', 'dot-labels'], l.outages);
    vis(['hubs'], l.equipment || sel != null || fl != null);
  };

  // ── build the map (again when the theme changes, since the base style is swapped)
  useEffect(() => {
    const map = new maplibregl.Map({ container: box.current, style: dark ? STYLE.dark : STYLE.light, center: JHB, zoom: 9.6, attributionControl: { compact: true }, cooperativeGestures: cooperative });
    mapRef.current = map;
    readyRef.current = false;
    framed.current = false;
    if (import.meta.env.DEV) window.__gwMap = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, maxWidth: '260px' });
    const nudge = requestAnimationFrame(() => map.resize());
    map.on('error', (e) => console.warn('map:', e.error?.message ?? e.message ?? 'error'));

    map.on('load', () => {
      const c = colors();
      map.addImage('hub-idle', hubImage(c.plan, c.card));
      map.addImage('hub-live', hubImage(c.live, c.card));
      map.addImage('hub-sel', hubImage(c.ink, c.card, 56));

      // suburb outlines
      map.addSource('regions', { type: 'geojson', data: regionCollection(), generateId: true });
      map.addLayer({
        id: 'regions-fill', type: 'fill', source: 'regions',
        paint: {
          'fill-color': ['get', 'color'],
          // the zoom expression has to be the outermost one; each stop then decides by suburb
          'fill-opacity': ['interpolate', ['linear'], ['zoom'],
            9, ['case', ['==', ['get', 'dim'], 1], 0.03, ['==', ['get', 'affected'], 1], 0.2, 0],
            12.5, ['case', ['==', ['get', 'dim'], 1], 0.04, ['==', ['get', 'affected'], 1], 0.3, 0.05]],
        },
      });
      map.addLayer({
        id: 'regions-line', type: 'line', source: 'regions',
        paint: {
          'line-color': ['case', ['==', ['get', 'affected'], 1], ['get', 'color'], c.idle],
          'line-width': ['case', ['==', ['get', 'affected'], 1], 1.6, 0.8],
          'line-opacity': ['interpolate', ['linear'], ['zoom'],
            9, ['case', ['==', ['get', 'dim'], 1], 0.1, ['==', ['get', 'affected'], 1], 0.8, 0],
            12.5, ['case', ['==', ['get', 'dim'], 1], 0.12, ['==', ['get', 'affected'], 1], 0.85, 0.35]],
        },
      });
      map.addLayer({ id: 'regions-hover', type: 'line', source: 'regions', filter: ['==', ['id'], -1], paint: { 'line-color': c.ink, 'line-width': 2.4 } });
      map.addSource('labels', { type: 'geojson', data: labelCollection() });
      map.addLayer({
        id: 'region-labels', type: 'symbol', source: 'labels',
        filter: ['step', ['zoom'], false, 11, ['==', ['get', 'affected'], 1], 12.4, true],
        layout: { 'text-field': ['get', 'name'], 'text-font': FONT_BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 14], 'text-max-width': 7, 'text-padding': 4 },
        paint: { 'text-color': c.ink, 'text-halo-color': c.card, 'text-halo-width': 1.6, 'text-opacity': ['case', ['==', ['get', 'dim'], 1], 0.25, ['==', ['get', 'affected'], 1], 1, 0.6] },
      });

      // equipment
      map.addSource('hubs', { type: 'geojson', data: hubCollection() });
      map.addLayer({
        id: 'hubs', type: 'symbol', source: 'hubs', minzoom: 9.2,
        layout: {
          'icon-image': ['case', ['==', ['get', 'selected'], 1], 'hub-sel', ['==', ['get', 'live'], 1], 'hub-live', 'hub-idle'],
          'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.45, 13, 0.75],
          'icon-allow-overlap': true,
          'text-field': ['step', ['zoom'], '', 12, ['get', 'name']], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true,
        },
        paint: { 'text-color': c.ink, 'text-halo-color': c.card, 'text-halo-width': 1.4 },
      });

      // suburb dots, grouped into numbered bubbles when zoomed out
      map.addSource('pts', {
        type: 'geojson', data: pointCollection(), cluster: true, clusterRadius: 44, clusterMaxZoom: 11,
        clusterProperties: {
          live: ['+', ['case', ['==', ['get', 'tone'], 'live'], 1, 0]],
          partial: ['+', ['case', ['==', ['get', 'tone'], 'partial'], 1, 0]],
        },
      });
      const clusterColor = ['case', ['>', ['get', 'live'], 0], c.live, ['>', ['get', 'partial'], 0], c.partial, c.good];
      map.addLayer({ id: 'cluster-halo', type: 'circle', source: 'pts', filter: ['has', 'point_count'], paint: { 'circle-color': clusterColor, 'circle-opacity': 0.2, 'circle-radius': ['step', ['get', 'point_count'], 24, 5, 30, 15, 38] } });
      map.addLayer({ id: 'cluster', type: 'circle', source: 'pts', filter: ['has', 'point_count'], paint: { 'circle-color': clusterColor, 'circle-radius': ['step', ['get', 'point_count'], 14, 5, 18, 15, 24], 'circle-stroke-color': c.card, 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'pts', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': FONT_BOLD, 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff' } });
      map.addLayer({ id: 'dots-halo', type: 'circle', source: 'pts', filter: ['!', ['has', 'point_count']], paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 7, 12, 12, 15, 20], 'circle-opacity': ['case', ['==', ['get', 'dim'], 1], 0.04, 0.16] } });
      map.addLayer({
        id: 'dots', type: 'circle', source: 'pts', filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': ['case', ['==', ['get', 'inferred'], 1], 'rgba(0,0,0,0)', ['get', 'color']],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 12, 6, 15, 10],
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': ['case', ['==', ['get', 'inferred'], 1], 2, 1.4],
          'circle-opacity': ['case', ['==', ['get', 'dim'], 1], 0.3, 1],
          'circle-stroke-opacity': ['case', ['==', ['get', 'dim'], 1], 0.3, 1],
        },
      });
      map.addLayer({
        id: 'dot-labels', type: 'symbol', source: 'pts', minzoom: 12.2, filter: ['!', ['has', 'point_count']],
        layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': c.ink, 'text-halo-color': c.card, 'text-halo-width': 1.5, 'text-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 1] },
      });

      // animated power flow (drawn by the loop further down)
      map.addSource('flow-lines', { type: 'geojson', data: EMPTY });
      map.addSource('flow-pulses', { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'flow-glow', type: 'line', source: 'flow-lines', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'kind'], 'equipment'], 9, 6], 'line-opacity': 0.12, 'line-blur': 3 } });
      map.addLayer({ id: 'flow-lines', type: 'line', source: 'flow-lines', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'kind'], 'equipment'], 3, 1.7], 'line-opacity': 0.75 } });
      map.addLayer({ id: 'flow-pulses-glow', type: 'circle', source: 'flow-pulses', paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['*', ['get', 'r'], 2.4], 'circle-opacity': ['*', ['get', 'o'], 0.22], 'circle-blur': 0.8 } });
      map.addLayer({ id: 'flow-pulses', type: 'circle', source: 'flow-pulses', paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['get', 'r'], 'circle-opacity': ['get', 'o'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['case', ['==', ['get', 'origin'], 1], 2, 0.8], 'circle-stroke-opacity': ['get', 'o'] } });

      readyRef.current = true;
      applyLayers();
      setReady((n) => n + 1); // let the effects below run now that the sources exist
    });

    // ── hover and click
    let hoverId = null;
    const clearHover = () => {
      if (hoverId != null && map.getLayer('regions-hover')) map.setFilter('regions-hover', ['==', ['id'], -1]);
      hoverId = null;
    };
    const pop = (lngLat, html) => popup.setLngLat(lngLat).setHTML(html).addTo(map);
    const hit = (point, ids) => map.queryRenderedFeatures(point, { layers: ids.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none') });
    map.on('mousemove', (e) => {
      if (!readyRef.current) return;
      const hub = hit(e.point, ['hubs'])[0];
      const dot = hit(e.point, ['dots'])[0];
      const cluster = hit(e.point, ['cluster'])[0];
      const region = hit(e.point, ['regions-fill'])[0];
      map.getCanvas().style.cursor = hub || dot || cluster || region ? 'pointer' : '';
      if (hub) {
        clearHover();
        const p = hub.properties;
        return pop(hub.geometry.coordinates, `<b>${esc(p.name)}</b><div style="margin-top:2px;opacity:.75">${esc(String(p.type).toLowerCase().replace('_', ' '))} · serves ${p.served} suburb${p.served === 1 ? '' : 's'}${p.live ? ' · outage now' : ''}</div><div style="margin-top:3px;opacity:.6;font-size:11.5px">Position inferred from the suburbs it serves</div>`);
      }
      if (dot) {
        clearHover();
        const p = dot.properties;
        return pop(dot.geometry.coordinates, `<b>${esc(p.name)}</b>${p.note ? `<div style="margin-top:2px;opacity:.75">${esc(p.note)}</div>` : ''}`);
      }
      popup.remove();
      if (region) {
        if (hoverId !== region.id) {
          hoverId = region.id;
          map.setFilter('regions-hover', ['==', ['id'], region.id]);
        }
      } else clearHover();
    });
    map.on('mouseleave', () => {
      popup.remove();
      clearHover();
    });
    map.on('click', (e) => {
      const hub = hit(e.point, ['hubs'])[0];
      if (hub) return latest.current.onPickHub?.(hub.properties.id);
      const cluster = hit(e.point, ['cluster'])[0];
      if (cluster) {
        return map.getSource('pts').getClusterExpansionZoom(cluster.properties.cluster_id).then((z) => map.easeTo({ center: cluster.geometry.coordinates, zoom: z + 0.4, duration: 500 }));
      }
      const dot = hit(e.point, ['dots'])[0];
      if (dot) return latest.current.onPickSuburb?.(dot.properties.id);
      const region = hit(e.point, ['regions-fill'])[0];
      if (region) return latest.current.onPickSuburb?.(region.properties.id);
      return latest.current.onClear?.();
    });

    return () => {
      cancelAnimationFrame(nudge);
      cancelAnimationFrame(raf.current);
      popup.remove();
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, [dark, cooperative]);

  // ── keep the sources in step with the data
  useEffect(() => {
    if (!readyRef.current) return;
    setData('regions', regionCollection());
    setData('labels', labelCollection());
  }, [regions, ready]);
  useEffect(() => {
    if (readyRef.current) setData('pts', pointCollection());
  }, [points, ready]);
  useEffect(() => {
    if (!readyRef.current) return;
    setData('hubs', hubCollection());
    applyLayers();
  }, [hubs, selectedHub, ready]);
  useEffect(() => {
    applyLayers();
  }, [layers, flow, ready]);
  useEffect(() => {
    if (readyRef.current && focus?.bounds) fitTo(focus.bounds);
  }, [focus?.key, ready]);

  // first paint: once the map and the data are both ready, frame the outages
  useEffect(() => {
    if (!readyRef.current || framed.current || !points.length || flow) return;
    framed.current = true;
    const b = new maplibregl.LngLatBounds();
    points.forEach((p) => b.extend([p.lon, p.lat]));
    fitTo(b, { duration: 0 });
  }, [points, flow, ready]);

  // ── animated power flow
  useEffect(() => {
    const map = mapRef.current;
    cancelAnimationFrame(raf.current);
    if (!map || !readyRef.current) return undefined;
    if (!flow?.edges?.length) {
      setData('flow-lines', EMPTY);
      setData('flow-pulses', EMPTY);
      return undefined;
    }
    const c = colors();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const paths = flow.edges.map((e, i) => {
      const dist = Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1]);
      return { pts: curve(e.from, e.to, (i % 2 ? 1 : -1) * 0.16), color: e.live ? c.live : c.brand, delay: Math.min(700, dist * 9000), phase: (i * 0.37) % 1, kind: e.kind };
    });
    const bounds = new maplibregl.LngLatBounds();
    paths.forEach((p) => p.pts.forEach((pt) => bounds.extend(pt)));
    if (!flow.noFit) fitTo(bounds, { padding: 90, maxZoom: 13.5, duration: 900 });

    const t0 = performance.now();
    let last = 0;
    const frame = (now) => {
      const t = now - t0;
      if (now - last > 32 || reduce) {
        last = now;
        const lines = [];
        const pulses = [];
        for (const p of paths) {
          const grow = reduce ? 1 : ease(Math.max(0, Math.min(1, (t - p.delay) / 700)));
          if (grow <= 0) continue;
          const n = Math.max(1, Math.round(grow * (p.pts.length - 1)));
          const seg = p.pts.slice(0, n + 1);
          if (grow < 1) seg[seg.length - 1] = at(p.pts, grow);
          lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: seg }, properties: { color: p.color, kind: p.kind } });
          if (!reduce && t > 1300) {
            const u = ((t - 1300) * 0.00042 + p.phase) % 1;
            [0, 0.045, 0.09].forEach((lag, k) => {
              const uu = u - lag;
              if (uu >= 0) pulses.push({ type: 'Feature', geometry: { type: 'Point', coordinates: at(p.pts, uu) }, properties: { color: p.color, r: [4.2, 3, 2][k] * (p.kind === 'equipment' ? 1.3 : 1), o: [1, 0.6, 0.3][k], origin: 0 } });
            });
          }
        }
        const ring = reduce ? 0 : (Math.sin(t * 0.004) + 1) / 2;
        pulses.push({ type: 'Feature', geometry: { type: 'Point', coordinates: flow.origin }, properties: { color: c.brand, r: 7 + ring * 4, o: 1, origin: 1 } });
        setData('flow-lines', { type: 'FeatureCollection', features: lines });
        setData('flow-pulses', { type: 'FeatureCollection', features: pulses });
      }
      if (!reduce) raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf.current);
  }, [flow?.key, ready]);

  return <div ref={box} className="map" style={{ height }} role="img" aria-label={label} />;
}
