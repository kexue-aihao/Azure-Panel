import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	return ok({
		enabled: Boolean(user.totpEnabled)
	});
};
