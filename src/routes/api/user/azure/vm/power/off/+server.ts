import { getUserAccountWithProxy } from '$lib/server/accounts';
import { createAzureClients, deallocateVm } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const resourceGroup = String(body.resource_group ?? '');
	const vmName = String(body.vm_name ?? '');
	if (!accountId || !resourceGroup || !vmName) return fail('参数不完整');

	const { account, proxy } = await getUserAccountWithProxy(user.id, accountId, {
		clientIp: getRequestClientIp(event)
	});
	try {
		await deallocateVm(createAzureClients(account, proxy), resourceGroup, vmName);
		return ok({ message: `已触发关机(释放): ${vmName}` });
	} catch (err) {
		return fail(String(err), 500);
	}
};
