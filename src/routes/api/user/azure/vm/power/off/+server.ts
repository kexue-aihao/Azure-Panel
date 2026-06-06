import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { createAzureClients, deallocateVm, powerVmWithProgress } from '$lib/server/azure';
import { insertExecutionLog } from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import {
	operationProgressEvent,
	vmOperationStream,
	wantsProgressStream,
	writeVmOperationLog
} from '$lib/server/vm-operation-progress';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const resourceGroup = String(body.resource_group ?? '');
	const vmName = String(body.vm_name ?? '');
	if (!accountId || !resourceGroup || !vmName) return fail('参数不完整');

	try {
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: String(body.proxy_mode ?? 'account'),
			proxyProfileId: Number(body.proxy_profile_id ?? 0) || null
		});

		if (wantsProgressStream(event.request)) {
			return vmOperationStream({
				errorStep: 'power-off-failed',
				onProgress: (progressEvent) =>
					writeVmOperationLog({
						userId: user.id,
						accountId,
						source: 'vm_power',
						resourceGroup,
						vmName,
						event: progressEvent
					}),
				run: async (progress) => {
					await progress(
						operationProgressEvent('power-off-auth', 'success', 'Azure 账号已连接，准备关机并释放', {
							resourceGroup,
							vmName
						})
					);
					return powerVmWithProgress(createAzureClients(account, proxy), {
						resourceGroup,
						vmName,
						action: 'deallocate',
						progress
					});
				}
			});
		}

		await deallocateVm(createAzureClients(account, proxy), resourceGroup, vmName);
		await insertExecutionLog({
			userId: user.id,
			accountId,
			source: 'vm_power',
			action: 'power_off',
			status: 'success',
			message: `已触发关机(释放): ${vmName}`,
			resourceGroup,
			vmName
		}).catch((logErr) => console.warn('[execution-log] failed to write power log:', logErr));
		return ok({ message: `已触发关机(释放): ${vmName}` });
	} catch (err) {
		await insertExecutionLog({
			userId: user.id,
			accountId,
			source: 'vm_power',
			action: 'power_off',
			status: 'error',
			message: err instanceof Error ? err.message : String(err),
			resourceGroup,
			vmName
		}).catch((logErr) => console.warn('[execution-log] failed to write power log:', logErr));
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
