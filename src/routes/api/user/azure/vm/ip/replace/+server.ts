import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { createAzureClients, replaceVmPublicIPv4 } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const resourceGroup = String(body.resource_group ?? '').trim();
	const vmName = String(body.vm_name ?? '').trim();
	if (!accountId || !resourceGroup || !vmName) return fail('参数不完整');

	try {
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: String(body.proxy_mode ?? 'account'),
			proxyProfileId: Number(body.proxy_profile_id ?? 0) || null
		});
		const result = await replaceVmPublicIPv4(createAzureClients(account, proxy), resourceGroup, vmName);
		return ok({
			vm_name: result.vmName,
			resource_group: result.resourceGroup,
			public_ipv4: result.publicIPv4,
			old_public_ipv4: result.oldPublicIPv4,
			public_ip_name: result.publicIpName
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
