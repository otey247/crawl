import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startLiveTicker } from './services/live.js';
import { acquireLock, closeQueues, startWorkers } from './services/queue.js';
import { attachSocket } from './socket.js';

async function main() {
  await migrate((m) => console.log(`[db] ${m}`));
  const app = await buildApp();
  const io = attachSocket(app);
  const workers = config.inlineWorkers ? startWorkers() : [];
  startLiveTicker(acquireLock);
  await app.listen({ port: config.port, host: config.host });
  console.log(`[api] listening on ${config.apiUrl} (llm: ${config.anthropic.enabled ? config.anthropic.model : 'off — template explanations'}, routing: ${config.routing.valhallaUrl ? 'valhalla' : 'osrm'})`);

  const shutdown = async () => {
    io.close();
    await app.close();
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
