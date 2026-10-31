import type { StyleSpecification } from 'maplibre-gl';

/**
 * Night style on OpenMapTiles-schema vector tiles (OpenFreeMap by default; point
 * VITE_TILES_URL at a self-hosted Protomaps/OpenMapTiles source in production).
 */
const TILES = import.meta.env.VITE_TILES_URL ?? 'https://tiles.openfreemap.org/planet';
const GLYPHS = import.meta.env.VITE_GLYPHS_URL ?? 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

const c = {
  bg: '#0d0d0f',
  block: '#121215',
  building: '#18181c',
  park: '#0f1a14',
  water: '#0a1219',
  minor: '#222227',
  major: '#2c2c32',
  arterial: '#38383f',
  label: '#7f7b73',
  hood: '#8c887f',
};

export const nightStyle: StyleSpecification = {
  version: 8,
  glyphs: GLYPHS,
  sources: {
    omt: { type: 'vector', url: TILES, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · <a href="https://openfreemap.org">OpenFreeMap</a>' },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': c.bg } },
    { id: 'landuse', type: 'fill', source: 'omt', 'source-layer': 'landuse', paint: { 'fill-color': c.block } },
    {
      id: 'park',
      type: 'fill',
      source: 'omt',
      'source-layer': 'park',
      paint: { 'fill-color': c.park },
    },
    {
      id: 'landcover-green',
      type: 'fill',
      source: 'omt',
      'source-layer': 'landcover',
      filter: ['in', ['get', 'class'], ['literal', ['grass', 'wood', 'farmland']]],
      paint: { 'fill-color': c.park, 'fill-opacity': 0.8 },
    },
    { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': c.water } },
    {
      id: 'building',
      type: 'fill',
      source: 'omt',
      'source-layer': 'building',
      minzoom: 14,
      paint: { 'fill-color': c.building, 'fill-outline-color': '#202026' },
    },
    {
      id: 'road-minor',
      type: 'line',
      source: 'omt',
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'path', 'pedestrian', 'track']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.minor, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 13, 0.6, 18, 9] },
    },
    {
      id: 'road-major',
      type: 'line',
      source: 'omt',
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.major, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 1, 18, 14] },
    },
    {
      id: 'road-arterial',
      type: 'line',
      source: 'omt',
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['primary', 'trunk', 'motorway']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': c.arterial, 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 1, 18, 18] },
    },
    {
      id: 'rail',
      type: 'line',
      source: 'omt',
      'source-layer': 'transportation',
      filter: ['==', ['get', 'class'], 'rail'],
      paint: { 'line-color': '#26262b', 'line-width': 1, 'line-dasharray': [3, 3] },
    },
    {
      id: 'road-label',
      type: 'symbol',
      source: 'omt',
      'source-layer': 'transportation_name',
      minzoom: 14.5,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 18, 14],
        'text-letter-spacing': 0.02,
      },
      paint: { 'text-color': c.label, 'text-halo-color': c.bg, 'text-halo-width': 1.4 },
    },
    {
      id: 'park-label',
      type: 'symbol',
      source: 'omt',
      'source-layer': 'poi',
      minzoom: 15,
      filter: ['in', ['get', 'class'], ['literal', ['park', 'garden']]],
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-max-width': 8 },
      paint: { 'text-color': '#5f8a6c', 'text-halo-color': c.bg, 'text-halo-width': 1.2 },
    },
    {
      id: 'hood-label',
      type: 'symbol',
      source: 'omt',
      'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['neighbourhood', 'suburb', 'quarter']]],
      minzoom: 12,
      layout: {
        'text-field': ['upcase', ['get', 'name']],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 16, 20],
        'text-letter-spacing': 0.35,
        'text-max-width': 12,
      },
      paint: { 'text-color': c.hood, 'text-opacity': 0.55, 'text-halo-color': c.bg, 'text-halo-width': 1 },
    },
  ],
};
