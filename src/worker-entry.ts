/**
 * aaPanel Supervisor 独立补机进程入口
 * 构建: npm run build:worker
 * 运行: node build/worker.js
 */
import { initDatabase } from './lib/server/db';
import { loadDotEnv } from './lib/server/runtime-env';
import { startWorker } from './lib/server/worker';

loadDotEnv();
process.env.ENABLE_EMBEDDED_WORKER = 'false';

await initDatabase({ ensureSchema: false });
startWorker();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
