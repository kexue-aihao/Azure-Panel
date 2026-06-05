import { listProxyProfilesByUser } from '$lib/server/db/repo';
import { ok, requireUser } from '$lib/server/http';
import { publicProxyProfile } from '$lib/server/proxy';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const profiles = await listProxyProfilesByUser(user.id);
	return ok(profiles.map(publicProxyProfile));
};
