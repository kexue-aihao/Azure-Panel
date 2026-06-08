import { isAdminUser, normalizeUserRole } from '$lib/server/admin';
import { serializeUserForClient } from '$lib/server/auth';
import {
	countActiveAdminUsers,
	deleteUserAndOwnedData,
	findNotificationSettingsByUser,
	findUserById,
	listAccountsByUser,
	listDnsBindingsByUser,
	listDnsConfigsByUser,
	listProxyProfilesByUser,
	listSubscriptionNotificationStatesByUser,
	listUnifiedExecutionLogs,
	listWorkflowsByUser,
	updateUserAdminFields
} from '$lib/server/db/repo';
import type {
	AzureAccount,
	DnsConfig,
	DnsRecordBinding,
	ProxyProfile,
	WorkflowPolicy
} from '$lib/server/db/schema';
import { fail, ok, requireAdmin } from '$lib/server/http';
import { maskTelegramChatId, parseTelegramChatIds } from '$lib/server/telegram';
import type { RequestHandler } from './$types';

function isLastActiveAdmin(target: Awaited<ReturnType<typeof findUserById>>, activeAdminCount: number) {
	return Boolean(target && isAdminUser(target) && !target.disabled && activeAdminCount <= 1);
}

function hasConfiguredSecret(value: unknown) {
	return String(value ?? '').trim().length > 0;
}

function parseVmNames(value: string) {
	try {
		const parsed = JSON.parse(value || '[]');
		return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
	} catch {
		return [];
	}
}

function serializeProxy(profile: ProxyProfile) {
	return {
		id: profile.id,
		name: profile.name,
		type: profile.type,
		host: profile.host,
		port: profile.port,
		username_configured: hasConfiguredSecret(profile.usernameEncrypted),
		password_configured: hasConfiguredSecret(profile.passwordEncrypted),
		managed_core: profile.managedCore ?? '',
		share_link_configured: hasConfiguredSecret(profile.shareLinkEncrypted),
		created_at: profile.createdAt
	};
}

function serializeAccount(account: AzureAccount) {
	return {
		id: account.id,
		name: account.name,
		tenant_id: account.tenantId,
		client_id: account.clientId,
		client_secret_configured: hasConfiguredSecret(account.clientSecretEncrypted),
		subscription_id: account.subscriptionId,
		proxy_profile_id: account.proxyProfileId,
		proxy_url_configured: hasConfiguredSecret(account.proxyUrlEncrypted),
		vm_region_cache_configured: hasConfiguredSecret(account.vmRegionCache),
		vm_image_cache_configured: hasConfiguredSecret(account.vmImageCache),
		vm_provider_cache_configured: hasConfiguredSecret(account.vmProviderCache),
		subscription_enabled_at: account.subscriptionEnabledAt,
		azure_registered_at: account.azureRegisteredAt,
		remark: account.remark ?? '',
		created_at: account.createdAt
	};
}

function serializeDnsConfig(config: DnsConfig) {
	return {
		id: config.id,
		name: config.name,
		base_url: config.baseUrl,
		uid: config.uid,
		api_key_configured: hasConfiguredSecret(config.apiKeyEncrypted),
		username_configured: hasConfiguredSecret(config.usernameEncrypted),
		password_configured: hasConfiguredSecret(config.passwordEncrypted),
		enabled: Boolean(config.enabled),
		created_at: config.createdAt
	};
}

function serializeDnsBinding(binding: DnsRecordBinding) {
	return {
		id: binding.id,
		config_id: binding.configId,
		name: binding.name,
		domain_id: binding.domainId,
		domain_name: binding.domainName,
		subdomain: binding.subdomain,
		record_type: binding.recordType,
		line: binding.line,
		ttl: binding.ttl,
		weight: binding.weight,
		mx: binding.mx,
		remark: binding.remark ?? '',
		enabled: Boolean(binding.enabled),
		last_a_record_id: binding.lastARecordId ?? '',
		last_aaaa_record_id: binding.lastAAAARecordId ?? '',
		last_ipv4: binding.lastIpv4 ?? '',
		last_ipv6: binding.lastIpv6 ?? '',
		last_synced_at: binding.lastSyncedAt,
		created_at: binding.createdAt
	};
}

function serializeWorkflow(policy: WorkflowPolicy) {
	return {
		id: policy.id,
		account_id: policy.accountId,
		name: policy.name,
		enabled: Boolean(policy.enabled),
		resource_group: policy.resourceGroup,
		location: policy.location,
		vm_names: parseVmNames(policy.vmNamesJson),
		min_running_count: policy.minRunningCount,
		replenish_target_count: policy.replenishTargetCount,
		auto_start: Boolean(policy.autoStart),
		auto_create: Boolean(policy.autoCreate),
		vm_size: policy.vmSize,
		image_reference: policy.imageReference,
		name_prefix: policy.namePrefix,
		admin_username: policy.adminUsername,
		admin_password_configured: hasConfiguredSecret(policy.adminPasswordEncrypted),
		userdata_configured: hasConfiguredSecret(policy.userdataEncrypted),
		enable_ipv6: Boolean(policy.enableIpv6),
		enable_accelerated_networking: Boolean(policy.enableAcceleratedNetworking),
		enable_ddos_protection: Boolean(policy.enableDdosProtection),
		ip_prefix: policy.ipPrefix,
		ip_brush_max_attempts: policy.ipBrushMaxAttempts,
		check_interval_seconds: policy.checkIntervalSeconds,
		status_check_enabled: Boolean(policy.statusCheckEnabled),
		status_trigger_states: policy.statusTriggerStates,
		replenishment_account_order: policy.replenishmentAccountOrder,
		dns_binding_id: policy.dnsBindingId,
		last_account_status: policy.lastAccountStatus,
		last_status_checked_at: policy.lastStatusCheckedAt,
		replenishment_failure_count: policy.replenishmentFailureCount,
		replenishment_cooldown_until: policy.replenishmentCooldownUntil,
		replenishment_pending_resource_group: policy.replenishmentPendingResourceGroup,
		replenishment_pending_account_id: policy.replenishmentPendingAccountId,
		last_replenishment_error: policy.lastReplenishmentError,
		replenishment_in_progress: Boolean(policy.replenishmentInProgress),
		replenishment_started_at: policy.replenishmentStartedAt,
		last_run_at: policy.lastRunAt,
		created_at: policy.createdAt
	};
}

export const GET: RequestHandler = async (event) => {
	await requireAdmin(event);
	const targetId = Number(event.params.id);
	if (!Number.isInteger(targetId) || targetId <= 0) return fail('用户 ID 无效', 400);

	const target = await findUserById(targetId);
	if (!target) return fail('用户不存在', 404);
	if (isAdminUser(target)) return fail('只能查看非管理员用户详情', 403);

	const [
		accounts,
		proxies,
		dnsConfigs,
		dnsBindings,
		workflows,
		notificationSettings,
		subscriptionStates,
		recentLogs
	] = await Promise.all([
		listAccountsByUser(target.id),
		listProxyProfilesByUser(target.id),
		listDnsConfigsByUser(target.id),
		listDnsBindingsByUser(target.id),
		listWorkflowsByUser(target.id),
		findNotificationSettingsByUser(target.id),
		listSubscriptionNotificationStatesByUser(target.id),
		listUnifiedExecutionLogs(target.id, undefined, 50)
	]);

	return ok({
		user: {
			id: target.id,
			email: target.email,
			role: target.role,
			disabled: Boolean(target.disabled),
			totp_enabled: Boolean(target.totpEnabled),
			created_at: target.createdAt
		},
		summary: {
			account_count: accounts.length,
			proxy_count: proxies.length,
			dns_config_count: dnsConfigs.length,
			dns_binding_count: dnsBindings.length,
			workflow_count: workflows.length,
			recent_log_count: recentLogs.length
		},
		accounts: accounts.map(serializeAccount),
		proxies: proxies.map(serializeProxy),
		dns_configs: dnsConfigs.map(serializeDnsConfig),
		dns_bindings: dnsBindings.map(serializeDnsBinding),
		workflows: workflows.map(serializeWorkflow),
		notification_settings: notificationSettings
			? {
					enabled: Boolean(notificationSettings.enabled),
					telegram_chat_id_masked: maskTelegramChatId(notificationSettings.telegramChatId),
					telegram_group_chat_id_masked_list: parseTelegramChatIds(
						notificationSettings.telegramGroupChatIds
					).map(maskTelegramChatId),
					bot_token_configured: hasConfiguredSecret(notificationSettings.telegramBotTokenEncrypted),
					subscription_check_interval_hours: notificationSettings.subscriptionCheckIntervalHours,
					last_subscription_checked_at: notificationSettings.lastSubscriptionCheckedAt,
					created_at: notificationSettings.createdAt
				}
			: null,
		subscription_states: subscriptionStates.map((state) => ({
			id: state.id,
			account_id: state.accountId,
			subscription_id: state.subscriptionId,
			display_name: state.displayName,
			last_state: state.lastState,
			last_notified_state: state.lastNotifiedState,
			last_checked_at: state.lastCheckedAt,
			last_notified_at: state.lastNotifiedAt,
			created_at: state.createdAt
		})),
		recent_logs: recentLogs.map((log) => ({
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
	});
};

export const PUT: RequestHandler = async (event) => {
	const admin = await requireAdmin(event);
	const targetId = Number(event.params.id);
	if (!Number.isInteger(targetId) || targetId <= 0) return fail('用户 ID 无效', 400);

	const target = await findUserById(targetId);
	if (!target) return fail('用户不存在', 404);

	const body = (await event.request.json().catch(() => ({}))) as {
		role?: unknown;
		disabled?: unknown;
	};
	const updates: { role?: string; disabled?: boolean } = {};

	if (body.role !== undefined) {
		const role = String(body.role).trim().toLowerCase();
		if (role !== 'admin' && role !== 'user') return fail('用户角色无效', 400);
		updates.role = normalizeUserRole(role);
	}
	if (body.disabled !== undefined) {
		updates.disabled = Boolean(body.disabled);
	}
	if (Object.keys(updates).length === 0) return fail('没有需要更新的字段', 400);

	if (target.id === admin.id) {
		if (updates.disabled === true) return fail('不能禁用当前登录的管理员账号', 400);
		if (updates.role && updates.role !== 'admin') return fail('不能降级当前登录的管理员账号', 400);
	}

	const activeAdminCount = await countActiveAdminUsers();
	if (isLastActiveAdmin(target, activeAdminCount)) {
		if (updates.disabled === true || updates.role === 'user') {
			return fail('至少需要保留一个可用管理员账号', 400);
		}
	}

	const updated = await updateUserAdminFields(target.id, updates);
	if (!updated) return fail('用户不存在', 404);
	return ok(serializeUserForClient(updated));
};

export const DELETE: RequestHandler = async (event) => {
	const admin = await requireAdmin(event);
	const targetId = Number(event.params.id);
	if (!Number.isInteger(targetId) || targetId <= 0) return fail('用户 ID 无效', 400);

	const target = await findUserById(targetId);
	if (!target) return fail('用户不存在', 404);
	if (target.id === admin.id) return fail('不能删除当前登录的管理员账号', 400);

	const activeAdminCount = await countActiveAdminUsers();
	if (isLastActiveAdmin(target, activeAdminCount)) {
		return fail('至少需要保留一个可用管理员账号', 400);
	}

	await deleteUserAndOwnedData(target.id);
	return ok({ message: '用户已删除' });
};
