import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { createAzureClients, refreshVmPublicIps } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import {
	operationProgressEvent,
	vmOperationStream,
	wantsProgressStream,
	writeVmOperationLog
} from '$lib/server/vm-operation-progress';
import type { RequestHandler } from './$types';

type RefreshIpPublicResult = {
	vm_name: string;
	resource_group: string;
	public_ipv4: string;
	public_ipv6: string;
	nic_name: string;
	nic_resource_group: string;
};

function publicResult(result: Awaited<ReturnType<typeof refreshVmPublicIps>>): RefreshIpPublicResult {
	return {
		vm_name: result.vmName,
		resource_group: result.resourceGroup,
		public_ipv4: result.publicIPv4,
		public_ipv6: result.publicIPv6,
		nic_name: result.nicName,
		nic_resource_group: result.nicResourceGroup
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
				errorStep: 'refresh-ip-failed',
				onProgress: (progressEvent) =>
					writeVmOperationLog({
						userId: user.id,
						accountId,
						source: 'vm_ip',
						resourceGroup,
						vmName,
						event: progressEvent
					}),
				run: async (progress) => {
					await progress(
						operationProgressEvent('refresh-ip-auth', 'success', 'Azure 账号已连接，准备重读公网 IP', {
							resourceGroup,
							vmName
						})
					);
					const result = await refreshVmPublicIps(
						createAzureClients(account, proxy),
						resourceGroup,
						vmName,
						progress
					);
					return publicResult(result);
				}
			});
		}

		const result = await refreshVmPublicIps(createAzureClients(account, proxy), resourceGroup, vmName);
		return ok(publicResult(result));
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
