import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { createAzureClients, listVirtualMachines } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = Number(event.url.searchParams.get('account_id'));
	const resourceGroup = event.url.searchParams.get('resource_group') ?? undefined;
	if (!accountId) return fail('缺少 account_id');

	try {
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: event.url.searchParams.get('proxy_mode'),
			proxyProfileId: Number(event.url.searchParams.get('proxy_profile_id') ?? 0) || null
		});
		const clients = createAzureClients(account, proxy);
		const vms = await listVirtualMachines(clients, resourceGroup);
		return ok(
			vms.map((vm) => ({
				name: vm.name,
				resource_group: vm.resourceGroup,
				location: vm.location,
				vm_size: vm.vmSize,
				power_state: vm.powerState,
				provisioning_state: vm.provisioningState,
				public_ipv4: vm.publicIPv4,
				public_ipv6: vm.publicIPv6
			}))
		);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
