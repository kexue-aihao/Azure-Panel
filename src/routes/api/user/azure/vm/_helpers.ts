import { getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { createAzureClientsForSubscription } from '$lib/server/azure';
import { getRequestClientIp } from '$lib/server/http';
import type { RequestEvent } from '@sveltejs/kit';

function firstSearchParam(event: RequestEvent, names: string[]) {
	for (const name of names) {
		const value = event.url.searchParams.get(name);
		if (value) return value.trim();
	}
	return '';
}

export async function getVmQueryContext(event: RequestEvent, userId: number) {
	const accountId = Number(firstSearchParam(event, ['account_id', 'account']));
	const location = firstSearchParam(event, ['location']);
	if (!accountId || !location) throw new Error('Missing account/account_id or location');

	const { account, proxy } = await getUserAccountWithSelectedProxy(userId, accountId, {
		clientIp: getRequestClientIp(event),
		proxyMode: event.url.searchParams.get('proxy_mode'),
		proxyProfileId: Number(event.url.searchParams.get('proxy_profile_id') ?? 0) || null
	});
	const subscriptionId =
		firstSearchParam(event, ['subscription_id', 'subscription']) || account.subscriptionId;
	return {
		account,
		proxy,
		location,
		subscriptionId,
		clients: createAzureClientsForSubscription(account, subscriptionId, proxy)
	};
}
