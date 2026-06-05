import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { createAzureClients, listComputeQuotas } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = Number(event.url.searchParams.get('account_id'));
	const location = String(event.url.searchParams.get('location') ?? '').trim();
	if (!accountId || !location) return fail('缺少 account_id 或 location');

	try {
		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: event.url.searchParams.get('proxy_mode'),
			proxyProfileId: Number(event.url.searchParams.get('proxy_profile_id') ?? 0) || null
		});
		const quotas = await listComputeQuotas(createAzureClients(account, proxy), location);
		return ok(quotas);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
