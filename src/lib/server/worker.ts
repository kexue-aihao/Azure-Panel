import { decryptSecret } from './crypto';
import { getWorkerIntervalMs } from './env';
import {
	acquireWorkflowReplenishmentLock,
	deleteAccount,
	findAccountById,
	findDnsBindingByUser,
	findDnsConfigByUser,
	findNotificationSettingsByUser,
	findSubscriptionNotificationState,
	findWorkflowByUser,
	findProxyProfileByUser,
	insertWorkflowLog,
	listAccountsByUser,
	listEnabledWorkflows,
	listEnabledWorkflowsByUser,
	listEnabledNotificationSettings,
	listProxyProfilesByUser,
	updateWorkflow,
	updateDnsBindingSyncState,
	updateNotificationLastSubscriptionChecked,
	releaseWorkflowReplenishmentLock,
	upsertSubscriptionNotificationState,
	updateWorkflowLastRun,
	updateWorkflowStatusCheck
} from './db/repo';
import {
	DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES,
	createAzureClients,
	createVmSimple,
	deleteResourceGroupWithProgress,
	getAccountSubscriptionStatus,
	getPowerState,
	isAzureSubscriptionTriggerState,
	isRunning,
	powerVmWithProgress,
	randomAzureResourceName,
	type CreateVmProgressEvent,
	type CreateVmResult
} from './azure';
import type { AzureAccount, ProxyProfile, WorkflowPolicy } from './db/schema';
import { createRainbowDnsClient, syncDnsBindingToIp } from './dns';
import {
	maskProxy,
	proxyProfileToAzureReady,
	proxySource,
	validateProxyConnection,
	type ProxyRuntimeConfig
} from './proxy';
import {
	buildAbnormalAccountRemovedMessage,
	buildDnsSyncMessage,
	buildIpBrushMissMessage,
	buildReplenishmentMessage,
	buildSubscriptionAlertMessage,
	getTelegramCredentials,
	normalizeSubscriptionCheckIntervalHours,
	sendTelegramMessageToTargets
} from './telegram';
import { randomUUID } from 'node:crypto';

let timer: NodeJS.Timeout | null = null;
const activePolicies = new Set<number>();
const activeNotificationUsers = new Set<number>();
const SUBSCRIPTION_STATUS_TIMEOUT_MS = 30_000;
const MIN_POLICY_CHECK_INTERVAL_SECONDS = 10;
const DEFAULT_POLICY_CHECK_INTERVAL_SECONDS = 60;
const SUBSCRIPTION_STATUS_NOTIFY_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_REPLENISHMENT_IP_PREFIX = '85.211';
const DEFAULT_REPLENISHMENT_IP_BRUSH_ATTEMPTS = 30;
const REPLENISHMENT_ACCOUNT_ORDER_LABELS: Record<string, string> = {
	pool_added_at: '加入 Azure 号池时间',
	subscription_enabled_at: '账号订阅启用时间',
	azure_registered_at: 'Azure 账号注册时间'
};
const REPLENISHMENT_FAILURE_BASE_COOLDOWN_MS = 5 * 60 * 1000;
const REPLENISHMENT_FAILURE_MAX_COOLDOWN_MS = 60 * 60 * 1000;
const REPLENISHMENT_FLOW_LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const replenishmentFailureBackoff = new Map<
	number,
	{ attempts: number; until: number; message: string }
>();

type WorkerAccountRuntime = {
	account: AzureAccount;
	proxy: ProxyRuntimeConfig | null;
	proxyLabel: string;
	clients: ReturnType<typeof createAzureClients>;
};

type WorkerBootProxyRuntime = {
	name: string;
	proxy: ProxyRuntimeConfig;
};

type WorkerRuntimeOptions = {
	bootProxyPool?: WorkerBootProxyRuntime[];
	getBootProxyPool?: () => Promise<WorkerBootProxyRuntime[]>;
	fallbackToBootProxy?: boolean;
};

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

function isProxyOutboundFailure(message: string) {
	return /代理出站失败|代理握手失败|socket hang up|SocksClient|REQUEST_SEND_ERROR|ECONNRESET|ETIMEDOUT/i.test(
		message
	);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timerId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timerId = setTimeout(() => reject(new Error(message)), timeoutMs);
			})
		]);
	} finally {
		if (timerId) clearTimeout(timerId);
	}
}

async function getAccountSubscriptionStatusWithTimeout(
	account: AzureAccount,
	proxy: ProxyRuntimeConfig | null,
	label: string
) {
	return withTimeout(
		getAccountSubscriptionStatus(account, proxy),
		SUBSCRIPTION_STATUS_TIMEOUT_MS,
		`${label} 订阅状态查询超过 ${SUBSCRIPTION_STATUS_TIMEOUT_MS / 1000} 秒`
	);
}

function normalizedNotificationState(state?: string | null) {
	const normalized = String(state ?? '').trim().toLowerCase();
	return normalized === 'warned' ? 'warning' : normalized;
}

function dateTimeMs(value: Date | string | number | null | undefined) {
	if (!value) return 0;
	const date = value instanceof Date ? value : new Date(value);
	const time = date.getTime();
	return Number.isFinite(time) ? time : 0;
}

function shuffle<T>(items: T[]) {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

function shouldRunNotificationCheck(settings: {
	lastSubscriptionCheckedAt: Date | null;
	subscriptionCheckIntervalHours: number;
}) {
	if (!settings.lastSubscriptionCheckedAt) return true;
	const intervalHours = normalizeSubscriptionCheckIntervalHours(settings.subscriptionCheckIntervalHours);
	return Date.now() - settings.lastSubscriptionCheckedAt.getTime() >= intervalHours * 60 * 60 * 1000;
}

function parseVmNames(value: string) {
	try {
		const parsed = JSON.parse(value || '[]');
		return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
	} catch {
		return [];
	}
}

async function saveTrackedVmName(policy: WorkflowPolicy, vmName: string) {
	const names = parseVmNames(policy.vmNamesJson);
	if (!names.some((name) => name.toLowerCase() === vmName.toLowerCase())) {
		names.push(vmName);
		policy.vmNamesJson = JSON.stringify(names);
		await updateWorkflow(policy.id, { vmNamesJson: policy.vmNamesJson });
	}
}

function safeReplenishTargetCount(policy: WorkflowPolicy) {
	const count = Number(policy.replenishTargetCount ?? policy.minRunningCount ?? 1);
	return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
}

function safeCheckIntervalSeconds(policy: WorkflowPolicy) {
	const seconds = Number(policy.checkIntervalSeconds ?? DEFAULT_POLICY_CHECK_INTERVAL_SECONDS);
	if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_POLICY_CHECK_INTERVAL_SECONDS;
	return Math.max(MIN_POLICY_CHECK_INTERVAL_SECONDS, Math.floor(seconds));
}

function replenishmentIpPrefix(policy: WorkflowPolicy) {
	return String(policy.ipPrefix || DEFAULT_REPLENISHMENT_IP_PREFIX).trim() || DEFAULT_REPLENISHMENT_IP_PREFIX;
}

function replenishmentIpBrushMaxAttempts(policy: WorkflowPolicy) {
	const attempts = Number(policy.ipBrushMaxAttempts ?? DEFAULT_REPLENISHMENT_IP_BRUSH_ATTEMPTS);
	return Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : DEFAULT_REPLENISHMENT_IP_BRUSH_ATTEMPTS;
}

function normalizeReplenishmentAccountOrder(value?: string | null) {
	const normalized = String(value ?? '').trim().toLowerCase();
	return normalized === 'subscription_enabled_at' || normalized === 'azure_registered_at'
		? normalized
		: 'pool_added_at';
}

function orderTimestamp(account: AzureAccount, order: string) {
	const value =
		order === 'subscription_enabled_at'
			? account.subscriptionEnabledAt
			: order === 'azure_registered_at'
				? account.azureRegisteredAt
				: account.createdAt;
	const date = value instanceof Date ? value : value ? new Date(value) : account.createdAt;
	const time = date instanceof Date ? date.getTime() : Number(date);
	return Number.isFinite(time) && time > 0 ? time : account.createdAt.getTime();
}

function orderAccountsForReplenishment(accounts: AzureAccount[], orderValue?: string | null) {
	const order = normalizeReplenishmentAccountOrder(orderValue);
	return [...accounts].sort((a, b) => {
		const timeDiff = orderTimestamp(a, order) - orderTimestamp(b, order);
		return timeDiff !== 0 ? timeDiff : a.id - b.id;
	});
}

function shouldRunPolicyStatusCheck(policy: WorkflowPolicy, force: boolean) {
	if (force || !policy.lastStatusCheckedAt) return true;
	const intervalMs = safeCheckIntervalSeconds(policy) * 1000;
	return Date.now() - policy.lastStatusCheckedAt.getTime() >= intervalMs;
}

function replenishmentFlowStartedAtMs(policy: WorkflowPolicy) {
	const startedAt = policy.replenishmentStartedAt;
	if (!startedAt) return 0;
	if (startedAt instanceof Date) return startedAt.getTime();
	const value = Number(startedAt);
	return Number.isFinite(value) ? value : 0;
}

function activeReplenishmentFlowLock(policy: WorkflowPolicy) {
	if (!policy.replenishmentInProgress) return null;
	const startedAtMs = replenishmentFlowStartedAtMs(policy);
	if (!startedAtMs) return { stale: true, ageMs: REPLENISHMENT_FLOW_LOCK_TIMEOUT_MS };
	const ageMs = Date.now() - startedAtMs;
	return {
		stale: ageMs >= REPLENISHMENT_FLOW_LOCK_TIMEOUT_MS,
		ageMs
	};
}

async function clearStaleReplenishmentFlowLock(policy: WorkflowPolicy) {
	const released = await releaseWorkflowReplenishmentLock(policy.id, policy.replenishmentLockToken || '');
	if (released) {
		policy.replenishmentInProgress = false;
		policy.replenishmentStartedAt = null;
		policy.replenishmentLockToken = '';
	}
	return released;
}

async function acquireReplenishmentFlowLock(policy: WorkflowPolicy, reason: string) {
	const token = randomUUID();
	const staleBefore = new Date(Date.now() - REPLENISHMENT_FLOW_LOCK_TIMEOUT_MS);
	const acquired = await acquireWorkflowReplenishmentLock(policy.id, token, staleBefore);
	if (!acquired) {
		await insertWorkflowLog(
			policy.id,
			'auto_create',
			'skipped',
			'上一轮补机流程仍在执行，跳过本轮检测/触发，等待上一轮完成后再继续'
		);
		return null;
	}

	policy.replenishmentInProgress = true;
	policy.replenishmentStartedAt = new Date();
	policy.replenishmentLockToken = token;
	await insertWorkflowLog(
		policy.id,
		'auto_create',
		'running',
		`${reason}；已锁定本策略，上一轮补机流程完成前不会再次触发检测`
	);
	return token;
}

async function releaseReplenishmentFlowLock(policy: WorkflowPolicy, token: string) {
	const released = await releaseWorkflowReplenishmentLock(policy.id, token);
	if (!released) return;
	policy.replenishmentInProgress = false;
	policy.replenishmentStartedAt = null;
	policy.replenishmentLockToken = '';
}

function policyReplenishmentCooldown(policyId: number) {
	const state = replenishmentFailureBackoff.get(policyId);
	if (!state) return null;
	if (Date.now() >= state.until) {
		replenishmentFailureBackoff.delete(policyId);
		return null;
	}
	return state;
}

function persistedReplenishmentCooldown(policy: WorkflowPolicy) {
	const cooldownUntil = policy.replenishmentCooldownUntil;
	if (!cooldownUntil || Date.now() >= cooldownUntil.getTime()) return null;
	return {
		attempts: Math.max(1, Number(policy.replenishmentFailureCount ?? 1) || 1),
		until: cooldownUntil.getTime(),
		message: policy.lastReplenishmentError || '补机失败后等待清理/冷却',
		pendingResourceGroup: policy.replenishmentPendingResourceGroup || '',
		pendingAccountId: Number(policy.replenishmentPendingAccountId ?? 0) || 0
	};
}

function activeReplenishmentCooldown(policy: WorkflowPolicy) {
	const memory = policyReplenishmentCooldown(policy.id);
	const persisted = persistedReplenishmentCooldown(policy);
	if (!memory) return persisted;
	if (!persisted) return memory;
	return memory.until >= persisted.until ? memory : persisted;
}

function nextReplenishmentCooldownMs(attempts: number, minimumMs = 0) {
	const exponential = Math.min(
		REPLENISHMENT_FAILURE_BASE_COOLDOWN_MS * 2 ** (Math.max(1, attempts) - 1),
		REPLENISHMENT_FAILURE_MAX_COOLDOWN_MS
	);
	return Math.min(Math.max(exponential, minimumMs), REPLENISHMENT_FAILURE_MAX_COOLDOWN_MS);
}

async function recordReplenishmentFailure(
	policy: WorkflowPolicy,
	message: string,
	options: {
		resourceGroup?: string;
		accountId?: number;
		minCooldownMs?: number;
	} = {}
) {
	const previous = replenishmentFailureBackoff.get(policy.id);
	const persistedAttempts = Number(policy.replenishmentFailureCount ?? 0) || 0;
	const attempts = Math.min(Math.max(previous?.attempts ?? 0, persistedAttempts) + 1, 8);
	const cooldownMs = nextReplenishmentCooldownMs(attempts, options.minCooldownMs ?? 0);
	const until = Date.now() + cooldownMs;
	replenishmentFailureBackoff.set(policy.id, { attempts, until, message });
	const cooldownUntil = new Date(until);
	const pendingAccountId = Number(options.accountId ?? policy.replenishmentPendingAccountId ?? 0) || 0;
	policy.replenishmentFailureCount = attempts;
	policy.replenishmentCooldownUntil = cooldownUntil;
	policy.replenishmentPendingResourceGroup = options.resourceGroup ?? policy.replenishmentPendingResourceGroup ?? '';
	policy.replenishmentPendingAccountId = pendingAccountId;
	policy.lastReplenishmentError = message.slice(0, 1024);
	await updateWorkflow(policy.id, {
		replenishmentFailureCount: attempts,
		replenishmentCooldownUntil: cooldownUntil,
		replenishmentPendingResourceGroup: policy.replenishmentPendingResourceGroup,
		replenishmentPendingAccountId: policy.replenishmentPendingAccountId,
		lastReplenishmentError: policy.lastReplenishmentError
	});
	return { attempts, until, cooldownMs };
}

async function clearReplenishmentFailure(policy: WorkflowPolicy) {
	replenishmentFailureBackoff.delete(policy.id);
	policy.replenishmentFailureCount = 0;
	policy.replenishmentCooldownUntil = null;
	policy.replenishmentPendingResourceGroup = '';
	policy.replenishmentPendingAccountId = 0;
	policy.lastReplenishmentError = '';
	await updateWorkflow(policy.id, {
		replenishmentFailureCount: 0,
		replenishmentCooldownUntil: null,
		replenishmentPendingResourceGroup: '',
		replenishmentPendingAccountId: 0,
		lastReplenishmentError: ''
	});
}

function hasReplenishmentFailureState(policy: WorkflowPolicy) {
	return Boolean(
		(policy.replenishmentFailureCount ?? 0) > 0 ||
			policy.replenishmentCooldownUntil ||
			policy.replenishmentPendingResourceGroup ||
			policy.lastReplenishmentError
	);
}

function policyResourcePrefix(policy: WorkflowPolicy) {
	const base = (policy.namePrefix || 'auto-vm').replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^-+|-+$/g, '');
	return `${base || 'auto-vm'}-w${policy.id}`.toLowerCase();
}

function isBootProxyProfile(profile: ProxyProfile) {
	if (proxySource(profile) === 'client_ip') return false;
	return ['http', 'https', 'socks4', 'socks4a', 'socks5'].includes(String(profile.type).toLowerCase());
}

async function collectBootProxyPool(policy: WorkflowPolicy): Promise<WorkerBootProxyRuntime[]> {
	const profiles = await listProxyProfilesByUser(policy.userId);
	const bootProfiles = shuffle(profiles.filter(isBootProxyProfile));
	const pool: WorkerBootProxyRuntime[] = [];

	for (const profile of bootProfiles) {
		try {
			const proxy = await proxyProfileToAzureReady(profile, {
				timeoutMs: 10_000,
				autoDetectHttpSocks: true,
				updateProfileType: true
			});
			pool.push({
				name: profile.name,
				proxy
			});
		} catch (err) {
			await insertWorkflowLog(
				policy.id,
				'proxy_pool',
				'failed',
				`补机代理 ${profile.name} 初始化失败: ${errorMessage(err)}`
			);
		}
	}

	if (pool.length > 0) {
		await insertWorkflowLog(
			policy.id,
			'proxy_pool',
			'success',
			`已加载 ${pool.length} 个 HTTP/SOCKS 补机开机代理，将随机使用`
		);
	} else {
		await insertWorkflowLog(
			policy.id,
			'proxy_pool',
			'skipped',
			'未找到可用的 HTTP/SOCKS 补机开机代理，将回退使用账号绑定代理或直连'
		);
	}

	return pool;
}

function bootProxyLabel(proxy: WorkerBootProxyRuntime | null) {
	return proxy ? `${proxy.name} (${maskProxy(proxy.proxy)})` : '';
}

async function pickValidatedBootProxy(
	policyId: number,
	pool: WorkerBootProxyRuntime[],
	reason: string
) {
	if (pool.length === 0) return null;

	for (const candidate of shuffle(pool)) {
		try {
			const proxy = await validateProxyConnection(candidate.proxy, { timeoutMs: 10_000 });
			await insertWorkflowLog(
				policyId,
				'proxy_pool',
				'success',
				`${reason} 已切换到可用随机代理: ${candidate.name} (${maskProxy(proxy)})`
			);
			return { ...candidate, proxy };
		} catch (err) {
			await insertWorkflowLog(
				policyId,
				'proxy_pool',
				'failed',
				`${reason} 随机代理 ${candidate.name} 测活失败，继续切换下一个: ${errorMessage(err)}`
			);
		}
	}

	await insertWorkflowLog(
		policyId,
		'proxy_pool',
		'warning',
		`${reason} 没有找到可用随机代理，将回退到账号默认出口或直连`
	);
	return null;
}

async function resolveWorkerProxyForAccount(
	policyId: number,
	account: AzureAccount,
	options: WorkerRuntimeOptions = {}
): Promise<{ proxy: ProxyRuntimeConfig | null; label: string }> {
	const proxyProfile = account.proxyProfileId
		? await findProxyProfileByUser(account.userId, account.proxyProfileId)
		: null;

	if (proxyProfile && proxySource(proxyProfile) === 'client_ip') {
		if (policyId > 0) {
			await insertWorkflowLog(
				policyId,
				'account_pool',
				'skipped',
				`账号 ${account.name} 使用当前访问 IP 代理，后台定时任务无法获取访问者 IP，改用补机代理池或直连`
			);
		}
	} else if (proxyProfile) {
		try {
			const proxy = await proxyProfileToAzureReady(proxyProfile, {
				timeoutMs: 10_000,
				autoDetectHttpSocks: true,
				updateProfileType: true
			});
			return {
				proxy,
				label: `账号绑定代理 ${proxyProfile.name} (${maskProxy(proxy)})`
			};
		} catch (err) {
			if (policyId > 0) {
				await insertWorkflowLog(
					policyId,
					'account_pool',
					'warning',
					`账号 ${account.name} 绑定代理 ${proxyProfile.name} 当前不可用，将尝试补机代理池备用出口: ${errorMessage(err)}`
				);
			}
		}
	}

	if (options.fallbackToBootProxy !== false) {
		const bootProxyPool =
			options.bootProxyPool ?? (options.getBootProxyPool ? await options.getBootProxyPool() : []);
		const bootProxy = await pickValidatedBootProxy(
			policyId,
			bootProxyPool,
			`账号 ${account.name} 备用出口`
		);
		if (bootProxy) {
			return {
				proxy: bootProxy.proxy,
				label: `补机代理池 ${bootProxyLabel(bootProxy)}`
			};
		}
	}

	return { proxy: null, label: '服务器源站 IP/直连' };
}

async function createRuntimeForAccount(
	policyId: number,
	account: AzureAccount,
	options: WorkerRuntimeOptions = {}
): Promise<WorkerAccountRuntime | null> {
	const { proxy: runtimeProxy, label } = await resolveWorkerProxyForAccount(policyId, account, options);
	if (policyId > 0) {
		await insertWorkflowLog(policyId, 'account_pool', 'success', `账号 ${account.name} 检测出口: ${label}`);
	}
	return {
		account,
		proxy: runtimeProxy,
		proxyLabel: label,
		clients: createAzureClients(account, runtimeProxy)
	};
}

async function pickReplenishmentRuntimeFromPool(options: {
	policy: WorkflowPolicy;
	accounts: AzureAccount[];
	excludedAccountIds: Set<number>;
	startIndex?: number;
	getBootProxyPool: () => Promise<WorkerBootProxyRuntime[]>;
}): Promise<{ runtime: WorkerAccountRuntime; selectedIndex: number } | null> {
	const order = normalizeReplenishmentAccountOrder(options.policy.replenishmentAccountOrder);
	const ordered = orderAccountsForReplenishment(
		options.accounts.filter((account) => !options.excludedAccountIds.has(account.id)),
		order
	);
	const offset = ordered.length > 0 ? Math.max(0, options.startIndex ?? 0) % ordered.length : 0;
	const candidates = [...ordered.slice(offset), ...ordered.slice(0, offset)];
	const missingOrderTime =
		order !== 'pool_added_at' &&
		candidates.some((account) =>
			order === 'subscription_enabled_at' ? !account.subscriptionEnabledAt : !account.azureRegisteredAt
		);
	await insertWorkflowLog(
		options.policy.id,
		'account_pool',
		candidates.length > 0 ? 'success' : 'warning',
		`本轮可按${REPLENISHMENT_ACCOUNT_ORDER_LABELS[order]}选择的候选补机账号 ${candidates.length} 个`
	);
	if (missingOrderTime) {
		await insertWorkflowLog(
			options.policy.id,
			'account_pool',
			'info',
			`部分账号未记录${REPLENISHMENT_ACCOUNT_ORDER_LABELS[order]}，这些账号已自动回退按加入 Azure 号池时间排序`
		);
	}

	for (const candidate of candidates) {
		try {
			const runtime = await createRuntimeForAccount(options.policy.id, candidate, {
				getBootProxyPool: options.getBootProxyPool
			});
			if (!runtime) continue;

			const status = await getAccountSubscriptionStatusWithTimeout(
				runtime.account,
				runtime.proxy,
				`候选补机账号 ${runtime.account.name}`
			);
			const abnormal = isAzureSubscriptionTriggerState(
				status.state,
				DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES
			);
			const usable = !status.abnormal && !abnormal;
			await insertWorkflowLog(
				options.policy.id,
				'account_pool',
				usable ? 'success' : 'warning',
				`${REPLENISHMENT_ACCOUNT_ORDER_LABELS[order]}候选补机账号 ${runtime.account.name} 订阅状态 ${status.state}${usable ? '，已选用' : '，跳过'}`
			);
			if (usable) {
				const selectedIndex = ordered.findIndex((account) => account.id === runtime.account.id);
				return { runtime, selectedIndex: selectedIndex >= 0 ? selectedIndex : offset };
			}
		} catch (err) {
			await insertWorkflowLog(
				options.policy.id,
				'account_pool',
				'failed',
				`顺序候选补机账号 ${candidate.name} 状态检测失败: ${errorMessage(err)}`
			);
		}
	}
	return null;
}

async function logCreateProgress(policyId: number, event: CreateVmProgressEvent) {
	const detailError =
		typeof event.detail?.error === 'string' && event.detail.error.trim()
			? `: ${event.detail.error.trim()}`
			: '';
	await insertWorkflowLog(policyId, `create:${event.step}`, event.status, `${event.message}${detailError}`);
}

async function notifyIpBrushMiss(policy: WorkflowPolicy, vmName: string, event: CreateVmProgressEvent) {
	if (event.step !== 'public-ipv4') return;
	if (event.detail?.brushRecordOnly !== true || event.detail?.matched !== false) return;
	const ipv4 = String(event.detail?.ip ?? '').trim();
	const targetPrefix = String(event.detail?.targetPrefix ?? replenishmentIpPrefix(policy)).trim();
	if (!ipv4 || !targetPrefix || ipv4.startsWith(targetPrefix)) return;

	try {
		const settings = await findNotificationSettingsByUser(policy.userId);
		const credentials = getTelegramCredentials(settings);
		if (!credentials) return;
		await sendTelegramMessageToTargets({
			token: credentials.token,
			chatIds: credentials.chatIds,
			text: buildIpBrushMissMessage({
				policyName: policy.name,
				vmName,
				ipv4,
				targetPrefix,
				attempt: Number(event.detail?.attempt ?? 0) || null,
				maxAttempts: Number(event.detail?.maxAttempts ?? 0) || null,
				kept: event.detail?.kept === true
			})
		});
		await insertWorkflowLog(
			policy.id,
			'telegram_notify',
			'success',
			`刷 IP 未命中通知已发送到 Telegram: ${ipv4} 未命中 ${targetPrefix}`
		);
	} catch (err) {
		await insertWorkflowLog(
			policy.id,
			'telegram_notify',
			'failed',
			`Telegram 刷 IP 未命中通知发送失败: ${errorMessage(err)}`
		);
	}
}

async function logReplenishmentCreateProgress(
	policy: WorkflowPolicy,
	vmName: string,
	event: CreateVmProgressEvent
) {
	await logCreateProgress(policy.id, event);
	await notifyIpBrushMiss(policy, vmName, event);
}

async function cleanupFailedReplenishmentResourceGroup(
	policyId: number,
	clients: ReturnType<typeof createAzureClients>,
	resourceGroup: string
) {
	await insertWorkflowLog(
		policyId,
		'cleanup_resource_group',
		'running',
		`补机失败，开始删除临时资源组 ${resourceGroup}`
	);
	await deleteResourceGroupWithProgress(clients, resourceGroup, async (event) => {
		await insertWorkflowLog(policyId, `cleanup:${event.step}`, event.status, event.message);
	});
	await insertWorkflowLog(
		policyId,
		'cleanup_resource_group',
		'success',
		`补机失败后的临时资源组已删除: ${resourceGroup}`
	);
}

async function cleanupReplenishmentResourceGroupWithFallback(options: {
	policy: WorkflowPolicy;
	account: AzureAccount;
	resourceGroup: string;
	getBootProxyPool: () => Promise<WorkerBootProxyRuntime[]>;
}) {
	try {
		const cleanupRuntime = await createRuntimeForAccount(options.policy.id, options.account, {
			getBootProxyPool: options.getBootProxyPool
		});
		if (!cleanupRuntime) throw new Error(`无法为账号 ${options.account.name} 创建 Azure 清理客户端`);
		await insertWorkflowLog(
			options.policy.id,
			'cleanup_resource_group',
			'running',
			`资源组清理出口: ${cleanupRuntime.proxyLabel}`
		);
		await cleanupFailedReplenishmentResourceGroup(
			options.policy.id,
			cleanupRuntime.clients,
			options.resourceGroup
		);
	} catch (firstErr) {
		const firstMessage = errorMessage(firstErr);
		await insertWorkflowLog(
			options.policy.id,
			'cleanup_resource_group',
			'warning',
			`代理出口清理资源组失败，尝试服务器直连清理: ${firstMessage}`
		);
		await cleanupFailedReplenishmentResourceGroup(
			options.policy.id,
			createAzureClients(options.account, null),
			options.resourceGroup
		).catch((directErr) => {
			throw new Error(`${firstMessage}；直连清理也失败: ${errorMessage(directErr)}`);
		});
	}
}

async function cleanupPendingReplenishmentResourceGroup(
	policy: WorkflowPolicy,
	accounts: AzureAccount[],
	getBootProxyPool: () => Promise<WorkerBootProxyRuntime[]>
) {
	const resourceGroup = policy.replenishmentPendingResourceGroup?.trim();
	if (!resourceGroup) return true;

	const account =
		accounts.find((item) => item.id === Number(policy.replenishmentPendingAccountId ?? 0)) ??
		accounts.find((item) => item.id === policy.accountId) ??
		accounts[0];
	if (!account) {
		const message = `上次补机失败留下待清理资源组 ${resourceGroup}，但当前号池为空，无法清理；暂停创建新资源组`;
		const cooldown = await recordReplenishmentFailure(policy, message, {
			resourceGroup,
			minCooldownMs: REPLENISHMENT_FAILURE_MAX_COOLDOWN_MS
		});
		await insertWorkflowLog(
			policy.id,
			'cleanup_resource_group',
			'failed',
			`${message}，约 ${Math.ceil(cooldown.cooldownMs / 1000)} 秒后重试`
		);
		return false;
	}

	await insertWorkflowLog(
		policy.id,
		'cleanup_resource_group',
		'running',
		`检测到上次补机失败遗留资源组 ${resourceGroup}，本轮先清理，清理完成前不会创建新的资源组`
	);
	try {
		await cleanupReplenishmentResourceGroupWithFallback({
			policy,
			account,
			resourceGroup,
			getBootProxyPool
		});
		await clearReplenishmentFailure(policy);
		return true;
	} catch (err) {
		const message = `遗留资源组 ${resourceGroup} 清理失败: ${errorMessage(err)}`;
		const cooldown = await recordReplenishmentFailure(policy, message, {
			resourceGroup,
			accountId: account.id,
			minCooldownMs: REPLENISHMENT_FAILURE_MAX_COOLDOWN_MS
		});
		await insertWorkflowLog(
			policy.id,
			'cleanup_resource_group',
			'failed',
			`${message}；已暂停创建新资源组，约 ${Math.ceil(cooldown.cooldownMs / 1000)} 秒后重试`
		);
		return false;
	}
}

async function notifyReplenishmentSuccess(options: {
	policy: WorkflowPolicy;
	account: AzureAccount;
	result: CreateVmResult;
	vmSize: string;
}) {
	try {
		const settings = await findNotificationSettingsByUser(options.policy.userId);
		const credentials = getTelegramCredentials(settings);
		if (!credentials) return;
		await sendTelegramMessageToTargets({
			token: credentials.token,
			chatIds: credentials.chatIds,
			text: buildReplenishmentMessage({
				policyName: options.policy.name,
				account: options.account,
				vmName: options.result.name,
				resourceGroup: options.result.resourceGroup,
				vmSize: options.vmSize,
				location: options.policy.location,
				publicIPv4: options.result.publicIPv4,
				publicIPv6: options.result.publicIPv6
			})
		});
		await insertWorkflowLog(options.policy.id, 'telegram_notify', 'success', '补机成功通知已发送到 Telegram');
	} catch (err) {
		await insertWorkflowLog(
			options.policy.id,
			'telegram_notify',
			'failed',
			`Telegram 补机通知发送失败: ${errorMessage(err)}`
		);
	}
}

async function syncWorkflowDns(options: {
	policy: WorkflowPolicy;
	result: CreateVmResult;
}): Promise<void> {
	if (!options.policy.dnsBindingId) {
		await insertWorkflowLog(options.policy.id, 'dns_sync', 'skipped', '未配置 DNS 绑定，跳过解析同步');
		return;
	}

	const binding = await findDnsBindingByUser(options.policy.userId, options.policy.dnsBindingId);
	if (!binding || !binding.enabled) {
		await insertWorkflowLog(options.policy.id, 'dns_sync', 'skipped', 'DNS 绑定不存在或已停用');
		return;
	}

	const config = await findDnsConfigByUser(options.policy.userId, binding.configId);
	if (!config || !config.enabled) {
		await insertWorkflowLog(options.policy.id, 'dns_sync', 'skipped', 'DNS 配置不存在或已停用');
		return;
	}

	try {
		const syncResult = await syncDnsBindingToIp(createRainbowDnsClient(config), binding, {
			ipv4: options.result.publicIPv4,
			ipv6: options.result.publicIPv6,
			vmName: options.result.name,
			resourceGroup: options.result.resourceGroup
		});

		await updateDnsBindingSyncState(options.policy.userId, binding.id, {
			lastARecordId: syncResult.lastARecordId,
			lastAAAARecordId: syncResult.lastAAAARecordId,
			lastIpv4: syncResult.lastIpv4,
			lastIpv6: syncResult.lastIpv6,
			lastSyncedAt: new Date()
		});

		await insertWorkflowLog(
			options.policy.id,
			'dns_sync',
			'success',
			`DNS 已同步到 ${syncResult.fqdn}，新增 ${syncResult.created.join(',') || '-'}，更新 ${
				syncResult.updated.join(',') || '-'
			}`
		);
		try {
			const settings = await findNotificationSettingsByUser(options.policy.userId);
			const credentials = getTelegramCredentials(settings);
			if (credentials) {
				await sendTelegramMessageToTargets({
					token: credentials.token,
					chatIds: credentials.chatIds,
					text: buildDnsSyncMessage({
						policyName: options.policy.name,
						fqdn: syncResult.fqdn,
						ipv4: syncResult.lastIpv4,
						ipv6: syncResult.lastIpv6,
						created: syncResult.created,
						updated: syncResult.updated
					})
				});
				await insertWorkflowLog(
					options.policy.id,
					'telegram_notify',
					'success',
					'DNS 同步成功通知已发送到 Telegram'
				);
			}
		} catch (notifyErr) {
			await insertWorkflowLog(
				options.policy.id,
				'telegram_notify',
				'failed',
				`Telegram DNS 同步通知发送失败: ${errorMessage(notifyErr)}`
			);
		}
	} catch (err) {
		await insertWorkflowLog(
			options.policy.id,
			'dns_sync',
			'failed',
			err instanceof Error ? err.message : String(err)
		);
	}
}

async function startTrackedStoppedVms(options: {
	policy: WorkflowPolicy;
	runtime: WorkerAccountRuntime;
	vmNames: string[];
}) {
	if (!options.policy.autoStart) {
		return { runningOrStarted: 0, failed: 0 };
	}
	if (options.vmNames.length === 0) {
		await insertWorkflowLog(options.policy.id, 'auto_start', 'skipped', '策略未记录可自动启动的 VM');
		return { runningOrStarted: 0, failed: 0 };
	}

	let runningOrStarted = 0;
	let failed = 0;
	for (const vmName of options.vmNames) {
		try {
			const state = await getPowerState(options.runtime.clients, options.policy.resourceGroup, vmName);
			if (isRunning(state)) {
				runningOrStarted += 1;
				await insertWorkflowLog(options.policy.id, 'auto_start', 'success', `VM ${vmName} 当前状态 ${state}，无需启动`);
				continue;
			}
			await insertWorkflowLog(
				options.policy.id,
				'auto_start',
				'running',
				`VM ${vmName} 当前状态 ${state}，按 Azure Start API 自动开机`
			);
			await powerVmWithProgress(options.runtime.clients, {
				resourceGroup: options.policy.resourceGroup,
				vmName,
				action: 'start',
				progress: async (event) => {
					await insertWorkflowLog(options.policy.id, `auto_start:${event.step}`, event.status, event.message);
				}
			});
			runningOrStarted += 1;
		} catch (err) {
			failed += 1;
			await insertWorkflowLog(
				options.policy.id,
				'auto_start',
				'failed',
				`自动启动 VM ${vmName} 失败: ${errorMessage(err)}`
			);
		}
	}
	return { runningOrStarted, failed };
}

async function removeAbnormalAccountAfterReplenishment(options: {
	policy: WorkflowPolicy;
	abnormalAccount: AzureAccount;
	replacementAccount: AzureAccount;
	state: string;
}) {
	if (options.abnormalAccount.id === options.replacementAccount.id) {
		await insertWorkflowLog(
			options.policy.id,
			'account_cleanup',
			'skipped',
			'异常账号与补机账号相同，跳过自动删除以避免误删当前可用账号'
		);
		return;
	}

	try {
		await updateWorkflow(options.policy.id, { accountId: options.replacementAccount.id });
		options.policy.accountId = options.replacementAccount.id;
		await insertWorkflowLog(
			options.policy.id,
			'account_cleanup',
			'running',
			`补机已完成，策略触发账号已切换到 ${options.replacementAccount.name}，准备删除异常账号 ${options.abnormalAccount.name}`
		);

		await deleteAccount(options.abnormalAccount.id);
		const poolCount = (await listAccountsByUser(options.policy.userId)).length;
		await insertWorkflowLog(
			options.policy.id,
			'account_cleanup',
			'success',
			`已删除订阅异常账号 ${options.abnormalAccount.name}，异常状态 ${options.state}，账号池剩余 ${poolCount} 个`
		);

		try {
			const settings = await findNotificationSettingsByUser(options.policy.userId);
			const credentials = getTelegramCredentials(settings);
			if (!credentials) {
				await insertWorkflowLog(
					options.policy.id,
					'telegram_notify',
					'skipped',
					'未配置 Telegram，跳过异常账号删除通知'
				);
				return;
			}
			await sendTelegramMessageToTargets({
				token: credentials.token,
				chatIds: credentials.chatIds,
				text: buildAbnormalAccountRemovedMessage({
					removedAccount: options.abnormalAccount,
					replacementAccount: options.replacementAccount,
					state: options.state,
					policyName: options.policy.name,
					poolCount
				})
			});
			await insertWorkflowLog(
				options.policy.id,
				'telegram_notify',
				'success',
				'异常账号删除通知已发送到 Telegram'
			);
		} catch (err) {
			await insertWorkflowLog(
				options.policy.id,
				'telegram_notify',
				'failed',
				`Telegram 异常账号删除通知发送失败: ${errorMessage(err)}`
			);
		}
	} catch (err) {
		await insertWorkflowLog(
			options.policy.id,
			'account_cleanup',
			'failed',
			`补机成功后删除异常账号失败: ${errorMessage(err)}`
		);
	}
}

async function runPolicies(policies: WorkflowPolicy[], options: { force?: boolean } = {}) {
	const force = options.force === true;
	for (const initialPolicy of policies) {
		if (activePolicies.has(initialPolicy.id)) {
			await insertWorkflowLog(
				initialPolicy.id,
				'status_check',
				'skipped',
				'上一轮补机/检测流程仍在执行，跳过本轮检测/触发，等待上一轮完成后再继续'
			).catch((err) => {
				console.warn('[worker] failed to log active policy skip:', err);
			});
			continue;
		}

		let policy = initialPolicy;
		let flowLockToken: string | null = null;
		activePolicies.add(policy.id);

		try {
			const latestPolicy = await findWorkflowByUser(policy.userId, policy.id);
			if (!latestPolicy || !latestPolicy.enabled) continue;
			policy = latestPolicy;

			const runningFlow = activeReplenishmentFlowLock(policy);
			if (runningFlow) {
				if (!runningFlow.stale) {
					const runningSeconds = Math.max(1, Math.ceil(runningFlow.ageMs / 1000));
					await insertWorkflowLog(
						policy.id,
						'status_check',
						'skipped',
						`上一轮补机流程仍在执行，已运行约 ${runningSeconds} 秒，跳过本轮检测/触发`
					);
					continue;
				}

				const released = await clearStaleReplenishmentFlowLock(policy);
				if (!released) {
					await insertWorkflowLog(
						policy.id,
						'status_check',
						'skipped',
						'上一轮补机执行锁正在被其它进程处理，跳过本轮检测/触发'
					);
					continue;
				}
				await insertWorkflowLog(
					policy.id,
					'status_check',
					'warning',
					`检测到上一轮补机执行锁已超过 ${Math.ceil(
						REPLENISHMENT_FLOW_LOCK_TIMEOUT_MS / 60 / 60 / 1000
					)} 小时未释放，已按异常中断处理并继续本轮检测`
				);
			}

			if (!policy.statusCheckEnabled) {
				await insertWorkflowLog(policy.id, 'status_check', 'skipped', '账号状态检测未启用，本轮不执行自动补机');
				continue;
			}

			if (!shouldRunPolicyStatusCheck(policy, force)) {
				continue;
			}

			const account = await findAccountById(policy.accountId);
			if (!account) {
				await insertWorkflowLog(policy.id, 'policy_error', 'failed', '关联 Azure 账号不存在');
				continue;
			}

			const primaryRuntime = await createRuntimeForAccount(policy.id, account, {
				fallbackToBootProxy: false
			});
			if (!primaryRuntime) continue;

			let status: Awaited<ReturnType<typeof getAccountSubscriptionStatus>>;
			try {
				status = await getAccountSubscriptionStatusWithTimeout(
					account,
					primaryRuntime.proxy,
					`触发账号 ${account.name}`
				);
			} catch (err) {
				const checkError = errorMessage(err);
				await updateWorkflowStatusCheck(policy.id, {
					lastAccountStatus: 'check_failed',
					lastStatusCheckedAt: new Date()
				});
				await notifyPolicySubscriptionCheckFailure({
					policy,
					account,
					message: checkError
				})
					.then((sent) =>
						insertWorkflowLog(
							policy.id,
							'telegram_notify',
							sent ? 'success' : 'skipped',
							sent
								? '本轮订阅状态查询失败结果已发送到 Telegram'
								: '未配置 Telegram 通知，或 1 小时内已发送过订阅状态查询失败结果通知，本轮跳过发送'
						)
					)
					.catch((notifyErr) =>
						insertWorkflowLog(
							policy.id,
							'telegram_notify',
							'failed',
							`Telegram 订阅状态查询失败通知发送失败: ${errorMessage(notifyErr)}`
						)
					);
				await insertWorkflowLog(policy.id, 'status_check', 'failed', `订阅状态查询失败: ${checkError}`);
				continue;
			}
			await updateWorkflowStatusCheck(policy.id, {
				lastAccountStatus: status.state,
				lastStatusCheckedAt: new Date()
			});

			const shouldReplenish = isAzureSubscriptionTriggerState(
				status.state,
				policy.statusTriggerStates || DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES
			);
			await notifySubscriptionStateIfNeeded({
				settingsUserId: policy.userId,
				account,
				status,
				alwaysNotify: true,
				policyName: policy.name,
				triggered: shouldReplenish
			})
				.then((sent) =>
					insertWorkflowLog(
						policy.id,
						'telegram_notify',
						sent ? 'success' : 'skipped',
						sent
							? `本轮订阅状态 ${status.state} 检测结果已发送到 Telegram`
							: '未配置 Telegram 通知，或 1 小时内已发送过订阅状态结果通知，本轮跳过发送'
					)
				)
				.catch((err) => {
					console.warn('[worker] failed to send subscription status notification:', err);
					return insertWorkflowLog(
						policy.id,
						'telegram_notify',
						'failed',
						`Telegram 订阅状态结果通知发送失败: ${errorMessage(err)}`
					);
				});
			await insertWorkflowLog(
				policy.id,
				'status_check',
				shouldReplenish ? 'warning' : 'success',
				`订阅状态: ${status.state}，${shouldReplenish ? '命中补机触发条件' : '未命中补机触发条件，跳过本轮'}`
			);
			if (!shouldReplenish) {
				if (policy.replenishmentPendingResourceGroup) {
					const cleanupCooldown = activeReplenishmentCooldown(policy);
					if (cleanupCooldown) {
						const remainingSeconds = Math.max(1, Math.ceil((cleanupCooldown.until - Date.now()) / 1000));
						await insertWorkflowLog(
							policy.id,
							'cleanup_resource_group',
							'skipped',
							`遗留资源组 ${policy.replenishmentPendingResourceGroup} 仍在清理冷却中，剩余约 ${remainingSeconds} 秒后再重试`
						);
						continue;
					}
					flowLockToken = await acquireReplenishmentFlowLock(
						policy,
						`检测到遗留资源组 ${policy.replenishmentPendingResourceGroup}，准备先执行清理`
					);
					if (!flowLockToken) continue;
					try {
						const accounts = await listAccountsByUser(policy.userId);
						let bootProxyPoolPromise: Promise<WorkerBootProxyRuntime[]> | null = null;
						const getBootProxyPool = () => {
							bootProxyPoolPromise ??= collectBootProxyPool(policy);
							return bootProxyPoolPromise;
						};
						await cleanupPendingReplenishmentResourceGroup(policy, accounts, getBootProxyPool);
					} finally {
						await releaseReplenishmentFlowLock(policy, flowLockToken);
						flowLockToken = null;
					}
				} else if (hasReplenishmentFailureState(policy)) {
					await clearReplenishmentFailure(policy);
				}
				continue;
			}

			if (!policy.dnsBindingId) {
				await insertWorkflowLog(
					policy.id,
					'dns_sync',
					'failed',
					'自动补机要求必须指定 DNS 解析绑定，请先在补机策略中选择要同步的域名'
				);
				continue;
			}

			const cooldown = activeReplenishmentCooldown(policy);
			if (cooldown) {
				const remainingSeconds = Math.max(1, Math.ceil((cooldown.until - Date.now()) / 1000));
				await insertWorkflowLog(
					policy.id,
					'auto_create',
					'skipped',
					`上一轮补机创建失败，已进入失败冷却，剩余约 ${remainingSeconds} 秒后再重试；上次失败: ${cooldown.message}`
				);
				continue;
			}

			const targetCount = safeReplenishTargetCount(policy);
			const trackedVmNames = parseVmNames(policy.vmNamesJson);
			const replenishmentVmSize = policy.vmSize;
			const ipPrefix = replenishmentIpPrefix(policy);
			const ipBrushMaxAttempts = replenishmentIpBrushMaxAttempts(policy);
			const enableAcceleratedNetworking = Boolean(policy.enableAcceleratedNetworking);
			const enableDdosProtection = Boolean(policy.enableDdosProtection);
			const started = await startTrackedStoppedVms({
				policy,
				runtime: primaryRuntime,
				vmNames: trackedVmNames
			});
			const effectiveTrackedCount = policy.autoStart ? started.runningOrStarted : trackedVmNames.length;
			const deficit = Math.max(targetCount - effectiveTrackedCount, 0);
			await insertWorkflowLog(
				policy.id,
				'auto_create',
				deficit > 0 ? 'running' : 'skipped',
				`订阅异常已触发补机计划：触发账号=${account.name}，订阅状态=${status.state}，已记录补机=${trackedVmNames.length}，已运行/已提交启动=${started.runningOrStarted}，自动开机失败=${started.failed}，目标=${targetCount}，需新建=${deficit}，规格=${replenishmentVmSize}，刷 IPv4 前缀=${ipPrefix}，最大次数=${ipBrushMaxAttempts}`
			);
			if (deficit <= 0) {
				await insertWorkflowLog(
					policy.id,
					'auto_create',
					'skipped',
					'策略已记录的补机数量满足目标，本轮不再创建新 VM；如果这些 VM 已被手动删除，请在策略里清空绑定 VM 名称后重新触发'
				);
				continue;
			}

			if (!policy.autoCreate) {
				await insertWorkflowLog(
					policy.id,
					'auto_create',
					'warning',
					'策略未开启“自动创建新 VM”，但当前订阅异常已命中补机条件，将按补机策略立即创建'
				);
			}

			const password = decryptSecret(policy.adminPasswordEncrypted);
			const userdata = decryptSecret(policy.userdataEncrypted ?? '');
			if (!password) {
				await insertWorkflowLog(policy.id, 'auto_create', 'failed', '未配置管理员密码，无法自动补机');
				continue;
			}

			flowLockToken = await acquireReplenishmentFlowLock(
				policy,
				`订阅异常已命中并存在补机缺口 ${deficit} 台，准备执行补机流程`
			);
			if (!flowLockToken) continue;

			try {
				const accounts = await listAccountsByUser(policy.userId);
				const accountOrder = normalizeReplenishmentAccountOrder(policy.replenishmentAccountOrder);
				await insertWorkflowLog(
					policy.id,
					'account_pool',
					accounts.length > 0 ? 'success' : 'warning',
					`Azure 号池当前共有 ${accounts.length} 个账号，自动补机会按${REPLENISHMENT_ACCOUNT_ORDER_LABELS[accountOrder]}逐个检测，选中第一个正常订阅账号`
				);
				let bootProxyPoolPromise: Promise<WorkerBootProxyRuntime[]> | null = null;
				const getBootProxyPool = () => {
					bootProxyPoolPromise ??= collectBootProxyPool(policy);
					return bootProxyPoolPromise;
				};
				if (!(await cleanupPendingReplenishmentResourceGroup(policy, accounts, getBootProxyPool))) {
					continue;
				}
				let accountPoolCursor = 0;
				const excludedAccountIds = new Set([account.id]);
				const maxCreateAttempts = Math.max(deficit, accounts.length);
				for (let i = 0; i < maxCreateAttempts; i++) {
					await insertWorkflowLog(
						policy.id,
						'auto_create',
						'running',
						`准备创建补机，目标缺口 ${deficit} 台，本轮尝试 ${i + 1}/${maxCreateAttempts}，按${REPLENISHMENT_ACCOUNT_ORDER_LABELS[accountOrder]}选择可用号池账号`
					);
					const selected = await pickReplenishmentRuntimeFromPool({
						policy,
						accounts,
						excludedAccountIds,
						startIndex: accountPoolCursor,
						getBootProxyPool
					});
					const replenishRuntime = selected?.runtime ?? null;
					if (!replenishRuntime) {
						await insertWorkflowLog(
							policy.id,
							'auto_create',
							'failed',
							'账号池中没有可用于补机的正常订阅账号'
						);
						break;
					}
					excludedAccountIds.add(replenishRuntime.account.id);
					accountPoolCursor = selected ? selected.selectedIndex + 1 : accountPoolCursor + 1;
					const prefix = policyResourcePrefix(policy);
					const resourceGroup = randomAzureResourceName(`${prefix}-rg`, 64);
					const vmName = randomAzureResourceName(prefix, 48);
					const createClients = replenishRuntime.clients;
					const createProxyLabel = replenishRuntime.proxyLabel;
					try {
						await insertWorkflowLog(
							policy.id,
							'auto_create',
							'running',
							`已选用补机账号 ${replenishRuntime.account.name}，出口=${createProxyLabel}，开始创建 VM ${vmName}`
						);
						const result = await createVmSimple(createClients, {
							resourceGroup,
							location: policy.location,
							vmName,
							vmSize: replenishmentVmSize,
							imageReference: policy.imageReference,
							adminUsername: policy.adminUsername,
							adminPassword: password,
							enableIpv6: policy.enableIpv6,
							enableAcceleratedNetworking,
							enableDdosProtection,
							customData: userdata,
							ipPrefix,
							ipBrushMaxAttempts,
							progress: (event) => logReplenishmentCreateProgress(policy, vmName, event)
						});
						await insertWorkflowLog(
							policy.id,
							'auto_create',
							'success',
							`已使用账号 ${replenishRuntime.account.name} 创建 VM: ${vmName} 规格 ${replenishmentVmSize} 代理=${createProxyLabel} 资源组=${resourceGroup} IPv4=${result.publicIPv4 || '-'} IPv6=${
								result.publicIPv6 || '-'
							}`
						);
						await clearReplenishmentFailure(policy);
						await saveTrackedVmName(policy, result.name);
						await notifyReplenishmentSuccess({
							policy,
							account: replenishRuntime.account,
							result,
							vmSize: replenishmentVmSize
						});
						await syncWorkflowDns({ policy, result });
						await removeAbnormalAccountAfterReplenishment({
							policy,
							abnormalAccount: account,
							replacementAccount: replenishRuntime.account,
							state: status.state
						});
						break;
					} catch (err) {
						const createFailureMessage = errorMessage(err);
						await insertWorkflowLog(
							policy.id,
							'auto_create',
							'failed',
							`补机失败 ${vmName}: ${createFailureMessage}`
						);
						let cleanupFailed = false;
						let cleanupFailureMessage = '';
						try {
							await cleanupReplenishmentResourceGroupWithFallback({
								policy,
								account: replenishRuntime.account,
								resourceGroup,
								getBootProxyPool
							});
						} catch (cleanupErr) {
							cleanupFailed = true;
							cleanupFailureMessage = errorMessage(cleanupErr);
							await insertWorkflowLog(
								policy.id,
								'cleanup_resource_group',
								'failed',
								`补机失败后的临时资源组 ${resourceGroup} 删除失败: ${cleanupFailureMessage}`
							);
						}
						const cooldownMessage = cleanupFailed
							? `${createFailureMessage}；临时资源组 ${resourceGroup} 清理失败: ${cleanupFailureMessage}`
							: createFailureMessage;
						if (!cleanupFailed && isProxyOutboundFailure(createFailureMessage) && i < maxCreateAttempts - 1) {
							await insertWorkflowLog(
								policy.id,
								'auto_create',
								'warning',
								`本次补机失败来自代理出口异常，临时资源已清理，将跳过该出口继续尝试下一个候选账号`
							);
							continue;
						}
						const cooldown = await recordReplenishmentFailure(policy, cooldownMessage, {
							resourceGroup: cleanupFailed ? resourceGroup : '',
							accountId: cleanupFailed ? replenishRuntime.account.id : 0,
							minCooldownMs: cleanupFailed ? REPLENISHMENT_FAILURE_MAX_COOLDOWN_MS : 0
						});
						await insertWorkflowLog(
							policy.id,
							'auto_create',
							'skipped',
							`补机失败后进入退避冷却，第 ${cooldown.attempts} 次失败，约 ${Math.ceil(
								cooldown.cooldownMs / 1000
							)} 秒后再自动重试，避免持续创建 Azure 资源`
						);
						break;
					}
				}
			} finally {
				await releaseReplenishmentFlowLock(policy, flowLockToken);
				flowLockToken = null;
			}
		} catch (err) {
			await insertWorkflowLog(policy.id, 'policy_error', 'failed', errorMessage(err));
		} finally {
			if (flowLockToken) {
				await releaseReplenishmentFlowLock(policy, flowLockToken).catch((err) => {
					console.warn('[worker] failed to release replenishment flow lock:', err);
				});
			}
			await updateWorkflowLastRun(policy.id).catch((err) => {
				console.warn('[worker] failed to update workflow last_run_at:', err);
			});
			activePolicies.delete(policy.id);
		}
	}
}

async function notifySubscriptionStateIfNeeded(options: {
	settingsUserId: number;
	account: AzureAccount;
	status: Awaited<ReturnType<typeof getAccountSubscriptionStatus>>;
	alwaysNotify?: boolean;
	policyName?: string;
	triggered?: boolean;
}) {
	const now = new Date();
	const trigger = isAzureSubscriptionTriggerState(
		options.status.state,
		DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES
	);
	const existing = await findSubscriptionNotificationState(
		options.settingsUserId,
		options.account.id
	);
	const normalizedState = normalizedNotificationState(options.status.state) || 'unknown';
	const baseState = {
		subscriptionId: options.status.subscriptionId || options.account.subscriptionId,
		displayName: options.status.displayName || '',
		lastState: normalizedState,
		lastCheckedAt: now
	};
	const triggered = options.triggered ?? trigger;

	if (!options.alwaysNotify && !triggered) {
		await upsertSubscriptionNotificationState(options.settingsUserId, options.account.id, {
			...baseState,
			lastNotifiedState: ''
		});
		return false;
	}

	const lastNotifiedAt = dateTimeMs(existing?.lastNotifiedAt);
	const stateChanged = !existing || existing.lastState !== normalizedState;
	const notifyIntervalElapsed =
		!lastNotifiedAt || now.getTime() - lastNotifiedAt >= SUBSCRIPTION_STATUS_NOTIFY_INTERVAL_MS;
	const shouldNotify = options.alwaysNotify
		? stateChanged || notifyIntervalElapsed
		: existing?.lastNotifiedState !== normalizedState;
	if (!shouldNotify) {
		await upsertSubscriptionNotificationState(options.settingsUserId, options.account.id, baseState);
		return false;
	}

	const settings = await findNotificationSettingsByUser(options.settingsUserId);
	const credentials = getTelegramCredentials(settings);
	if (!credentials) {
		await upsertSubscriptionNotificationState(options.settingsUserId, options.account.id, baseState);
		return false;
	}

	await sendTelegramMessageToTargets({
		token: credentials.token,
		chatIds: credentials.chatIds,
		text: buildSubscriptionAlertMessage({
			account: options.account,
			subscriptionId: options.status.subscriptionId,
			displayName: options.status.displayName,
			state: options.status.state,
			checkedAt: now,
			policyName: options.policyName,
			triggered
		})
	});

	await upsertSubscriptionNotificationState(options.settingsUserId, options.account.id, {
		...baseState,
		lastNotifiedState: triggered ? normalizedState : '',
		lastNotifiedAt: now
	});
	return true;
}

async function notifyPolicySubscriptionCheckFailure(options: {
	policy: WorkflowPolicy;
	account: AzureAccount;
	message: string;
}) {
	const now = new Date();
	const normalizedState = 'check_failed';
	const existing = await findSubscriptionNotificationState(options.policy.userId, options.account.id);
	const baseState = {
		subscriptionId: options.account.subscriptionId,
		displayName: '',
		lastState: normalizedState,
		lastCheckedAt: now
	};
	const lastNotifiedAt = dateTimeMs(existing?.lastNotifiedAt);
	const stateChanged = !existing || existing.lastState !== normalizedState;
	const notifyIntervalElapsed =
		!lastNotifiedAt || now.getTime() - lastNotifiedAt >= SUBSCRIPTION_STATUS_NOTIFY_INTERVAL_MS;
	const shouldNotify = stateChanged || notifyIntervalElapsed;
	if (!shouldNotify) {
		await upsertSubscriptionNotificationState(options.policy.userId, options.account.id, baseState);
		return false;
	}

	const settings = await findNotificationSettingsByUser(options.policy.userId);
	const credentials = getTelegramCredentials(settings);
	if (!credentials) {
		await upsertSubscriptionNotificationState(options.policy.userId, options.account.id, baseState);
		return false;
	}

	await sendTelegramMessageToTargets({
		token: credentials.token,
		chatIds: credentials.chatIds,
		text: buildSubscriptionAlertMessage({
			account: options.account,
			subscriptionId: options.account.subscriptionId,
			displayName: '',
			state: 'CheckFailed',
			checkedAt: new Date(),
			policyName: options.policy.name,
			triggered: false,
			result: '订阅状态查询失败',
			detail: options.message
		})
	});
	await upsertSubscriptionNotificationState(options.policy.userId, options.account.id, {
		...baseState,
		lastNotifiedState: normalizedState,
		lastNotifiedAt: now
	});
	return true;
}

async function runSubscriptionNotificationChecks(force = false) {
	const settingsRows = await listEnabledNotificationSettings();

	for (const settings of settingsRows) {
		if (!force && !shouldRunNotificationCheck(settings)) continue;
		if (activeNotificationUsers.has(settings.userId)) continue;

		activeNotificationUsers.add(settings.userId);
		try {
			const accounts = await listAccountsByUser(settings.userId);
			for (const account of accounts) {
				try {
					const runtime = await createRuntimeForAccount(0, account);
					if (!runtime) continue;
					const status = await getAccountSubscriptionStatus(account, runtime.proxy);
					await notifySubscriptionStateIfNeeded({
						settingsUserId: settings.userId,
						account,
						status
					});
				} catch (err) {
					console.warn(
						`[worker] Telegram subscription check failed for account ${account.id}:`,
						err
					);
				}
			}
			await updateNotificationLastSubscriptionChecked(settings.userId);
		} finally {
			activeNotificationUsers.delete(settings.userId);
		}
	}
}

export async function runWorkflowOnce() {
	await Promise.all([runPolicies(await listEnabledWorkflows()), runSubscriptionNotificationChecks()]);
}

export async function runWorkflowOnceForUser(userId: number, options: { force?: boolean } = {}) {
	await Promise.all([
		runPolicies(await listEnabledWorkflowsByUser(userId), { force: options.force === true }),
		runSubscriptionNotificationChecks(options.force === true)
	]);
}

export function startWorker() {
	if (timer) return;
	const interval = getWorkerIntervalMs();
	timer = setInterval(() => {
		void runWorkflowOnce();
	}, interval);
	void runWorkflowOnce();
	console.log(`[worker] 自动补机引擎已启动，间隔 ${interval}ms`);
}

export function stopWorker() {
	if (timer) clearInterval(timer);
	timer = null;
}
