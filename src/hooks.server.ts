import type { Handle } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { initDatabase } from '$lib/server/db';
import { isEmbeddedWorkerEnabled } from '$lib/server/env';
import { getDotEnvError, getDotEnvPath, loadDotEnv } from '$lib/server/runtime-env';
import { startWorker } from '$lib/server/worker';

loadDotEnv();
if (getDotEnvError()) {
	console.error('[env] failed to load .env', getDotEnvError());
} else {
	console.log('[env] loaded .env:', getDotEnvPath() ?? '(not found)');
}

let initialized = false;
let startupErrorReported = false;

export const handle: Handle = async ({ event, resolve }) => {
	if (!initialized) {
		const envError = getDotEnvError();
		if (envError) {
			if (!startupErrorReported) {
				console.error('[startup] .env load failed', envError);
				startupErrorReported = true;
			}
			if (event.url.pathname.startsWith('/api/')) {
				return json(
					{ message: `服务初始化失败: 无法读取 .env (${envError.message})` },
					{ status: 500 }
				);
			}
			throw envError;
		}

		try {
			await initDatabase();
			// aaPanel 生产环境建议用 Supervisor 独立进程跑补机，设置 ENABLE_EMBEDDED_WORKER=false
			if (isEmbeddedWorkerEnabled()) {
				startWorker();
			}
			initialized = true;
		} catch (err) {
			console.error('[startup] database initialization failed', err);
			if (event.url.pathname.startsWith('/api/')) {
				return json(
					{
						message:
							err instanceof Error ? `服务初始化失败: ${err.message}` : '服务初始化失败'
					},
					{ status: 500 }
				);
			}
			throw err;
		}
	}
	return resolve(event);
};
