import net from 'node:net';
import tls from 'node:tls';
import { decryptSecret } from './crypto';
import type { ProxyProfile } from './db/schema';

export const CLIENT_IP_PROXY_HOST = '__client_ip__';
export const PROXY_TYPES = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'shadowsocks'] as const;
export const AUTO_CLIENT_IP_PROXY_NAME = '当前访问网站 IP（自动识别）';
export const AUTO_CLIENT_IP_PROXY_CANDIDATES = [
	{ type: 'http', port: 7890, label: 'HTTP 7890' },
	{ type: 'socks5', port: 7890, label: 'SOCKS5 7890' },
	{ type: 'http', port: 7891, label: 'HTTP 7891' },
	{ type: 'socks5', port: 7891, label: 'SOCKS5 7891' },
	{ type: 'http', port: 7892, label: 'HTTP 7892' },
	{ type: 'socks5', port: 7892, label: 'SOCKS5 7892' },
	{ type: 'http', port: 7893, label: 'HTTP 7893' },
	{ type: 'socks5', port: 7893, label: 'SOCKS5 7893' },
	{ type: 'http', port: 7897, label: 'HTTP 7897' },
	{ type: 'socks5', port: 7897, label: 'SOCKS5 7897' },
	{ type: 'http', port: 7899, label: 'HTTP 7899' },
	{ type: 'socks5', port: 7899, label: 'SOCKS5 7899' },
	{ type: 'socks5', port: 10808, label: 'SOCKS5 10808' },
	{ type: 'http', port: 10809, label: 'HTTP 10809' },
	{ type: 'socks5', port: 10810, label: 'SOCKS5 10810' },
	{ type: 'socks5', port: 1080, label: 'SOCKS5 1080' },
	{ type: 'socks5', port: 1081, label: 'SOCKS5 1081' },
	{ type: 'socks5', port: 1086, label: 'SOCKS5 1086' },
	{ type: 'socks5', port: 1087, label: 'SOCKS5 1087' },
	{ type: 'http', port: 2080, label: 'HTTP 2080' },
	{ type: 'socks5', port: 2081, label: 'SOCKS5 2081' },
	{ type: 'http', port: 3128, label: 'HTTP 3128' },
	{ type: 'http', port: 8080, label: 'HTTP 8080' },
	{ type: 'http', port: 8081, label: 'HTTP 8081' },
	{ type: 'http', port: 8118, label: 'HTTP 8118' },
	{ type: 'http', port: 8888, label: 'HTTP 8888' },
	{ type: 'http', port: 8889, label: 'HTTP 8889' },
	{ type: 'socks5', port: 20170, label: 'SOCKS5 20170' },
	{ type: 'http', port: 20171, label: 'HTTP 20171' }
] as const satisfies { type: ProxyType; port: number; label: string }[];
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

export type ParsedProxyShareLink = {
	supported: boolean;
	protocol: string;
	name: string;
	message: string;
	proxy: ProxyRuntimeConfig | null;
	details: {
		host?: string;
		port?: number;
		security?: string;
		transport?: string;
		sni?: string;
		remark?: string;
	};
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

function decodeBase64Url(value: string) {
	const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
	return Buffer.from(padded, 'base64').toString('utf8');
}

function safeDecode(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function parseShadowsocksShareLink(link: string, parsed: URL): ParsedProxyShareLink {
	const remark = parsed.hash ? safeDecode(parsed.hash.slice(1)) : '';
	const query = parsed.search;
	const withoutProtocol = link.trim().slice('ss://'.length).split('#')[0].split('?')[0];
	let body = withoutProtocol;

	if (!body.includes('@')) {
		body = decodeBase64Url(body);
	}

	const [authPart, endpointPart] = body.split('@');
	if (!authPart || !endpointPart) throw new Error('Shadowsocks 分享链接缺少认证或主机信息');

	let auth = safeDecode(authPart);
	if (!auth.includes(':')) {
		auth = decodeBase64Url(auth);
	}
	const authSplit = auth.split(':');
	const method = authSplit.shift() ?? '';
	const password = authSplit.join(':');
	const endpoint = new URL(`ss://${endpointPart}${query}`);
	const proxy = normalizeProxyRuntime({
		type: 'shadowsocks',
		host: endpoint.hostname,
		port: endpoint.port,
		method,
		password
	});

	return {
		supported: true,
		protocol: 'ss',
		name: remark || endpoint.hostname || 'Shadowsocks',
		message: '已识别 Shadowsocks 分享链接，可直接验证并保存。',
		proxy,
		details: {
			host: proxy.host,
			port: proxy.port,
			remark
		}
	};
}

function unsupportedShareLink(parsed: URL): ParsedProxyShareLink {
	const protocol = parsed.protocol.replace(':', '').toLowerCase();
	const remark = parsed.hash ? safeDecode(parsed.hash.slice(1)) : '';
	const params = parsed.searchParams;
	const message =
		protocol === 'vless'
			? '已识别 VLESS 分享链接，但 VLESS/Reality 不是 HTTP/SOCKS 代理端口，不能被 Azure SDK 直接使用。请先用 Xray、sing-box、Clash 或 v2rayN 导入该链接，并在当前机器暴露 HTTP/SOCKS 本地端口后再填写该端口。'
			: `已识别 ${protocol.toUpperCase()} 分享链接，但当前面板只能直接使用 HTTP、HTTPS、SOCKS4、SOCKS5 和 Shadowsocks。请先转换成本地 HTTP/SOCKS 代理端口。`;
	return {
		supported: false,
		protocol,
		name: remark || `${protocol.toUpperCase()} ${parsed.hostname}`,
		message,
		proxy: null,
		details: {
			host: parsed.hostname,
			port: parsed.port ? Number(parsed.port) : undefined,
			security: params.get('security') ?? undefined,
			transport: params.get('type') ?? undefined,
			sni: params.get('sni') ?? undefined,
			remark
		}
	};
}

export function parseProxyShareLink(shareLink: string): ParsedProxyShareLink {
	const normalized = shareLink.trim();
	if (!normalized) throw new Error('请粘贴代理分享链接');

	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error('代理分享链接格式无效');
	}

	const protocol = parsed.protocol.replace(':', '').toLowerCase();
	if (['http', 'https', 'socks4', 'socks4a', 'socks5'].includes(protocol)) {
		const proxy = parseProxyUrl(normalized);
		if (!proxy) throw new Error('代理分享链接为空');
		const remark = parsed.hash ? safeDecode(parsed.hash.slice(1)) : '';
		return {
			supported: true,
			protocol,
			name: remark || parsed.hostname || `${protocol.toUpperCase()} Proxy`,
			message: '已识别可直接使用的代理链接。',
			proxy,
			details: {
				host: proxy.host,
				port: proxy.port,
				remark
			}
		};
	}
	if (protocol === 'ss') return parseShadowsocksShareLink(normalized, parsed);
	return unsupportedShareLink(parsed);
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
