import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let dotenvLoaded = false;

/** 从项目根目录 .env 加载变量（aaPanel 生产环境 Supervisor 不会自动注入） */
export function loadDotEnv() {
	if (dotenvLoaded) return;
	dotenvLoaded = true;
	const envPath = resolve(process.cwd(), '.env');
	if (!existsSync(envPath)) return;
	const content = readFileSync(envPath, 'utf8');
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const idx = trimmed.indexOf('=');
		if (idx < 0) continue;
		const key = trimmed.slice(0, idx).trim();
		const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
		if (!process.env[key]) process.env[key] = value;
	}
}

/** 统一读取环境变量，兼容 SvelteKit Web 与 Supervisor 独立 Worker */
export function readEnv(key: string): string | undefined {
	return process.env[key];
}
