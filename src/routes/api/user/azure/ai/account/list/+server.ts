import { listAiAccounts } from '$lib/server/azure';
import { fail, ok, requireUser } from '$lib/server/http';
import { getAzureContext } from '../../../_helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = event.url.searchParams.get('account_id');

	try {
		const { clients, subscriptionId } = await getAzureContext(event, user.id, accountId);
		const accounts = await listAiAccounts(clients);
		return ok({
			subscription_id: subscriptionId,
			accounts: accounts.map((account) => ({
				id: account.id,
				name: account.name,
				resource_group: account.resourceGroup,
				location: account.location,
				kind: account.kind,
				sku_name: account.skuName,
				endpoint: account.endpoint,
				provisioning_state: account.provisioningState,
				public_network_access: account.publicNetworkAccess
			}))
		});
	} catch (err) {
		return fail(String(err), 500);
	}
};
