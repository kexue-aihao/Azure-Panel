import { ok, requireUser } from '$lib/server/http';
import { parseProxyShareLink } from '$lib/server/proxy';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	await requireUser(event);
	const body = await event.request.json();
	const result = parseProxyShareLink(String(body.share_link ?? ''));
	return ok({
		supported: result.supported,
		managed_supported: result.managed_supported,
		managed_core: result.managed_core,
		protocol: result.protocol,
		name: result.name,
		message: result.message,
		proxy: result.proxy
			? {
					type: result.proxy.type,
					host: result.proxy.host,
					port: result.proxy.port,
					username: result.proxy.username ?? '',
					password: result.proxy.password ?? '',
					method: result.proxy.method ?? ''
				}
			: null,
		details: result.details
	});
};
