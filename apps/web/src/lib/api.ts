import type {
  CrawlDetailDTO,
  CrawlSummaryDTO,
  InviteDTO,
  InvitePreviewDTO,
  LiveSpecialDTO,
  LiveStateDTO,
  MeDTO,
  MemberDTO,
  MessageDTO,
  NeighborhoodDTO,
  NotificationDTO,
  PhotoDTO,
  PreferenceTag,
  RecapDTO,
  RideBoardDTO,
  RouteDTO,
  ScheduleFix,
  SpecialDTO,
  UserDTO,
  VenueDTO,
  VisitedHistoryDTO,
} from '@crawl/core';

const BASE = import.meta.env.VITE_API_URL ?? '';
const TOKEN_KEY = 'crawl.token';

export const tokenStore = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (t: string | null) => {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.code);
  return data as T;
}

const get = <T,>(p: string) => request<T>('GET', p);
const post = <T,>(p: string, b: unknown = {}) => request<T>('POST', p, b);
const patch = <T,>(p: string, b: unknown) => request<T>('PATCH', p, b);
const put = <T,>(p: string, b: unknown) => request<T>('PUT', p, b);
const del = <T,>(p: string) => request<T>('DELETE', p);

const qs = (o: Record<string, string | number | undefined | null>) => {
  const e = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return e.length ? '?' + new URLSearchParams(e.map(([k, v]) => [k, String(v)])).toString() : '';
};

export interface SpecialInput {
  title: string;
  details?: string | null;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  validFrom?: string | null;
  validTo?: string | null;
  crawlId?: string | null;
}

export const api = {
  // auth
  devUsers: () => get<UserDTO[]>('/auth/dev-users'),
  magicLink: (email: string, displayName?: string) => post<{ sent: boolean; devLink?: string }>('/auth/magic-link', { email, displayName }),
  session: (body: { provider: 'magic_link'; token: string } | { provider: 'dev'; userId: string }) => post<{ token: string; user: MeDTO }>('/auth/session', body),
  me: () => get<MeDTO>('/me'),
  updateMe: (displayName: string) => patch<MeDTO>('/me', { displayName }),
  verifyAge: () => post<MeDTO>('/me/age-verification', { confirmedOfAge: true, minimumAge: 21 }),

  // venues
  neighborhoods: () => get<NeighborhoodDTO[]>('/neighborhoods'),
  venues: (o: { q?: string; neighborhood?: string; near?: string; limit?: number }) => get<VenueDTO[]>(`/venues/search${qs(o)}`),
  venue: (id: string) => get<VenueDTO>(`/venues/${id}`),
  addSpecial: (venueId: string, body: SpecialInput) => post<SpecialDTO>(`/venues/${venueId}/specials`, body),
  deleteSpecial: (id: string) => del<{ ok: true }>(`/specials/${id}`),
  confirmSpecial: (id: string) => post<SpecialDTO>(`/specials/${id}/confirm`),

  // crawls
  crawls: (o: { neighborhood?: string; when?: 'tonight' | 'week' | 'all' }) => get<CrawlSummaryDTO[]>(`/crawls${qs(o)}`),
  myCrawls: () => get<CrawlSummaryDTO[]>('/me/crawls'),
  crawl: (id: string) => get<CrawlDetailDTO>(`/crawls/${id}`),
  createCrawl: (b: { title: string; description?: string; visibility: 'public' | 'private'; date: string; startTime: string; neighborhoodId: string }) =>
    post<CrawlDetailDTO>('/crawls', b),
  updateCrawl: (id: string, b: Partial<{ title: string; description: string | null; visibility: 'public' | 'private'; date: string; startTime: string }>) =>
    patch<CrawlDetailDTO>(`/crawls/${id}`, b),
  deleteCrawl: (id: string) => del<{ ok: true }>(`/crawls/${id}`),
  addStop: (id: string, venueId: string, dwellMin?: number) => post<CrawlDetailDTO>(`/crawls/${id}/stops`, { venueId, dwellMin }),
  updateStop: (id: string, stopId: string, b: { dwellMin?: number; locked?: boolean }) => patch<CrawlDetailDTO>(`/crawls/${id}/stops/${stopId}`, b),
  removeStop: (id: string, stopId: string) => del<CrawlDetailDTO>(`/crawls/${id}/stops/${stopId}`),
  reorderStops: (id: string, order: string[]) => post<CrawlDetailDTO>(`/crawls/${id}/stops:reorder`, { order }),

  // routes
  optimize: (id: string, b: { tags: PreferenceTag[]; note?: string; order?: string[] }) => post<{ routeId: string }>(`/crawls/${id}/routes:optimize`, b),
  route: (id: string, routeId: string) => get<RouteDTO>(`/crawls/${id}/routes/${routeId}`),
  approveRoute: (id: string, routeId: string) => post<CrawlDetailDTO>(`/crawls/${id}/routes/${routeId}:approve`),

  // invites & members
  invites: (id: string) => get<InviteDTO[]>(`/crawls/${id}/invites`),
  createInvite: (id: string, b: { maxUses?: number | null; expiresInHours?: number | null }) => post<InviteDTO>(`/crawls/${id}/invites`, b),
  revokeInvite: (id: string, inviteId: string) => del<InviteDTO>(`/crawls/${id}/invites/${inviteId}`),
  inviteUsers: (id: string, userIds: string[]) => post<{ invited: number }>(`/crawls/${id}/invite-users`, { userIds }),
  searchUsers: (q: string) => get<UserDTO[]>(`/users/search${qs({ q })}`),
  invitePreview: (token: string) => get<InvitePreviewDTO>(`/invites/${token}`),
  acceptInvite: (token: string) => post<CrawlDetailDTO>(`/invites/${token}:accept`),
  join: (id: string) => post<CrawlDetailDTO>(`/crawls/${id}/join`),
  declineInvite: (id: string) => post<{ ok: true }>(`/crawls/${id}/decline-invite`),
  leave: (id: string) => post<{ ok: true }>(`/crawls/${id}/leave`),
  updateMyMembership: (id: string, b: { rsvp?: 'going' | 'maybe' | 'declined'; locationSharing?: boolean }) => patch<MemberDTO>(`/crawls/${id}/members/me`, b),
  updateMember: (id: string, userId: string, b: { role?: 'co_host' | 'participant'; crewRole?: string | null }) => patch<MemberDTO>(`/crawls/${id}/members/${userId}`, b),
  removeMember: (id: string, userId: string) => del<{ ok: true }>(`/crawls/${id}/members/${userId}`),
  myInvites: () => get<{ crawl: CrawlSummaryDTO; invitedBy: string; invitedAt: string }[]>('/me/invites'),

  // live
  start: (id: string) => post<CrawlDetailDTO>(`/crawls/${id}:start`),
  end: (id: string) => post<CrawlDetailDTO>(`/crawls/${id}:end`),
  live: (id: string) => get<LiveStateDTO>(`/crawls/${id}/live`),
  upcomingSpecials: (id: string) => get<LiveSpecialDTO[]>(`/crawls/${id}/specials/upcoming`),
  arrive: (id: string, stopId: string) => post<CrawlDetailDTO>(`/crawls/${id}/stops/${stopId}/arrive`),
  depart: (id: string) => post<CrawlDetailDTO>(`/crawls/${id}/depart`),
  skipStop: (id: string, stopId: string, skipped: boolean) => post<CrawlDetailDTO>(`/crawls/${id}/stops/${stopId}/skip`, { skipped }),
  applyFix: (id: string, patch: ScheduleFix['patch']) => post<CrawlDetailDTO>(`/crawls/${id}/fixes:apply`, { patch }),
  simulate: (id: string, on: boolean, speed?: number) => post<{ ok: true }>(`/crawls/${id}/simulate`, { on, speed }),
  setLeader: (id: string, userId: string) => put<{ ok: true }>(`/crawls/${id}/leader`, { userId }),
  position: (id: string, b: { lat: number; lng: number; accuracyM?: number }) => post<{ ok: true }>(`/crawls/${id}/position`, b),
  checkIn: (id: string, stopId: string, pos?: { lat: number; lng: number }) => post<{ ok: true; checkedInAt: string }>(`/crawls/${id}/stops/${stopId}/check-in`, pos ?? {}),
  myCheckIns: (id: string) => get<{ stopId: string; checkedInAt: string }[]>(`/crawls/${id}/check-ins/me`),

  // photos
  photos: (id: string, cursor?: string) => get<{ items: PhotoDTO[]; nextCursor: string | null }>(`/crawls/${id}/photos${qs({ cursor })}`),
  uploadUrl: (id: string, b: { contentType: string; width?: number; height?: number; takenAt?: string; stopId?: string | null }) =>
    post<{ photoId: string; uploadUrl: string; headers: Record<string, string> }>(`/crawls/${id}/photos:upload-url`, b),
  completePhoto: (id: string, photoId: string) => post<{ ok: true }>(`/crawls/${id}/photos/${photoId}:complete`),
  deletePhoto: (id: string, photoId: string) => del<{ ok: true }>(`/crawls/${id}/photos/${photoId}`),
  setPhotoHidden: (id: string, photoId: string, hidden: boolean) => post<{ ok: true }>(`/crawls/${id}/photos/${photoId}/visibility`, { hidden }),
  reportPhoto: (photoId: string, reason: string) => post<{ ok: true; hidden: boolean }>(`/photos/${photoId}/reports`, { reason }),
  archiveUrl: (id: string) => `${BASE}/v1/crawls/${id}/photos/archive`,

  // chat, notifications, history
  messages: (id: string, before?: string) => get<{ items: MessageDTO[]; hasMore: boolean }>(`/crawls/${id}/messages${qs({ before })}`),
  sendMessage: (id: string, body: string) => post<MessageDTO>(`/crawls/${id}/messages`, { body }),
  notifications: () => get<{ items: NotificationDTO[]; unread: number }>('/me/notifications'),
  markRead: (ids?: string[]) => post<{ ok: true }>('/me/notifications/read', { ids }),
  history: () => get<VisitedHistoryDTO>('/me/history'),

  // push & safety
  vapidKey: () => get<{ publicKey: string }>('/push/vapid-public-key'),
  savePushSubscription: (b: { endpoint: string; keys: { p256dh: string; auth: string } }) => post<{ ok: true }>('/me/push-subscriptions', b),
  deletePushSubscription: (endpoint: string) => request<{ ok: true }>('DELETE', '/me/push-subscriptions', { endpoint }),
  homeSafe: (id: string) => post<{ ok: true; homeSafeAt: string }>(`/crawls/${id}/home-safe`),

  // tier 2: rides, photographer picks, catch-up, recap
  rides: (id: string) => get<RideBoardDTO>(`/crawls/${id}/rides`),
  offerRide: (id: string, b: { seats: number; area: string; leavingNote?: string | null }) => put<RideBoardDTO>(`/crawls/${id}/rides/offer`, b),
  cancelOffer: (id: string) => del<RideBoardDTO>(`/crawls/${id}/rides/offer`),
  requestRide: (id: string, b: { destination: string; partySize: number }) => put<RideBoardDTO>(`/crawls/${id}/rides/request`, b),
  cancelRequest: (id: string) => del<RideBoardDTO>(`/crawls/${id}/rides/request`),
  seatRider: (id: string, offerId: string, userId: string) => post<RideBoardDTO>(`/crawls/${id}/rides/offers/${offerId}/riders`, { userId }),
  unseatRider: (id: string, offerId: string, userId: string) => del<RideBoardDTO>(`/crawls/${id}/rides/offers/${offerId}/riders/${userId}`),
  photoPicks: (id: string) => get<PhotoDTO[]>(`/crawls/${id}/photos/picks`),
  featurePhoto: (id: string, photoId: string, featured: boolean) => post<PhotoDTO>(`/crawls/${id}/photos/${photoId}/feature`, { featured }),
  catchUp: (id: string, pos?: { lat: number; lng: number }) => post<{ stopId: string; stopName: string; walkMin: number | null }>(`/crawls/${id}/catch-up`, pos ?? {}),
  cancelCatchUp: (id: string) => del<{ ok: true }>(`/crawls/${id}/catch-up`),
  recap: (id: string) => get<RecapDTO>(`/crawls/${id}/recap`),
  recapCardUrl: (id: string) => `${BASE}/v1/crawls/${id}/recap/card.png`,
};

/** Authenticated binary download (album zip). */
export async function downloadWithAuth(url: string, filename: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${tokenStore.get()}` } });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? 'Download failed');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
