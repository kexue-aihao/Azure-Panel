import { fail, ok, requireUser } from '$lib/server/http';
import { getUserDnsClient, numberParam } from '../../_helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const configId = numberParam(event.url.searchParams.get('config_id'));
	const kw = event.url.searchParams.get('kw') ?? '';

	try {
		const { client } = await getUserDnsClient(user.id, configId);
		const result = await client.listDomains({ limit: 100, kw });
		return ok(result);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
