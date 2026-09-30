import { useEffect, useRef, useState } from 'react';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import { StyleSheet } from 'react-native';
import { areasToGeoJSON, selectionSentence } from '@/src/lib/geo.js';
import type { MapOutage } from '@/src/lib/api';

export { selectionSentence };

const STYLE = 'https://tiles.openfreemap.org/styles/dark';

export type Selection = {
  outageId: string;
  placeId: string;
  title: string;
  name: string;
  status: string;
  service: 'ELECTRICITY' | 'WATER';
  waterState: string | null;
  restored: boolean;
  inferred: boolean;
  updatedAt: string | null;
};

export type CameraCommand =
  | { id: number; kind: 'fit'; bounds: [number, number, number, number]; duration: number }
  | { id: number; kind: 'center'; center: [number, number]; zoom: number; duration: number };

export function MapCanvas({ outages, onSelect, onUnavailable, command }: { outages: MapOutage[]; onSelect: (items: Selection[]) => void; onUnavailable: () => void; command?: CameraCommand | null }) {
  const [MapLibre, setMapLibre] = useState<typeof import('@maplibre/maplibre-react-native') | null>(null);
  const cameraRef = useRef<CameraRef | null>(null);
  const data = areasToGeoJSON(outages);

  useEffect(() => {
    const camera = cameraRef.current;
    if (!command || !camera) return;
    if (command.kind === 'fit') {
      camera.fitBounds(command.bounds, { padding: { top: 72, right: 24, bottom: 24, left: 24 }, duration: command.duration });
      return;
    }
    camera.easeTo({ center: command.center, zoom: command.zoom, duration: command.duration });
  }, [command, MapLibre]);

  useEffect(() => {
    let live = true;
    import('@maplibre/maplibre-react-native').then((mod) => {
      if (live) setMapLibre(mod);
    }).catch(() => {
      if (live) onUnavailable();
    });
    return () => {
      live = false;
    };
  }, [onUnavailable]);

  if (!MapLibre) return null;
  const { Map, Camera, GeoJSONSource, Layer } = MapLibre;
  return (
      <Map mapStyle={STYLE} onPress={() => onSelect([])} style={styles.map} attribution>
      <Camera ref={cameraRef} initialViewState={{ center: [28.0473, -26.2041], zoom: 9 }} />
      <GeoJSONSource
        id="live-areas"
        data={data as GeoJSON.FeatureCollection}
        onPress={(event) => {
          const features = event.nativeEvent.features ?? [];
          const items = features.map((feature) => selectionFrom(feature?.properties as Record<string, unknown> | undefined)).filter((item): item is Selection => Boolean(item));
          if (!items.length) return;
          event.stopPropagation?.();
          onSelect(items);
        }}
      >
        <Layer
          id="areas-fill"
          type="fill"
          filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
          paint={{
            'fill-color': ['case', ['==', ['get', 'inferred'], 1], '#A7B2C2', ['match', ['get', 'tone'], 'live', '#FF7969', 'partial', '#F3BE63', 'plan', '#A1BFFF', 'good', '#62D5AD', '#A7B2C2']],
            'fill-opacity': ['case', ['==', ['get', 'inferred'], 1], 0.55, ['==', ['get', 'tone'], 'live'], 0.72, 0.45],
          }}
        />
        <Layer
          id="areas-line"
          type="line"
          filter={['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]]}
          paint={{
            'line-color': ['case', ['==', ['get', 'inferred'], 1], '#A7B2C2', ['match', ['get', 'tone'], 'live', '#FF7969', 'partial', '#F3BE63', 'plan', '#A1BFFF', 'good', '#62D5AD', '#A7B2C2']],
            'line-width': ['case', ['==', ['get', 'inferred'], 1], 2.5, 1.5],
            'line-opacity': 0.9,
          }}
        />
        <Layer
          id="areas-circle"
          type="circle"
          filter={['==', ['geometry-type'], 'Point']}
          paint={{
            'circle-radius': 7,
            'circle-color': ['case', ['==', ['get', 'inferred'], 1], '#A7B2C2', ['match', ['get', 'tone'], 'live', '#FF7969', 'partial', '#F3BE63', 'plan', '#A1BFFF', 'good', '#62D5AD', '#A7B2C2']],
            'circle-opacity': 1,
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#F4F1EA',
          }}
        />
      </GeoJSONSource>
    </Map>
  );
}

function flagOn(value: unknown) {
  return value === 1 || value === '1' || value === true;
}

export function selectionFrom(props: Record<string, unknown> | undefined): Selection | null {
  if (!props?.outageId) return null;
  return {
    outageId: String(props.outageId),
    placeId: String(props.placeId ?? ''),
    title: String(props.title ?? ''),
    name: String(props.name ?? ''),
    status: String(props.status ?? ''),
    service: props.service === 'WATER' ? 'WATER' : 'ELECTRICITY',
    waterState: props.waterState ? String(props.waterState) : null,
    restored: flagOn(props.restored),
    inferred: flagOn(props.inferred),
    updatedAt: props.updatedAt ? String(props.updatedAt) : null,
  };
}

const styles = StyleSheet.create({
  map: { flex: 1 },
});
