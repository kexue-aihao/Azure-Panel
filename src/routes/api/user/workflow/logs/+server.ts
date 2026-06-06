import { listUnifiedExecutionLogs } from '$lib/server/db/repo';
import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const policyId = event.url.searchParams.get('policy_id');
	const logs = await listUnifiedExecutionLogs(user.id, policyId ? Number(policyId) : undefined);
	return ok(
		logs.map((log) => ({
			id: log.id,
			source: log.source,
			policy_id: log.policyId,
			account_id: log.accountId,
			action: log.action,
			status: log.status,
			message: log.message,
			resource_group: log.resourceGroup,
			vm_name: log.vmName,
			created_at: log.createdAt
		}))
	);
};
