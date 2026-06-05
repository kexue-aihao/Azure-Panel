import net from 'node:net';
import tls from 'node:tls';
import { decryptSecret } from './crypto';
import type { ProxyProfile } from './db/schema';

export const CLIENT_IP_PROXY_HOST = '__client_ip__';
export const PROXY_TYPES = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'shadowsocks'] as const;
export type ProxyType = (typeof PROXY_TYPES)[number];
export type ProxySource = 'fixed' | 'client_ip';

export type ProxyRuntimeConfig = {
	type: ProxyType;
	host: string;
	port: number;
	username?: string;
	password?: string;
	method?: string;
};

export type PublicProxyProfile = {
	id: number;
	name: string;
	type: ProxyType;
	source: ProxySource;
	host: string;
	port: number;
	auth_enabled: boolean;
	label: string;
	method: string;
	created_at: Date;
};

const DEFAULT_PORTS: Record<ProxyType, number> = {
	http: 80,
	https: 443,
	socks4: 1080,
	socks4a: 1080,
	socks5: 1080,
	shadowsocks: 8388
};

const SHADOWSOCKS_METHODS = [
	'aes-128-gcm',
	'aes-192-gcm',
	'aes-256-gcm',
	'chacha20-ietf-poly1305'
] as const;

export function normalizeProxyType(type: string): ProxyType {
	const normalized = type.trim().toLowerCase();
	if (PROXY_TYPES.includes(normalized as ProxyType)) return normalized as ProxyType;
	throw new Error('代理类型仅支持 HTTP、HTTPS、SOCKS4、SOCKS4A、SOCKS5、Shadowsocks');
}

function normalizeHost(host: string) {
	const normalized = host.trim().replace(/^\[(.*)\]$/, '$1');
	if (!normalized) throw new Error('请填写代理主机');
	if (normalized === CLIENT_IP_PROXY_HOST) return normalized;
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

function normalizeMethod(type: ProxyType, method?: string) {
	const normalized = method?.trim().toLowerCase() ?? '';
	if (type !== 'shadowsocks') return undefined;
	if (!normalized) throw new Error('请选择 Shadowsocks 加密方法');
	if (!SHADOWSOCKS_METHODS.includes(normalized as (typeof SHADOWSOCKS_METHODS)[number])) {
		throw new Error('Shadowsocks 加密方法暂不支持');
	}
	return normalized;
}

export function normalizeProxyRuntime(config: {
	type: string;
	host: string;
	port?: unknown;
	username?: string;
	password?: string;
	method?: string;
}): ProxyRuntimeConfig {
	const type = normalizeProxyType(config.type);
	const method = normalizeMethod(type, config.method ?? config.username);
	const password = config.password || undefined;
	if (type === 'shadowsocks' && !password) throw new Error('请填写 Shadowsocks 密码');

	return {
		type,
		host: normalizeHost(config.host),
		port: normalizePort(config.port, type),
		username: type === 'shadowsocks' ? undefined : config.username?.trim() || undefined,
		password,
		method
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
	if (proxy.type === 'shadowsocks') {
		const method = encodeURIComponent(proxy.method ?? '');
		const password = encodeURIComponent(proxy.password ?? '');
		const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
		return `ss://${method}:${password}@${host}:${proxy.port}`;
	}
	const username = proxy.username ? encodeURIComponent(proxy.username) : '';
	const password = proxy.password ? encodeURIComponent(proxy.password) : '';
	const auth = username || password ? `${username}${password ? `:${password}` : ''}@` : '';
	const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
	return `${proxy.type}://${auth}${host}:${proxy.port}`;
}

export function maskProxy(proxy: ProxyRuntimeConfig): string {
	const auth = proxy.username || proxy.password ? '***@' : '';
	const rawHost = proxy.host === CLIENT_IP_PROXY_HOST ? '当前访问网站 IP' : proxy.host;
	const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost;
	if (proxy.type === 'shadowsocks') return `ss://${proxy.method ?? 'method'}:***@${host}:${proxy.port}`;
	return `${proxy.type}://${auth}${host}:${proxy.port}`;
}

export function proxySource(profile: Pick<ProxyProfile, 'host'>): ProxySource {
	return profile.host === CLIENT_IP_PROXY_HOST ? 'client_ip' : 'fixed';
}

function storedProxyProfileToRuntime(profile: ProxyProfile): ProxyRuntimeConfig {
	const type = normalizeProxyType(profile.type);
	const username = profile.usernameEncrypted ? decryptSecret(profile.usernameEncrypted) : '';
	return normalizeProxyRuntime({
		type: profile.type,
		host: profile.host,
		port: profile.port,
		username,
		method: type === 'shadowsocks' ? username : '',
		password: profile.passwordEncrypted ? decryptSecret(profile.passwordEncrypted) : ''
	});
}

export function resolveClientIpProxyHost(host: string, clientIp?: string) {
	if (host !== CLIENT_IP_PROXY_HOST) return host;
	const normalized = clientIp?.trim().replace(/^\[(.*)\]$/, '$1') ?? '';
	if (!normalized) {
		throw new Error('当前访问 IP 代理只能在前台请求中使用，后台自动补机无法获取访问者 IP');
	}
	return normalizeHost(normalized);
}

export function proxyProfileToRuntime(
	profile: ProxyProfile,
	options: { clientIp?: string } = {}
): ProxyRuntimeConfig {
	const runtime = storedProxyProfileToRuntime(profile);
	return {
		...runtime,
		host: resolveClientIpProxyHost(runtime.host, options.clientIp)
	};
}

function connectWithTimeout(options: { host: string; port: number; tls: boolean; timeoutMs: number }) {
	return new Promise<void>((resolve, reject) => {
		const socket = options.tls
			? tls.connect({ host: options.host, port: options.port, servername: options.host })
			: net.connect({ host: options.host, port: options.port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error('代理连接超时'));
		}, options.timeoutMs);

		socket.once('connect', () => {
			clearTimeout(timer);
			socket.end();
			resolve();
		});
		socket.once('secureConnect', () => {
			clearTimeout(timer);
			socket.end();
			resolve();
		});
		socket.once('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

export async function validateProxyConnection(
	proxy: ProxyRuntimeConfig,
	options: { clientIp?: string; timeoutMs?: number } = {}
) {
	const resolved: ProxyRuntimeConfig = {
		...proxy,
		host: resolveClientIpProxyHost(proxy.host, options.clientIp)
	};
	await connectWithTimeout({
		host: resolved.host,
		port: resolved.port,
		tls: resolved.type === 'https',
		timeoutMs: options.timeoutMs ?? 5000
	});
}

export function publicProxyProfile(profile: ProxyProfile): PublicProxyProfile {
	const runtime = storedProxyProfileToRuntime(profile);
	const source = proxySource(profile);
	const host = source === 'client_ip' ? '当前访问网站 IP' : runtime.host;
	return {
		id: profile.id,
		name: profile.name,
		type: runtime.type,
		source,
		host,
		port: runtime.port,
		auth_enabled: Boolean(profile.usernameEncrypted || profile.passwordEncrypted),
		label: maskProxy(runtime),
		method: runtime.method ?? '',
		created_at: profile.createdAt
	};
}
