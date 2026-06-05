import { getAiAccountKeys } from '$lib/server/azure';
import { fail, ok, requireUser } from '$lib/server/http';
import { getAzureContext } from '../../../_helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = event.url.searchParams.get('account_id');
	const resourceGroup = String(event.url.searchParams.get('resource_group') ?? '').trim();
	const accountName = String(event.url.searchParams.get('ai_account_name') ?? '').trim();
	if (!resourceGroup || !accountName) return fail('缺少 resource_group 或 ai_account_name');

	try {
		const { account, proxy } = await getAzureContext(event, user.id, accountId);
		return ok(await getAiAccountKeys(account, proxy, resourceGroup, accountName));
	} catch (err) {
		return fail(String(err), 500);
	}
};
