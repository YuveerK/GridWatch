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
const TONE_VAR = { live: '--live', partial: '--partial', good: '--good', plan: '--plan', idle: '--idle' };

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

/**
 * Approximate map of suburbs. `points`: [{ id, name, lat, lon, tone, r, group, note, inferred }].
 * Points are suburb centres, never exact cable routes: callers say so in words next to the map.
 */
export default function MapView({ points, selected = null, onPick, height = 460, cooperative = false, label = 'Map' }) {
  const box = useRef(null);
  const mapRef = useRef(null);
  const readyRef = useRef(false);
  const latest = useRef({ points, selected, onPick });
  latest.current = { points, selected, onPick };
  const fitted = useRef('');
  const dark = useIsDark();

  const data = () => {
    const { points: pts, selected: sel } = latest.current;
    const css = getComputedStyle(document.documentElement);
    return {
      type: 'FeatureCollection',
      features: pts.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {
          id: p.id,
          name: p.name,
          note: p.note ?? '',
          group: p.group ?? '',
          color: css.getPropertyValue(TONE_VAR[p.tone] ?? '--idle').trim() || '#888',
          r: p.r ?? 7,
          inferred: p.inferred ? 1 : 0,
          dim: sel && p.group !== sel ? 1 : 0,
        },
      })),
    };
  };

  const fit = () => {
    const map = mapRef.current;
    const { points: pts } = latest.current;
    if (!map || !pts.length) return;
    const b = new maplibregl.LngLatBounds();
    pts.forEach((p) => b.extend([p.lon, p.lat]));
    map.fitBounds(b, { padding: 56, maxZoom: 13, duration: 0 });
  };

  // (re)build the map when the theme changes, since the base style is swapped
  useEffect(() => {
    const map = new maplibregl.Map({
      container: box.current,
      style: dark ? STYLE.dark : STYLE.light,
      center: JHB,
      zoom: 9.6,
      attributionControl: { compact: true },
      cooperativeGestures: cooperative,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) window.__gwMap = map;
    readyRef.current = false;
    // the first frame can wait for a layout change; a resize right after mount makes it draw straight away
    const nudge = requestAnimationFrame(() => map.resize());
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: '240px' });

    map.on('error', (e) => console.warn('map:', e.error?.message ?? e.message ?? 'error'));
    map.on('load', () => {
      map.addSource('pts', { type: 'geojson', data: data() });
      map.addLayer({
        id: 'halo', type: 'circle', source: 'pts',
        paint: { 'circle-color': ['get', 'color'], 'circle-radius': ['*', ['get', 'r'], 1.9], 'circle-opacity': ['case', ['==', ['get', 'dim'], 1], 0.05, 0.16] },
      });
      map.addLayer({
        id: 'dots', type: 'circle', source: 'pts',
        paint: {
          'circle-color': ['case', ['==', ['get', 'inferred'], 1], 'rgba(0,0,0,0)', ['get', 'color']],
          'circle-radius': ['get', 'r'],
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': ['case', ['==', ['get', 'inferred'], 1], 2.5, 1.5],
          'circle-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 1],
          'circle-stroke-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 1],
        },
      });
      readyRef.current = true;
      fit();
      fitted.current = latest.current.points.map((p) => p.id).join('|');
    });

    map.on('mousemove', 'dots', (e) => {
      map.getCanvas().style.cursor = 'pointer';
      const f = e.features?.[0];
      if (!f) return;
      popup.setLngLat(f.geometry.coordinates).setHTML(`<b>${esc(f.properties.name)}</b>${f.properties.note ? `<div style="margin-top:2px;opacity:.75">${esc(f.properties.note)}</div>` : ''}`).addTo(map);
    });
    map.on('mouseleave', 'dots', () => {
      map.getCanvas().style.cursor = '';
      popup.remove();
    });
    map.on('click', 'dots', (e) => {
      const g = e.features?.[0]?.properties?.group;
      if (g) latest.current.onPick?.(g);
    });

    return () => {
      cancelAnimationFrame(nudge);
      popup.remove();
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, [dark, cooperative]);

  // keep the dots in step with the data and the selection
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.getSource('pts')?.setData(data());
    const key = points.map((p) => p.id).join('|');
    if (key !== fitted.current) {
      fitted.current = key;
      fit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, selected]);

  // zoom to the selected group
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !selected) return;
    const mine = points.filter((p) => p.group === selected);
    if (!mine.length) return;
    const b = new maplibregl.LngLatBounds();
    mine.forEach((p) => b.extend([p.lon, p.lat]));
    map.fitBounds(b, { padding: 70, maxZoom: 13, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  return <div ref={box} className="map" style={{ height }} role="img" aria-label={label} />;
}
