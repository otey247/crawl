/**
 * Refresh a neighborhood from OpenStreetMap via Overpass:
 *   - upserts bars/pubs/biergartens into `venues` by osm_id (app-side overrides are preserved)
 *   - writes data/<hood>.geo.json with arterial roads and green space for route preferences
 *
 *   npm run venues:import -- soulard
 *
 * Run nightly per launched neighborhood. Use your own Overpass instance (OVERPASS_URL) for
 * anything beyond light use; the public servers do not allow bulk scraping.
 */
import { writeFileSync } from 'node:fs';
import { CITIES, findNeighborhood } from '../cities/index.js';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';

async function overpass(q: string, attempt = 1): Promise<any[]> {
  try {
    return await overpassOnce(q);
  } catch (err) {
    if (attempt >= 4) throw err;
    console.warn(`Overpass attempt ${attempt} failed (${(err as Error).message.slice(0, 80)}); retrying…`);
    await new Promise((r) => setTimeout(r, 3000 * 2 ** attempt));
    return overpass(q, attempt + 1);
  }
}

async function overpassOnce(q: string): Promise<any[]> {
  const res = await fetch(config.overpassUrl, {
    method: 'POST',
    body: new URLSearchParams({ data: `[out:json][timeout:60];${q}` }),
    headers: { 'user-agent': 'crawl-app/1.0 (venue sync)' },
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { elements: any[] }).elements;
}

async function main() {
  const hoodId = process.argv[2] ?? 'soulard';
  const found = findNeighborhood(hoodId);
  if (!found) throw new Error(`Unknown neighborhood ${hoodId}. Known: ${CITIES.flatMap((c) => c.neighborhoods.map((n) => n.id)).join(', ')}`);
  const [s, w, n, e] = found.hood.bbox;
  const bbox = `${s},${w},${n},${e}`;

  const venues = await overpass(`(nwr["amenity"~"^(pub|bar|biergarten)$"](${bbox}););out center tags;`);
  let upserted = 0;
  for (const el of venues) {
    const t = el.tags ?? {};
    if (!t.name) continue;
    const c = el.center ?? el;
    const category = t.amenity === 'pub' ? 'pub' : t.amenity === 'biergarten' ? 'biergarten' : t.cocktails === 'yes' ? 'cocktail' : 'bar';
    const address = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || null;
    // OSM-owned fields refresh; name_override, tags, price and claims are app-side and untouched.
    await query(
      `insert into venues (osm_id, name, lat, lng, address, neighborhood_id, category, opening_hours, source, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'osm', now())
       on conflict (osm_id) do update set name = excluded.name, lat = excluded.lat, lng = excluded.lng,
         address = coalesce(excluded.address, venues.address), opening_hours = excluded.opening_hours, synced_at = now()`,
      [`${el.type}/${el.id}`, t.name, c.lat, c.lon, address, hoodId, category, t.opening_hours ?? null],
    );
    upserted++;
  }

  const line = (g: any[]) => g.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]);
  const arterials = await overpass(`(way["highway"~"^(trunk|primary|secondary|motorway)$"](${bbox}););out geom tags;`);
  const green = await overpass(`(way["leisure"~"^(park|garden)$"](${bbox});way["amenity"="marketplace"](${bbox});way["highway"="pedestrian"](${bbox}););out geom tags;`);
  const geo = {
    attribution: '© OpenStreetMap contributors (ODbL)',
    arterials: arterials.filter((x) => x.geometry).map((x) => ({ name: x.tags?.name ?? x.tags?.ref ?? 'unnamed', class: x.tags.highway, line: line(x.geometry) })),
    green: green.filter((x) => x.geometry).map((x) => ({ name: x.tags?.name ?? 'green', kind: x.tags?.leisure ?? x.tags?.amenity ?? x.tags?.highway, line: line(x.geometry) })),
  };
  writeFileSync(new URL(`../../data/${hoodId}.geo.json`, import.meta.url), JSON.stringify(geo));
  console.log(`${found.hood.name}: ${upserted} venues upserted, ${geo.arterials.length} arterials, ${geo.green.length} green features.`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
