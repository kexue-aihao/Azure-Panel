import { readEnv } from './runtime-env';

export function getSecretKey(): string {
	return readEnv('SECRET_KEY') ?? 'dev-secret-change-in-production';
}

export function getEncryptionKey(): string {
	return readEnv('ENCRYPTION_KEY') ?? 'dev-encryption-key-change-me!!';
}

export function getWorkerIntervalMs(): number {
	const seconds = Number(readEnv('WORKER_INTERVAL_SECONDS') ?? '60');
	return Number.isFinite(seconds) ? seconds * 1000 : 60_000;
}

export function getPort(): number {
	return Number(readEnv('PORT') ?? '3000');
}

export function getHost(): string {
	return readEnv('HOST') ?? '127.0.0.1';
}

export function isEmbeddedWorkerEnabled(): boolean {
	return readEnv('ENABLE_EMBEDDED_WORKER') !== 'false';
}
