import { getUserAccount } from '$lib/server/accounts';
import { DEFAULT_PROVIDER_NAMESPACES, listProviderStatuses } from '$lib/server/azure';
import {
	canCacheProviderStatuses,
	getCachedProviderStatuses,
	mergeProviderStatusCache,
	parseProviderStatusCache
} from '$lib/server/azure-provider-cache';
import { updateAccountProviderCache } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import { getAzureContext } from '../../_helpers';
import type { RequestHandler } from './$types';

function shouldRefreshCache(value: string | null) {
	return ['1', 'true', 'yes', 'force'].includes((value ?? '').trim().toLowerCase());
}

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = event.url.searchParams.get('account_id');
	const numericAccountId = Number(accountId);
	const namespaces =
		event.url.searchParams.getAll('namespace').filter(Boolean).length > 0
			? event.url.searchParams.getAll('namespace').filter(Boolean)
			: DEFAULT_PROVIDER_NAMESPACES;

	try {
		if (!numericAccountId) return fail('缺少 account_id', 400);
		const account = await getUserAccount(user.id, numericAccountId);
		const selectedSubscriptionId =
			String(event.url.searchParams.get('subscription_id') ?? '').trim() || account.subscriptionId;
		const cache = parseProviderStatusCache(account.vmProviderCache);
		const cachedProviders = getCachedProviderStatuses(cache, selectedSubscriptionId, namespaces);
		if (!shouldRefreshCache(event.url.searchParams.get('refresh')) && cachedProviders) {
			return ok({
				subscription_id: selectedSubscriptionId,
				providers: cachedProviders
			});
		}

		const { clients, subscriptionId } = await getAzureContext(event, user.id, accountId);
		const providers = await listProviderStatuses(clients, namespaces);
		if (canCacheProviderStatuses(providers)) {
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
