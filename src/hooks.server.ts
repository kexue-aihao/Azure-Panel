import type { Handle } from '@sveltejs/kit';
import { initDatabase } from '$lib/server/db';
import { isEmbeddedWorkerEnabled } from '$lib/server/env';
import { loadDotEnv } from '$lib/server/runtime-env';
import { startWorker } from '$lib/server/worker';

loadDotEnv();

let initialized = false;

export const handle: Handle = async ({ event, resolve }) => {
	if (!initialized) {
		await initDatabase();
		// aaPanel 生产环境建议用 Supervisor 独立进程跑补机，设置 ENABLE_EMBEDDED_WORKER=false
		if (isEmbeddedWorkerEnabled()) {
			startWorker();
		}
		initialized = true;
	}
	return resolve(event);
};
