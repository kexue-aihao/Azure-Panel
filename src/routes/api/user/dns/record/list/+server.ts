import { fail, ok, requireUser } from '$lib/server/http';
import { getUserDnsClient, numberParam } from '../../_helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const configId = numberParam(event.url.searchParams.get('config_id'));
	const domainId = numberParam(event.url.searchParams.get('domain_id'));
	if (!domainId) return fail('缺少域名 ID');

	try {
		const { client } = await getUserDnsClient(user.id, configId);
		const result = await client.listRecords(domainId, {
			offset: numberParam(event.url.searchParams.get('offset')),
			limit: numberParam(event.url.searchParams.get('limit'), 100),
			keyword: event.url.searchParams.get('keyword') ?? '',
			subdomain: event.url.searchParams.get('subdomain') ?? '',
			value: event.url.searchParams.get('value') ?? '',
			type: event.url.searchParams.get('type') ?? '',
			line: event.url.searchParams.get('line') ?? '',
			status: event.url.searchParams.get('status') ?? ''
		});
		return ok(result);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
