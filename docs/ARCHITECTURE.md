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
| FCM / APNs push | Notifications are stored, delivered in-app over Socket.IO, and sent through the Expo push API when a device registers a token (`PUT /me/push-tokens`). | Web push would need VAPID keys and a service worker. |
| Automated photo moderation | Format and size validation in `moderate()`, plus 3-report auto-hide and host hide | Wire Azure AI Content Safety or Rekognition into `moderate()`. |
| S3 / Azure Blob | A local driver that implements presigned PUT and GET semantics, with 10-minute upload URLs and 1-hour signed reads | Implement `ObjectStorage` for S3 or Blob, and point `presignPut` at the real service. |
| Photo retention (12 months) | Not scheduled yet | Add a daily job that deletes albums 12 months after `ended_at`, with a warning notification 30 days before. |

## Open questions from the spec, as decided here

- **Launch city:** St. Louis, starting with Soulard. The other neighborhoods are configured and get venues from `npm run venues:import -- <id>`.
- **Age:** 21+, US.
- **Specials data:** crowd-reported (confidence starts at 0.5, rises with confirmations, decays after 30 days), organizer-entered (0.9, scoped to one crawl), and venue-claimed (1.0). Specials below 0.4 confidence are hidden.
- **Who edits stops:** organizers and co-hosts only.
