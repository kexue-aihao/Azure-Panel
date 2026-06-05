import { ClientSecretCredential } from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import type { ProxySettings } from '@azure/core-rest-pipeline';
import type { TokenCredentialOptions } from '@azure/identity';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { AzureAccount } from './db/schema';
import { decryptSecret } from './crypto';
import {
	buildProxyUrl,
	maskProxy,
	parseProxyUrl,
	type ProxyRuntimeConfig
} from './proxy';

export type VmInfo = {
	name: string;
	resourceGroup: string;
	location: string;
	vmSize: string;
	powerState: string;
	provisioningState: string;
};

export type AzureClients = {
	compute: ComputeManagementClient;
	network: NetworkManagementClient;
	resources: ResourceManagementClient;
	subscriptionId: string;
};

const RUNNING = new Set(['PowerState/running', 'PowerState/starting']);

export function validateProxyUrl(proxyUrl: string) {
	parseProxyUrl(proxyUrl);
}

export function maskProxyUrl(proxyUrl: string): string {
	try {
		const parsed = parseProxyUrl(proxyUrl);
		return parsed ? maskProxy(parsed) : '';
	} catch {
		return '代理配置异常';
	}
}

function proxySettings(proxy: ProxyRuntimeConfig): ProxySettings {
	return {
		host: `${proxy.type}://${proxy.host}`,
		port: proxy.port,
		username: proxy.username,
		password: proxy.password
	};
}

function azureClientOptions(proxy?: ProxyRuntimeConfig | null): TokenCredentialOptions {
	if (!proxy) return {};
	if (proxy.type === 'http' || proxy.type === 'https') {
		return { proxyOptions: proxySettings(proxy) };
	}
	return { agent: new SocksProxyAgent(buildProxyUrl(proxy)) as TokenCredentialOptions['agent'] };
}

function decryptLegacyProxy(account: AzureAccount): ProxyRuntimeConfig | null {
	return account.proxyUrlEncrypted ? parseProxyUrl(decryptSecret(account.proxyUrlEncrypted)) : null;
}

export function createAzureClients(account: AzureAccount, proxy?: ProxyRuntimeConfig | null): AzureClients {
	const runtimeProxy = proxy ?? decryptLegacyProxy(account);
	const clientOptions = azureClientOptions(runtimeProxy);
	const credential = new ClientSecretCredential(
		account.tenantId,
		account.clientId,
		decryptSecret(account.clientSecretEncrypted),
		clientOptions
	);
	return {
		compute: new ComputeManagementClient(credential, account.subscriptionId, clientOptions),
		network: new NetworkManagementClient(credential, account.subscriptionId, clientOptions),
		resources: new ResourceManagementClient(credential, account.subscriptionId, clientOptions),
		subscriptionId: account.subscriptionId
	};
}

export async function validateAzureCredentials(
	tenantId: string,
	clientId: string,
	clientSecret: string,
	subscriptionId: string,
	proxy?: ProxyRuntimeConfig | string | null
) {
	const runtimeProxy = typeof proxy === 'string' ? parseProxyUrl(proxy) : proxy;
	const clientOptions = azureClientOptions(runtimeProxy);
	const credential = new ClientSecretCredential(tenantId, clientId, clientSecret, clientOptions);
	const client = new ComputeManagementClient(credential, subscriptionId, clientOptions);
	await client.virtualMachines.listAll().next();
}

function parseResourceGroup(resourceId: string): string {
	const match = resourceId.match(/resourceGroups\/([^/]+)/i);
	return match?.[1] ?? '';
}

export async function listVirtualMachines(
	clients: AzureClients,
	resourceGroup?: string
): Promise<VmInfo[]> {
	const items: VmInfo[] = [];
	const iterator = resourceGroup
		? clients.compute.virtualMachines.list(resourceGroup)
		: clients.compute.virtualMachines.listAll();

	for await (const vm of iterator) {
		const rg = parseResourceGroup(vm.id ?? '');
		const view = await clients.compute.virtualMachines.instanceView(rg, vm.name!);
		const power =
			view.statuses?.find((s) => s.code?.startsWith('PowerState/'))?.code?.replace('PowerState/', '') ??
			'unknown';
		items.push({
			name: vm.name ?? '',
			resourceGroup: rg,
			location: vm.location ?? '',
			vmSize: vm.hardwareProfile?.vmSize ?? '',
			powerState: power,
			provisioningState: vm.provisioningState ?? ''
		});
	}
	return items;
}

export async function getPowerState(clients: AzureClients, resourceGroup: string, vmName: string) {
	const view = await clients.compute.virtualMachines.instanceView(resourceGroup, vmName);
	return view.statuses?.find((s) => s.code?.startsWith('PowerState/'))?.code ?? 'PowerState/unknown';
}

export function isRunning(powerState: string) {
	return RUNNING.has(powerState.startsWith('PowerState/') ? powerState : `PowerState/${powerState}`);
}

export async function startVm(clients: AzureClients, resourceGroup: string, vmName: string) {
	await clients.compute.virtualMachines.beginStartAndWait(resourceGroup, vmName);
}

export async function deallocateVm(clients: AzureClients, resourceGroup: string, vmName: string) {
	await clients.compute.virtualMachines.beginDeallocateAndWait(resourceGroup, vmName);
}

export async function restartVm(clients: AzureClients, resourceGroup: string, vmName: string) {
	await clients.compute.virtualMachines.beginRestartAndWait(resourceGroup, vmName);
}

export async function createVmSimple(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		location: string;
		vmName: string;
		vmSize: string;
		imageReference: string;
		adminUsername: string;
		adminPassword: string;
	}
) {
	const { resourceGroup, location, vmName, vmSize, imageReference, adminUsername, adminPassword } =
		options;
	const [publisher, offer, sku, version] = imageReference.split(':');
	const vnetName = `${vmName}-vnet`;
	const subnetName = 'default';
	const nicName = `${vmName}-nic`;
	const pipName = `${vmName}-pip`;

	await clients.resources.resourceGroups.createOrUpdate(resourceGroup, { location });
	await clients.network.virtualNetworks.beginCreateOrUpdateAndWait(resourceGroup, vnetName, {
		location,
		addressSpace: { addressPrefixes: ['10.0.0.0/16'] },
		subnets: [{ name: subnetName, addressPrefix: '10.0.0.0/24' }]
	});
	await clients.network.publicIPAddresses.beginCreateOrUpdateAndWait(resourceGroup, pipName, {
		location,
		publicIPAllocationMethod: 'Dynamic',
		sku: { name: 'Basic' }
	});
	const pip = await clients.network.publicIPAddresses.get(resourceGroup, pipName);
	const vnet = await clients.network.virtualNetworks.get(resourceGroup, vnetName);
	const subnetId = vnet.subnets?.[0]?.id;
	if (!subnetId || !pip.id) throw new Error('网络资源创建失败');

	await clients.network.networkInterfaces.beginCreateOrUpdateAndWait(resourceGroup, nicName, {
		location,
		ipConfigurations: [
			{
				name: 'ipconfig1',
				subnet: { id: subnetId },
				privateIPAllocationMethod: 'Dynamic',
				publicIPAddress: { id: pip.id }
			}
		]
	});
	const nic = await clients.network.networkInterfaces.get(resourceGroup, nicName);
	if (!nic.id) throw new Error('网卡创建失败');

	await clients.compute.virtualMachines.beginCreateOrUpdateAndWait(resourceGroup, vmName, {
		location,
		hardwareProfile: { vmSize },
		storageProfile: {
			imageReference: { publisher, offer, sku, version }
		},
		osProfile: {
			computerName: vmName,
			adminUsername,
			adminPassword
		},
		networkProfile: {
			networkInterfaces: [{ id: nic.id, primary: true }]
		}
	});
}
