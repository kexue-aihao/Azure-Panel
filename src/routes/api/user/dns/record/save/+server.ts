import { fail, ok, requireUser } from '$lib/server/http';
import { getUserDnsClient } from '../../_helpers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const configId = Number(body.config_id ?? 0);
	const domainId = Number(body.domain_id ?? 0);
	const recordId = String(body.record_id ?? body.recordid ?? '').trim();
	const input = {
		name: String(body.name ?? '@').trim() || '@',
		type: String(body.type ?? 'A').trim().toUpperCase(),
		value: String(body.value ?? '').trim(),
		line: String(body.line ?? 'default').trim() || 'default',
		ttl: Number(body.ttl ?? 60),
		weight: body.weight === '' ? null : Number(body.weight ?? 0) || null,
		mx: body.mx === '' ? null : Number(body.mx ?? 0) || null,
		remark: String(body.remark ?? '').trim()
	};
	if (!domainId || !input.value) return fail('缺少域名 ID 或记录值');

	try {
		const { client } = await getUserDnsClient(user.id, configId);
		if (recordId) {
			await client.updateRecord(domainId, recordId, input);
			return ok({ ok: true, action: 'updated' });
		}
		await client.addRecord(domainId, input);
		return ok({ ok: true, action: 'created' });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
