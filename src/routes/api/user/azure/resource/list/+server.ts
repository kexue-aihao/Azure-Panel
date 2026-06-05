import { getUserAccountWithProxy } from '$lib/server/accounts';
import { createAzureClients, listVirtualMachines } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = Number(event.url.searchParams.get('account_id'));
	const resourceGroup = event.url.searchParams.get('resource_group') ?? undefined;
	if (!accountId) return fail('缺少 account_id');

	const { account, proxy } = await getUserAccountWithProxy(user.id, accountId, {
		clientIp: getRequestClientIp(event)
	});
	const clients = createAzureClients(account, proxy);

	try {
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
		return fail(String(err), 500);
	}
};
