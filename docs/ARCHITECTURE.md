# Architecture notes

This build implements the *Pub Crawl App — Technical Spec*. This page records the decisions behind it and where it differs from the spec.

## Shape

```
Web PWA (React/MapLibre) ──HTTPS /v1──▶ Fastify API ──▶ Postgres
          │                                 │  ├─▶ Redis (BullMQ queues, Socket.IO adapter, rate limits, tick locks)
          └──── Socket.IO crawl:{id} ◀──────┤  ├─▶ Valhalla / OSRM (walking matrix + legs)
                                            │  ├─▶ Claude API (preferences → weights, explanations)
          presigned PUT/GET ──▶ object storage (local driver; S3/Blob interface)
                                Workers: route-optimize, photo-process (in-process or `worker` container)
```

The server is the source of truth for live state. Clients send intents (`position.update`, `chat.send`, HTTP actions), and the server broadcasts `live.state` snapshots plus the discrete events listed in the spec (`stop.arrived`, `special.highlight`, …). Organizers and co-hosts sit in a separate `crawl:{id}:hosts` room, so only they receive the one-tap fixes.

## Route optimization

`packages/core/src/solver.ts` minimizes the spec's objective:

```
C = Σ t_ij (1 + α s_ij + β b_ij) + λ·missed specials + μ·minutes waiting for a venue to open
```

- **Matrix:** Valhalla `/sources_to_targets` with pedestrian costing tuned by α and β, or OSRM `/table`. Results are cached by point set and costing hash.
- **s / b:** these are the share of a leg near arterial roads (plus nightlife streets after 9 PM local) and the share away from parks, gardens or pedestrian zones. Both are sampled along the leg against OSM geometry stored in `apps/api/data/<hood>.geo.json`.
- **Solve:** for ≤ 12 stops, Held–Karp over (visited set, last stop). Each state keeps a small Pareto set of (cost, clock) labels so time-dependent penalties stay correct. Above 12 stops, a multi-start nearest-neighbour search with or-opt and 2-opt runs under a 3 s budget. Both paths respect locked positions.
- **Catching a special** means it overlaps the stay by at least 20 minutes (or the whole stay, if shorter). Venue hours come from the OSM `opening_hours` string, evaluated in the crawl's timezone.
- **Approval:** the organizer sees totals and each metric's change against their own order, plus arrival times and caught or missed specials per stop. They can approve, re-optimize, or evaluate their own order ("Use my order"). Approving rewrites stop positions and planned times.

## Live specials engine

`packages/core/src/live.ts` and `apps/api/src/services/live.ts` follow the spec's state table. ETA projection, the five states, hysteresis (two consecutive evaluations before alerting), de-duplication by (crawl, special, kind) and the 30 s position throttle are all implemented as specified. The engine adds two display states: `caught` and `unavailable`. Arrival and departure use the 40 m / 2 min geofence on the leader's position; "We're here" overrides it. Drift is measured against the approved plan, shifted when a crawl goes live early.

## Deviations from the spec

| Spec | This build | Why / path forward |
| --- | --- | --- |
| React Native + Expo client with MapLibre Native | A mobile-first **web PWA** (React + MapLibre GL JS) | Testable in a browser and shippable today. All domain logic and wire types live in `@crawl/core`, so an Expo app can reuse them as-is; the screens map one-to-one. |
| OR-Tools Python worker above 10 stops | Held–Karp up to 12, then TypeScript local search | Keeps one runtime. The worker boundary (`runRouteJob`) is where an OR-Tools or VROOM call would go. |
| PostGIS geography columns | Plain lat/lng doubles. `002_postgis.sql` adds a geography column and GiST index when PostGIS is installed. | Runs on stock Postgres as well as the `postgis/postgis` image. |
| Sign in with Apple / Google | Magic links, plus dev sign-in as seeded users. The `apple` / `google` providers are stubbed in `POST /auth/session`. | Needs app credentials: verify the ID token against the provider's JWKS, then upsert by email. |
| FCM / APNs push | Web Push (VAPID) from the service worker, plus in-app delivery over Socket.IO and the Expo push API for native tokens. Expired subscriptions (404/410) are pruned. | iOS supports Web Push only for PWAs added to the Home Screen; a native app closes that gap. |
| Automated photo moderation | Format and size validation in `moderate()`, plus 3-report auto-hide and host hide | Wire Azure AI Content Safety or Rekognition into `moderate()`. |
| S3 / Azure Blob | A local driver that implements presigned PUT and GET semantics, with 10-minute upload URLs and 1-hour signed reads | Implement `ObjectStorage` for S3 or Blob, and point `presignPut` at the real service. |
| Photo retention (12 months) | Not scheduled yet | Add a daily job that deletes albums 12 months after `ended_at`, with a warning notification 30 days before. |

## Open questions from the spec, as decided here

- **Launch city:** St. Louis, starting with Soulard. The other neighborhoods are configured and get venues from `npm run venues:import -- <id>`.
- **Age:** 21+, US.
- **Specials data:** crowd-reported (confidence starts at 0.5, rises with confirmations, decays after 30 days), organizer-entered (0.9, scoped to one crawl), and venue-claimed (1.0). Specials below 0.4 confidence are hidden.
- **Who edits stops:** organizers and co-hosts only.

## Tier-1 additions

- **Offline (`apps/web/public/sw.js`).** Hashed bundles are precached at install. Crawl API reads are network-first with a cache fallback, and are cleared on sign-out. Map tiles (z10–14, plus label glyphs) for a crawl's area are precached when a member opens a crawl that is live or starts within a day. Chat messages and check-ins made offline go into a localStorage outbox (`lib/outbox.ts`) and replay in order on reconnect. Offline mode applies to the production build only; the Vite dev server serves unbundled modules the worker doesn't cache.
- **Reminders (`services/reminders.ts`).** These run every minute under a Redis lock and are de-duplicated by `reminders_sent (crawl, user, kind)`.
- **Link previews (`routes/og.ts`).** nginx (and the Vite dev middleware) send known crawler user agents on `/i/:token` and `/crawls/:id` to server-rendered Open Graph pages, with a 1200×630 card rendered by sharp. Private crawls are previewed only through an invite token, and only with what the invite landing page already shows.
- **Navigator role.** The assigned Navigator becomes the live leader, so their phone drives the group's position, ETAs and arrival detection. Every member gets walking directions to the next stop.

## Tier-2 additions

- **Ride board (`routes/rides.ts`, `ride_offers` and `ride_requests`).** Only members with the Designated Driver badge can offer seats, so the board never pairs riders with someone who's been drinking. A crawl can have several Designated Drivers; the Navigator and Photographer badges stay one per crawl. Seating runs inside a transaction that locks the offer row, so two riders can't take the last seat. Destinations are free-text areas shown to every member, and the UI asks people not to enter an address. The board closes 12 hours after the crawl ends.
- **Photographer's picks.** `photos.featured_at` can be set by the Photographer or a host. `GET /photos/picks` returns featured photos first, then the rest of the Photographer's shots. The recap orders photos the same way.
- **Catch up (`memberships.catching_up_*`).** "On my way" targets the group's current stop, or the next stop while the group is walking. When the group departs, anyone catching up is moved to the next stop and gets a push. Arrival is confirmed on check-in, or when an opted-in shared position comes within 60 m of the target.
- **Recap (`routes/recap.ts`).** Built once the crawl ends. Distance comes from the approved route legs between stops actually visited, with a straight-line estimate otherwise. "Specials caught" re-runs the live classifier over each stay. `GET /recap/card.png` is members-only to fetch, but the card itself contains no member photos or names, so it's safe to post.
