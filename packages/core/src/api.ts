/** Wire types shared by the API and the clients. All timestamps are ISO strings. */
import type { ScheduleFix, StopPhase } from './live.js';
import type {
  CrawlStatus,
  CrewRole,
  MemberRole,
  PhotoStatus,
  RoutePreferences,
  RouteStatus,
  Rsvp,
  SpecialSource,
  SpecialState,
  Visibility,
} from './types.js';

export interface UserDTO {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface MeDTO extends UserDTO {
  email: string | null;
  ageVerified: boolean;
}

export interface SpecialDTO {
  id: string;
  venueId: string;
  crawlId: string | null;
  title: string;
  details: string | null;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  validFrom: string | null;
  validTo: string | null;
  source: SpecialSource;
  confidence: number;
  /** e.g. "Weekdays · 4–7pm" */
  label: string;
  liveNow: boolean;
}

export interface VenueDTO {
  id: string;
  osmId: string | null;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  category: 'pub' | 'bar' | 'biergarten' | 'cocktail';
  priceLevel: number | null;
  tags: string[];
  openingHours: string | null;
  /** null when OSM has no hours for the venue. */
  openNow: boolean | null;
  imageUrl: string | null;
  /** Photo credit for imageUrl (author, license, where it came from). */
  imageCredit: ImageCreditDTO | null;
  neighborhoodId: string | null;
  specials: SpecialDTO[];
  distanceM?: number;
}

export interface ImageCreditDTO {
  author: string | null;
  license: string | null;
  sourcePage: string | null;
}

export interface SafetyInfoDTO {
  emergency: string;
  crisisLine: { label: string; phone: string };
  cabs: { name: string; phone: string; url: string }[];
  rideApps: { name: string; url: string }[];
}

export interface NeighborhoodDTO {
  id: string;
  cityId: string;
  name: string;
  cityName: string;
  timezone: string;
  center: { lat: number; lng: number };
  zoom: number;
  venueCount: number;
}

export interface StopDTO {
  id: string;
  venue: VenueDTO;
  position: number;
  dwellMin: number;
  locked: boolean;
  plannedArrivalAt: string | null;
  plannedDepartureAt: string | null;
  arrivedAt: string | null;
  departedAt: string | null;
  skipped: boolean;
}

export interface MemberDTO {
  user: UserDTO;
  role: MemberRole;
  crewRole: CrewRole | null;
  rsvp: Rsvp;
  locationSharing: boolean;
  joinedAt: string;
  checkInCount: number;
  /** Set when the member confirms they got home after the crawl. */
  homeSafeAt: string | null;
}

export interface RouteLegDTO {
  fromStopId: string | null;
  toStopId: string;
  distanceM: number;
  walkS: number;
  geometry: [number, number][];
}

export interface RouteStopMetric {
  stopId: string;
  arrival: string;
  departure: string;
  waitS: number;
  caught: string[];
  missed: string[];
}

export interface RouteTotals {
  order: string[];
  totalDistanceM: number;
  totalWalkS: number;
  totalS: number;
  caughtCount: number;
  missedCount: number;
}

export interface RouteDTO {
  id: string;
  status: RouteStatus;
  stopOrder: string[];
  geometry: [number, number][];
  totalDistanceM: number;
  totalWalkS: number;
  totalS: number;
  preferences: RoutePreferences;
  explanation: string | null;
  method: string | null;
  legs: RouteLegDTO[];
  stops: RouteStopMetric[];
  caughtCount: number;
  missedCount: number;
  baseline: RouteTotals | null;
  violations: string[];
  error: string | null;
  createdAt: string;
}

export interface ProjectedStopDTO {
  stopId: string;
  phase: StopPhase;
  eta: string | null;
  departure: string | null;
}

export interface LiveSpecialDTO {
  stopId: string;
  specialId: string;
  venueName: string;
  title: string;
  details: string | null;
  state: SpecialState;
  endsAt: string | null;
  eta: string | null;
  minutesShort: number | null;
  hoursUnverified: boolean;
  source: SpecialSource;
}

export interface AtRiskDTO extends LiveSpecialDTO {
  fixes: ScheduleFix[];
}

export interface LiveStateDTO {
  currentStopId: string | null;
  leaderUserId: string | null;
  position: { lat: number; lng: number; at: string } | null;
  driftS: number;
  paceFactor: number;
  schedule: ProjectedStopDTO[];
  specials: LiveSpecialDTO[];
  /** Only populated for organizers / co-hosts. */
  atRisk: AtRiskDTO[];
  simulating: boolean;
}

export interface CrawlPermissions {
  isMember: boolean;
  canEdit: boolean;
  canApprove: boolean;
  canInvite: boolean;
  canManageMembers: boolean;
  canRunLive: boolean;
  canModeratePhotos: boolean;
  canDelete: boolean;
}

export interface CrawlSummaryDTO {
  id: string;
  title: string;
  description: string | null;
  visibility: Visibility;
  status: CrawlStatus;
  startAt: string;
  timezone: string;
  neighborhoodId: string | null;
  organizer: UserDTO;
  stopCount: number;
  goingCount: number;
  maybeCount: number;
  attendeesPreview: UserDTO[];
  highlights: string[];
  cover: { venueName: string; imageUrl: string | null; category: VenueDTO['category'] } | null;
  firstStop: { name: string; lat: number; lng: number } | null;
  myMembership: { role: MemberRole; rsvp: Rsvp; crewRole: CrewRole | null } | null;
  photoCount: number;
}

export interface CrawlDetailDTO extends CrawlSummaryDTO {
  stops: StopDTO[];
  members: MemberDTO[];
  approvedRoute: RouteDTO | null;
  latestProposal: RouteDTO | null;
  live: LiveStateDTO | null;
  permissions: CrawlPermissions;
  safety: SafetyInfoDTO | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface PhotoDTO {
  id: string;
  crawlId: string;
  uploader: UserDTO;
  stopId: string | null;
  thumbUrl: string;
  url: string;
  width: number | null;
  height: number | null;
  takenAt: string | null;
  status: PhotoStatus;
  createdAt: string;
  reportCount: number;
}

export interface MessageDTO {
  id: string;
  crawlId: string;
  user: UserDTO | null;
  body: string;
  kind: 'text' | 'system';
  createdAt: string;
}

export interface NotificationDTO {
  id: string;
  kind: string;
  title: string;
  body: string;
  crawlId: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export interface InviteDTO {
  id: string;
  token: string;
  url: string;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface InvitePreviewDTO {
  crawl: Pick<CrawlSummaryDTO, 'id' | 'title' | 'startAt' | 'timezone' | 'organizer' | 'stopCount' | 'goingCount' | 'firstStop' | 'visibility'>;
  valid: boolean;
  reason: string | null;
}

export interface VisitedCrawlDTO {
  crawl: { id: string; title: string; startAt: string; endedAt: string | null; timezone: string };
  venues: { stopId: string; venueId: string; name: string; address: string | null; category: VenueDTO['category']; checkedInAt: string }[];
}

export interface VisitedHistoryDTO {
  totalVenues: number;
  uniqueVenues: number;
  crawls: VisitedCrawlDTO[];
}

/** Socket.IO events on the `crawl:{id}` channel. */
export interface ServerToClientEvents {
  'group.position': (p: { lat: number; lng: number; at: string; currentStopId: string | null }) => void;
  'stop.arrived': (p: { stopId: string; arrivedAt: string; driftS: number }) => void;
  'stop.departed': (p: { stopId: string; departedAt: string; nextStopId: string | null; eta: string | null }) => void;
  'schedule.updated': (p: { stops: ProjectedStopDTO[] }) => void;
  'live.state': (p: { crawlId: string; live: LiveStateDTO }) => void;
  'special.highlight': (p: LiveSpecialDTO) => void;
  'special.at_risk': (p: AtRiskDTO) => void;
  'special.missed': (p: LiveSpecialDTO) => void;
  'route.proposed': (p: { crawlId: string; routeId: string; status: RouteStatus }) => void;
  'route.approved': (p: { crawlId: string; routeId: string; stopOrder: string[] }) => void;
  'photo.added': (p: PhotoDTO) => void;
  'photo.removed': (p: { photoId: string }) => void;
  'member.joined': (p: { userId: string; displayName: string }) => void;
  'member.updated': (p: MemberDTO) => void;
  'member.removed': (p: { userId: string }) => void;
  'chat.message': (p: MessageDTO) => void;
  'crawl.updated': (p: { crawlId: string }) => void;
  'crawl.ended': (p: { endedAt: string; photoCount: number }) => void;
  notification: (p: NotificationDTO) => void;
}

export interface ClientToServerEvents {
  'crawl.join': (crawlId: string, ack: (res: { ok: boolean; error?: string }) => void) => void;
  'crawl.leave': (crawlId: string) => void;
  'position.update': (p: { crawlId: string; lat: number; lng: number; accuracyM?: number; at?: string }) => void;
  'chat.send': (p: { crawlId: string; body: string }, ack: (res: { ok: boolean; message?: MessageDTO; error?: string }) => void) => void;
}
