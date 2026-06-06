import { fail, ok, requireUser } from '$lib/server/http';
import { getUserDnsClient } from '../../_helpers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const configId = Number(body.config_id ?? 0);
	const domainId = Number(body.domain_id ?? 0);
	const recordId = String(body.record_id ?? body.recordid ?? '').trim();
	if (!domainId || !recordId) return fail('缺少域名 ID 或记录 ID');

	try {
		const { client } = await getUserDnsClient(user.id, configId);
		await client.deleteRecord(domainId, recordId);
		return ok({ ok: true });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
