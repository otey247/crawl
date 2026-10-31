/**
 * Process curated venue photos into data/venue-images:
 *   <osm-type>-<id>.jpg      1600 px max, for sheets and share cards
 *   <osm-type>-<id>-480.jpg  640×480 crop, for list tiles
 * and record credits in data/venue-images/credits.json (read by the seed).
 *
 *   npx tsx src/scripts/import-venue-images.ts <manifest.json> <source-dir>
 *
 * Manifest rows: { osmName, file, imageUrl, sourcePage, license, author, notes }.
 * Metadata (EXIF, GPS) is stripped by re-encoding.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { venueImageFile } from '../routes/venueImages.js';

const [manifestPath, sourceDir] = process.argv.slice(2);
if (!manifestPath || !sourceDir) throw new Error('usage: import-venue-images <manifest.json> <source-dir>');
const outDir = new URL('../../data/venue-images/', import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const venues: { osm_id: string; name: string }[] = JSON.parse(readFileSync(new URL('../../data/soulard-venues.json', import.meta.url), 'utf8'));
const manifest: any[] = JSON.parse(readFileSync(manifestPath, 'utf8'));
const credits: Record<string, { file: string; author: string | null; license: string | null; sourcePage: string | null }> = {};

for (const row of manifest) {
  if (!row.file) continue;
  const venue = venues.find((v) => v.name === row.osmName);
  if (!venue) {
    console.warn(`skip: no venue named ${row.osmName}`);
    continue;
  }
  const src = readFileSync(join(sourceDir, row.file));
  const full = venueImageFile(venue.osm_id);
  await sharp(src).rotate().resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toFile(join(outDir, full));
  await sharp(src).rotate().resize({ width: 640, height: 480, fit: 'cover', position: 'attention' }).jpeg({ quality: 78, mozjpeg: true }).toFile(join(outDir, venueImageFile(venue.osm_id, 'thumb')));
  credits[venue.osm_id] = { file: full, author: row.author ?? null, license: row.license ?? null, sourcePage: row.sourcePage ?? row.imageUrl ?? null };
  console.log(`${venue.name}: ${full}`);
}
writeFileSync(join(outDir, 'credits.json'), JSON.stringify(credits, null, 2) + '\n');
console.log(`${Object.keys(credits).length} venue images processed.`);
