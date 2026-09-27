import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { areasToGeoJSON } from '@/src/lib/geo.js';
import type { MapOutage } from '@/src/lib/api';
import { statusMeta } from '@/src/lib/status.js';

const STYLE = 'https://tiles.openfreemap.org/styles/dark';

export type Selection = {
  outageId: string;
  title: string;
  name: string;
  status: string;
  service: 'ELECTRICITY' | 'WATER';
  waterState: string | null;
};

export function MapCanvas({ outages, onSelect, onUnavailable }: { outages: MapOutage[]; onSelect: (item: Selection | null) => void; onUnavailable: () => void }) {
  const [MapLibre, setMapLibre] = useState<typeof import('@maplibre/maplibre-react-native') | null>(null);
  const data = areasToGeoJSON(outages);

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
    <Map mapStyle={STYLE} onPress={() => onSelect(null)} style={styles.map} attribution>
      <Camera initialViewState={{ center: [28.0473, -26.2041], zoom: 9 }} />
      <GeoJSONSource
        id="live-areas"
        data={data as GeoJSON.FeatureCollection}
        onPress={(event) => {
          const feature = event.nativeEvent.features?.[0];
          const props = feature?.properties as Record<string, string> | undefined;
          if (!props?.outageId) return;
          event.stopPropagation?.();
          onSelect({
            outageId: String(props.outageId),
            title: String(props.title ?? ''),
            name: String(props.name ?? ''),
            status: String(props.status ?? ''),
            service: props.service === 'WATER' ? 'WATER' : 'ELECTRICITY',
            waterState: props.waterState ? String(props.waterState) : null,
          });
        }}
      >
        <Layer
          id="areas-fill"
          type="fill"
          filter={['==', ['geometry-type'], 'Polygon']}
          paint={{
            'fill-color': ['match', ['get', 'tone'], 'live', '#e23d3d', 'partial', '#e0a03a', 'plan', '#7eb0e0', 'good', '#3dba7a', '#8b93a0'],
            'fill-opacity': ['case', ['==', ['get', 'inferred'], 1], 0.22, ['==', ['get', 'tone'], 'live'], 0.72, 0.45],
          }}
        />
        <Layer
          id="areas-line"
          type="line"
          filter={['==', ['geometry-type'], 'Polygon']}
          paint={{
            'line-color': ['match', ['get', 'tone'], 'live', '#e23d3d', 'partial', '#e0a03a', 'plan', '#7eb0e0', 'good', '#3dba7a', '#8b93a0'],
            'line-width': 1.5,
            'line-opacity': 0.9,
          }}
        />
        <Layer
          id="areas-circle"
          type="circle"
          filter={['==', ['geometry-type'], 'Point']}
          paint={{
            'circle-radius': 7,
            'circle-color': ['match', ['get', 'tone'], 'live', '#e23d3d', 'partial', '#e0a03a', 'plan', '#7eb0e0', 'good', '#3dba7a', '#8b93a0'],
            'circle-opacity': ['case', ['==', ['get', 'inferred'], 1], 0.35, 0.95],
            'circle-stroke-width': 1,
            'circle-stroke-color': '#090b0e',
          }}
        />
      </GeoJSONSource>
    </Map>
  );
}

export function selectionSentence(item: Selection) {
  return statusMeta(item.status, item.service, item.waterState);
}

const styles = StyleSheet.create({
  map: { flex: 1 },
});
