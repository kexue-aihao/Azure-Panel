import { fail, ok, requireUser } from '$lib/server/http';
import { fetchProxyApiText, parseProxyApiImport } from '../../_api-import';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	await requireUser(event);
	const body = await event.request.json();
	const proxyApiUrl = String(body.proxy_api_url ?? '').trim();
	if (!proxyApiUrl) return ok({ mode: 'api_parse', raw_type: 'auto', total_candidates: 0, errors: [], proxies: [] });

	try {
		const responseText = await fetchProxyApiText(proxyApiUrl);
		const parsed = parseProxyApiImport(responseText, {
			apiUrl: proxyApiUrl,
			rawType: String(body.raw_type ?? body.type ?? ''),
			limit: body.proxy_api_limit
		});

		return ok({
			mode: 'api_parse',
			raw_type: parsed.rawType,
			total_candidates: parsed.totalCandidates,
			errors: parsed.errors,
			proxies: parsed.proxies.map((item) => ({
				name: item.name,
				protocol: item.protocol,
				message: item.message,
				proxy: item.proxy
			}))
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : '代理 API 解析失败', 400);
	}
};
