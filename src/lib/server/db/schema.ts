import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	email: text('email').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	role: text('role').notNull().default('user'),
	disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const proxyProfiles = sqliteTable('proxy_profiles', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	type: text('type').notNull(),
	host: text('host').notNull(),
	port: integer('port').notNull(),
	usernameEncrypted: text('username_encrypted').default(''),
	passwordEncrypted: text('password_encrypted').default(''),
	managedCore: text('managed_core').default(''),
	shareLinkEncrypted: text('share_link_encrypted').default(''),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const azureAccounts = sqliteTable('azure_accounts', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	tenantId: text('tenant_id').notNull(),
	clientId: text('client_id').notNull(),
	clientSecretEncrypted: text('client_secret_encrypted').notNull(),
	subscriptionId: text('subscription_id').notNull(),
	proxyProfileId: integer('proxy_profile_id').references(() => proxyProfiles.id, {
		onDelete: 'set null'
	}),
	proxyUrlEncrypted: text('proxy_url_encrypted').default(''),
	vmRegionCache: text('vm_region_cache').default(''),
	vmImageCache: text('vm_image_cache').default(''),
	vmProviderCache: text('vm_provider_cache').default(''),
	remark: text('remark').default(''),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const dnsConfigs = sqliteTable('dns_configs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	baseUrl: text('base_url').notNull(),
	uid: integer('uid').notNull(),
	apiKeyEncrypted: text('api_key_encrypted').notNull(),
	usernameEncrypted: text('username_encrypted').default(''),
	passwordEncrypted: text('password_encrypted').default(''),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const dnsRecordBindings = sqliteTable('dns_record_bindings', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	configId: integer('config_id')
		.notNull()
		.references(() => dnsConfigs.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	domainId: integer('domain_id').notNull(),
	domainName: text('domain_name').notNull(),
	subdomain: text('subdomain').notNull().default('@'),
	recordType: text('record_type').notNull().default('A'),
	line: text('line').notNull().default('default'),
	ttl: integer('ttl').notNull().default(60),
	weight: integer('weight'),
	mx: integer('mx'),
	remark: text('remark').default(''),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	lastARecordId: text('last_a_record_id').default(''),
	lastAAAARecordId: text('last_aaaa_record_id').default(''),
	lastIpv4: text('last_ipv4').default(''),
	lastIpv6: text('last_ipv6').default(''),
	lastSyncedAt: integer('last_synced_at', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const notificationSettings = sqliteTable('notification_settings', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	telegramBotTokenEncrypted: text('telegram_bot_token_encrypted').notNull().default(''),
	telegramChatId: text('telegram_chat_id').notNull().default(''),
	telegramGroupChatIds: text('telegram_group_chat_ids').notNull().default(''),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
	subscriptionCheckIntervalHours: integer('subscription_check_interval_hours')
		.notNull()
		.default(6),
	lastSubscriptionCheckedAt: integer('last_subscription_checked_at', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const subscriptionNotificationStates = sqliteTable('subscription_notification_states', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	accountId: integer('account_id')
		.notNull()
		.references(() => azureAccounts.id, { onDelete: 'cascade' }),
	subscriptionId: text('subscription_id').notNull().default(''),
	displayName: text('display_name').notNull().default(''),
	lastState: text('last_state').notNull().default(''),
	lastNotifiedState: text('last_notified_state').notNull().default(''),
	lastCheckedAt: integer('last_checked_at', { mode: 'timestamp' }),
	lastNotifiedAt: integer('last_notified_at', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const workflowPolicies = sqliteTable('workflow_policies', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	accountId: integer('account_id')
		.notNull()
		.references(() => azureAccounts.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	resourceGroup: text('resource_group').notNull(),
	location: text('location').notNull().default('eastus'),
	vmNamesJson: text('vm_names_json').notNull().default('[]'),
	minRunningCount: integer('min_running_count').notNull().default(1),
	replenishTargetCount: integer('replenish_target_count').notNull().default(1),
	autoStart: integer('auto_start', { mode: 'boolean' }).notNull().default(true),
	autoCreate: integer('auto_create', { mode: 'boolean' }).notNull().default(true),
	vmSize: text('vm_size').notNull().default('Standard_B1s'),
	imageReference: text('image_reference')
		.notNull()
		.default('Canonical:ubuntu-24_04-lts:server:latest'),
	namePrefix: text('name_prefix').notNull().default('auto-vm'),
	adminUsername: text('admin_username').notNull().default('azureuser'),
	adminPasswordEncrypted: text('admin_password_encrypted').notNull().default(''),
	userdataEncrypted: text('userdata_encrypted').notNull().default(''),
	enableIpv6: integer('enable_ipv6', { mode: 'boolean' }).notNull().default(false),
	ipPrefix: text('ip_prefix').notNull().default(''),
	ipBrushMaxAttempts: integer('ip_brush_max_attempts').notNull().default(30),
	checkIntervalSeconds: integer('check_interval_seconds').notNull().default(60),
	statusCheckEnabled: integer('status_check_enabled', { mode: 'boolean' }).notNull().default(true),
	statusTriggerStates: text('status_trigger_states').notNull().default('banned,warning,warned,disabled'),
	dnsBindingId: integer('dns_binding_id').notNull().default(0),
	lastAccountStatus: text('last_account_status').notNull().default(''),
	lastStatusCheckedAt: integer('last_status_checked_at', { mode: 'timestamp' }),
	lastRunAt: integer('last_run_at', { mode: 'timestamp' }),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const workflowLogs = sqliteTable('workflow_logs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	policyId: integer('policy_id')
		.notNull()
		.references(() => workflowPolicies.id, { onDelete: 'cascade' }),
	action: text('action').notNull(),
	status: text('status').notNull(),
	message: text('message').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const executionLogs = sqliteTable('execution_logs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	accountId: integer('account_id'),
	source: text('source').notNull().default('manual'),
	action: text('action').notNull(),
	status: text('status').notNull(),
	message: text('message').notNull(),
	resourceGroup: text('resource_group').default(''),
	vmName: text('vm_name').default(''),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
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
