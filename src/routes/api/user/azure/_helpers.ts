import { getUserAccountWithProxy } from '$lib/server/accounts';
import { createAzureClientsForSubscription } from '$lib/server/azure';
import { getRequestClientIp } from '$lib/server/http';
import type { RequestEvent } from '@sveltejs/kit';

export async function getAzureContext(
	event: RequestEvent,
	userId: number,
	rawAccountId: unknown,
	rawSubscriptionId?: unknown
) {
	const accountId = Number(rawAccountId);
	if (!accountId) throw new Error('缺少 account_id');

	const { account, proxy } = await getUserAccountWithProxy(userId, accountId, {
		clientIp: getRequestClientIp(event)
	});
	const requestedSubscription = String(
		rawSubscriptionId ?? event.url.searchParams.get('subscription_id') ?? ''
	).trim();
	const subscriptionId = requestedSubscription || account.subscriptionId;
	const selectedAccount = { ...account, subscriptionId };
	return {
		account: selectedAccount,
		proxy,
		clients: createAzureClientsForSubscription(selectedAccount, subscriptionId, proxy),
		subscriptionId
	};
}
