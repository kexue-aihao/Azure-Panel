import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { brushVmPublicIPv4Prefix, createAzureClients } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import {
	operationProgressEvent,
	vmOperationStream,
	wantsProgressStream,
	writeVmOperationLog
} from '$lib/server/vm-operation-progress';
import type { RequestHandler } from './$types';

type BrushIpPublicResult = {
	vm_name: string;
	resource_group: string;
	public_ipv4: string;
	old_public_ipv4: string;
	public_ip_name: string;
	target_prefix: string;
	attempts: number;
	matched: boolean;
};

function publicResult(result: Awaited<ReturnType<typeof brushVmPublicIPv4Prefix>>): BrushIpPublicResult {
	return {
		vm_name: result.vmName,
		resource_group: result.resourceGroup,
		public_ipv4: result.publicIPv4,
		old_public_ipv4: result.oldPublicIPv4,
		public_ip_name: result.publicIpName,
		target_prefix: result.targetPrefix,
		attempts: result.attempts,
		matched: result.matched
	};
}

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const resourceGroup = String(body.resource_group ?? '').trim();
	const vmName = String(body.vm_name ?? '').trim();
	const ipPrefix = String(body.ip_prefix ?? '').trim();
	if (!accountId || !resourceGroup || !vmName || !ipPrefix) return fail('参数不完整');

	try {
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: String(body.proxy_mode ?? 'account'),
			proxyProfileId: Number(body.proxy_profile_id ?? 0) || null
		});

		if (wantsProgressStream(event.request)) {
			return vmOperationStream({
				errorStep: 'brush-ip-failed',
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
						operationProgressEvent('brush-ip-auth', 'success', 'Azure 账号已连接，准备刷 IPv4 段', {
							resourceGroup,
							vmName,
							ipPrefix
						})
					);
					const result = await brushVmPublicIPv4Prefix(createAzureClients(account, proxy), {
						resourceGroup,
						vmName,
						ipPrefix,
						maxAttempts: Number(body.max_attempts ?? 30),
						progress
					});
					return publicResult(result);
				}
			});
		}

		const result = await brushVmPublicIPv4Prefix(createAzureClients(account, proxy), {
			resourceGroup,
			vmName,
			ipPrefix,
			maxAttempts: Number(body.max_attempts ?? 30)
		});
		return ok(publicResult(result));
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
