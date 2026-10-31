// Standalone worker process (INLINE_WORKERS=false on the API).
import { closeQueues, startWorkers } from './services/queue.js';

const workers = startWorkers();
console.log('[worker] route-optimize + photo-process workers running');
const shutdown = async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
