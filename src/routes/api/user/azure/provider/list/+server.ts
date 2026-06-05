import { DEFAULT_PROVIDER_NAMESPACES, listProviderStatuses } from '$lib/server/azure';
import { fail, ok, requireUser } from '$lib/server/http';
import { getAzureContext } from '../../_helpers';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = event.url.searchParams.get('account_id');
	const namespaces =
		event.url.searchParams.getAll('namespace').filter(Boolean).length > 0
			? event.url.searchParams.getAll('namespace').filter(Boolean)
			: DEFAULT_PROVIDER_NAMESPACES;

	try {
		const { clients, subscriptionId } = await getAzureContext(event, user.id, accountId);
		return ok({
			subscription_id: subscriptionId,
			providers: await listProviderStatuses(clients, namespaces)
		});
	} catch (err) {
		return fail(String(err), 500);
	}
};
