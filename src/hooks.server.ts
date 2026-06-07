import type { Handle } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { initDatabase } from '$lib/server/db';
import { isEmbeddedWorkerEnabled } from '$lib/server/env';
import { getDotEnvError, getDotEnvPath, loadDotEnv, readEnv } from '$lib/server/runtime-env';
import {
	getStartupStatus,
	markStartupFailed,
	markStartupInitializing,
	markStartupReady,
	markStartupStep
} from '$lib/server/startup-state';
import { startWorker } from '$lib/server/worker';

loadDotEnv();
if (getDotEnvError()) {
	console.error('[env] failed to load .env', getDotEnvError());
} else {
	console.log('[env] loaded .env:', getDotEnvPath() ?? '(not found)');
}

let initialized = false;
let initializationPromise: Promise<void> | null = null;
let startupErrorReported = false;

function reportStartupError(message: string, err: unknown) {
	if (startupErrorReported) return;
	console.error(message, err);
	startupErrorReported = true;
}

function readTimeoutMs(key: string, fallback: number) {
	const value = Number(readEnv(key));
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} 超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成`)), timeoutMs);
		})
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function startInitialization() {
	if (initialized) return Promise.resolve();
	if (initializationPromise) return initializationPromise;

	markStartupInitializing('startup:begin');
	initializationPromise = (async () => {
		const envError = getDotEnvError();
		if (envError) throw envError;

		markStartupStep('database:init');
		await withTimeout(initDatabase(), readTimeoutMs('STARTUP_INIT_TIMEOUT_MS', 60_000), '服务初始化');
		// aaPanel 生产环境建议用 Supervisor 独立进程跑补机，设置 ENABLE_EMBEDDED_WORKER=false
		if (isEmbeddedWorkerEnabled()) {
			markStartupStep('worker:start');
			startWorker();
		}
		initialized = true;
		markStartupReady();
	})().catch((err) => {
		initializationPromise = null;
		markStartupFailed(err);
		reportStartupError('[startup] service initialization failed', err);
		throw err;
	});
	void initializationPromise.catch(() => undefined);
	return initializationPromise;
}

function waitForStartup(promise: Promise<void>, timeoutMs = 15_000) {
	return withTimeout(promise, timeoutMs, '服务初始化');
}

export const handle: Handle = async ({ event, resolve }) => {
	const initialization = startInitialization();
	if (event.url.pathname === '/api/health') {
		return resolve(event);
	}

	if (!initialized) {
		try {
			await waitForStartup(initialization);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return json(
				{
					message: `服务初始化失败: ${message}`,
					startup: getStartupStatus()
				},
				{ status: 503 }
			);
		}
	}
	return resolve(event);
};
