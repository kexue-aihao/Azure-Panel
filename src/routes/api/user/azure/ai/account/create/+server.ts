import { createAiAccount } from '$lib/server/azure';
import { fail, ok, requireUser } from '$lib/server/http';
import { getAzureContext } from '../../../_helpers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const resourceGroup = String(body.resource_group ?? '').trim();
	const location = String(body.location ?? '').trim();
	const accountName = String(body.account_name ?? '').trim();
	if (!resourceGroup || !location || !accountName) return fail('参数不完整');

	try {
		const { account, proxy } = await getAzureContext(
			event,
			user.id,
			body.account_id,
			body.subscription_id
		);
		const created = await createAiAccount(account, proxy, {
			resourceGroup,
			location,
			accountName,
			kind: String(body.kind ?? 'OpenAI').trim() || 'OpenAI',
			skuName: String(body.sku_name ?? 'S0').trim() || 'S0'
		});
		return ok({
			id: created.id,
			name: created.name,
			resource_group: created.resourceGroup,
			location: created.location,
			kind: created.kind,
			sku_name: created.skuName,
			endpoint: created.endpoint,
			provisioning_state: created.provisioningState,
			public_network_access: created.publicNetworkAccess
		});
	} catch (err) {
		return fail(String(err), 500);
	}
};
