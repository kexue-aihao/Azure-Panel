import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { createAzureClients, restartVm } from '$lib/server/azure';
import { insertExecutionLog } from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
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
		await restartVm(createAzureClients(account, proxy), resourceGroup, vmName);
		await insertExecutionLog({
			userId: user.id,
			accountId,
			source: 'vm_power',
			action: 'power_restart',
			status: 'success',
			message: `已触发重启: ${vmName}`,
			resourceGroup,
			vmName
		}).catch((logErr) => console.warn('[execution-log] failed to write power log:', logErr));
		return ok({ message: `已触发重启: ${vmName}` });
	} catch (err) {
		await insertExecutionLog({
			userId: user.id,
			accountId,
			source: 'vm_power',
			action: 'power_restart',
			status: 'error',
			message: err instanceof Error ? err.message : String(err),
			resourceGroup,
			vmName
		}).catch((logErr) => console.warn('[execution-log] failed to write power log:', logErr));
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
