import { listUserAccounts } from '$lib/server/accounts';
import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accounts = await listUserAccounts(user);
	return ok(
		accounts.map((a) => ({
			id: a.id,
			name: a.name,
			tenant_id: a.tenantId,
			client_id: a.clientId,
			subscription_id: a.subscriptionId,
			remark: a.remark,
			created_at: a.createdAt
		}))
	);
};
