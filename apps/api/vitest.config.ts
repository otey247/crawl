import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://crawl:crawl@localhost:5432/crawl_test',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/1',
      OSRM_URL: 'http://127.0.0.1:9', // force the offline estimate so tests are hermetic
      LLM_DISABLED: 'true',
      WEATHER_DISABLED: 'true',
      JWT_SECRET: 'test-secret',
      NODE_ENV: 'test',
    },
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
