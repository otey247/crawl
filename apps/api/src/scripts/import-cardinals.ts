/**
 * Cardinals home games (Busch Stadium, a few blocks north of Soulard) from the public MLB Stats API.
 * Writes data/events/cardinals-<season>.json, which the seed and the events sync read.
 *
 *   npx tsx src/scripts/import-cardinals.ts 2027
 */
import { writeFileSync } from 'node:fs';

const CARDINALS = 138;
const season = Number(process.argv[2] ?? new Date().getFullYear() + 1);
const res = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${CARDINALS}&season=${season}&gameType=R`, {
  headers: { 'user-agent': 'crawl-app/1.0 (schedule sync)' },
  signal: AbortSignal.timeout(30_000),
});
if (!res.ok) throw new Error(`MLB schedule ${res.status}`);
const data = (await res.json()) as any;
const games = data.dates
  .flatMap((d: any) => d.games)
  .filter((g: any) => g.teams.home.team.id === CARDINALS)
  .map((g: any) => ({ id: `mlb-${g.gamePk}`, startsAt: g.gameDate, opponent: g.teams.away.team.name, venue: g.venue?.name ?? 'Busch Stadium', dayNight: g.dayNight }));
writeFileSync(new URL(`../../data/events/cardinals-${season}.json`, import.meta.url), JSON.stringify({ source: 'https://statsapi.mlb.com', fetchedAt: new Date().toISOString(), season, games }, null, 1) + '\n');
console.log(`${games.length} Cardinals home games in ${season}.`);
