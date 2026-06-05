import { decryptSecret } from './crypto';
import { getWorkerIntervalMs } from './env';
import {
	findAccountById,
	insertWorkflowLog,
	listEnabledWorkflows,
	updateWorkflowLastRun
} from './db/repo';
import {
	createAzureClients,
	createVmSimple,
	getPowerState,
	isRunning,
	startVm
} from './azure';

let timer: NodeJS.Timeout | null = null;

function shouldRun(policy: { lastRunAt: Date | null; checkIntervalSeconds: number }) {
	if (!policy.lastRunAt) return true;
	return Date.now() - policy.lastRunAt.getTime() >= policy.checkIntervalSeconds * 1000;
}

export async function runWorkflowOnce() {
	const policies = await listEnabledWorkflows();

	for (const policy of policies) {
		if (!shouldRun(policy)) continue;
		try {
			const account = await findAccountById(policy.accountId);
			if (!account) {
				await insertWorkflowLog(policy.id, 'policy_error', 'failed', '关联 Azure 账号不存在');
				continue;
			}

			const clients = createAzureClients(account);
			const vmNames = JSON.parse(policy.vmNamesJson || '[]') as string[];
			const listed = clients.compute.virtualMachines.list(policy.resourceGroup);
			const existing = new Map<string, string>();
			for await (const vm of listed) {
				if (vm.name) existing.set(vm.name, vm.name);
			}

			const tracked =
				vmNames.length > 0 ? vmNames.filter((name) => existing.has(name)) : [...existing.keys()];

			let running = 0;
			const stopped: string[] = [];

			for (const name of tracked) {
				const state = await getPowerState(clients, policy.resourceGroup, name);
				if (isRunning(state)) running += 1;
				else stopped.push(name);
			}

			await insertWorkflowLog(
				policy.id,
				'inspect',
				'success',
				`资源组 ${policy.resourceGroup}: 运行中 ${running}/${tracked.length}, 停止 ${stopped.length}`
			);

			if (policy.autoStart) {
				for (const name of stopped) {
					try {
						await startVm(clients, policy.resourceGroup, name);
						await insertWorkflowLog(policy.id, 'auto_start', 'success', `已触发开机: ${name}`);
						running += 1;
					} catch (err) {
						await insertWorkflowLog(policy.id, 'auto_start', 'failed', `开机失败 ${name}: ${String(err)}`);
					}
				}
			}

			const deficit = Math.max(policy.minRunningCount - running, 0);
			if (deficit > 0 && policy.autoCreate) {
				const password = decryptSecret(policy.adminPasswordEncrypted);
				if (!password) {
					await insertWorkflowLog(policy.id, 'auto_create', 'failed', '未配置管理员密码，无法自动补机');
				} else {
					for (let i = 0; i < deficit; i++) {
						const vmName = `${policy.namePrefix}-${Date.now()}-${i}`;
						try {
							await createVmSimple(clients, {
								resourceGroup: policy.resourceGroup,
								location: policy.location,
								vmName,
								vmSize: policy.vmSize,
								imageReference: policy.imageReference,
								adminUsername: policy.adminUsername,
								adminPassword: password
							});
							await insertWorkflowLog(policy.id, 'auto_create', 'success', `已创建 VM: ${vmName}`);
						} catch (err) {
							await insertWorkflowLog(
								policy.id,
								'auto_create',
								'failed',
								`补机失败 ${vmName}: ${String(err)}`
							);
						}
					}
				}
			}

			await updateWorkflowLastRun(policy.id);
		} catch (err) {
			await insertWorkflowLog(policy.id, 'policy_error', 'failed', String(err));
		}
	}
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
