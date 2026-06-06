import { serializeUserForClient } from '$lib/server/auth';
import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	return ok(serializeUserForClient(user));
};
