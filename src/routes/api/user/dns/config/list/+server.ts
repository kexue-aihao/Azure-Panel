import { listDnsConfigsByUser } from '$lib/server/db/repo';
import { publicDnsConfig } from '$lib/server/dns';
import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const configs = await listDnsConfigsByUser(user.id);
	return ok(configs.map(publicDnsConfig));
};
