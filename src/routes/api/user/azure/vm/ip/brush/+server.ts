import { getUserAccountWithProxy } from '$lib/server/accounts';
import { brushVmPublicIPv4Prefix, createAzureClients } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const resourceGroup = String(body.resource_group ?? '').trim();
	const vmName = String(body.vm_name ?? '').trim();
	const ipPrefix = String(body.ip_prefix ?? '').trim();
	if (!accountId || !resourceGroup || !vmName || !ipPrefix) return fail('参数不完整');

	const { account, proxy } = await getUserAccountWithProxy(user.id, accountId, {
		clientIp: getRequestClientIp(event)
	});
	try {
		const result = await brushVmPublicIPv4Prefix(createAzureClients(account, proxy), {
			resourceGroup,
			vmName,
			ipPrefix,
			maxAttempts: Number(body.max_attempts ?? 30)
		});
		return ok({
			vm_name: result.vmName,
			resource_group: result.resourceGroup,
			public_ipv4: result.publicIPv4,
			old_public_ipv4: result.oldPublicIPv4,
			public_ip_name: result.publicIpName,
			target_prefix: result.targetPrefix,
			attempts: result.attempts,
			matched: result.matched
		});
	} catch (err) {
		return fail(String(err), 500);
	}
};
