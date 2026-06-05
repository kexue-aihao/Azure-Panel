import { getUserAccountWithProxy } from '$lib/server/accounts';
import { createAzureClients, listAvailableVmRegions } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = Number(event.url.searchParams.get('account_id'));
	if (!accountId) return fail('缺少 account_id');

	try {
		const { account, proxy } = await getUserAccountWithProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event)
		});
		return ok(await listAvailableVmRegions(createAzureClients(account, proxy)));
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
