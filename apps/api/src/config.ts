const env = process.env;

export const config = {
  env: env.NODE_ENV ?? 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT ?? 4000),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://crawl:crawl@localhost:5432/crawl',
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: env.JWT_SECRET ?? 'dev-only-secret-change-me',
  /** Public origin of the web client, used for invite and magic links. */
  appUrl: env.APP_URL ?? 'http://localhost:5173',
  /** Public origin of this API, used for signed media URLs. */
  apiUrl: env.API_URL ?? `http://localhost:${env.PORT ?? 4000}`,
  corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  /** Dev-only: allows signing in as seeded users without a magic link. */
  devLogin: env.DEV_LOGIN ? env.DEV_LOGIN === 'true' : env.NODE_ENV !== 'production',
  /** Run the BullMQ workers inside the API process. Set false when running `worker` separately. */
  inlineWorkers: env.INLINE_WORKERS !== 'false',
  routing: {
    valhallaUrl: env.VALHALLA_URL || null,
    osrmUrl: env.OSRM_URL ?? 'https://routing.openstreetmap.de/routed-foot',
    timeoutMs: Number(env.ROUTING_TIMEOUT_MS ?? 6000),
  },
  overpassUrl: env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter',
  anthropic: {
    model: env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
    enabled: !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) && env.LLM_DISABLED !== 'true',
  },
  storage: {
    driver: (env.STORAGE_DRIVER ?? 'local') as 'local',
    localDir: env.STORAGE_DIR ?? new URL('../storage', import.meta.url).pathname,
    signedUrlTtlS: 3600,
    uploadUrlTtlS: 600,
    maxUploadBytes: 10 * 1024 * 1024,
  },
  live: {
    arrivalRadiusM: 40,
    arrivalDwellS: 120,
    positionThrottleS: 30,
    tickS: Number(env.LIVE_TICK_S ?? 30),
  },
};
