import { deleteDnsConfig } from '$lib/server/db/repo';
import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	await deleteDnsConfig(user.id, Number(body.id ?? 0));
	return ok({ ok: true });
};
