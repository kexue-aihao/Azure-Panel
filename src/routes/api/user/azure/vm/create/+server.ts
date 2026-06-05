import { getUserAccountWithProxy } from '$lib/server/accounts';
import { createAzureClients, createVmAdvanced, randomAzureResourceName } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const location = String(body.location ?? '').trim();
	const requestedResourceGroup = String(body.resource_group ?? '').trim();
	const requestedVmName = String(body.vm_name ?? '').trim();
	const resourceGroup = requestedResourceGroup || randomAzureResourceName('rg-azp', 64);
	const vmName = requestedVmName || randomAzureResourceName('vm-azp', 48);
	const adminPassword = String(body.admin_password ?? '');

	if (!accountId || !location) return fail('参数不完整');
	if (!adminPassword) return fail('缺少管理员密码');

	try {
		const { account, proxy } = await getUserAccountWithProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event)
		});
		const result = await createVmAdvanced(createAzureClients(account, proxy), {
			resourceGroup,
			location,
			vmName,
			vmSize: String(body.vm_size ?? 'Standard_B1s'),
			imageReference: String(body.image_reference ?? 'Canonical:ubuntu-24_04-lts:server:latest'),
			adminUsername: String(body.admin_username ?? 'azureuser'),
			adminPassword,
			enableIpv6: Boolean(body.enable_ipv6),
			customData: String(body.userdata ?? ''),
			ipPrefix: String(body.ip_prefix ?? ''),
			ipBrushMaxAttempts: Number(body.ip_brush_max_attempts ?? 30)
		});
		return ok({
			name: result.name,
			resource_group: result.resourceGroup,
			location: result.location,
			public_ipv4: result.publicIPv4,
			public_ipv6: result.publicIPv6,
			ip_brush_attempts: result.ipBrushAttempts,
			ip_brush_matched: result.ipBrushMatched
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
