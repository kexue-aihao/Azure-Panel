import { getUserAccount } from '$lib/server/accounts';
import { encryptSecret } from '$lib/server/crypto';
import { DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES } from '$lib/server/azure';
import { deleteWorkflow, findWorkflowByUser, updateWorkflow } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const policyId = Number(event.params.id);
	const policy = await findWorkflowByUser(user.id, policyId);
	if (!policy) return fail('工作流不存在', 404);

	const body = await event.request.json();
	const updates: Record<string, unknown> = {};

	if (body.account_id !== undefined) {
		const accountId = Number(body.account_id);
		if (!accountId) return fail('请从 Azure 号池选择触发检测账号');
		await getUserAccount(user.id, accountId);
		updates.accountId = accountId;
	}
	if (body.name !== undefined) updates.name = String(body.name);
	if (body.resource_group !== undefined) updates.resourceGroup = String(body.resource_group);
	if (body.location !== undefined) updates.location = String(body.location);
	if (body.vm_names !== undefined) updates.vmNamesJson = JSON.stringify(body.vm_names);
	if (body.min_running_count !== undefined)
		updates.minRunningCount = Math.max(0, Number(body.min_running_count) || 0);
	if (body.replenish_target_count !== undefined)
		updates.replenishTargetCount = Math.max(1, Number(body.replenish_target_count) || 1);
	if (body.auto_start !== undefined) updates.autoStart = Boolean(body.auto_start);
	updates.autoCreate = true;
	if (body.vm_size !== undefined) updates.vmSize = String(body.vm_size);
	if (body.image_reference !== undefined) updates.imageReference = String(body.image_reference);
	if (body.name_prefix !== undefined) updates.namePrefix = String(body.name_prefix);
	if (body.admin_username !== undefined) updates.adminUsername = String(body.admin_username);
	if (body.userdata !== undefined) updates.userdataEncrypted = encryptSecret(String(body.userdata));
	if (body.enable_ipv6 !== undefined) updates.enableIpv6 = Boolean(body.enable_ipv6);
	if (body.ip_prefix !== undefined) updates.ipPrefix = String(body.ip_prefix);
	if (body.ip_brush_max_attempts !== undefined)
		updates.ipBrushMaxAttempts = Number(body.ip_brush_max_attempts);
	if (body.check_interval_seconds !== undefined) updates.checkIntervalSeconds = 60;
	if (body.status_check_enabled !== undefined)
		updates.statusCheckEnabled = Boolean(body.status_check_enabled);
	if (body.status_trigger_states !== undefined)
		updates.statusTriggerStates = DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES;
	if (body.dns_binding_id !== undefined) updates.dnsBindingId = Number(body.dns_binding_id) || 0;
	if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled);
	if (body.admin_password) updates.adminPasswordEncrypted = encryptSecret(String(body.admin_password));

	const updated = await updateWorkflow(policyId, updates);
	return ok({
		id: updated?.id,
		account_id: updated?.accountId,
		name: updated?.name,
		enabled: updated?.enabled,
		resource_group: updated?.resourceGroup,
		location: updated?.location,
		vm_names: JSON.parse(updated?.vmNamesJson || '[]'),
		min_running_count: updated?.minRunningCount,
		replenish_target_count: updated?.replenishTargetCount,
		auto_start: updated?.autoStart,
		auto_create: true,
		vm_size: updated?.vmSize,
		image_reference: updated?.imageReference,
		name_prefix: updated?.namePrefix,
		admin_username: updated?.adminUsername,
		userdata_configured: Boolean(updated?.userdataEncrypted),
		enable_ipv6: updated?.enableIpv6,
		ip_prefix: updated?.ipPrefix,
		ip_brush_max_attempts: updated?.ipBrushMaxAttempts,
		check_interval_seconds: updated?.checkIntervalSeconds,
		status_check_enabled: updated?.statusCheckEnabled,
		status_trigger_states: updated?.statusTriggerStates,
		dns_binding_id: updated?.dnsBindingId,
		last_account_status: updated?.lastAccountStatus,
		last_status_checked_at: updated?.lastStatusCheckedAt,
		last_run_at: updated?.lastRunAt,
		created_at: updated?.createdAt
	});
};

export const DELETE: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const policyId = Number(event.params.id);
	const policy = await findWorkflowByUser(user.id, policyId);
	if (!policy) return fail('工作流不存在', 404);
	await deleteWorkflow(policyId);
	return ok({ message: '已删除' });
};
