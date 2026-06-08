import { getUserAccount } from '$lib/server/accounts';
import { DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES } from '$lib/server/azure';
import { encryptSecret } from '$lib/server/crypto';
import { insertWorkflow } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

function normalizeAccountOrder(value: unknown) {
	const raw = String(value ?? '').trim();
	return ['pool_added_at', 'subscription_enabled_at', 'azure_registered_at'].includes(raw)
		? raw
		: 'pool_added_at';
}

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	if (!accountId) return fail('请从 Azure 号池选择触发检测账号');
	const dnsBindingId = Number(body.dns_binding_id ?? 0) || 0;
	if (!dnsBindingId) return fail('自动补机策略必须选择 DNS 解析绑定');
	await getUserAccount(user.id, accountId);
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
		autoCreate: true,
		vmSize: String(body.vm_size ?? 'Standard_B1s'),
		imageReference: String(body.image_reference ?? 'Canonical:ubuntu-24_04-lts:server:latest'),
		namePrefix: String(body.name_prefix ?? 'auto-vm'),
		adminUsername: String(body.admin_username ?? 'azureuser'),
		adminPasswordEncrypted: encryptSecret(String(body.admin_password ?? '')),
		userdataEncrypted: encryptSecret(String(body.userdata ?? '')),
		enableIpv6: Boolean(body.enable_ipv6),
		ipPrefix: String(body.ip_prefix ?? '85.211') || '85.211',
		ipBrushMaxAttempts: Number(body.ip_brush_max_attempts ?? 30) || 30,
		checkIntervalSeconds: 60,
		statusCheckEnabled: body.status_check_enabled !== false,
		statusTriggerStates: DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES,
		replenishmentAccountOrder: normalizeAccountOrder(body.replenishment_account_order),
		dnsBindingId
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
		auto_create: true,
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
		replenishment_account_order: policy.replenishmentAccountOrder,
		dns_binding_id: policy.dnsBindingId,
		last_account_status: policy.lastAccountStatus,
		last_status_checked_at: policy.lastStatusCheckedAt,
		last_run_at: policy.lastRunAt,
		created_at: policy.createdAt
	});
};
