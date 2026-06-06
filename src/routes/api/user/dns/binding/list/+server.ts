import { listDnsBindingsByUser } from '$lib/server/db/repo';
import { publicDnsBinding } from '$lib/server/dns';
import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const bindings = await listDnsBindingsByUser(user.id);
	return ok(bindings.map(publicDnsBinding));
};
