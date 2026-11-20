import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// MapLibre 6 loads its worker by URL; let Vite emit the file and hand over its final path
maplibregl.setWorkerUrl(workerUrl);
import { Crosshair } from 'lucide-react';
import type { GeoBounds, MapCluster } from '../types';

interface MapGlobeViewProps {
  mode: 'map-2d' | 'globe-3d';
  baseQueryString: string;
  revision: number;
  syncBounds: boolean;
  onToggleSyncBounds: () => void;
  onBoundsChange: (bounds: GeoBounds | null) => void;
  onSelectPhotoId: (mediaId: number) => void;
}

// Free, keyless vector basemap (OpenFreeMap, OSM data). Light and quiet so photo pins stand out.
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

export const MapGlobeView: React.FC<MapGlobeViewProps> = ({
  mode,
  baseQueryString,
  revision,
  syncBounds,
  onToggleSyncBounds,
  onBoundsChange,
  onSelectPhotoId,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // One marker per cover photo, reused across refreshes: only clusters that appear/disappear touch the DOM
  const markersRef = useRef<Map<number, { marker: maplibregl.Marker; cluster: MapCluster; countEl: HTMLSpanElement }>>(
    new Map(),
  );
  const debounceRef = useRef<number | null>(null);
  const requestSeqRef = useRef(0);
  const lastBoundsKeyRef = useRef('');
  // Latest callbacks via refs: parents pass new function instances every render, and depending on them
  // re-ran the fetch effect on every render (bounds -> parent re-render -> new callback -> refetch: a flicker loop)
  const onBoundsChangeRef = useRef(onBoundsChange);
  const onSelectPhotoIdRef = useRef(onSelectPhotoId);
  onBoundsChangeRef.current = onBoundsChange;
  onSelectPhotoIdRef.current = onSelectPhotoId;

  const [clusterStats, setClusterStats] = useState({ clusters: 0, points: 0, queryMs: 0 });
  const [mapReady, setMapReady] = useState(false);

  const fetchAndRenderClusters = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;

    const bounds = map.getBounds();
    const zoom = map.getZoom();

    // After panning past the date line MapLibre reports longitudes like 170..200: wrap them into
    // -180..180 (west > east then means "crosses the antimeridian", which the server handles)
    const wrapLon = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
    const fullWorld = bounds.getEast() - bounds.getWest() >= 360;
    const geoBounds: GeoBounds = {
      minLat: Math.max(-90, bounds.getSouth()),
      maxLat: Math.min(90, bounds.getNorth()),
      minLon: fullWorld ? -180 : wrapLon(bounds.getWest()),
      maxLon: fullWorld ? 180 : wrapLon(bounds.getEast()),
    };

    if (syncBounds) {
      const key = [geoBounds.minLat, geoBounds.maxLat, geoBounds.minLon, geoBounds.maxLon].map((n) => n.toFixed(5)).join();
      if (key !== lastBoundsKeyRef.current) {
        lastBoundsKeyRef.current = key;
        onBoundsChangeRef.current(geoBounds);
      }
    }

    const params = new URLSearchParams(baseQueryString);
    params.set('zoom', zoom.toFixed(2));
    if (zoom > 2.2) {
      params.set('minLat', geoBounds.minLat.toFixed(5));
      params.set('maxLat', geoBounds.maxLat.toFixed(5));
      params.set('minLon', geoBounds.minLon.toFixed(5));
      params.set('maxLon', geoBounds.maxLon.toFixed(5));
    }

    const seq = ++requestSeqRef.current;
    const res = await fetch(`/api/map/clusters?${params.toString()}`).catch(() => null);
    if (!res?.ok || seq !== requestSeqRef.current) return; // a newer request superseded this one
    const data = (await res.json()) as { clusters: MapCluster[]; totalPoints: number; queryMs: number };
    if (seq !== requestSeqRef.current) return;

    setClusterStats({ clusters: data.clusters.length, points: data.totalPoints, queryMs: data.queryMs });

    const markers = markersRef.current;
    const next = new Set<number>();
    // Markers whose cover isn't in the new result, by grid cell: a cell whose cover photo changed
    // (e.g. a newer photo indexed) reuses its marker instead of flashing a blank new one
    const byCell = new Map<string, number>();
    const newCovers = new Set(data.clusters.map((c) => c.coverId));
    for (const [id, entry] of markers) if (!newCovers.has(id)) byCell.set(entry.cluster.id, id);
    for (const cluster of data.clusters) {
      next.add(cluster.coverId);
      let existing = markers.get(cluster.coverId);
      const recycledId = existing ? undefined : byCell.get(cluster.id);
      if (recycledId !== undefined) {
        existing = markers.get(recycledId)!;
        markers.delete(recycledId);
        byCell.delete(cluster.id);
        markers.set(cluster.coverId, existing);
        (existing.marker.getElement().querySelector('img') as HTMLImageElement).src = `/api/thumb/${cluster.coverId}/sm`;
      }
      if (existing) {
        existing.cluster = cluster;
        existing.marker.setLngLat([cluster.lon, cluster.lat]);
        existing.countEl.textContent = String(cluster.count);
        existing.countEl.hidden = cluster.count < 2;
        continue;
      }

      const el = document.createElement('div');
      el.className = 'map-photo-pin';
      const img = document.createElement('img');
      img.src = `/api/thumb/${cluster.coverId}/sm`;
      img.alt = '';
      img.decoding = 'async';
      const countEl = document.createElement('span');
      countEl.className = 'map-pin-count';
      countEl.textContent = String(cluster.count);
      countEl.hidden = cluster.count < 2;
      el.append(img, countEl);

      const entry = { marker: new maplibregl.Marker({ element: el, anchor: 'bottom' }), cluster, countEl };
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = entry.cluster; // latest data for this marker, not the one it was created with
        if (c.count === 1 || map.getZoom() >= 14) {
          onSelectPhotoIdRef.current(c.coverId);
        } else {
          map.fitBounds(
            [
              [c.minLon, c.minLat],
              [c.maxLon, c.maxLat],
            ],
            { padding: 80, maxZoom: 16, duration: 650 },
          );
        }
      });
      entry.marker.setLngLat([cluster.lon, cluster.lat]).addTo(map);
      markers.set(cluster.coverId, entry);
    }
    for (const [id, entry] of markers) {
      if (!next.has(id)) {
        entry.marker.remove();
        markers.delete(id);
      }
    }
  }, [baseQueryString, syncBounds]);

  // Initialize MapLibre GL JS once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: [-30, 5],
      zoom: 1.7,
      attributionControl: { compact: true },
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');

    map.on('style.load', () => {
      try {
        map.setProjection({ type: mode === 'globe-3d' ? 'globe' : 'mercator' });
      } catch {
        // Fallback silently if WebGL context doesn't support globe
      }
      setMapReady(true);
    });

    mapRef.current = map;

    return () => {
      for (const { marker } of markersRef.current.values()) marker.remove();
      markersRef.current.clear();
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch between 2D Mercator and 3D Globe seamlessly
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    try {
      map.setProjection({ type: mode === 'globe-3d' ? 'globe' : 'mercator' });
    } catch {
      // ignore
    }
  }, [mode, mapReady]);

  // Bind moveend/zoomend + refresh on filter/revision change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const scheduleRefresh = () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        void fetchAndRenderClusters();
      }, 90);
    };

    map.on('moveend', scheduleRefresh);
    map.on('zoomend', scheduleRefresh);
    void fetchAndRenderClusters();

    return () => {
      map.off('moveend', scheduleRefresh);
      map.off('zoomend', scheduleRefresh);
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [mapReady, fetchAndRenderClusters, revision]);

  // Clear spatial filter when sync is turned off
  useEffect(() => {
    if (!syncBounds) {
      lastBoundsKeyRef.current = ''; // so turning sync back on re-sends the current area
      onBoundsChange(null);
    }
  }, [syncBounds, onBoundsChange]);

  return (
    <div className="map-globe-container">
      <div ref={containerRef} className="map-canvas" />

      <div className="map-controls">
        <button
          type="button"
          className={`btn btn-float ${syncBounds ? 'btn-on' : ''}`}
          onClick={onToggleSyncBounds}
          aria-pressed={syncBounds}
          title="Quando ligado, a grade mostra só o que está visível no mapa"
        >
          <Crosshair size={15} />
          Só esta área
        </button>
        <span className="map-count">
          {clusterStats.points === 1 ? '1 foto com local' : `${clusterStats.points} fotos com local`}
        </span>
      </div>
    </div>
  );
};
