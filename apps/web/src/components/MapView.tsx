import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type Map as MLMap } from 'maplibre-gl';
import { useEffect, useRef, type ReactNode } from 'react';
import { haversineM, type VenueDTO } from '@crawl/core';
import { nightStyle } from './mapStyle';

export type PinState = 'visited' | 'current' | 'next' | 'upcoming' | 'skipped' | 'planned';

export interface MapStop {
  id: string;
  lat: number;
  lng: number;
  number: number;
  name: string;
  category: VenueDTO['category'];
  state?: PinState;
}

export interface MapVenue {
  id: string;
  lat: number;
  lng: number;
  name: string;
  category: VenueDTO['category'];
  hasSpecial?: boolean;
}

interface Props {
  center: { lat: number; lng: number };
  zoom?: number;
  stops?: MapStop[];
  venues?: MapVenue[];
  route?: [number, number][] | null;
  /** Dimmed secondary route (e.g. the organizer's original order). */
  ghostRoute?: [number, number][] | null;
  group?: { lat: number; lng: number } | null;
  me?: { lat: number; lng: number } | null;
  fitKey?: string;
  onVenueClick?: (id: string) => void;
  onStopClick?: (id: string) => void;
  padding?: { top: number; bottom: number; left: number; right: number };
  className?: string;
  children?: ReactNode;
}

const ICONS: Record<VenueDTO['category'], string> = {
  pub: '<path d="M17 11h1a3 3 0 0 1 0 6h-1"/><path d="M9 12v6"/><path d="M13 12v6"/><path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"/><path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/>',
  bar: '<path d="M8 22h8"/><path d="M7 10h10"/><path d="M12 15v7"/><path d="M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5Z"/>',
  cocktail: '<path d="M8 22h8"/><path d="M12 11v11"/><path d="m19 3-7 8-7-8Z"/>',
  biergarten: '<path d="M10 10v.2A3 3 0 0 1 8.9 16H5a3 3 0 0 1-1-5.8V10a3 3 0 0 1 6 0Z"/><path d="M7 16v6"/><path d="M13 19v3"/><path d="M12 19h8.3a1 1 0 0 0 .7-1.7L18 14h.3a1 1 0 0 0 .7-1.7L16 9h.2a1 1 0 0 0 .8-1.7L13 3l-1.4 1.5"/>',
};

const svg = (cat: VenueDTO['category'], size: number, color: string) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[cat] ?? ICONS.bar}</svg>`;

function stopEl(s: MapStop): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.setAttribute('aria-label', `Stop ${s.number}: ${s.name}`);
  const st = s.state ?? 'planned';
  const dim = st === 'visited' || st === 'skipped';
  const filled = st === 'current';
  const ring = dim ? '#55524c' : '#f6b73c';
  el.style.cssText = `width:52px;height:62px;background:none;border:0;padding:0;opacity:${st === 'skipped' ? 0.4 : 1}`;
  el.innerHTML = `
    ${st === 'next' ? `<span class="pulse-ring" style="position:absolute;left:4px;top:4px;width:44px;height:44px;border-radius:999px;border:2px solid #f6b73c"></span>` : ''}
    <span style="position:absolute;left:2px;top:2px;width:48px;height:48px;border-radius:999px;background:${filled ? '#f6b73c' : '#16120c'};border:3px solid ${ring};box-shadow:0 0 ${dim ? 0 : 18}px rgba(246,183,60,.45),0 6px 14px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center">
      ${svg(s.category, 22, filled ? '#1a1205' : dim ? '#8a867e' : '#f6b73c')}
    </span>
    <span style="position:absolute;left:21px;top:46px;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:9px solid ${ring}"></span>
    <span style="position:absolute;left:-6px;top:-8px;min-width:24px;height:24px;padding:0 5px;border-radius:999px;background:#0b0b0c;border:2px solid ${ring};color:${dim ? '#a29e95' : '#f5f3ee'};font:700 12px/20px Inter,system-ui;text-align:center">${st === 'visited' ? '✓' : s.number}</span>`;
  return el;
}

function venueEl(v: MapVenue): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.setAttribute('aria-label', v.name);
  el.style.cssText = 'width:30px;height:30px;background:none;border:0;padding:0';
  el.innerHTML = `<span style="position:absolute;inset:0;border-radius:999px;background:#1c1c1f;border:1.5px solid ${v.hasSpecial ? '#f6b73c' : '#4a4a52'};display:flex;align-items:center;justify-content:center;box-shadow:0 4px 10px rgba(0,0,0,.5)">${svg(v.category, 14, v.hasSpecial ? '#f6b73c' : '#c9c5bc')}</span>`;
  return el;
}

function dotEl(color: string, label: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('aria-label', label);
  el.style.cssText = 'width:22px;height:22px';
  el.innerHTML = `<span style="position:absolute;left:-39px;top:-39px;width:100px;height:100px;border-radius:999px;background:${color}22;border:1px solid ${color}33"></span>
    <span style="position:absolute;inset:0;border-radius:999px;background:${color};border:3px solid #fff;box-shadow:0 0 14px ${color}"></span>`;
  return el;
}

const line = (coords: [number, number][] | null | undefined) => ({
  type: 'Feature' as const,
  properties: {},
  geometry: { type: 'LineString' as const, coordinates: coords && coords.length > 1 ? coords : [] },
});

export function MapView({ center, zoom = 15, stops = [], venues = [], route, ghostRoute, group, me, fitKey, onVenueClick, onStopClick, padding, className, children }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const loaded = useRef(false);
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const cbs = useRef({ onVenueClick, onStopClick });
  cbs.current = { onVenueClick, onStopClick };
  const pending = useRef<() => void>(() => {});

  useEffect(() => {
    if (!container.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: nightStyle,
      center: [center.lng, center.lat],
      zoom,
      attributionControl: { compact: true },
      pitchWithRotate: false,
      dragRotate: false,
    });
    m.touchZoomRotate.disableRotation();
    m.on('load', () => {
      m.addSource('ghost', { type: 'geojson', data: line(null) });
      m.addSource('route', { type: 'geojson', data: line(null) });
      m.addLayer({ id: 'ghost', type: 'line', source: 'ghost', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#6f6b64', 'line-width': 3, 'line-dasharray': [1, 2] } });
      m.addLayer({ id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#f6b73c', 'line-width': 10, 'line-opacity': 0.12, 'line-blur': 4 } });
      m.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#f6b73c', 'line-width': 4, 'line-dasharray': [1.4, 1.4] } });
      loaded.current = true;
      pending.current();
    });
    m.on('zoomend', () => spreadRef.current());
    map.current = m;
    if (import.meta.env.DEV) (window as any).__crawlMap = m;
    // Keep the canvas in sync with layout changes (sheets, viewport, fonts loading).
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(container.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      loaded.current = false;
      markers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Fan out stop pins that would overlap on screen at the current zoom (e.g. bars 30 m apart). */
  const spread = () => {
    const m = map.current;
    if (!m) return;
    const pins = [...markers.current.entries()].filter(([k]) => k.startsWith('s:')).map(([, mk]) => ({ mk, p: m.project(mk.getLngLat()) }));
    const groups: (typeof pins)[] = [];
    for (const pin of pins) {
      const g = groups.find((grp) => grp.some((o) => Math.hypot(o.p.x - pin.p.x, o.p.y - pin.p.y) < 44));
      if (g) g.push(pin);
      else groups.push([pin]);
    }
    for (const g of groups) {
      g.sort((a, b) => a.p.x - b.p.x);
      g.forEach((pin, i) => pin.mk.setOffset([g.length > 1 ? (i - (g.length - 1) / 2) * 46 : 0, 0]));
    }
  };
  const spreadRef = useRef(spread);
  spreadRef.current = spread;

  // Sync markers and route data.
  useEffect(() => {
    const apply = () => {
      const m = map.current;
      if (!m) return;
      (m.getSource('route') as GeoJSONSource | undefined)?.setData(line(route));
      (m.getSource('ghost') as GeoJSONSource | undefined)?.setData(line(ghostRoute));
      const next = new Map<string, { el: () => HTMLElement; lngLat: [number, number]; anchor: 'bottom' | 'center'; z: number; click?: () => void }>();
      for (const v of venues) {
        // A plain venue pin under (or right next to) a numbered stop only adds clutter.
        if (stops.some((s) => haversineM(s, v) < 25)) continue;
        next.set(`v:${v.id}:${v.hasSpecial ? 1 : 0}`, { el: () => venueEl(v), lngLat: [v.lng, v.lat], anchor: 'center', z: 1, click: () => cbs.current.onVenueClick?.(v.id) });
      }
      for (const s of stops) {
        next.set(`s:${s.id}:${s.number}:${s.state}`, { el: () => stopEl(s), lngLat: [s.lng, s.lat], anchor: 'bottom', z: 3, click: () => cbs.current.onStopClick?.(s.id) });
      }
      if (group) next.set('group', { el: () => dotEl('#3b82f6', 'Group location'), lngLat: [group.lng, group.lat], anchor: 'center', z: 4 });
      if (me) next.set('me', { el: () => dotEl('#a3a3a3', 'Your location'), lngLat: [me.lng, me.lat], anchor: 'center', z: 2 });

      for (const [key, mk] of markers.current) {
        if (!next.has(key)) {
          mk.remove();
          markers.current.delete(key);
        }
      }
      for (const [key, spec] of next) {
        const existing = markers.current.get(key);
        if (existing) {
          existing.setLngLat(spec.lngLat);
          continue;
        }
        const el = spec.el();
        el.style.zIndex = String(spec.z);
        if (spec.click) el.addEventListener('click', (e) => (e.stopPropagation(), spec.click!()));
        const label = el.getAttribute('aria-label');
        markers.current.set(key, new maplibregl.Marker({ element: el, anchor: spec.anchor }).setLngLat(spec.lngLat).addTo(m));
        // MapLibre replaces the label with a generic "Map marker"; restore ours.
        if (label) el.setAttribute('aria-label', label);
      }
      spread();
    };
    if (loaded.current) apply();
    else pending.current = apply;
  }, [stops, venues, route, ghostRoute, group, me]);

  // Fit to content when the key changes.
  useEffect(() => {
    const m = map.current;
    if (!m || !fitKey) return;
    const pts: [number, number][] = [...stops.map((s) => [s.lng, s.lat] as [number, number]), ...(route ?? [])];
    if (group) pts.push([group.lng, group.lat]);
    if (pts.length < 2) {
      if (pts.length === 1) m.easeTo({ center: pts[0], zoom: 16 });
      return;
    }
    const lngs = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    const bounds: LngLatBoundsLike = [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ];
    const run = () => (m.resize(), m.fitBounds(bounds, { padding: padding ?? { top: 90, bottom: 60, left: 50, right: 50 }, maxZoom: 16.5, duration: 600 }));
    if (loaded.current) run();
    else m.once('load', run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  return (
    <div className={`relative overflow-hidden ${className ?? ''}`}>
      <div ref={container} className="h-full w-full" />
      {children}
    </div>
  );
}
