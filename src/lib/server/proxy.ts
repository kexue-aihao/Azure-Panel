import { decryptSecret } from './crypto';
import type { ProxyProfile } from './db/schema';

export const PROXY_TYPES = ['http', 'https', 'socks4', 'socks5'] as const;
export type ProxyType = (typeof PROXY_TYPES)[number];

export type ProxyRuntimeConfig = {
	type: ProxyType;
	host: string;
	port: number;
	username?: string;
	password?: string;
};

export type PublicProxyProfile = {
	id: number;
	name: string;
	type: ProxyType;
	host: string;
	port: number;
	auth_enabled: boolean;
	label: string;
	created_at: Date;
};

const DEFAULT_PORTS: Record<ProxyType, number> = {
	http: 80,
	https: 443,
	socks4: 1080,
	socks5: 1080
};

export function normalizeProxyType(type: string): ProxyType {
	const normalized = type.trim().toLowerCase();
	if (PROXY_TYPES.includes(normalized as ProxyType)) return normalized as ProxyType;
	throw new Error('代理类型仅支持 HTTP、HTTPS、SOCKS4、SOCKS5');
}

function normalizeHost(host: string) {
	const normalized = host.trim().replace(/^\[(.*)\]$/, '$1');
	if (!normalized) throw new Error('请填写代理主机');
	if (/[\s/]/.test(normalized)) throw new Error('代理主机格式无效');
	return normalized;
}

function normalizePort(port: unknown, type: ProxyType) {
	const value = port === undefined || port === null || port === '' ? DEFAULT_PORTS[type] : Number(port);
	if (!Number.isInteger(value) || value <= 0 || value > 65535) {
		throw new Error('代理端口必须是 1-65535 之间的整数');
	}
	return value;
}

export function normalizeProxyRuntime(config: {
	type: string;
	host: string;
	port?: unknown;
	username?: string;
	password?: string;
}): ProxyRuntimeConfig {
	const type = normalizeProxyType(config.type);
	return {
		type,
		host: normalizeHost(config.host),
		port: normalizePort(config.port, type),
		username: config.username?.trim() || undefined,
		password: config.password || undefined
	};
}

export function parseProxyUrl(proxyUrl: string): ProxyRuntimeConfig | null {
	const normalized = proxyUrl.trim();
	if (!normalized) return null;

	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error('代理地址格式无效，请使用 http://host:port 或 socks5://host:port');
	}

	const type = normalizeProxyType(parsed.protocol.replace(':', ''));
	if (!parsed.hostname) throw new Error('代理地址缺少主机名');

	return normalizeProxyRuntime({
		type,
		host: parsed.hostname,
		port: parsed.port,
		username: parsed.username ? decodeURIComponent(parsed.username) : '',
		password: parsed.password ? decodeURIComponent(parsed.password) : ''
	});
}

export function buildProxyUrl(proxy: ProxyRuntimeConfig): string {
	const username = proxy.username ? encodeURIComponent(proxy.username) : '';
	const password = proxy.password ? encodeURIComponent(proxy.password) : '';
	const auth = username || password ? `${username}${password ? `:${password}` : ''}@` : '';
	const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
	return `${proxy.type}://${auth}${host}:${proxy.port}`;
}

export function maskProxy(proxy: ProxyRuntimeConfig): string {
	const auth = proxy.username || proxy.password ? '***@' : '';
	const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
	return `${proxy.type}://${auth}${host}:${proxy.port}`;
}

export function proxyProfileToRuntime(profile: ProxyProfile): ProxyRuntimeConfig {
	return normalizeProxyRuntime({
		type: profile.type,
		host: profile.host,
		port: profile.port,
		username: profile.usernameEncrypted ? decryptSecret(profile.usernameEncrypted) : '',
		password: profile.passwordEncrypted ? decryptSecret(profile.passwordEncrypted) : ''
	});
}

export function publicProxyProfile(profile: ProxyProfile): PublicProxyProfile {
	const runtime = proxyProfileToRuntime(profile);
	return {
		id: profile.id,
		name: profile.name,
		type: runtime.type,
		host: runtime.host,
		port: runtime.port,
		auth_enabled: Boolean(profile.usernameEncrypted || profile.passwordEncrypted),
		label: maskProxy(runtime),
		created_at: profile.createdAt
	};
}
