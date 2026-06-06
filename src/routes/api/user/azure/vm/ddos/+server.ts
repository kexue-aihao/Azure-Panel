import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { createAzureClients, enableVmDdosProtection } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import {
	operationProgressEvent,
	vmOperationStream,
	wantsProgressStream,
	writeVmOperationLog
} from '$lib/server/vm-operation-progress';
import type { RequestHandler } from './$types';

type EnableDdosPublicResult = {
	vm_name: string;
	resource_group: string;
	ddos_protection_plan_name: string;
	ddos_protection_plan_id: string;
	virtual_network_name: string;
	virtual_network_resource_group: string;
	public_ipv4: string;
	public_ipv4_ddos_enabled: boolean;
	message: string;
};

function publicResult(result: Awaited<ReturnType<typeof enableVmDdosProtection>>): EnableDdosPublicResult {
	return {
		vm_name: result.vmName,
		resource_group: result.resourceGroup,
		ddos_protection_plan_name: result.ddosProtectionPlanName,
		ddos_protection_plan_id: result.ddosProtectionPlanId,
		virtual_network_name: result.virtualNetworkName,
		virtual_network_resource_group: result.virtualNetworkResourceGroup,
		public_ipv4: result.publicIPv4,
		public_ipv4_ddos_enabled: result.publicIPv4DdosEnabled,
		message: `已为 VM ${result.vmName} 开启 DDoS 防护计划`
	};
}

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

		if (wantsProgressStream(event.request)) {
			return vmOperationStream({
				errorStep: 'ddos-failed',
				onProgress: (progressEvent) =>
					writeVmOperationLog({
						userId: user.id,
						accountId,
						source: 'vm_ddos',
						resourceGroup,
						vmName,
						event: progressEvent
					}),
				run: async (progress) => {
					await progress(
						operationProgressEvent('ddos-auth', 'success', 'Azure 账号已连接，准备开启 DDoS 防护', {
							resourceGroup,
							vmName
						})
					);
					const result = await enableVmDdosProtection(
						createAzureClients(account, proxy),
						resourceGroup,
						vmName,
						progress
					);
					return publicResult(result);
				}
			});
		}

		const result = await enableVmDdosProtection(createAzureClients(account, proxy), resourceGroup, vmName);
		return ok(publicResult(result));
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
