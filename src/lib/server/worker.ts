import { decryptSecret } from './crypto';
import { getWorkerIntervalMs } from './env';
import {
	findAccountById,
	findDnsBindingByUser,
	findDnsConfigByUser,
	findProxyProfileByUser,
	insertWorkflowLog,
	listAccountsByUser,
	listEnabledWorkflows,
	listEnabledWorkflowsByUser,
	listProxyProfilesByUser,
	updateDnsBindingSyncState,
	updateWorkflowLastRun,
	updateWorkflowStatusCheck
} from './db/repo';
import {
	DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES,
	createAzureClients,
	createVmSimple,
	getAccountSubscriptionStatus,
	getPowerState,
	isAzureSubscriptionTriggerState,
	isRunning,
	randomAzureResourceName,
	startVm,
	type CreateVmProgressEvent,
	type CreateVmResult
} from './azure';
import type { AzureAccount, ProxyProfile, WorkflowPolicy } from './db/schema';
import { createRainbowDnsClient, syncDnsBindingToIp } from './dns';
import { proxyProfileToRuntimeReady, proxySource, type ProxyRuntimeConfig } from './proxy';

let timer: NodeJS.Timeout | null = null;
const activePolicies = new Set<number>();

type WorkerAccountRuntime = {
	account: AzureAccount;
	proxy: ProxyRuntimeConfig | null;
	clients: ReturnType<typeof createAzureClients>;
};

type WorkerBootProxyRuntime = {
	name: string;
	proxy: ProxyRuntimeConfig;
};

type TrackedVm = {
	name: string;
	resourceGroup: string;
	vmSize: string;
	accountId: number;
	accountName: string;
	clients: ReturnType<typeof createAzureClients>;
};

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

function shuffle<T>(items: T[]) {
	const result = [...items];
	for (let i = result.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

function safeIntervalSeconds(value: number) {
	return Number.isFinite(value) && value > 0 ? value : 120;
}

function shouldRun(policy: { lastRunAt: Date | null; checkIntervalSeconds: number }, force: boolean) {
	if (force || !policy.lastRunAt) return true;
	return Date.now() - policy.lastRunAt.getTime() >= safeIntervalSeconds(policy.checkIntervalSeconds) * 1000;
}

function parseVmNames(value: string) {
	try {
		const parsed = JSON.parse(value || '[]');
		return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
	} catch {
		return [];
	}
}

function safeReplenishTargetCount(policy: WorkflowPolicy) {
	const count = Number(policy.replenishTargetCount ?? policy.minRunningCount ?? 1);
	return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
}

function resourceGroupFromId(resourceId?: string | null) {
	const match = String(resourceId ?? '').match(/resourceGroups\/([^/]+)/i);
	return match ? decodeURIComponent(match[1]) : '';
}

function policyResourcePrefix(policy: WorkflowPolicy) {
	const base = (policy.namePrefix || 'auto-vm').replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^-+|-+$/g, '');
	return `${base || 'auto-vm'}-w${policy.id}`.toLowerCase();
}

async function collectTrackedVms(
	policy: WorkflowPolicy,
	runtimes: WorkerAccountRuntime[]
) {
	const configuredNames = parseVmNames(policy.vmNamesJson);
	const configuredNameSet = new Set(configuredNames.map((name) => name.toLowerCase()));
	const prefix = policyResourcePrefix(policy);
	const tracked: TrackedVm[] = [];

	for (const runtime of runtimes) {
		try {
			for await (const vm of runtime.clients.compute.virtualMachines.listAll()) {
				if (!vm.name) continue;
				const resourceGroup = resourceGroupFromId(vm.id);
				if (!resourceGroup) continue;
				const lowerName = vm.name.toLowerCase();
				const isConfigured = configuredNameSet.size > 0 && configuredNameSet.has(lowerName);
				const isPolicyCreated = lowerName.startsWith(`${prefix}-`);
				if (isConfigured || isPolicyCreated) {
					tracked.push({
						name: vm.name,
						resourceGroup,
						vmSize: vm.hardwareProfile?.vmSize ?? '',
						accountId: runtime.account.id,
						accountName: runtime.account.name,
						clients: runtime.clients
					});
				}
			}
		} catch (err) {
			await insertWorkflowLog(
				policy.id,
				'inspect',
				'failed',
				`账号 ${runtime.account.name} VM 列表读取失败: ${errorMessage(err)}`
			);
		}
	}

	return tracked;
}

function selectVmSizeForReplenishment(runningVms: TrackedVm[], fallbackVmSize: string) {
	const counts = new Map<string, number>();
	for (const vm of runningVms) {
		if (!vm.vmSize) continue;
		counts.set(vm.vmSize, (counts.get(vm.vmSize) ?? 0) + 1);
	}
	const selected = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
	return selected || fallbackVmSize;
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
			pool.push({
				name: profile.name,
				proxy: await proxyProfileToRuntimeReady(profile)
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

function pickBootProxy(pool: WorkerBootProxyRuntime[]) {
	if (pool.length === 0) return null;
	return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

async function createRuntimeForAccount(
	policyId: number,
	account: AzureAccount
): Promise<WorkerAccountRuntime | null> {
	const proxyProfile = account.proxyProfileId
		? await findProxyProfileByUser(account.userId, account.proxyProfileId)
		: null;
	if (proxyProfile && proxySource(proxyProfile) === 'client_ip') {
		await insertWorkflowLog(
			policyId,
			'account_pool',
			'skipped',
			`账号 ${account.name} 使用当前访问 IP 代理，后台定时任务无法使用，已跳过`
		);
		return null;
	}

	const proxy = proxyProfile ? await proxyProfileToRuntimeReady(proxyProfile) : null;
	return {
		account,
		proxy,
		clients: createAzureClients(account, proxy)
	};
}

async function collectAccountPoolRuntimes(policy: WorkflowPolicy, primaryAccount: AzureAccount) {
	const accounts = await listAccountsByUser(policy.userId);
	const runtimes: WorkerAccountRuntime[] = [];
	for (const account of accounts) {
		try {
			const runtime = await createRuntimeForAccount(policy.id, account);
			if (runtime) runtimes.push(runtime);
		} catch (err) {
			await insertWorkflowLog(
				policy.id,
				'account_pool',
				'failed',
				`账号 ${account.name} 代理初始化失败: ${errorMessage(err)}`
			);
		}
	}

	if (!runtimes.some((runtime) => runtime.account.id === primaryAccount.id)) {
		const primaryRuntime = await createRuntimeForAccount(policy.id, primaryAccount);
		if (primaryRuntime) runtimes.push(primaryRuntime);
	}
	return runtimes;
}

async function pickReplenishmentRuntime(
	policy: WorkflowPolicy,
	runtimes: WorkerAccountRuntime[],
	excludedAccountId: number
): Promise<WorkerAccountRuntime | null> {
	const candidates = shuffle(runtimes.filter((runtime) => runtime.account.id !== excludedAccountId));
	for (const runtime of candidates) {
		try {
			const status = await getAccountSubscriptionStatus(runtime.account, runtime.proxy);
			const abnormal = isAzureSubscriptionTriggerState(
				status.state,
				DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES
			);
			const usable = !status.abnormal && !abnormal;
			await insertWorkflowLog(
				policy.id,
				'account_pool',
				usable ? 'success' : 'warning',
				`随机候选补机账号 ${runtime.account.name} 订阅状态 ${status.state}${usable ? '，已选用' : '，跳过'}`
			);
			if (usable) return runtime;
		} catch (err) {
			await insertWorkflowLog(
				policy.id,
				'account_pool',
				'failed',
				`随机候选补机账号 ${runtime.account.name} 状态检测失败: ${errorMessage(err)}`
			);
		}
	}
	return null;
}

async function logCreateProgress(policyId: number, event: CreateVmProgressEvent) {
	await insertWorkflowLog(policyId, `create:${event.step}`, event.status, event.message);
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
	} catch (err) {
		await insertWorkflowLog(
			options.policy.id,
			'dns_sync',
			'failed',
			err instanceof Error ? err.message : String(err)
		);
	}
}

async function runPolicies(policies: WorkflowPolicy[], force: boolean) {
	for (const policy of policies) {
		if (!shouldRun(policy, force)) continue;
		if (activePolicies.has(policy.id)) continue;

		activePolicies.add(policy.id);

		try {
			if (!policy.statusCheckEnabled) {
				await insertWorkflowLog(policy.id, 'status_check', 'skipped', '账号状态检测未启用，本轮不执行自动补机');
				continue;
			}

			const account = await findAccountById(policy.accountId);
			if (!account) {
				await insertWorkflowLog(policy.id, 'policy_error', 'failed', '关联 Azure 账号不存在');
				continue;
			}

			const primaryRuntime = await createRuntimeForAccount(policy.id, account);
			if (!primaryRuntime) continue;

			const status = await getAccountSubscriptionStatus(account, primaryRuntime.proxy);
			await updateWorkflowStatusCheck(policy.id, {
				lastAccountStatus: status.state,
				lastStatusCheckedAt: new Date()
			});

			const shouldReplenish = isAzureSubscriptionTriggerState(
				status.state,
				DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES
			);
			await insertWorkflowLog(
				policy.id,
				'status_check',
				shouldReplenish ? 'warning' : 'success',
				`订阅状态: ${status.state}，${shouldReplenish ? '命中补机触发条件' : '未命中补机触发条件，跳过本轮'}`
			);
			if (!shouldReplenish) continue;

			const targetCount = safeReplenishTargetCount(policy);
			const accountPoolRuntimes = await collectAccountPoolRuntimes(policy, account);
			const bootProxyPool = await collectBootProxyPool(policy);
			const tracked = await collectTrackedVms(policy, accountPoolRuntimes);
			let running = 0;
			const runningVms: TrackedVm[] = [];
			const stopped: TrackedVm[] = [];

			for (const vm of tracked) {
				const state = await getPowerState(vm.clients, vm.resourceGroup, vm.name);
				if (isRunning(state)) {
					running += 1;
					runningVms.push(vm);
				} else {
					stopped.push(vm);
				}
			}
			const replenishmentVmSize = selectVmSizeForReplenishment(runningVms, policy.vmSize);

			await insertWorkflowLog(
				policy.id,
				'inspect',
				'success',
				`已跟踪本策略补机 VM ${tracked.length} 台，运行中 ${running} 台，停止 ${stopped.length} 台，目标 ${targetCount} 台，补机规格 ${replenishmentVmSize}`
			);

			if (policy.autoStart) {
				for (const vm of stopped) {
					if (running >= targetCount) break;
					try {
						await startVm(vm.clients, vm.resourceGroup, vm.name);
						await insertWorkflowLog(
							policy.id,
							'auto_start',
							'success',
							`已触发开机 ${vm.name}（账号 ${vm.accountName}）`
						);
						running += 1;
					} catch (err) {
						await insertWorkflowLog(
							policy.id,
							'auto_start',
							'failed',
							`开机失败 ${vm.name}: ${errorMessage(err)}`
						);
					}
				}
			}

			const deficit = Math.max(targetCount - running, 0);
			if (deficit > 0 && policy.autoCreate) {
				const password = decryptSecret(policy.adminPasswordEncrypted);
				const userdata = decryptSecret(policy.userdataEncrypted ?? '');
				if (!password) {
					await insertWorkflowLog(policy.id, 'auto_create', 'failed', '未配置管理员密码，无法自动补机');
				} else {
					for (let i = 0; i < deficit; i++) {
						const replenishRuntime = await pickReplenishmentRuntime(
							policy,
							accountPoolRuntimes,
							account.id
						);
						if (!replenishRuntime) {
							await insertWorkflowLog(
								policy.id,
								'auto_create',
								'failed',
								'账号池中没有可用于补机的正常订阅账号'
							);
							break;
						}
						const prefix = policyResourcePrefix(policy);
						const resourceGroup = randomAzureResourceName(`${prefix}-rg`, 64);
						const vmName = randomAzureResourceName(prefix, 48);
						const bootProxy = pickBootProxy(bootProxyPool);
						const createClients = bootProxy
							? createAzureClients(replenishRuntime.account, bootProxy.proxy)
							: replenishRuntime.clients;
						try {
							const result = await createVmSimple(createClients, {
								resourceGroup,
								location: policy.location,
								vmName,
								vmSize: replenishmentVmSize,
								imageReference: policy.imageReference,
								adminUsername: policy.adminUsername,
								adminPassword: password,
								enableIpv6: policy.enableIpv6,
								customData: userdata,
								ipPrefix: policy.ipPrefix,
								ipBrushMaxAttempts: policy.ipBrushMaxAttempts,
								progress: (event) => logCreateProgress(policy.id, event)
							});
							await insertWorkflowLog(
								policy.id,
								'auto_create',
								'success',
								`已使用账号 ${replenishRuntime.account.name} 创建 VM: ${vmName} 规格 ${replenishmentVmSize} 代理=${bootProxy?.name || '账号默认/直连'} 资源组=${resourceGroup} IPv4=${result.publicIPv4 || '-'} IPv6=${
									result.publicIPv6 || '-'
								} 刷 IP 次数=${result.ipBrushAttempts}`
							);
							await syncWorkflowDns({ policy, result });
						} catch (err) {
							await insertWorkflowLog(
								policy.id,
								'auto_create',
								'failed',
								`补机失败 ${vmName}: ${errorMessage(err)}`
							);
						}
					}
				}
			}
		} catch (err) {
			await insertWorkflowLog(policy.id, 'policy_error', 'failed', errorMessage(err));
		} finally {
			await updateWorkflowLastRun(policy.id).catch((err) => {
				console.warn('[worker] failed to update workflow last_run_at:', err);
			});
			activePolicies.delete(policy.id);
		}
	}
}

export async function runWorkflowOnce() {
	await runPolicies(await listEnabledWorkflows(), false);
}

export async function runWorkflowOnceForUser(userId: number, options: { force?: boolean } = {}) {
	await runPolicies(await listEnabledWorkflowsByUser(userId), options.force === true);
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
