import { getUserAccount } from '$lib/server/accounts';
import { DEFAULT_PROVIDER_NAMESPACES, registerResourceProviders } from '$lib/server/azure';
import {
	canCacheProviderStatuses,
	mergeProviderStatusCache,
	parseProviderStatusCache
} from '$lib/server/azure-provider-cache';
import { updateAccountProviderCache } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import { getAzureContext } from '../../_helpers';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const namespaces = Array.isArray(body.namespaces)
		? body.namespaces.map(String).filter(Boolean)
		: DEFAULT_PROVIDER_NAMESPACES;

	try {
		const { clients, subscriptionId } = await getAzureContext(
			event,
			user.id,
			body.account_id,
			body.subscription_id
		);
		const providers = await registerResourceProviders(clients, namespaces);
		if (canCacheProviderStatuses(providers)) {
			const numericAccountId = Number(body.account_id);
			const account = await getUserAccount(user.id, numericAccountId);
			const cache = parseProviderStatusCache(account.vmProviderCache);
			await updateAccountProviderCache(
				user.id,
				numericAccountId,
				JSON.stringify(mergeProviderStatusCache(cache, subscriptionId, providers))
			);
		}
		return ok({
			subscription_id: subscriptionId,
			providers
		});
	} catch (err) {
		return fail(String(err), 500);
	}
};
