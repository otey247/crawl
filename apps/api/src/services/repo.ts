import {
  formatDays,
  formatWindow,
  isSpecialLive,
  type CrawlDetailDTO,
  type CrawlPermissions,
  type CrawlSummaryDTO,
  type MemberDTO,
  type MemberRole,
  type MessageDTO,
  type PhotoDTO,
  type RouteDTO,
  type SpecialDTO,
  type SpecialRule,
  type StopDTO,
  type UserDTO,
  type VenueDTO,
} from '@crawl/core';
import { DEFAULT_NEIGHBORHOOD, findNeighborhood } from '../cities/index.js';
import { one, query, type Queryable } from '../db/pool.js';
import { forbidden, notFound } from '../lib/errors.js';
import { hoursGuard } from './hours.js';
import { storage } from './storage.js';

export const MIN_SPECIAL_CONFIDENCE = 0.4;

export function userDTO(r: { id: string; display_name: string; avatar_url: string | null }): UserDTO {
  return { id: r.id, displayName: r.display_name, avatarUrl: r.avatar_url };
}

/** Crowd specials decay after 30 days without a confirmation (halving every 30 days after). */
export function effectiveConfidence(r: { source: string; confidence: number; last_confirmed_at: string | null; created_at: string }): number {
  if (r.source !== 'crowd') return r.confidence;
  const since = new Date(r.last_confirmed_at ?? r.created_at).getTime();
  const days = (Date.now() - since) / 86_400_000;
  return days <= 30 ? r.confidence : r.confidence * 0.5 ** ((days - 30) / 30);
}

export function specialRule(r: any): SpecialRule {
  return {
    id: r.id,
    title: r.title,
    daysOfWeek: r.days_of_week ?? [],
    startTime: r.start_time,
    endTime: r.end_time,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  };
}

export function specialDTO(r: any, tz: string, now = Date.now()): SpecialDTO {
  const rule = specialRule(r);
  return {
    id: r.id,
    venueId: r.venue_id,
    crawlId: r.crawl_id,
    title: r.title,
    details: r.details,
    daysOfWeek: rule.daysOfWeek,
    startTime: r.start_time,
    endTime: r.end_time,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    source: r.source,
    confidence: +effectiveConfidence(r).toFixed(2),
    label: `${formatDays(rule.daysOfWeek)} · ${formatWindow(rule)}`,
    liveNow: isSpecialLive(rule, now, tz),
  };
}

/** Specials for venues: global ones plus any scoped to `crawlId`, above the confidence floor. */
export async function specialsForVenues(venueIds: string[], crawlId: string | null, db?: Queryable): Promise<any[]> {
  if (!venueIds.length) return [];
  const rows = await query(
    `select * from specials where venue_id = any($1) and (crawl_id is null or crawl_id = $2) order by start_time`,
    [venueIds, crawlId],
    db,
  );
  return rows.filter((r) => effectiveConfidence(r) >= MIN_SPECIAL_CONFIDENCE);
}

const VENUE_COLS = `v.id, v.osm_id, coalesce(v.name_override, v.name) as name, v.lat, v.lng, v.address, v.category, v.price_level,
  v.tags, v.opening_hours, v.image_url, v.image_credit, v.neighborhood_id`;

export function venueDTO(r: any, specials: any[], tz: string, now = Date.now()): VenueDTO {
  return {
    id: r.id,
    osmId: r.osm_id,
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    address: r.address,
    category: r.category,
    priceLevel: r.price_level,
    tags: r.tags ?? [],
    openingHours: r.opening_hours,
    openNow: hoursGuard(r.opening_hours, tz).isOpenAt(now) ?? null,
    imageUrl: r.image_url,
    imageCredit: r.image_credit ?? null,
    neighborhoodId: r.neighborhood_id,
    specials: specials.filter((s) => s.venue_id === r.id).map((s) => specialDTO(s, tz, now)),
    ...(r.distance_m != null ? { distanceM: r.distance_m } : {}),
  };
}

export function tzForNeighborhood(id: string | null | undefined): string {
  return (findNeighborhood(id ?? DEFAULT_NEIGHBORHOOD) ?? findNeighborhood(DEFAULT_NEIGHBORHOOD))!.city.timezone;
}

export async function searchVenues(opts: {
  q?: string;
  neighborhoodId?: string;
  bbox?: [number, number, number, number];
  near?: { lat: number; lng: number };
  limit?: number;
}): Promise<VenueDTO[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.q) {
    params.push(`%${opts.q.toLowerCase()}%`);
    where.push(`(lower(coalesce(v.name_override, v.name)) like $${params.length} or lower(coalesce(v.address,'')) like $${params.length} or exists (select 1 from unnest(v.tags) t where lower(t) like $${params.length}))`);
  }
  if (opts.neighborhoodId) {
    params.push(opts.neighborhoodId);
    where.push(`v.neighborhood_id = $${params.length}`);
  }
  if (opts.bbox) {
    const [s, w, n, e] = opts.bbox;
    params.push(s, w, n, e);
    const i = params.length;
    where.push(`v.lat between $${i - 3} and $${i - 1} and v.lng between $${i - 2} and $${i}`);
  }
  let distance = 'null::double precision';
  if (opts.near) {
    params.push(opts.near.lat, opts.near.lng);
    const i = params.length;
    // Equirectangular approximation; fine at city scale and index-free.
    distance = `sqrt(power((v.lat - $${i - 1}) * 111320, 2) + power((v.lng - $${i}) * 111320 * cos(radians($${i - 1})), 2))`;
  }
  params.push(opts.limit ?? 100);
  const rows = await query(
    `select ${VENUE_COLS}, ${distance} as distance_m from venues v ${where.length ? 'where ' + where.join(' and ') : ''}
     order by ${opts.near ? 'distance_m' : 'name'} limit $${params.length}`,
    params,
  );
  const tz = tzForNeighborhood(opts.neighborhoodId);
  const specials = await specialsForVenues(rows.map((r) => r.id), null);
  return rows.map((r) => venueDTO(r, specials, tz));
}

export async function getVenue(id: string, crawlId: string | null = null): Promise<VenueDTO> {
  const r = await one(`select ${VENUE_COLS} from venues v where v.id = $1`, [id]);
  if (!r) throw notFound('Venue not found');
  const specials = await specialsForVenues([id], crawlId);
  return venueDTO(r, specials, tzForNeighborhood(r.neighborhood_id));
}

// ---------------------------------------------------------------------------------------------
// Crawls

export interface CrawlRow {
  id: string;
  organizer_id: string;
  title: string;
  description: string | null;
  visibility: 'public' | 'private';
  date: string;
  start_at: string;
  timezone: string;
  status: 'draft' | 'planned' | 'live' | 'ended';
  neighborhood_id: string | null;
  approved_route_id: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export async function getCrawlRow(id: string, db?: Queryable): Promise<CrawlRow> {
  const row = await one<CrawlRow>('select * from crawls where id = $1', [id], db);
  if (!row) throw notFound('Crawl not found');
  return row;
}

export async function getMembership(crawlId: string, userId: string | null | undefined, db?: Queryable) {
  if (!userId) return null;
  return one<{ role: MemberRole; rsvp: string; crew_role: string | null; location_sharing: boolean }>(
    'select role, rsvp, crew_role, location_sharing from memberships where crawl_id = $1 and user_id = $2',
    [crawlId, userId],
    db,
  );
}

export function permissionsFor(role: MemberRole | null | undefined): CrawlPermissions {
  const org = role === 'organizer';
  const host = org || role === 'co_host';
  return {
    isMember: !!role,
    canEdit: host,
    canApprove: org,
    canInvite: host,
    canManageMembers: org,
    canRunLive: host,
    canModeratePhotos: host,
    canDelete: org,
  };
}

/** Throws unless the user's role meets `need`. Returns the membership. */
export async function requireRole(crawlId: string, userId: string, need: 'member' | 'host' | 'organizer', db?: Queryable) {
  const m = await getMembership(crawlId, userId, db);
  if (!m) throw forbidden('Members only');
  if (need === 'host' && m.role === 'participant') throw forbidden('Organizer or co-host only');
  if (need === 'organizer' && m.role !== 'organizer') throw forbidden('Organizer only');
  return m;
}

export async function loadStops(crawlId: string, tz: string, db?: Queryable): Promise<StopDTO[]> {
  const rows = await query(
    `select s.*, ${VENUE_COLS} , s.id as stop_id from crawl_stops s join venues v on v.id = s.venue_id where s.crawl_id = $1 order by s.position`,
    [crawlId],
    db,
  );
  const specials = await specialsForVenues(rows.map((r) => r.venue_id), crawlId, db);
  return rows.map((r) => ({
    id: r.stop_id,
    venue: venueDTO({ ...r, id: r.venue_id }, specials, tz),
    position: r.position,
    dwellMin: r.dwell_min,
    locked: r.locked,
    plannedArrivalAt: r.planned_arrival_at,
    plannedDepartureAt: r.planned_departure_at,
    arrivedAt: r.arrived_at,
    departedAt: r.departed_at,
    skipped: r.skipped,
  }));
}

export async function loadMembers(crawlId: string, db?: Queryable): Promise<MemberDTO[]> {
  const rows = await query(
    `select m.*, u.display_name, u.avatar_url,
       (select count(*) from check_ins c where c.crawl_id = m.crawl_id and c.user_id = m.user_id) as check_in_count
     from memberships m join users u on u.id = m.user_id where m.crawl_id = $1
     order by case m.role when 'organizer' then 0 when 'co_host' then 1 else 2 end,
              case m.rsvp when 'going' then 0 when 'maybe' then 1 else 2 end, m.joined_at`,
    [crawlId],
    db,
  );
  return rows.map(memberDTO);
}

export function memberDTO(r: any): MemberDTO {
  return {
    user: userDTO({ id: r.user_id, display_name: r.display_name, avatar_url: r.avatar_url }),
    role: r.role,
    crewRole: r.crew_role,
    rsvp: r.rsvp,
    locationSharing: r.location_sharing,
    joinedAt: r.joined_at,
    checkInCount: Number(r.check_in_count ?? 0),
    homeSafeAt: r.home_safe_at ?? null,
  };
}

export async function loadMember(crawlId: string, userId: string): Promise<MemberDTO> {
  const r = await one(
    `select m.*, u.display_name, u.avatar_url,
       (select count(*) from check_ins c where c.crawl_id = m.crawl_id and c.user_id = m.user_id) as check_in_count
     from memberships m join users u on u.id = m.user_id where m.crawl_id = $1 and m.user_id = $2`,
    [crawlId, userId],
  );
  if (!r) throw notFound('Member not found');
  return memberDTO(r);
}

export async function loadRoute(routeId: string | null, db?: Queryable): Promise<RouteDTO | null> {
  if (!routeId) return null;
  const r = await one('select * from routes where id = $1', [routeId], db);
  if (!r) return null;
  const legs = await query('select * from route_legs where route_id = $1 order by seq', [routeId], db);
  const m = r.metrics ?? {};
  return {
    id: r.id,
    status: r.status,
    stopOrder: r.stop_order,
    geometry: r.geometry,
    totalDistanceM: r.total_distance_m,
    totalWalkS: r.total_walk_s,
    totalS: r.total_s,
    preferences: r.preferences,
    explanation: r.explanation,
    method: r.method,
    legs: legs.map((l) => ({ fromStopId: l.from_stop_id, toStopId: l.to_stop_id, distanceM: l.distance_m, walkS: l.walk_s, geometry: l.geometry })),
    stops: m.stops ?? [],
    caughtCount: m.caughtCount ?? 0,
    missedCount: m.missedCount ?? 0,
    baseline: m.baseline ?? null,
    violations: m.violations ?? [],
    error: r.error,
    createdAt: r.created_at,
  };
}

/** Badges shown on crawl cards, derived from stops and specials. */
function highlightsFor(stops: { tags: string[]; specialCount: number }[], goingCount: number): string[] {
  const out: string[] = [];
  if (stops.some((s) => s.specialCount > 0)) out.push('Happy hour');
  if (stops.some((s) => s.tags.some((t) => /live music/i.test(t)))) out.push('Live music');
  if (stops.some((s) => s.tags.some((t) => /patio|garden|courtyard|beer garden/i.test(t)))) out.push('Patio');
  if (goingCount >= 8) out.push('Great for groups');
  return out;
}

export async function summarize(rows: CrawlRow[], viewerId: string | null): Promise<CrawlSummaryDTO[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [organizers, stops, counts, previews, mine, photos] = await Promise.all([
    query('select id, display_name, avatar_url from users where id = any($1)', [rows.map((r) => r.organizer_id)]),
    query(
      `select s.crawl_id, s.position, coalesce(v.name_override, v.name) as name, v.lat, v.lng, v.tags, v.image_url, v.category,
         (select count(*) from specials sp where sp.venue_id = v.id and (sp.crawl_id is null or sp.crawl_id = s.crawl_id)) as special_count
       from crawl_stops s join venues v on v.id = s.venue_id where s.crawl_id = any($1) order by s.crawl_id, s.position`,
      [ids],
    ),
    query(
      `select crawl_id, count(*) filter (where rsvp = 'going') as going, count(*) filter (where rsvp = 'maybe') as maybe
       from memberships where crawl_id = any($1) group by crawl_id`,
      [ids],
    ),
    query(
      `select * from (select m.crawl_id, u.id, u.display_name, u.avatar_url,
         row_number() over (partition by m.crawl_id order by (m.role = 'organizer') desc, m.joined_at) as rn
       from memberships m join users u on u.id = m.user_id where m.crawl_id = any($1) and m.rsvp = 'going') x where rn <= 5`,
      [ids],
    ),
    viewerId ? query('select crawl_id, role, rsvp, crew_role from memberships where crawl_id = any($1) and user_id = $2', [ids, viewerId]) : Promise.resolve([]),
    query(`select crawl_id, count(*) as n from photos where crawl_id = any($1) and status = 'ready' group by crawl_id`, [ids]),
  ]);
  return rows.map((r) => {
    const org = organizers.find((o) => o.id === r.organizer_id)!;
    const myStops = stops.filter((s) => s.crawl_id === r.id);
    const c = counts.find((x) => x.crawl_id === r.id);
    const m = mine.find((x: any) => x.crawl_id === r.id);
    const goingCount = Number(c?.going ?? 0);
    const first = myStops[0];
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      visibility: r.visibility,
      status: r.status,
      startAt: r.start_at,
      timezone: r.timezone,
      neighborhoodId: r.neighborhood_id,
      organizer: userDTO(org),
      stopCount: myStops.length,
      goingCount,
      maybeCount: Number(c?.maybe ?? 0),
      attendeesPreview: previews.filter((p) => p.crawl_id === r.id).map(userDTO),
      highlights: highlightsFor(
        myStops.map((s) => ({ tags: s.tags, specialCount: Number(s.special_count) })),
        goingCount,
      ),
      cover: first ? { venueName: first.name, imageUrl: first.image_url, category: first.category } : null,
      firstStop: first ? { name: first.name, lat: first.lat, lng: first.lng } : null,
      myMembership: m ? { role: m.role, rsvp: m.rsvp, crewRole: m.crew_role } : null,
      photoCount: Number(photos.find((p) => p.crawl_id === r.id)?.n ?? 0),
    };
  });
}

/** Members see everything; non-members see a public crawl's title, date and stops only. */
export async function loadCrawlDetail(crawlId: string, viewerId: string | null, liveLoader?: (crawlId: string, viewerRole: MemberRole | null) => Promise<CrawlDetailDTO['live']>): Promise<CrawlDetailDTO> {
  const row = await getCrawlRow(crawlId);
  const membership = await getMembership(crawlId, viewerId);
  if (!membership && row.visibility === 'private') {
    const invited = viewerId ? await one('select 1 from invite_targets where crawl_id = $1 and user_id = $2', [crawlId, viewerId]) : null;
    if (!invited) throw notFound('Crawl not found');
  }
  const [summary] = await summarize([row], viewerId);
  const isMember = !!membership;
  const [stops, members, approvedRoute, proposalRow] = await Promise.all([
    loadStops(crawlId, row.timezone),
    isMember ? loadMembers(crawlId) : Promise.resolve([]),
    loadRoute(row.approved_route_id),
    membership && membership.role !== 'participant'
      ? one(`select id from routes where crawl_id = $1 and status in ('pending','proposed','failed') order by created_at desc limit 1`, [crawlId])
      : Promise.resolve(null),
  ]);
  const latestProposal = proposalRow ? await loadRoute(proposalRow.id) : null;
  const live = isMember && liveLoader && (row.status === 'live' || row.status === 'ended') ? await liveLoader(crawlId, membership!.role) : null;
  return {
    ...summary,
    stops,
    members,
    approvedRoute,
    latestProposal,
    live,
    permissions: permissionsFor(membership?.role),
    safety: (findNeighborhood(row.neighborhood_id) ?? findNeighborhood(DEFAULT_NEIGHBORHOOD))!.city.safety,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function photoDTO(r: any): PhotoDTO {
  return {
    id: r.id,
    crawlId: r.crawl_id,
    uploader: userDTO({ id: r.uploader_id, display_name: r.display_name, avatar_url: r.avatar_url }),
    stopId: r.stop_id,
    thumbUrl: storage.presignGet(r.thumb_key ?? r.storage_key),
    url: storage.presignGet(r.medium_key ?? r.storage_key),
    width: r.width,
    height: r.height,
    takenAt: r.taken_at,
    status: r.status,
    createdAt: r.created_at,
    reportCount: Number(r.report_count ?? 0),
  };
}

export async function loadPhoto(id: string): Promise<PhotoDTO | null> {
  const r = await one(
    `select p.*, u.display_name, u.avatar_url, (select count(*) from photo_reports pr where pr.photo_id = p.id) as report_count
     from photos p join users u on u.id = p.uploader_id where p.id = $1`,
    [id],
  );
  return r ? photoDTO(r) : null;
}

export function messageDTO(r: any): MessageDTO {
  return {
    id: r.id,
    crawlId: r.crawl_id,
    user: r.user_id ? userDTO({ id: r.user_id, display_name: r.display_name, avatar_url: r.avatar_url }) : null,
    body: r.body,
    kind: r.kind,
    createdAt: r.created_at,
  };
}
