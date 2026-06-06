import {
	findDnsBindingByUser,
	findDnsConfigByUser,
	insertDnsBinding,
	updateDnsBinding
} from '$lib/server/db/repo';
import { publicDnsBinding } from '$lib/server/dns';
import { fail, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

function optionalNumber(value: unknown) {
	if (value === undefined || value === null || value === '') return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const id = Number(body.id ?? 0);
	const configId = Number(body.config_id ?? 0);
	const domainId = Number(body.domain_id ?? 0);
	const name = String(body.name ?? '').trim();
	const domainName = String(body.domain_name ?? '').trim();
	const subdomain = String(body.subdomain ?? '@').trim() || '@';
	const recordType = String(body.record_type ?? 'A').trim().toUpperCase();
	const line = String(body.line ?? 'default').trim() || 'default';
	const ttl = Number(body.ttl ?? 60);
	const remark = String(body.remark ?? '').trim();
	const enabled = body.enabled !== false;

	if (!configId || !domainId || !name || !domainName) {
		return fail('请填写绑定名称、DNS 配置、域名和域名 ID');
	}
	if (!['A', 'AAAA', 'A+AAAA', 'BOTH'].includes(recordType)) {
		return fail('记录类型只支持 A、AAAA 或 A+AAAA');
	}
	const config = await findDnsConfigByUser(user.id, configId);
	if (!config) return fail('DNS 配置不存在', 404);

	try {
		if (id) {
			const existing = await findDnsBindingByUser(user.id, id);
			if (!existing) return fail('DNS 绑定不存在', 404);
			const updated = await updateDnsBinding(user.id, id, {
				configId,
				name,
				domainId,
				domainName,
				subdomain,
				recordType,
				line,
				ttl,
				weight: optionalNumber(body.weight),
				mx: optionalNumber(body.mx),
				remark,
				enabled
			});
			if (!updated) return fail('DNS 绑定保存失败', 500);
			return ok(publicDnsBinding(updated));
		}

		const created = await insertDnsBinding({
			userId: user.id,
			configId,
			name,
			domainId,
			domainName,
			subdomain,
			recordType,
			line,
			ttl,
			weight: optionalNumber(body.weight),
			mx: optionalNumber(body.mx),
			remark,
			enabled,
			lastARecordId: '',
			lastAAAARecordId: '',
			lastIpv4: '',
			lastIpv6: ''
		});
		return ok(publicDnsBinding(created));
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
