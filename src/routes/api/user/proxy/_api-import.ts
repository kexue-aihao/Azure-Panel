import {
	inferProxyApiRawType,
	parseProxyApiResponse,
	type ParsedProxyApiResponse
} from '$lib/server/proxy';

export const MAX_PROXY_API_BYTES = 1024 * 1024;
export const MAX_PROXY_API_IMPORT = 100;

export async function fetchProxyApiText(apiUrl: string) {
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
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw new Error('代理 API 拉取超时，请减少 Num 数量或检查代理商接口是否稳定');
		}
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}

export function parseProxyApiImport(
	responseText: string,
	options: { apiUrl: string; rawType?: string; limit?: unknown }
): ParsedProxyApiResponse {
	const rawType = inferProxyApiRawType(options.apiUrl, options.rawType ?? '');
	const parsed = parseProxyApiResponse(responseText, { apiUrl: options.apiUrl, rawType });
	const limit = Math.min(
		MAX_PROXY_API_IMPORT,
		Math.max(1, Number(options.limit ?? parsed.proxies.length) || parsed.proxies.length)
	);
	return {
		...parsed,
		proxies: parsed.proxies.slice(0, limit)
	};
}
