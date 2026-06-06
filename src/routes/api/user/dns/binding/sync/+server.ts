import {
	findDnsBindingByUser,
	findDnsConfigByUser,
	updateDnsBindingSyncState
} from '$lib/server/db/repo';
import { createRainbowDnsClient, syncDnsBindingToIp } from '$lib/server/dns';
import { fail, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const bindingId = Number(body.binding_id ?? body.id ?? 0);
	const ipv4 = String(body.ipv4 ?? '').trim();
	const ipv6 = String(body.ipv6 ?? '').trim();
	if (!bindingId) return fail('缺少 DNS 绑定 ID');
	if (!ipv4 && !ipv6) return fail('请至少填写一个 IPv4 或 IPv6');

	try {
		const binding = await findDnsBindingByUser(user.id, bindingId);
		if (!binding) return fail('DNS 绑定不存在', 404);
		const config = await findDnsConfigByUser(user.id, binding.configId);
		if (!config) return fail('DNS 配置不存在', 404);
		const result = await syncDnsBindingToIp(createRainbowDnsClient(config), binding, {
			ipv4,
			ipv6,
			vmName: String(body.vm_name ?? '').trim(),
			resourceGroup: String(body.resource_group ?? '').trim()
		});
		await updateDnsBindingSyncState(user.id, binding.id, {
			lastARecordId: result.lastARecordId,
			lastAAAARecordId: result.lastAAAARecordId,
			lastIpv4: result.lastIpv4,
			lastIpv6: result.lastIpv6,
			lastSyncedAt: new Date()
		});
		return ok(result);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
