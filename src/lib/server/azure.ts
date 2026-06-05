import { ClientSecretCredential } from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import type { ResourceSku, Usage, VirtualMachineSize } from '@azure/arm-compute';
import type {
	NetworkInterface,
	NetworkInterfaceIPConfiguration,
	PublicIPAddress
} from '@azure/arm-network';
import type { ProxySettings } from '@azure/core-rest-pipeline';
import type { TokenCredentialOptions } from '@azure/identity';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { AzureAccount } from './db/schema';
import { decryptSecret } from './crypto';
import { ShadowsocksProxyAgent } from './shadowsocks-agent';
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
	publicIPv4: string;
	publicIPv6: string;
};

export type VmCapability = {
	name: string;
	family: string;
	tier: string;
	cores: number;
	memoryGB: number;
	maxDataDiskCount: number;
	acceleratedNetworking: boolean | null;
	hyperVGenerations: string;
	restricted: boolean;
	restrictionReasons: string[];
};

export type VmCapabilitiesResult = {
	location: string;
	available: VmCapability[];
	restricted: VmCapability[];
	highestCoreSize: VmCapability | null;
	largestMemorySize: VmCapability | null;
};

export type AzureRegionOption = {
	name: string;
	displayName: string;
	availableSizeCount: number;
	highestCoreSize: VmCapability | null;
	largestMemorySize: VmCapability | null;
};

export type ComputeQuota = {
	name: string;
	localizedName: string;
	current: number;
	limit: number;
	remaining: number;
	unit: string;
};

export type VmImageOption = {
	label: string;
	imageReference: string;
	publisher: string;
	offer: string;
	sku: string;
	version: string;
	osType: 'Linux' | 'Windows' | 'Unknown';
	architecture: string;
	hyperVGeneration: string;
};

export type CreateVmOptions = {
	resourceGroup: string;
	location: string;
	vmName: string;
	vmSize: string;
	imageReference: string;
	adminUsername: string;
	adminPassword: string;
	enableIpv6?: boolean;
	customData?: string;
	ipPrefix?: string;
	ipBrushMaxAttempts?: number;
};

export type CreateVmResult = {
	name: string;
	resourceGroup: string;
	location: string;
	publicIPv4: string;
	publicIPv6: string;
	ipBrushAttempts: number;
	ipBrushMatched: boolean;
};

export type ReplaceIpResult = {
	vmName: string;
	resourceGroup: string;
	publicIPv4: string;
	oldPublicIPv4: string;
	publicIpName: string;
};

export type BrushIpResult = ReplaceIpResult & {
	targetPrefix: string;
	attempts: number;
	matched: boolean;
};

export type AzureClients = {
	compute: ComputeManagementClient;
	network: NetworkManagementClient;
	resources: ResourceManagementClient;
	subscriptionId: string;
};

const RUNNING = new Set(['PowerState/running', 'PowerState/starting']);

const LOCATION_DISPLAY_NAMES: Record<string, string> = {
	australiacentral: 'Australia Central',
	australiaeast: 'Australia East',
	australiasoutheast: 'Australia Southeast',
	brazilsouth: 'Brazil South',
	canadacentral: 'Canada Central',
	canadaeast: 'Canada East',
	centralindia: 'Central India',
	centralus: 'Central US',
	eastasia: 'East Asia',
	eastus: 'East US',
	eastus2: 'East US 2',
	francecentral: 'France Central',
	germanywestcentral: 'Germany West Central',
	israelcentral: 'Israel Central',
	italynorth: 'Italy North',
	japaneast: 'Japan East',
	japanwest: 'Japan West',
	jioindiawest: 'Jio India West',
	koreacentral: 'Korea Central',
	koreasouth: 'Korea South',
	malaysiawest: 'Malaysia West',
	northcentralus: 'North Central US',
	northeurope: 'North Europe',
	norwayeast: 'Norway East',
	polandcentral: 'Poland Central',
	qatarcentral: 'Qatar Central',
	southafricanorth: 'South Africa North',
	southcentralus: 'South Central US',
	southeastasia: 'Southeast Asia',
	southindia: 'South India',
	spaincentral: 'Spain Central',
	swedencentral: 'Sweden Central',
	switzerlandnorth: 'Switzerland North',
	uaenorth: 'UAE North',
	uksouth: 'UK South',
	ukwest: 'UK West',
	westcentralus: 'West Central US',
	westeurope: 'West Europe',
	westindia: 'West India',
	westus: 'West US',
	westus2: 'West US 2',
	westus3: 'West US 3'
};

const FEATURED_IMAGE_CANDIDATES = [
	{
		label: 'Ubuntu 24.04 LTS',
		publisher: 'Canonical',
		offer: 'ubuntu-24_04-lts',
		sku: 'server',
		osType: 'Linux'
	},
	{
		label: 'Ubuntu 22.04 LTS Gen2',
		publisher: 'Canonical',
		offer: '0001-com-ubuntu-server-jammy',
		sku: '22_04-lts-gen2',
		osType: 'Linux'
	},
	{
		label: 'Ubuntu 20.04 LTS Gen2',
		publisher: 'Canonical',
		offer: '0001-com-ubuntu-server-focal',
		sku: '20_04-lts-gen2',
		osType: 'Linux'
	},
	{
		label: 'Debian 12 Gen2',
		publisher: 'Debian',
		offer: 'debian-12',
		sku: '12-gen2',
		osType: 'Linux'
	},
	{
		label: 'Debian 11 Gen2',
		publisher: 'Debian',
		offer: 'debian-11',
		sku: '11-gen2',
		osType: 'Linux'
	},
	{
		label: 'Windows Server 2022 Azure Edition',
		publisher: 'MicrosoftWindowsServer',
		offer: 'WindowsServer',
		sku: '2022-datacenter-azure-edition',
		osType: 'Windows'
	},
	{
		label: 'Windows Server 2022 Datacenter Gen2',
		publisher: 'MicrosoftWindowsServer',
		offer: 'WindowsServer',
		sku: '2022-datacenter-g2',
		osType: 'Windows'
	},
	{
		label: 'Windows Server 2019 Datacenter Gen2',
		publisher: 'MicrosoftWindowsServer',
		offer: 'WindowsServer',
		sku: '2019-datacenter-gensecond',
		osType: 'Windows'
	}
] as const;

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
	if (proxy.type === 'shadowsocks') {
		return { agent: new ShadowsocksProxyAgent(proxy) as TokenCredentialOptions['agent'] };
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

function parseResourceName(resourceId: string): string {
	const match = resourceId.match(/\/([^/]+)$/);
	return match ? decodeURIComponent(match[1]) : '';
}

function capabilityValue(sku: ResourceSku, name: string): string {
	return sku.capabilities?.find((capability) => capability.name === name)?.value ?? '';
}

function capabilityNumber(sku: ResourceSku, name: string): number {
	const value = Number(capabilityValue(sku, name));
	return Number.isFinite(value) ? value : 0;
}

function isLocationRestricted(sku: ResourceSku, location: string): boolean {
	const normalized = location.toLowerCase();
	return (
		sku.restrictions?.some((restriction) => {
			const locations = restriction.restrictionInfo?.locations ?? restriction.values ?? [];
			const appliesToLocation =
				locations.length === 0 || locations.some((item) => item.toLowerCase() === normalized);
			return appliesToLocation && restriction.reasonCode === 'NotAvailableForSubscription';
		}) ?? false
	);
}

function restrictionReasons(sku: ResourceSku, location: string): string[] {
	const normalized = location.toLowerCase();
	return (
		sku.restrictions
			?.filter((restriction) => {
				const locations = restriction.restrictionInfo?.locations ?? restriction.values ?? [];
				return locations.length === 0 || locations.some((item) => item.toLowerCase() === normalized);
			})
			.map((restriction) => restriction.reasonCode ?? restriction.type ?? 'Restricted')
			.filter(Boolean) ?? []
	);
}

function vmSizeToCapability(size: VirtualMachineSize): VmCapability {
	const memoryGB = Math.round(((size.memoryInMB ?? 0) / 1024) * 100) / 100;
	return {
		name: size.name ?? '',
		family: '',
		tier: '',
		cores: size.numberOfCores ?? 0,
		memoryGB,
		maxDataDiskCount: size.maxDataDiskCount ?? 0,
		acceleratedNetworking: null,
		hyperVGenerations: '',
		restricted: false,
		restrictionReasons: []
	};
}

function skuToCapability(sku: ResourceSku, location: string): VmCapability {
	const accelerated = capabilityValue(sku, 'AcceleratedNetworkingEnabled');
	return {
		name: sku.name ?? '',
		family: sku.family ?? '',
		tier: sku.tier ?? '',
		cores: capabilityNumber(sku, 'vCPUs'),
		memoryGB: capabilityNumber(sku, 'MemoryGB'),
		maxDataDiskCount: capabilityNumber(sku, 'MaxDataDiskCount'),
		acceleratedNetworking: accelerated ? accelerated.toLowerCase() === 'true' : null,
		hyperVGenerations: capabilityValue(sku, 'HyperVGenerations'),
		restricted: isLocationRestricted(sku, location),
		restrictionReasons: restrictionReasons(sku, location)
	};
}

function byCapacity(a: VmCapability, b: VmCapability) {
	if (a.cores !== b.cores) return a.cores - b.cores;
	if (a.memoryGB !== b.memoryGB) return a.memoryGB - b.memoryGB;
	return a.name.localeCompare(b.name);
}

function selectLargest(list: VmCapability[], key: 'cores' | 'memoryGB') {
	return [...list].sort((a, b) => {
		if (a[key] !== b[key]) return b[key] - a[key];
		if (a.cores !== b.cores) return b.cores - a.cores;
		if (a.memoryGB !== b.memoryGB) return b.memoryGB - a.memoryGB;
		return a.name.localeCompare(b.name);
	})[0] ?? null;
}

function displayLocationName(location: string) {
	return LOCATION_DISPLAY_NAMES[location.toLowerCase()] ?? location;
}

function latestImageVersion(versions: { name?: string }[]) {
	return [...versions]
		.map((version) => version.name ?? '')
		.filter(Boolean)
		.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))[0];
}

async function collectPublicIps(clients: AzureClients, vm: { networkProfile?: { networkInterfaces?: { id?: string }[] } }) {
	const ips = { publicIPv4: '', publicIPv6: '' };
	for (const nicRef of vm.networkProfile?.networkInterfaces ?? []) {
		const nicId = nicRef.id ?? '';
		const nicName = parseResourceName(nicId);
		const nicResourceGroup = parseResourceGroup(nicId);
		if (!nicName || !nicResourceGroup) continue;

		try {
			const nic = await clients.network.networkInterfaces.get(nicResourceGroup, nicName);
			for (const config of nic.ipConfigurations ?? []) {
				const pipId = config.publicIPAddress?.id;
				if (!pipId) continue;
				const pipName = parseResourceName(pipId);
				const pipResourceGroup = parseResourceGroup(pipId);
				if (!pipName || !pipResourceGroup) continue;
				const pip = await clients.network.publicIPAddresses.get(pipResourceGroup, pipName);
				if (pip.publicIPAddressVersion === 'IPv6') ips.publicIPv6 ||= pip.ipAddress ?? '';
				else ips.publicIPv4 ||= pip.ipAddress ?? '';
			}
		} catch {
			// Keep listing resilient even if one NIC/IP has been removed concurrently.
		}
	}
	return ips;
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
		const publicIps = await collectPublicIps(clients, vm);
		items.push({
			name: vm.name ?? '',
			resourceGroup: rg,
			location: vm.location ?? '',
			vmSize: vm.hardwareProfile?.vmSize ?? '',
			powerState: power,
			provisioningState: vm.provisioningState ?? '',
			publicIPv4: publicIps.publicIPv4,
			publicIPv6: publicIps.publicIPv6
		});
	}
	return items;
}

export async function listVmCapabilities(
	clients: AzureClients,
	location: string
): Promise<VmCapabilitiesResult> {
	const skus: VmCapability[] = [];

	try {
		for await (const sku of clients.compute.resourceSkus.list({
			filter: `location eq '${location}'`
		})) {
			if (sku.resourceType !== 'virtualMachines' || !sku.name) continue;
			skus.push(skuToCapability(sku, location));
		}
	} catch {
		for await (const size of clients.compute.virtualMachineSizes.list(location)) {
			if (size.name) skus.push(vmSizeToCapability(size));
		}
	}

	const available = skus
		.filter((sku) => !sku.restricted)
		.sort((a, b) => byCapacity(a, b));
	const restricted = skus
		.filter((sku) => sku.restricted)
		.sort((a, b) => byCapacity(a, b));

	return {
		location,
		available,
		restricted,
		highestCoreSize: selectLargest(available, 'cores'),
		largestMemorySize: selectLargest(available, 'memoryGB')
	};
}

export async function listAvailableVmRegions(clients: AzureClients): Promise<AzureRegionOption[]> {
	const byRegion = new Map<string, VmCapability[]>();

	for await (const sku of clients.compute.resourceSkus.list()) {
		if (sku.resourceType !== 'virtualMachines' || !sku.name) continue;
		for (const region of sku.locations ?? []) {
			const location = region.toLowerCase();
			const capability = skuToCapability(sku, location);
			if (capability.restricted) continue;
			const list = byRegion.get(location) ?? [];
			list.push(capability);
			byRegion.set(location, list);
		}
	}

	return [...byRegion.entries()]
		.map(([name, available]) => ({
			name,
			displayName: displayLocationName(name),
			availableSizeCount: available.length,
			highestCoreSize: selectLargest(available, 'cores'),
			largestMemorySize: selectLargest(available, 'memoryGB')
		}))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function listFeaturedVmImages(
	clients: AzureClients,
	location: string
): Promise<VmImageOption[]> {
	const images: VmImageOption[] = [];

	for (const candidate of FEATURED_IMAGE_CANDIDATES) {
		try {
			const versions = await clients.compute.virtualMachineImages.list(
				location,
				candidate.publisher,
				candidate.offer,
				candidate.sku,
				{ top: 1, orderby: 'name desc' }
			);
			const version = latestImageVersion(versions);
			if (!version) continue;

			let architecture = '';
			let hyperVGeneration = '';
			try {
				const image = await clients.compute.virtualMachineImages.get(
					location,
					candidate.publisher,
					candidate.offer,
					candidate.sku,
					version
				);
				architecture = image.architecture ?? '';
				hyperVGeneration = image.hyperVGeneration ?? '';
			} catch {
				// Version listing is enough for creation; details only enrich the dropdown.
			}

			images.push({
				label: `${candidate.label} (${version})`,
				imageReference: `${candidate.publisher}:${candidate.offer}:${candidate.sku}:${version}`,
				publisher: candidate.publisher,
				offer: candidate.offer,
				sku: candidate.sku,
				version,
				osType: candidate.osType,
				architecture,
				hyperVGeneration
			});
		} catch {
			// Some publishers/offers are not available in every region or subscription.
		}
	}

	return images;
}

function usageToQuota(usage: Usage): ComputeQuota {
	const current = usage.currentValue ?? 0;
	const limit = usage.limit ?? 0;
	return {
		name: usage.name?.value ?? '',
		localizedName: usage.name?.localizedValue ?? usage.name?.value ?? '',
		current,
		limit,
		remaining: Math.max(limit - current, 0),
		unit: usage.unit ?? 'Count'
	};
}

export async function listComputeQuotas(clients: AzureClients, location: string): Promise<ComputeQuota[]> {
	const quotas: ComputeQuota[] = [];
	for await (const usage of clients.compute.usageOperations.list(location)) {
		quotas.push(usageToQuota(usage));
	}
	return quotas.sort((a, b) => a.localizedName.localeCompare(b.localizedName));
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

function parseImageReference(imageReference: string) {
	const [publisher, offer, sku, version] = imageReference.split(':');
	if (!publisher || !offer || !sku || !version) {
		throw new Error('镜像格式应为 publisher:offer:sku:version');
	}
	return { publisher, offer, sku, version };
}

function encodeCustomData(customData?: string): string | undefined {
	if (!customData?.trim()) return undefined;
	if (Buffer.byteLength(customData, 'utf8') > 65535) {
		throw new Error('UserData/CustomData 解码后不能超过 65535 字节');
	}
	return Buffer.from(customData, 'utf8').toString('base64');
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeResourceName(value: string) {
	return value.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^-+|-+$/g, '') || 'azure-panel';
}

function resourceName(base: string, suffix: string, maxLength = 80) {
	const cleanBase = sanitizeResourceName(base);
	const cleanSuffix = sanitizeResourceName(suffix);
	const separator = '-';
	const available = Math.max(maxLength - cleanSuffix.length - separator.length, 1);
	return `${cleanBase.slice(0, available)}${separator}${cleanSuffix}`;
}

function normalizeIpPrefix(prefix?: string) {
	const value = (prefix ?? '').trim();
	if (!value) return '';
	if (!/^\d{1,3}(?:\.\d{1,3}){0,3}$/.test(value)) {
		throw new Error('IPv4 前缀格式不正确，例如 85.211');
	}
	const segments = value.split('.').map(Number);
	if (segments.some((segment) => segment < 0 || segment > 255)) {
		throw new Error('IPv4 前缀每段必须在 0-255 之间');
	}
	return value;
}

function normalizeAttempts(value?: number, fallback = 30) {
	const parsed = Math.floor(Number(value ?? fallback));
	if (!Number.isFinite(parsed) || parsed < 1) return fallback;
	return Math.min(parsed, 500);
}

async function waitForPublicIpAddress(
	clients: AzureClients,
	resourceGroup: string,
	publicIpName: string
): Promise<PublicIPAddress> {
	let pip = await clients.network.publicIPAddresses.get(resourceGroup, publicIpName);
	for (let i = 0; i < 8 && !pip.ipAddress; i++) {
		await sleep(1500);
		pip = await clients.network.publicIPAddresses.get(resourceGroup, publicIpName);
	}
	return pip;
}

async function createPublicIp(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		location: string;
		name: string;
		version: 'IPv4' | 'IPv6';
	}
): Promise<PublicIPAddress> {
	const pip = await clients.network.publicIPAddresses.beginCreateOrUpdateAndWait(
		options.resourceGroup,
		options.name,
		{
			location: options.location,
			publicIPAllocationMethod: 'Static',
			publicIPAddressVersion: options.version,
			sku: { name: 'Standard' },
			deleteOption: 'Delete'
		}
	);
	return pip.ipAddress ? pip : waitForPublicIpAddress(clients, options.resourceGroup, options.name);
}

async function deletePublicIpById(clients: AzureClients, publicIpId?: string) {
	if (!publicIpId) return;
	const name = parseResourceName(publicIpId);
	const resourceGroup = parseResourceGroup(publicIpId);
	if (!name || !resourceGroup) return;
	try {
		await clients.network.publicIPAddresses.beginDeleteAndWait(resourceGroup, name);
	} catch (err) {
		const statusCode = (err as { statusCode?: number }).statusCode;
		if (statusCode !== 404) throw err;
	}
}

async function createMatchingIPv4PublicIp(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		location: string;
		vmName: string;
		targetPrefix?: string;
		maxAttempts?: number;
		nameSalt?: string;
	}
): Promise<{ pip: PublicIPAddress; attempts: number; matched: boolean }> {
	const targetPrefix = normalizeIpPrefix(options.targetPrefix);
	const maxAttempts = targetPrefix ? normalizeAttempts(options.maxAttempts) : 1;
	const salt = options.nameSalt ?? String(Date.now());

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const name = resourceName(options.vmName, `pip4-${salt}-${attempt}`);
		const pip = await createPublicIp(clients, {
			resourceGroup: options.resourceGroup,
			location: options.location,
			name,
			version: 'IPv4'
		});
		const address = pip.ipAddress ?? '';
		const matched = !targetPrefix || address.startsWith(targetPrefix);
		if (matched) return { pip, attempts: attempt, matched: Boolean(targetPrefix) };

		await deletePublicIpById(clients, pip.id);
	}

	throw new Error(`刷 IP 未匹配 ${targetPrefix}，已达到最大尝试次数 ${maxAttempts}`);
}

async function getPrimaryNicAndIPv4Config(
	clients: AzureClients,
	resourceGroup: string,
	vmName: string
): Promise<{
	vmLocation: string;
	nicResourceGroup: string;
	nicName: string;
	nic: NetworkInterface;
	ipConfig: NetworkInterfaceIPConfiguration;
}> {
	const vm = await clients.compute.virtualMachines.get(resourceGroup, vmName);
	const nicRef =
		vm.networkProfile?.networkInterfaces?.find((networkInterface) => networkInterface.primary) ??
		vm.networkProfile?.networkInterfaces?.[0];
	const nicId = nicRef?.id ?? '';
	const nicName = parseResourceName(nicId);
	const nicResourceGroup = parseResourceGroup(nicId);
	if (!nicName || !nicResourceGroup) throw new Error('未找到 VM 主网卡');

	const nic = await clients.network.networkInterfaces.get(nicResourceGroup, nicName);
	const ipConfig =
		nic.ipConfigurations?.find(
			(config) => config.privateIPAddressVersion !== 'IPv6' && config.primary
		) ??
		nic.ipConfigurations?.find((config) => config.privateIPAddressVersion !== 'IPv6') ??
		nic.ipConfigurations?.[0];
	if (!ipConfig) throw new Error('未找到网卡 IPv4 配置');

	return {
		vmLocation: vm.location ?? nic.location ?? '',
		nicResourceGroup,
		nicName,
		nic,
		ipConfig
	};
}

async function attachPublicIpToNic(
	clients: AzureClients,
	options: {
		nicResourceGroup: string;
		nicName: string;
		nic: NetworkInterface;
		ipConfig: NetworkInterfaceIPConfiguration;
		publicIpId: string;
	}
) {
	options.ipConfig.publicIPAddress = { id: options.publicIpId };
	await clients.network.networkInterfaces.beginCreateOrUpdateAndWait(
		options.nicResourceGroup,
		options.nicName,
		options.nic
	);
}

async function createNetworkForVm(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		location: string;
		vmName: string;
		enableIpv6: boolean;
		ipPrefix?: string;
		ipBrushMaxAttempts?: number;
	}
) {
	const vnetName = resourceName(options.vmName, 'vnet');
	const subnetName = 'default';
	const nicName = resourceName(options.vmName, 'nic');
	const addressPrefixes = options.enableIpv6
		? ['10.0.0.0/16', 'fd00:db8:deca::/48']
		: ['10.0.0.0/16'];
	const subnetAddressPrefixes = options.enableIpv6
		? ['10.0.0.0/24', 'fd00:db8:deca:1::/64']
		: ['10.0.0.0/24'];

	await clients.resources.resourceGroups.createOrUpdate(options.resourceGroup, {
		location: options.location
	});
	await clients.network.virtualNetworks.beginCreateOrUpdateAndWait(options.resourceGroup, vnetName, {
		location: options.location,
		addressSpace: { addressPrefixes },
		subnets: [{ name: subnetName, addressPrefixes: subnetAddressPrefixes }]
	});

	const ipv4 = await createMatchingIPv4PublicIp(clients, {
		resourceGroup: options.resourceGroup,
		location: options.location,
		vmName: options.vmName,
		targetPrefix: options.ipPrefix,
		maxAttempts: options.ipBrushMaxAttempts
	});
	const ipv6 = options.enableIpv6
		? await createPublicIp(clients, {
				resourceGroup: options.resourceGroup,
				location: options.location,
				name: resourceName(options.vmName, 'pip6'),
				version: 'IPv6'
			})
		: null;
	const vnet = await clients.network.virtualNetworks.get(options.resourceGroup, vnetName);
	const subnetId = vnet.subnets?.[0]?.id;
	if (!subnetId || !ipv4.pip.id) throw new Error('网络资源创建失败');
	if (options.enableIpv6 && !ipv6?.id) throw new Error('IPv6 公网 IP 创建失败');

	const ipConfigurations: NetworkInterfaceIPConfiguration[] = [
		{
			name: 'ipconfig-ipv4',
			primary: true,
			subnet: { id: subnetId },
			privateIPAllocationMethod: 'Dynamic',
			privateIPAddressVersion: 'IPv4',
			publicIPAddress: { id: ipv4.pip.id }
		}
	];
	if (ipv6?.id) {
		ipConfigurations.push({
			name: 'ipconfig-ipv6',
			primary: false,
			subnet: { id: subnetId },
			privateIPAllocationMethod: 'Dynamic',
			privateIPAddressVersion: 'IPv6',
			publicIPAddress: { id: ipv6.id }
		});
	}

	const nic = await clients.network.networkInterfaces.beginCreateOrUpdateAndWait(
		options.resourceGroup,
		nicName,
		{
			location: options.location,
			ipConfigurations
		}
	);
	if (!nic.id) throw new Error('网卡创建失败');

	return {
		nic,
		publicIPv4: ipv4.pip.ipAddress ?? '',
		publicIPv6: ipv6?.ipAddress ?? '',
		ipBrushAttempts: ipv4.attempts,
		ipBrushMatched: ipv4.matched
	};
}

export async function createVmAdvanced(
	clients: AzureClients,
	options: CreateVmOptions
): Promise<CreateVmResult> {
	const {
		resourceGroup,
		location,
		vmName,
		vmSize,
		imageReference,
		adminUsername,
		adminPassword
	} = options;
	const { publisher, offer, sku, version } = parseImageReference(imageReference);
	const customData = encodeCustomData(options.customData);
	const network = await createNetworkForVm(clients, {
		resourceGroup,
		location,
		vmName,
		enableIpv6: options.enableIpv6 === true,
		ipPrefix: options.ipPrefix,
		ipBrushMaxAttempts: options.ipBrushMaxAttempts
	});

	await clients.compute.virtualMachines.beginCreateOrUpdateAndWait(resourceGroup, vmName, {
		location,
		hardwareProfile: { vmSize },
		storageProfile: {
			imageReference: { publisher, offer, sku, version }
		},
		osProfile: {
			computerName: vmName,
			adminUsername,
			adminPassword,
			customData
		},
		userData: customData,
		networkProfile: {
			networkInterfaces: [{ id: network.nic.id, primary: true }]
		}
	});

	return {
		name: vmName,
		resourceGroup,
		location,
		publicIPv4: network.publicIPv4,
		publicIPv6: network.publicIPv6,
		ipBrushAttempts: network.ipBrushAttempts,
		ipBrushMatched: network.ipBrushMatched
	};
}

export async function createVmSimple(
	clients: AzureClients,
	options: CreateVmOptions
): Promise<CreateVmResult> {
	return createVmAdvanced(clients, options);
}

export async function replaceVmPublicIPv4(
	clients: AzureClients,
	resourceGroup: string,
	vmName: string
): Promise<ReplaceIpResult> {
	const { vmLocation, nicResourceGroup, nicName, nic, ipConfig } = await getPrimaryNicAndIPv4Config(
		clients,
		resourceGroup,
		vmName
	);
	const oldPublicIpId = ipConfig.publicIPAddress?.id;
	const oldPublicIpName = oldPublicIpId ? parseResourceName(oldPublicIpId) : '';
	const oldPublicIpResourceGroup = oldPublicIpId ? parseResourceGroup(oldPublicIpId) : '';
	const oldPublicIp = oldPublicIpName
		? await clients.network.publicIPAddresses
				.get(oldPublicIpResourceGroup, oldPublicIpName)
				.catch(() => null)
		: null;
	const created = await createMatchingIPv4PublicIp(clients, {
		resourceGroup: nicResourceGroup,
		location: vmLocation,
		vmName,
		nameSalt: String(Date.now())
	});
	if (!created.pip.id) throw new Error('新公网 IPv4 创建失败');

	try {
		await attachPublicIpToNic(clients, {
			nicResourceGroup,
			nicName,
			nic,
			ipConfig,
			publicIpId: created.pip.id
		});
	} catch (err) {
		await deletePublicIpById(clients, created.pip.id);
		throw err;
	}
	await deletePublicIpById(clients, oldPublicIpId);

	const fresh = await waitForPublicIpAddress(
		clients,
		nicResourceGroup,
		parseResourceName(created.pip.id)
	);
	return {
		vmName,
		resourceGroup,
		publicIPv4: fresh.ipAddress ?? created.pip.ipAddress ?? '',
		oldPublicIPv4: oldPublicIp?.ipAddress ?? '',
		publicIpName: fresh.name ?? parseResourceName(created.pip.id)
	};
}

export async function brushVmPublicIPv4Prefix(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		vmName: string;
		ipPrefix: string;
		maxAttempts?: number;
	}
): Promise<BrushIpResult> {
	const targetPrefix = normalizeIpPrefix(options.ipPrefix);
	if (!targetPrefix) throw new Error('缺少 IPv4 前缀');

	const { vmLocation, nicResourceGroup, nicName, nic, ipConfig } = await getPrimaryNicAndIPv4Config(
		clients,
		options.resourceGroup,
		options.vmName
	);
	const oldPublicIpId = ipConfig.publicIPAddress?.id;
	const oldPublicIpName = oldPublicIpId ? parseResourceName(oldPublicIpId) : '';
	const oldPublicIpResourceGroup = oldPublicIpId ? parseResourceGroup(oldPublicIpId) : '';
	const oldPublicIp = oldPublicIpName
		? await clients.network.publicIPAddresses
				.get(oldPublicIpResourceGroup, oldPublicIpName)
				.catch(() => null)
		: null;
	const created = await createMatchingIPv4PublicIp(clients, {
		resourceGroup: nicResourceGroup,
		location: vmLocation,
		vmName: options.vmName,
		targetPrefix,
		maxAttempts: options.maxAttempts,
		nameSalt: String(Date.now())
	});
	if (!created.pip.id) throw new Error('匹配公网 IPv4 创建失败');

	try {
		await attachPublicIpToNic(clients, {
			nicResourceGroup,
			nicName,
			nic,
			ipConfig,
			publicIpId: created.pip.id
		});
	} catch (err) {
		await deletePublicIpById(clients, created.pip.id);
		throw err;
	}
	await deletePublicIpById(clients, oldPublicIpId);

	const fresh = await waitForPublicIpAddress(
		clients,
		nicResourceGroup,
		parseResourceName(created.pip.id)
	);
	return {
		vmName: options.vmName,
		resourceGroup: options.resourceGroup,
		publicIPv4: fresh.ipAddress ?? created.pip.ipAddress ?? '',
		oldPublicIPv4: oldPublicIp?.ipAddress ?? '',
		publicIpName: fresh.name ?? parseResourceName(created.pip.id),
		targetPrefix,
		attempts: created.attempts,
		matched: true
	};
}
