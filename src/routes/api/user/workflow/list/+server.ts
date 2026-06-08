import { listWorkflowsByUser } from '$lib/server/db/repo';
import { ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const rows = await listWorkflowsByUser(user.id);
	return ok(
		rows.map((p) => ({
			id: p.id,
			account_id: p.accountId,
			name: p.name,
			enabled: p.enabled,
			resource_group: p.resourceGroup,
			location: p.location,
			vm_names: JSON.parse(p.vmNamesJson || '[]'),
			min_running_count: p.minRunningCount,
			replenish_target_count: p.replenishTargetCount,
			auto_start: p.autoStart,
			auto_create: true,
			vm_size: p.vmSize,
			image_reference: p.imageReference,
			name_prefix: p.namePrefix,
			admin_username: p.adminUsername,
			userdata_configured: Boolean(p.userdataEncrypted),
			enable_ipv6: p.enableIpv6,
			enable_accelerated_networking: p.enableAcceleratedNetworking,
			enable_ddos_protection: p.enableDdosProtection,
			ip_prefix: p.ipPrefix,
			ip_brush_max_attempts: p.ipBrushMaxAttempts,
			check_interval_seconds: p.checkIntervalSeconds,
			status_check_enabled: p.statusCheckEnabled,
			status_trigger_states: p.statusTriggerStates,
			replenishment_account_order: p.replenishmentAccountOrder,
			dns_binding_id: p.dnsBindingId,
			last_account_status: p.lastAccountStatus,
			last_status_checked_at: p.lastStatusCheckedAt,
			last_run_at: p.lastRunAt,
			created_at: p.createdAt
		}))
	);
};
