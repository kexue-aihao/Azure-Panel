import { decryptSecret } from './crypto';
import { getWorkerIntervalMs } from './env';
import {
	findAccountById,
	findDnsBindingByUser,
	findDnsConfigByUser,
	findProxyProfileByUser,
	insertWorkflowLog,
	listEnabledWorkflows,
	listEnabledWorkflowsByUser,
	updateDnsBindingSyncState,
	updateWorkflowLastRun,
	updateWorkflowStatusCheck
} from './db/repo';
import {
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
import type { WorkflowPolicy } from './db/schema';
import { createRainbowDnsClient, syncDnsBindingToIp } from './dns';
import { proxyProfileToRuntimeReady, proxySource } from './proxy';

let timer: NodeJS.Timeout | null = null;
const activePolicies = new Set<number>();

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
	clients: ReturnType<typeof createAzureClients>
) {
	const configuredNames = parseVmNames(policy.vmNamesJson);
	const configuredNameSet = new Set(configuredNames.map((name) => name.toLowerCase()));
	const prefix = policyResourcePrefix(policy);
	const tracked: Array<{ name: string; resourceGroup: string }> = [];

	for await (const vm of clients.compute.virtualMachines.listAll()) {
		if (!vm.name) continue;
		const resourceGroup = resourceGroupFromId(vm.id);
		if (!resourceGroup) continue;
		const lowerName = vm.name.toLowerCase();
		const isConfigured = configuredNameSet.size > 0 && configuredNameSet.has(lowerName);
		const isPolicyCreated = configuredNameSet.size === 0 && lowerName.startsWith(`${prefix}-`);
		const isFixedResourceGroup =
			configuredNameSet.size === 0 &&
			resourceGroup.toLowerCase() === policy.resourceGroup.toLowerCase();
		if (isConfigured || isPolicyCreated || isFixedResourceGroup) {
			tracked.push({ name: vm.name, resourceGroup });
		}
	}

	return tracked;
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

			const proxyProfile = account.proxyProfileId
				? await findProxyProfileByUser(account.userId, account.proxyProfileId)
				: null;
			if (proxyProfile && proxySource(proxyProfile) === 'client_ip') {
				await insertWorkflowLog(
					policy.id,
					'policy_error',
					'failed',
					'此账号绑定了当前访问网站 IP 代理，后台定时任务无法获取访问者 IP，请改用固定代理'
				);
				continue;
			}

			const proxy = proxyProfile ? await proxyProfileToRuntimeReady(proxyProfile) : null;
			const status = await getAccountSubscriptionStatus(account, proxy);
			await updateWorkflowStatusCheck(policy.id, {
				lastAccountStatus: status.state,
				lastStatusCheckedAt: new Date()
			});

			const shouldReplenish = isAzureSubscriptionTriggerState(
				status.state,
				policy.statusTriggerStates
			);
			await insertWorkflowLog(
				policy.id,
				'status_check',
				shouldReplenish ? 'warning' : 'success',
				`订阅状态: ${status.state}，${shouldReplenish ? '命中补机触发条件' : '未命中补机触发条件，跳过本轮'}`
			);
			if (!shouldReplenish) continue;

			const clients = createAzureClients(account, proxy);
			const tracked = await collectTrackedVms(policy, clients);
			let running = 0;
			const stopped: Array<{ name: string; resourceGroup: string }> = [];

			for (const vm of tracked) {
				const state = await getPowerState(clients, vm.resourceGroup, vm.name);
				if (isRunning(state)) running += 1;
				else stopped.push(vm);
			}

			await insertWorkflowLog(
				policy.id,
				'inspect',
				'success',
				`已跟踪 VM ${tracked.length} 台，运行中 ${running} 台，停止 ${stopped.length} 台`
			);

			if (policy.autoStart) {
				for (const vm of stopped) {
					try {
						await startVm(clients, vm.resourceGroup, vm.name);
						await insertWorkflowLog(policy.id, 'auto_start', 'success', `已触发开机 ${vm.name}`);
						running += 1;
					} catch (err) {
						await insertWorkflowLog(
							policy.id,
							'auto_start',
							'failed',
							`开机失败 ${vm.name}: ${err instanceof Error ? err.message : String(err)}`
						);
					}
				}
			}

			const deficit = Math.max(policy.minRunningCount - running, 0);
			if (deficit > 0 && policy.autoCreate) {
				const password = decryptSecret(policy.adminPasswordEncrypted);
				const userdata = decryptSecret(policy.userdataEncrypted ?? '');
				if (!password) {
					await insertWorkflowLog(policy.id, 'auto_create', 'failed', '未配置管理员密码，无法自动补机');
				} else {
					for (let i = 0; i < deficit; i++) {
						const prefix = policyResourcePrefix(policy);
						const resourceGroup = randomAzureResourceName(`${prefix}-rg`, 64);
						const vmName = randomAzureResourceName(prefix, 48);
						try {
							const result = await createVmSimple(clients, {
								resourceGroup,
								location: policy.location,
								vmName,
								vmSize: policy.vmSize,
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
								`已创建 VM: ${vmName} 资源组=${resourceGroup} IPv4=${result.publicIPv4 || '-'} IPv6=${
									result.publicIPv6 || '-'
								} 刷 IP 次数=${result.ipBrushAttempts}`
							);
							await syncWorkflowDns({ policy, result });
						} catch (err) {
							await insertWorkflowLog(
								policy.id,
								'auto_create',
								'failed',
								`补机失败 ${vmName}: ${err instanceof Error ? err.message : String(err)}`
							);
						}
					}
				}
			}
		} catch (err) {
			await insertWorkflowLog(policy.id, 'policy_error', 'failed', err instanceof Error ? err.message : String(err));
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
