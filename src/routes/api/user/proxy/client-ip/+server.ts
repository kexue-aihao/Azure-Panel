import { detectClientIpProxy } from '$lib/server/auto-client-ip-proxy';
import { getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const clientIp = getRequestClientIp(event);
	return ok(await detectClientIpProxy(user.id, clientIp));
};
