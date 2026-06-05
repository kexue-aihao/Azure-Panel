import { getUserAccountWithProxy } from '$lib/server/accounts';
import { listAccountSubscriptions } from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = Number(event.url.searchParams.get('account_id'));
	if (!accountId) return fail('缺少 account_id');

	const { account, proxy } = await getUserAccountWithProxy(user.id, accountId, {
		clientIp: getRequestClientIp(event)
	});
	try {
		const subscriptions = await listAccountSubscriptions(account, proxy);
		return ok(
			subscriptions.map((subscription) => ({
				subscription_id: subscription.subscriptionId ?? '',
				display_name: subscription.displayName ?? '',
				state: subscription.state ?? '',
				is_default: subscription.subscriptionId === account.subscriptionId
			}))
		);
	} catch (err) {
		return fail(String(err), 500);
	}
};
