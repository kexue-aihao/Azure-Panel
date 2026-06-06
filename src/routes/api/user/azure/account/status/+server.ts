import { getUserAccountWithProxy } from '$lib/server/accounts';
import {
	getAccountSubscriptionStatus,
	isAzureSubscriptionTriggerState
} from '$lib/server/azure';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = Number(event.url.searchParams.get('account_id'));
	const triggerStates = event.url.searchParams.get('trigger_states') ?? 'banned,warning,warned';
	if (!accountId) return fail('缺少 account_id');

	try {
		const { account, proxy } = await getUserAccountWithProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event)
		});
		const status = await getAccountSubscriptionStatus(account, proxy);

		return ok({
			account_id: account.id,
			subscription_id: status.subscriptionId,
			display_name: status.displayName,
			state: status.state,
			abnormal: status.abnormal,
			should_run_workflow: isAzureSubscriptionTriggerState(status.state, triggerStates),
			trigger_states: triggerStates,
			checked_at: new Date()
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
