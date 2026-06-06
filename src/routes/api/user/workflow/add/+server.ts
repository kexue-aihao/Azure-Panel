import { getUserAccount } from '$lib/server/accounts';
import { DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES } from '$lib/server/azure';
import { encryptSecret } from '$lib/server/crypto';
import { insertWorkflow } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	if (!accountId) return fail('请从 Azure 号池选择触发检测账号');
	await getUserAccount(user.id, accountId);
	const checkIntervalSeconds = Number(body.check_interval_seconds);
	const minRunningCount = Math.max(0, Number(body.min_running_count ?? 1) || 0);
	const replenishTargetCount = Math.max(
		1,
		Number(body.replenish_target_count ?? body.min_running_count ?? 1) || 1
	);

	const policy = await insertWorkflow({
		userId: user.id,
		accountId,
		name: String(body.name ?? '默认策略'),
		enabled: body.enabled !== false,
		resourceGroup: String(body.resource_group ?? ''),
		location: String(body.location ?? 'eastus'),
		vmNamesJson: JSON.stringify(body.vm_names ?? []),
		minRunningCount,
		replenishTargetCount,
		autoStart: body.auto_start !== false,
		autoCreate: Boolean(body.auto_create),
		vmSize: String(body.vm_size ?? 'Standard_B1s'),
		imageReference: String(body.image_reference ?? 'Canonical:ubuntu-24_04-lts:server:latest'),
		namePrefix: String(body.name_prefix ?? 'auto-vm'),
		adminUsername: String(body.admin_username ?? 'azureuser'),
		adminPasswordEncrypted: encryptSecret(String(body.admin_password ?? '')),
		userdataEncrypted: encryptSecret(String(body.userdata ?? '')),
		enableIpv6: Boolean(body.enable_ipv6),
		ipPrefix: String(body.ip_prefix ?? ''),
		ipBrushMaxAttempts: Number(body.ip_brush_max_attempts ?? 30),
		checkIntervalSeconds:
			Number.isFinite(checkIntervalSeconds) && checkIntervalSeconds > 0 ? checkIntervalSeconds : 120,
		statusCheckEnabled: body.status_check_enabled !== false,
		statusTriggerStates: DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES,
		dnsBindingId: Number(body.dns_binding_id ?? 0) || 0
	});

	return ok({
		id: policy.id,
		account_id: policy.accountId,
		name: policy.name,
		enabled: policy.enabled,
		resource_group: policy.resourceGroup,
		location: policy.location,
		vm_names: JSON.parse(policy.vmNamesJson),
		min_running_count: policy.minRunningCount,
		replenish_target_count: policy.replenishTargetCount,
		auto_start: policy.autoStart,
		auto_create: policy.autoCreate,
		vm_size: policy.vmSize,
		image_reference: policy.imageReference,
		name_prefix: policy.namePrefix,
		admin_username: policy.adminUsername,
		userdata_configured: Boolean(policy.userdataEncrypted),
		enable_ipv6: policy.enableIpv6,
		ip_prefix: policy.ipPrefix,
		ip_brush_max_attempts: policy.ipBrushMaxAttempts,
		check_interval_seconds: policy.checkIntervalSeconds,
		status_check_enabled: policy.statusCheckEnabled,
		status_trigger_states: policy.statusTriggerStates,
		dns_binding_id: policy.dnsBindingId,
		last_account_status: policy.lastAccountStatus,
		last_status_checked_at: policy.lastStatusCheckedAt,
		last_run_at: policy.lastRunAt,
		created_at: policy.createdAt
	});
};
