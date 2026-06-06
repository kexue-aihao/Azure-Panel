import { listAdminUsers } from '$lib/server/db/repo';
import { ok, requireAdmin } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	await requireAdmin(event);
	const users = await listAdminUsers();
	return ok(
		users.map((user) => ({
			id: user.id,
			email: user.email,
			role: user.role,
			disabled: user.disabled,
			created_at: user.createdAt,
			account_count: user.accountCount,
			proxy_count: user.proxyCount,
			dns_config_count: user.dnsConfigCount,
			dns_binding_count: user.dnsBindingCount,
			workflow_count: user.workflowCount,
			execution_log_count: user.executionLogCount
		}))
	);
};
