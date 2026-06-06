import net from 'node:net';
import tls from 'node:tls';
import {
	createDefaultHttpClient,
	createHttpHeaders,
	createPipelineFromOptions,
	createPipelineRequest,
	type Agent,
	type HttpClient,
	type PipelineOptions,
	type ProxySettings
} from '@azure/core-rest-pipeline';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { decryptSecret } from './crypto';
import { updateProxyProfileType } from './db/repo';
import type { ProxyProfile } from './db/schema';
import { ensureManagedProxyForProfile } from './managed-proxy-core';
import { ShadowsocksProxyAgent } from './shadowsocks-agent';

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

export type ProxyClientOptions = PipelineOptions & {
	httpClient?: HttpClient;
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
	managed_core: string;
	created_at: Date;
};

export type ParsedProxyShareLink = {
	supported: boolean;
	managed_supported: boolean;
	managed_core: 'sing-box' | 'xray' | '';
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
		flow?: string;
		remark?: string;
	};
};

export type ParsedProxyApiResponse = {
	rawType: Extract<ProxyType, 'http' | 'socks5'> | 'auto';
	totalCandidates: number;
	proxies: ParsedProxyShareLink[];
	errors: string[];
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

function normalizeBareProxyType(type?: string): Extract<ProxyType, 'http' | 'socks5'> | 'auto' {
	const rawType = type?.trim().toLowerCase() || 'auto';
	if (rawType === 'auto') return 'auto';
	const normalized = normalizeProxyType(rawType);
	if (normalized !== 'http' && normalized !== 'socks5') {
		throw new Error('host:port:user:pass 格式仅支持选择 http 或 socks5');
	}
	return normalized;
}

function parseBareHostPortAuthProxy(
	value: string,
	rawType?: string
): ParsedProxyShareLink | null {
	if (value.includes('://')) return null;

	const match = value.match(/^([^:\s/]+):(\d{1,5}):([^:]+):(.+)$/);
	if (!match) return null;

	const [, host, port, username, password] = match;
	const type = normalizeBareProxyType(rawType);
	const proxy = normalizeProxyRuntime({
		type: type === 'auto' ? 'socks5' : type,
		host,
		port,
		username: safeDecode(username),
		password: safeDecode(password)
	});

	return {
		supported: true,
		managed_supported: false,
		managed_core: '',
		protocol: type,
		name: `${type.toUpperCase()} ${proxy.host}`,
		message: '已识别 host:port:user:pass 代理格式，可直接验证并保存。',
		proxy,
		details: {
			host: proxy.host,
			port: proxy.port
		}
	};
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
		managed_supported: false,
		managed_core: '',
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
	const managedSupported = protocol === 'vless';
	const message =
		protocol === 'vless'
			? '已识别 VLESS 分享链接，保存时将由内置 sing-box/Xray 核心转换为本机 HTTP 代理端口后供 Azure 使用。'
			: `已识别 ${protocol.toUpperCase()} 分享链接，但当前面板只能直接使用 HTTP、HTTPS、SOCKS4、SOCKS5、Shadowsocks，以及内置核心托管的 VLESS。请先转换成本地 HTTP/SOCKS 代理端口。`;
	return {
		supported: managedSupported,
		managed_supported: managedSupported,
		managed_core: managedSupported ? 'sing-box' : '',
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
			flow: params.get('flow') ?? undefined,
			remark
		}
	};
}

export function parseProxyShareLink(
	shareLink: string,
	options: { rawType?: string } = {}
): ParsedProxyShareLink {
	const normalized = shareLink.trim();
	if (!normalized) throw new Error('请粘贴代理分享链接');

	const bareProxy = parseBareHostPortAuthProxy(normalized, options.rawType);
	if (bareProxy) return bareProxy;

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
			managed_supported: false,
			managed_core: '',
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

function collectProxyApiStrings(value: unknown, output: string[]) {
	if (typeof value === 'string') {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectProxyApiStrings(item, output);
		return;
	}
	if (value && typeof value === 'object') {
		for (const item of Object.values(value)) collectProxyApiStrings(item, output);
	}
}

function splitProxyApiCandidates(value: string) {
	return value
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/\r/g, '\n')
		.split(/[\n,;\t ]+/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function proxyShareLinkKey(item: ParsedProxyShareLink) {
	if (item.proxy) {
		const proxy = item.proxy;
		return [
			proxy.type,
			proxy.host,
			proxy.port,
			proxy.username ?? '',
			proxy.password ?? '',
			proxy.method ?? ''
		].join('|');
	}
	return [item.protocol, item.details.host ?? '', item.details.port ?? '', item.name].join('|');
}

export function inferProxyApiRawType(
	apiUrl: string,
	fallbackRawType?: string
): Extract<ProxyType, 'http' | 'socks5'> | 'auto' {
	const fallback = normalizeBareProxyType(fallbackRawType);
	if (fallback !== 'auto') return fallback;

	try {
		const parsed = new URL(apiUrl);
		const fromQuery =
			parsed.searchParams.get('GenType') ??
			parsed.searchParams.get('type') ??
			parsed.searchParams.get('protocol');
		if (fromQuery) return normalizeBareProxyType(fromQuery);
	} catch {
		// The fetch layer will report URL format errors; parsing here is only for hints.
	}

	return 'auto';
}

export function parseProxyApiResponse(
	responseText: string,
	options: { apiUrl?: string; rawType?: string } = {}
): ParsedProxyApiResponse {
	const rawType = inferProxyApiRawType(options.apiUrl ?? '', options.rawType);
	const sources = [responseText];
	try {
		collectProxyApiStrings(JSON.parse(responseText), sources);
	} catch {
		// Plain text proxy pools are expected, e.g. one host:port:user:pass per line.
	}

	const candidates = [...new Set(sources.flatMap(splitProxyApiCandidates))].slice(0, 300);
	const proxies: ParsedProxyShareLink[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();

	for (const candidate of candidates) {
		try {
			const parsed = parseProxyShareLink(candidate, { rawType });
			if (!parsed.supported) {
				errors.push(`${candidate}: ${parsed.message}`);
				continue;
			}
			const key = proxyShareLinkKey(parsed);
			if (seen.has(key)) continue;
			seen.add(key);
			proxies.push(parsed);
		} catch (err) {
			errors.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return {
		rawType,
		totalCandidates: candidates.length,
		proxies,
		errors: errors.slice(0, 20)
	};
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

function proxySettings(proxy: ProxyRuntimeConfig): ProxySettings {
	return {
		host: `${proxy.type}://${proxy.host}`,
		port: proxy.port,
		username: proxy.username,
		password: proxy.password
	};
}

function socksProxyAgentUrl(proxy: ProxyRuntimeConfig): string {
	const proxyUrl = buildProxyUrl(proxy);
	if (proxy.type === 'socks5') return proxyUrl.replace(/^socks5:\/\//i, 'socks5h://');
	return proxyUrl;
}

function agentHttpClient(agent: Agent): HttpClient {
	const inner = createDefaultHttpClient();
	return {
		async sendRequest(request) {
			const url = new URL(request.url);
			// Azure SDK leaves the default HTTPS port empty; socks-proxy-agent can pass that
			// empty port into the socks handshake and surface "SocksClient internal error".
			const defaultPort = url.port || (url.protocol === 'https:' ? '443' : '80');
			return inner.sendRequest({
				...request,
				agent,
				disableKeepAlive: true,
				requestOverrides: {
					...request.requestOverrides,
					port: defaultPort
				}
			});
		}
	};
}

export function proxyClientOptions(proxy?: ProxyRuntimeConfig | null): ProxyClientOptions {
	if (!proxy) return {};
	if (proxy.type === 'http' || proxy.type === 'https') {
		return { proxyOptions: proxySettings(proxy) };
	}

	const agent =
		proxy.type === 'shadowsocks'
			? (new ShadowsocksProxyAgent(proxy) as Agent)
			: (new SocksProxyAgent(socksProxyAgentUrl(proxy), {
					timeout: 30_000,
					keepAlive: false
				}) as Agent);
	return {
		agent,
		httpClient: agentHttpClient(agent)
	};
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

export async function proxyProfileToRuntimeReady(
	profile: ProxyProfile,
	options: { clientIp?: string } = {}
): Promise<ProxyRuntimeConfig> {
	const managedProxy = await ensureManagedProxyForProfile(profile);
	if (managedProxy) return managedProxy;
	return proxyProfileToRuntime(profile, options);
}

function canAutoDetectHttpSocks(profile: ProxyProfile, proxy: ProxyRuntimeConfig) {
	if (profile.managedCore) return false;
	return proxy.type === 'http' || proxy.type === 'socks5';
}

export async function proxyProfileToAzureReady(
	profile: ProxyProfile,
	options: {
		clientIp?: string;
		timeoutMs?: number;
		autoDetectHttpSocks?: boolean;
		updateProfileType?: boolean;
	} = {}
): Promise<ProxyRuntimeConfig> {
	const proxy = await proxyProfileToRuntimeReady(profile, { clientIp: options.clientIp });
	const timeoutMs = options.timeoutMs ?? 10_000;
	try {
		return await validateProxyConnection(proxy, { clientIp: options.clientIp, timeoutMs });
	} catch (firstErr) {
		if (options.autoDetectHttpSocks !== false && canAutoDetectHttpSocks(profile, proxy)) {
			try {
				const detected = await detectWorkingBareProxyProtocol(proxy, {
					clientIp: options.clientIp,
					timeoutMs
				});
				if (options.updateProfileType !== false && detected.type !== profile.type) {
					await updateProxyProfileType(profile.userId, profile.id, detected.type);
				}
				return detected;
			} catch (detectErr) {
				throw new Error(
					`代理 ${profile.name} 当前类型 ${proxy.type.toUpperCase()} 验证失败，并且自动识别 HTTP/SOCKS 也失败: ${
						detectErr instanceof Error ? detectErr.message : String(detectErr)
					}`
				);
			}
		}
		throw firstErr;
	}
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

const PROXY_VALIDATION_URL =
	'https://management.azure.com/metadata/endpoints?api-version=2020-01-01';

function proxyErrorMessage(proxy: ProxyRuntimeConfig, err: unknown) {
	const message = err instanceof Error ? err.message : String(err);
	if (/SocksClient internal error/i.test(message)) {
		return `${proxy.type.toUpperCase()} 代理握手失败：代理端口可连接，但 SOCKS 握手没有按预期返回。请重新保存代理让系统自动识别 HTTP/SOCKS 类型，或手动改为 HTTP 后再试。原始错误: ${message}`;
	}
	if (/Socks5|SOCKS|socks/i.test(message)) {
		return `${proxy.type.toUpperCase()} 代理握手失败: ${message}`;
	}
	return `代理出站验证失败: ${message}`;
}

async function requestThroughProxy(proxy: ProxyRuntimeConfig, timeoutMs: number) {
	const options = proxyClientOptions(proxy);
	const pipeline = createPipelineFromOptions(options);
	const httpClient = options.httpClient ?? createDefaultHttpClient();
	const response = await pipeline.sendRequest(
		httpClient,
		createPipelineRequest({
			url: PROXY_VALIDATION_URL,
			method: 'GET',
			timeout: timeoutMs,
			headers: createHttpHeaders({
				accept: 'application/json',
				'user-agent': 'Azure-Panel proxy validation'
			})
		})
	);
	// The real credential check runs immediately after this probe. For proxy validation,
	// any Azure-side 4xx response still proves the proxy can complete TLS and reach ARM.
	if (response.status >= 200 && response.status < 500 && response.status !== 407) return;
	throw new Error(`Azure API connectivity check returned HTTP ${response.status}`);
}

export async function validateProxyConnection(
	proxy: ProxyRuntimeConfig,
	options: { clientIp?: string; timeoutMs?: number } = {}
): Promise<ProxyRuntimeConfig> {
	const resolved: ProxyRuntimeConfig = {
		...proxy,
		host: resolveClientIpProxyHost(proxy.host, options.clientIp)
	};
	const timeoutMs = options.timeoutMs ?? 8000;
	try {
		await requestThroughProxy(resolved, timeoutMs);
		return resolved;
	} catch (err) {
		try {
			await connectWithTimeout({
				host: resolved.host,
				port: resolved.port,
				tls: resolved.type === 'https',
				timeoutMs: Math.min(timeoutMs, 3000)
			});
		} catch {
			// Prefer the full outbound request error; the TCP check is only a fallback hint.
		}
		throw new Error(proxyErrorMessage(resolved, err));
	}
}

export async function detectWorkingBareProxyProtocol(
	proxy: ProxyRuntimeConfig,
	options: { clientIp?: string; timeoutMs?: number } = {}
): Promise<ProxyRuntimeConfig> {
	const candidates: ProxyRuntimeConfig[] = [
		{ ...proxy, type: 'socks5' },
		{ ...proxy, type: 'http' }
	];
	const errors: string[] = [];
	for (const candidate of candidates) {
		try {
			return await validateProxyConnection(candidate, options);
		} catch (err) {
			errors.push(`${candidate.type}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	throw new Error(
		`Bare proxy auto-detection failed: neither SOCKS5 nor HTTP can reach Azure API. ${errors.join(' ; ')}`
	);
}

export function publicProxyProfile(profile: ProxyProfile): PublicProxyProfile {
	const runtime = storedProxyProfileToRuntime(profile);
	const source = proxySource(profile);
	const host = source === 'client_ip' ? '当前访问网站 IP' : runtime.host;
	const managedCore = profile.managedCore ?? '';
	return {
		id: profile.id,
		name: profile.name,
		type: runtime.type,
		source,
		host,
		port: runtime.port,
		auth_enabled: Boolean(profile.usernameEncrypted || profile.passwordEncrypted),
		label: managedCore ? `${managedCore} 托管: ${maskProxy(runtime)}` : maskProxy(runtime),
		method: runtime.method ?? '',
		managed_core: managedCore,
		created_at: profile.createdAt
	};
}
