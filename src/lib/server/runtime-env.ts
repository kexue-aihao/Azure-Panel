import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let dotenvLoaded = false;
let dotenvPath: string | null = null;
let dotenvError: Error | null = null;

function unique(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function envCandidatesFrom(startDir: string): string[] {
	const candidates: string[] = [];
	let dir = resolve(startDir);

	for (let i = 0; i < 8; i += 1) {
		candidates.push(join(dir, '.env'));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return candidates;
}

function findDotEnv(): string | null {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const explicitDirs = [process.env.AZURE_PANEL_APP_DIR, process.env.APP_DIR, process.env.PROJECT_CWD];
	const baseDirs = unique([...explicitDirs, process.cwd(), moduleDir]);
	const candidates = unique(baseDirs.flatMap((dir) => envCandidatesFrom(dir)));
	return candidates.find((path) => existsSync(path)) ?? null;
}

function parseEnvLine(line: string): [string, string] | null {
	const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
	if (!match) return null;

	const [, key, rawValue] = match;
	let value = rawValue.trim();
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}

	return [key, value];
}

/** 从项目根目录 .env 加载变量（aaPanel 生产环境 Supervisor 不会自动注入） */
export function loadDotEnv() {
	if (dotenvLoaded) return;
	dotenvLoaded = true;

	const envPath = findDotEnv();
	if (!envPath) return;

	try {
		const content = readFileSync(envPath, 'utf8');
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;

			const parsed = parseEnvLine(line);
			if (!parsed) continue;

			const [key, value] = parsed;
			if (!process.env[key]) process.env[key] = value;
		}
		dotenvPath = envPath;
	} catch (err) {
		dotenvError = err instanceof Error ? err : new Error(String(err));
	}
}

/** 统一读取环境变量，兼容 SvelteKit Web 与 Supervisor 独立 Worker */
export function readEnv(key: string): string | undefined {
	return process.env[key];
}

export function getDotEnvPath(): string | null {
	return dotenvPath;
}

export function getDotEnvError(): Error | null {
	return dotenvError;
}

export function getProjectRoot(): string {
	if (dotenvPath) return dirname(dotenvPath);
	return process.env.AZURE_PANEL_APP_DIR ?? process.env.APP_DIR ?? process.cwd();
}
