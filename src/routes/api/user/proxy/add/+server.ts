import { encryptSecret } from '$lib/server/crypto';
import { insertProxyProfile } from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import {
	normalizeManagedCore,
	startManagedProxyFromShareLink,
	type ManagedProxyCore
} from '$lib/server/managed-proxy-core';
import {
	CLIENT_IP_PROXY_HOST,
	detectWorkingBareProxyProtocol,
	inferProxyApiRawType,
	normalizeProxyRuntime,
	parseProxyApiResponse,
	parseProxyShareLink,
	publicProxyProfile,
	type ProxyRuntimeConfig,
	validateProxyConnection
} from '$lib/server/proxy';
import type { RequestHandler } from './$types';

const MAX_PROXY_API_BYTES = 1024 * 1024;
const MAX_PROXY_API_IMPORT = 100;

async function fetchProxyApiText(apiUrl: string) {
	let parsed: URL;
	try {
		parsed = new URL(apiUrl);
	} catch {
		throw new Error('代理 API 链接格式无效');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error('代理 API 链接仅支持 http:// 或 https://');
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 20_000);
	try {
		const response = await fetch(parsed, {
			method: 'GET',
			headers: {
				accept: 'text/plain, application/json, */*',
				'user-agent': 'Azure-Panel proxy-api-import'
			},
			signal: controller.signal
		});
		const length = Number(response.headers.get('content-length') ?? 0);
		if (Number.isFinite(length) && length > MAX_PROXY_API_BYTES) {
			throw new Error('代理 API 返回内容过大，请减少 Num 数量');
		}
		const text = await response.text();
		if (!response.ok) throw new Error(`代理 API 请求失败 (${response.status}): ${text.slice(0, 200)}`);
		if (text.length > MAX_PROXY_API_BYTES) throw new Error('代理 API 返回内容过大，请减少 Num 数量');
		return text;
	} finally {
		clearTimeout(timeout);
	}
}

async function resolveProxyForSave(options: {
	proxy: ProxyRuntimeConfig;
	protocol?: string;
	clientIp: string;
}) {
	return options.protocol === 'auto'
		? detectWorkingBareProxyProtocol(options.proxy, { clientIp: options.clientIp })
		: validateProxyConnection(options.proxy, { clientIp: options.clientIp });
}

async function saveProxyProfile(options: {
	userId: number;
	name: string;
	proxy: ProxyRuntimeConfig;
	managedCore?: string;
	shareLink?: string;
}) {
	const profile = await insertProxyProfile({
		userId: options.userId,
		name: options.name,
		type: options.proxy.type,
		host: options.proxy.host,
		port: options.proxy.port,
		usernameEncrypted: options.proxy.method
			? encryptSecret(options.proxy.method)
			: options.proxy.username
				? encryptSecret(options.proxy.username)
				: '',
		passwordEncrypted: options.proxy.password ? encryptSecret(options.proxy.password) : '',
		managedCore: options.managedCore ?? '',
		shareLinkEncrypted:
			options.managedCore && options.shareLink ? encryptSecret(options.shareLink) : ''
	});
	return publicProxyProfile(profile);
}

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const clientIp = getRequestClientIp(event);

	const proxyApiUrl = String(body.proxy_api_url ?? '').trim();
	if (proxyApiUrl) {
		try {
			const responseText = await fetchProxyApiText(proxyApiUrl);
			const rawType = inferProxyApiRawType(proxyApiUrl, String(body.raw_type ?? body.type ?? ''));
			const parsed = parseProxyApiResponse(responseText, { apiUrl: proxyApiUrl, rawType });
			const limit = Math.min(
				MAX_PROXY_API_IMPORT,
				Math.max(1, Number(body.proxy_api_limit ?? parsed.proxies.length) || parsed.proxies.length)
			);
			const saved = [];
			const errors = [...parsed.errors];
			const requestedName = String(body.name ?? '').trim();
			let index = 0;

			for (const item of parsed.proxies.slice(0, limit)) {
				if (!item.proxy) {
					errors.push(`${item.name}: 代理内容为空`);
					continue;
				}
				try {
					const proxy = await resolveProxyForSave({
						proxy: item.proxy,
						protocol: item.protocol,
						clientIp
					});
					index += 1;
					saved.push(
						await saveProxyProfile({
							userId: user.id,
							name: requestedName
								? `${requestedName}-${index}`
								: item.name || `API代理-${index}`,
							proxy
						})
					);
				} catch (err) {
					errors.push(`${item.name}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}

			if (saved.length === 0) {
				return fail(
					`代理 API 未导入任何可用代理。已识别 ${parsed.totalCandidates} 条，错误: ${
						errors.slice(0, 5).join(' ; ') || '没有可解析的代理'
					}`
				);
			}

			return ok({
				mode: 'api',
				raw_type: parsed.rawType,
				total_candidates: parsed.totalCandidates,
				imported: saved.length,
				failed: errors.length,
				errors: errors.slice(0, 10),
				proxies: saved
			});
		} catch (err) {
			return fail(err instanceof Error ? err.message : '代理 API 导入失败');
		}
	}

	const shareLink = String(body.share_link ?? '').trim();
	const parsedShareLink = shareLink
		? parseProxyShareLink(shareLink, { rawType: String(body.raw_type ?? body.type ?? '') })
		: null;
	if (parsedShareLink && !parsedShareLink.supported) {
		return fail(parsedShareLink.message);
	}
	const requestedCore = normalizeManagedCore(String(body.managed_core ?? parsedShareLink?.managed_core ?? ''));
	const managedCore: ManagedProxyCore | null = parsedShareLink?.managed_supported
		? requestedCore ?? 'sing-box'
		: null;

	const requestedName = String(body.name ?? '').trim();
	const parsedName = String(parsedShareLink?.name ?? '').trim();
	const name = requestedName || parsedName;
	if (!name) return fail('请填写代理名称');

	let proxy;
	try {
		if (managedCore && shareLink) {
			proxy = await startManagedProxyFromShareLink(shareLink, { core: managedCore });
		} else {
			proxy = parsedShareLink?.proxy ?? normalizeProxyRuntime({
				type: String(body.type ?? ''),
				host:
					String(body.source ?? '') === 'client_ip'
						? CLIENT_IP_PROXY_HOST
						: String(body.host ?? ''),
				port: body.port,
				username: String(body.username ?? ''),
				password: String(body.password ?? ''),
				method: String(body.method ?? '')
			});
		}
		proxy = await resolveProxyForSave({
			proxy,
			protocol: parsedShareLink?.protocol,
			clientIp
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : '代理配置无效');
	}

	const profile = await saveProxyProfile({
		userId: user.id,
		name,
		proxy,
		managedCore: managedCore ?? '',
		shareLink: shareLink || undefined
	});

	return ok(profile);
};
