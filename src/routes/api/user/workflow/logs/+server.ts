import { listWorkflowLogs } from '$lib/server/db/repo';
import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const policyId = event.url.searchParams.get('policy_id');
	const logs = await listWorkflowLogs(user.id, policyId ? Number(policyId) : undefined);
	return ok(
		logs.map((log) => ({
			id: log.id,
			policy_id: log.policyId,
			action: log.action,
			status: log.status,
			message: log.message,
			created_at: log.createdAt
		}))
	);
};
