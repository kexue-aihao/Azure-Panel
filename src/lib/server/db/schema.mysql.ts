import {
	boolean,
	int,
	mysqlTable,
	text,
	timestamp,
	varchar
} from 'drizzle-orm/mysql-core';

export const users = mysqlTable('users', {
	id: int('id').primaryKey().autoincrement(),
	email: varchar('email', { length: 255 }).notNull().unique(),
	passwordHash: varchar('password_hash', { length: 255 }).notNull(),
	role: varchar('role', { length: 16 }).notNull().default('user'),
	disabled: boolean('disabled').notNull().default(false),
	totpEnabled: boolean('totp_enabled').notNull().default(false),
	totpSecretEncrypted: text('totp_secret_encrypted').notNull().default(''),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const proxyProfiles = mysqlTable('proxy_profiles', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	name: varchar('name', { length: 120 }).notNull(),
	type: varchar('type', { length: 16 }).notNull(),
	host: varchar('host', { length: 255 }).notNull(),
	port: int('port').notNull(),
	usernameEncrypted: text('username_encrypted').default(''),
	passwordEncrypted: text('password_encrypted').default(''),
	managedCore: varchar('managed_core', { length: 16 }).default(''),
	shareLinkEncrypted: text('share_link_encrypted').default(''),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const azureAccounts = mysqlTable('azure_accounts', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	name: varchar('name', { length: 120 }).notNull(),
	tenantId: varchar('tenant_id', { length: 64 }).notNull(),
	clientId: varchar('client_id', { length: 64 }).notNull(),
	clientSecretEncrypted: text('client_secret_encrypted').notNull(),
	subscriptionId: varchar('subscription_id', { length: 64 }).notNull(),
	proxyProfileId: int('proxy_profile_id'),
	proxyUrlEncrypted: text('proxy_url_encrypted').default(''),
	vmRegionCache: text('vm_region_cache').default(''),
	vmImageCache: text('vm_image_cache').default(''),
	vmProviderCache: text('vm_provider_cache').default(''),
	subscriptionEnabledAt: timestamp('subscription_enabled_at'),
	azureRegisteredAt: timestamp('azure_registered_at'),
	remark: varchar('remark', { length: 255 }).default(''),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const dnsConfigs = mysqlTable('dns_configs', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	name: varchar('name', { length: 120 }).notNull(),
	baseUrl: varchar('base_url', { length: 255 }).notNull(),
	uid: int('uid').notNull(),
	apiKeyEncrypted: text('api_key_encrypted').notNull(),
	usernameEncrypted: text('username_encrypted').default(''),
	passwordEncrypted: text('password_encrypted').default(''),
	enabled: boolean('enabled').notNull().default(true),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const dnsRecordBindings = mysqlTable('dns_record_bindings', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	configId: int('config_id').notNull(),
	name: varchar('name', { length: 120 }).notNull(),
	domainId: int('domain_id').notNull(),
	domainName: varchar('domain_name', { length: 255 }).notNull(),
	subdomain: varchar('subdomain', { length: 255 }).notNull().default('@'),
	recordType: varchar('record_type', { length: 16 }).notNull().default('A'),
	line: varchar('line', { length: 120 }).notNull().default('default'),
	ttl: int('ttl').notNull().default(60),
	weight: int('weight'),
	mx: int('mx'),
	remark: varchar('remark', { length: 255 }).default(''),
	enabled: boolean('enabled').notNull().default(true),
	lastARecordId: varchar('last_a_record_id', { length: 128 }).default(''),
	lastAAAARecordId: varchar('last_aaaa_record_id', { length: 128 }).default(''),
	lastIpv4: varchar('last_ipv4', { length: 64 }).default(''),
	lastIpv6: varchar('last_ipv6', { length: 128 }).default(''),
	lastSyncedAt: timestamp('last_synced_at'),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const notificationSettings = mysqlTable('notification_settings', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	telegramBotTokenEncrypted: text('telegram_bot_token_encrypted').notNull(),
	telegramChatId: varchar('telegram_chat_id', { length: 64 }).notNull().default(''),
	telegramGroupChatIds: text('telegram_group_chat_ids').notNull(),
	enabled: boolean('enabled').notNull().default(false),
	subscriptionCheckIntervalHours: int('subscription_check_interval_hours').notNull().default(6),
	lastSubscriptionCheckedAt: timestamp('last_subscription_checked_at'),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const subscriptionNotificationStates = mysqlTable('subscription_notification_states', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	accountId: int('account_id').notNull(),
	subscriptionId: varchar('subscription_id', { length: 64 }).notNull().default(''),
	displayName: varchar('display_name', { length: 255 }).notNull().default(''),
	lastState: varchar('last_state', { length: 64 }).notNull().default(''),
	lastNotifiedState: varchar('last_notified_state', { length: 64 }).notNull().default(''),
	lastCheckedAt: timestamp('last_checked_at'),
	lastNotifiedAt: timestamp('last_notified_at'),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const workflowPolicies = mysqlTable('workflow_policies', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	accountId: int('account_id').notNull(),
	name: varchar('name', { length: 120 }).notNull(),
	enabled: boolean('enabled').notNull().default(true),
	resourceGroup: varchar('resource_group', { length: 90 }).notNull(),
	location: varchar('location', { length: 64 }).notNull().default('eastus'),
	vmNamesJson: text('vm_names_json').notNull(),
	minRunningCount: int('min_running_count').notNull().default(1),
	replenishTargetCount: int('replenish_target_count').notNull().default(1),
	autoStart: boolean('auto_start').notNull().default(true),
	autoCreate: boolean('auto_create').notNull().default(true),
	vmSize: varchar('vm_size', { length: 64 }).notNull().default('Standard_B1s'),
	imageReference: varchar('image_reference', { length: 255 })
		.notNull()
		.default('Canonical:ubuntu-24_04-lts:server:latest'),
	namePrefix: varchar('name_prefix', { length: 32 }).notNull().default('auto-vm'),
	adminUsername: varchar('admin_username', { length: 32 }).notNull().default('azureuser'),
	adminPasswordEncrypted: text('admin_password_encrypted').notNull(),
	userdataEncrypted: text('userdata_encrypted').notNull().default(''),
	enableIpv6: boolean('enable_ipv6').notNull().default(false),
	ipPrefix: varchar('ip_prefix', { length: 32 }).notNull().default('85.211'),
	ipBrushMaxAttempts: int('ip_brush_max_attempts').notNull().default(30),
	checkIntervalSeconds: int('check_interval_seconds').notNull().default(60),
	statusCheckEnabled: boolean('status_check_enabled').notNull().default(true),
	statusTriggerStates: varchar('status_trigger_states', { length: 120 })
		.notNull()
		.default('banned,warning,warned,disabled'),
	replenishmentAccountOrder: varchar('replenishment_account_order', { length: 32 })
		.notNull()
		.default('pool_added_at'),
	dnsBindingId: int('dns_binding_id').notNull().default(0),
	lastAccountStatus: varchar('last_account_status', { length: 64 }).notNull().default(''),
	lastStatusCheckedAt: timestamp('last_status_checked_at'),
	replenishmentFailureCount: int('replenishment_failure_count').notNull().default(0),
	replenishmentCooldownUntil: timestamp('replenishment_cooldown_until'),
	replenishmentPendingResourceGroup: varchar('replenishment_pending_resource_group', {
		length: 90
	}).notNull().default(''),
	replenishmentPendingAccountId: int('replenishment_pending_account_id').notNull().default(0),
	lastReplenishmentError: varchar('last_replenishment_error', { length: 1024 }).notNull().default(''),
	replenishmentInProgress: boolean('replenishment_in_progress').notNull().default(false),
	replenishmentStartedAt: timestamp('replenishment_started_at'),
	replenishmentLockToken: varchar('replenishment_lock_token', { length: 64 }).notNull().default(''),
	lastRunAt: timestamp('last_run_at'),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const workflowLogs = mysqlTable('workflow_logs', {
	id: int('id').primaryKey().autoincrement(),
	policyId: int('policy_id').notNull(),
	action: varchar('action', { length: 64 }).notNull(),
	status: varchar('status', { length: 32 }).notNull(),
	message: text('message').notNull(),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export const executionLogs = mysqlTable('execution_logs', {
	id: int('id').primaryKey().autoincrement(),
	userId: int('user_id').notNull(),
	accountId: int('account_id'),
	source: varchar('source', { length: 32 }).notNull().default('manual'),
	action: varchar('action', { length: 64 }).notNull(),
	status: varchar('status', { length: 32 }).notNull(),
	message: text('message').notNull(),
	resourceGroup: varchar('resource_group', { length: 90 }).default(''),
	vmName: varchar('vm_name', { length: 64 }).default(''),
	createdAt: timestamp('created_at').notNull().defaultNow()
});

export type User = typeof users.$inferSelect;
export type ProxyProfile = typeof proxyProfiles.$inferSelect;
export type AzureAccount = typeof azureAccounts.$inferSelect;
export type DnsConfig = typeof dnsConfigs.$inferSelect;
export type DnsRecordBinding = typeof dnsRecordBindings.$inferSelect;
export type NotificationSettings = typeof notificationSettings.$inferSelect;
export type SubscriptionNotificationState = typeof subscriptionNotificationStates.$inferSelect;
export type WorkflowPolicy = typeof workflowPolicies.$inferSelect;
export type WorkflowLog = typeof workflowLogs.$inferSelect;
export type ExecutionLog = typeof executionLogs.$inferSelect;
