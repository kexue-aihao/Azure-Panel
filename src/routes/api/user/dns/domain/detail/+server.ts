import { fail, ok, requireUser } from '$lib/server/http';
import { getUserDnsClient, numberParam } from '../../_helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const configId = numberParam(event.url.searchParams.get('config_id'));
	const domainId = numberParam(event.url.searchParams.get('domain_id'));
	const loginurl = event.url.searchParams.get('loginurl') === '1';
	if (!domainId) return fail('缺少域名 ID');

	try {
		const { client } = await getUserDnsClient(user.id, configId);
		const detail = await client.getDomain(domainId, { loginurl });
		return ok(detail);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
