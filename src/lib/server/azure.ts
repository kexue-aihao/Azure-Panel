import { ClientSecretCredential } from '@azure/identity';
import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import type { ResourceSku, ResourceSkuRestrictions, Usage, VirtualMachineSize } from '@azure/arm-compute';
import type { GenericResourceExpanded, Provider, ResourceGroup } from '@azure/arm-resources';
import type {
	NetworkInterface,
	NetworkInterfaceIPConfiguration,
	PublicIPAddress
} from '@azure/arm-network';
import {
	createDefaultHttpClient,
	createHttpHeaders,
	createPipelineFromOptions,
	createPipelineRequest,
	type PipelineOptions,
	type ProxySettings
} from '@azure/core-rest-pipeline';
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
import { readEnv } from './runtime-env';

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
	source: string;
	family: string;
	tier: string;
	cores: number;
	memoryGB: number;
	maxDataDiskCount: number;
	acceleratedNetworking: boolean | null;
	hyperVGenerations: string;
	restricted: boolean;
	restrictionReasons: string[];
	quotaName: string;
	quotaLocalizedName: string;
	quotaRemaining: number;
	totalQuotaRemaining: number;
	quotaRequired: number;
	quotaRestricted: boolean;
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

export type AzureCredentialValidationResult = {
	subscriptionId: string;
};

type AzureClientOptions = TokenCredentialOptions & PipelineOptions;

export type AzureSubscription = {
	subscriptionId?: string;
	displayName?: string;
	state?: string;
};

export type AzureResourceGroupInfo = {
	id: string;
	name: string;
	location: string;
	provisioningState: string;
};

export type AzureResourceInfo = {
	id: string;
	name: string;
	type: string;
	location: string;
	resourceGroup: string;
	kind: string;
	skuName: string;
	provisioningState: string;
};

export type AzureProviderStatus = {
	namespace: string;
	registrationState: string;
	registrationPolicy: string;
	resourceTypeCount: number;
	locations: string[];
};

export type AiAccountInfo = {
	id: string;
	name: string;
	resourceGroup: string;
	location: string;
	kind: string;
	skuName: string;
	endpoint: string;
	provisioningState: string;
	publicNetworkAccess: string;
};

export type AiAccountKeys = {
	endpoint: string;
	key1: string;
	key2: string;
};

export type AiDeploymentInfo = {
	id: string;
	name: string;
	resourceGroup: string;
	accountName: string;
	modelFormat: string;
	modelName: string;
	modelVersion: string;
	scaleType: string;
	capacity: number;
	provisioningState: string;
};

export type CreateAiAccountOptions = {
	resourceGroup: string;
	location: string;
	accountName: string;
	kind?: string;
	skuName?: string;
};

export type CreateAiDeploymentOptions = {
	resourceGroup: string;
	accountName: string;
	deploymentName: string;
	modelFormat?: string;
	modelName: string;
	modelVersion?: string;
	scaleType?: string;
	capacity?: number;
};

const RUNNING = new Set(['PowerState/running', 'PowerState/starting']);
const ARM_ENDPOINT = 'https://management.azure.com';
const ARM_SCOPE = `${ARM_ENDPOINT}/.default`;
const SUBSCRIPTIONS_API_VERSION = '2020-01-01';
const COGNITIVE_SERVICES_API_VERSION = '2024-10-01';
export const DEFAULT_PROVIDER_NAMESPACES = [
	'Microsoft.Compute',
	'Microsoft.Network',
	'Microsoft.Storage',
	'Microsoft.KeyVault',
	'Microsoft.CognitiveServices',
	'Microsoft.MachineLearningServices'
];

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

const REGION_SCAN_PRIORITY = [
	'malaysiawest',
	'eastasia',
	'southeastasia',
	'japaneast',
	'japanwest',
	'koreacentral',
	'koreasouth',
	'australiaeast',
	'eastus',
	'eastus2',
	'centralus',
	'southcentralus',
	'westus',
	'westus2',
	'westus3',
	'northcentralus',
	'uksouth',
	'ukwest',
	'northeurope',
	'westeurope',
	'francecentral',
	'germanywestcentral',
	'swedencentral',
	'canadacentral'
];

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

function azureClientOptions(proxy?: ProxyRuntimeConfig | null): AzureClientOptions {
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

function createCredentialAndOptions(
	account: AzureAccount,
	proxy?: ProxyRuntimeConfig | null
): { credential: ClientSecretCredential; clientOptions: AzureClientOptions } {
	const runtimeProxy = proxy ?? decryptLegacyProxy(account);
	const clientOptions = azureClientOptions(runtimeProxy);
	const credential = new ClientSecretCredential(
		account.tenantId,
		account.clientId,
		decryptSecret(account.clientSecretEncrypted),
		clientOptions
	);
	return { credential, clientOptions };
}

export function createAzureClientsForSubscription(
	account: AzureAccount,
	subscriptionId: string,
	proxy?: ProxyRuntimeConfig | null
): AzureClients {
	const { credential, clientOptions } = createCredentialAndOptions(account, proxy);
	return {
		compute: new ComputeManagementClient(credential, subscriptionId, clientOptions),
		network: new NetworkManagementClient(credential, subscriptionId, clientOptions),
		resources: new ResourceManagementClient(credential, subscriptionId, clientOptions),
		subscriptionId
	};
}

function armResponseError(status: number, bodyAsText?: string | null) {
	let detail = '';
	try {
		const parsed = bodyAsText ? JSON.parse(bodyAsText) : null;
		detail = parsed?.error?.message ?? parsed?.error?.code ?? '';
	} catch {
		detail = bodyAsText ?? '';
	}
	return `Azure ARM 请求失败 (${status})${detail ? `: ${detail}` : ''}`;
}

function parseArmJson(bodyAsText?: string | null): unknown {
	if (!bodyAsText) return {};
	try {
		return JSON.parse(bodyAsText);
	} catch {
		return {};
	}
}

async function sendArmRequest(
	credential: ClientSecretCredential,
	clientOptions: AzureClientOptions,
	options: {
		method: 'GET' | 'POST' | 'PUT';
		pathOrUrl: string;
		body?: unknown;
	}
) {
	const token = await credential.getToken(ARM_SCOPE);
	if (!token?.token) throw new Error('无法获取 Azure 访问令牌，请检查 Tenant ID、Client ID 和 Client Secret');

	const pipeline = createPipelineFromOptions(clientOptions);
	const httpClient = createDefaultHttpClient();
	const response = await pipeline.sendRequest(
		httpClient,
		createPipelineRequest({
			url: options.pathOrUrl.startsWith('http')
				? options.pathOrUrl
				: `${ARM_ENDPOINT}${options.pathOrUrl}`,
			method: options.method,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			headers: createHttpHeaders({
				accept: 'application/json',
				authorization: `Bearer ${token.token}`,
				...(options.body === undefined ? {} : { 'content-type': 'application/json' })
			})
		})
	);

	if (response.status < 200 || response.status >= 300) {
		throw new Error(armResponseError(response.status, response.bodyAsText));
	}
	return parseArmJson(response.bodyAsText);
}

async function collectArmPages<T>(
	credential: ClientSecretCredential,
	clientOptions: AzureClientOptions,
	firstUrl: string
): Promise<T[]> {
	const items: T[] = [];
	let nextLink = firstUrl;
	while (nextLink) {
		const payload = (await sendArmRequest(credential, clientOptions, {
			method: 'GET',
			pathOrUrl: nextLink
		})) as { value?: T[]; nextLink?: string };
		items.push(...(payload.value ?? []));
		nextLink = String(payload.nextLink ?? '');
	}
	return items;
}

async function discoverSubscriptionId(
	credential: ClientSecretCredential,
	clientOptions: AzureClientOptions
) {
	const token = await credential.getToken(ARM_SCOPE);
	if (!token?.token) throw new Error('无法获取 Azure 访问令牌，请检查 Tenant ID、Client ID 和 Client Secret');

	const pipeline = createPipelineFromOptions(clientOptions);
	const httpClient = createDefaultHttpClient();
	const subscriptions: AzureSubscription[] = [];
	let nextLink = `${ARM_ENDPOINT}/subscriptions?api-version=${SUBSCRIPTIONS_API_VERSION}`;

	while (nextLink) {
		const response = await pipeline.sendRequest(
			httpClient,
			createPipelineRequest({
				url: nextLink,
				method: 'GET',
				headers: createHttpHeaders({
					accept: 'application/json',
					authorization: `Bearer ${token.token}`
				})
			})
		);

		if (response.status < 200 || response.status >= 300) {
			throw new Error(armResponseError(response.status, response.bodyAsText));
		}

		const payload = response.bodyAsText ? JSON.parse(response.bodyAsText) : {};
		subscriptions.push(...((payload.value ?? []) as AzureSubscription[]));
		nextLink = String(payload.nextLink ?? '');
	}

	const selected =
		subscriptions.find((subscription) => subscription.state?.toLowerCase() === 'enabled') ??
		subscriptions[0];
	if (!selected?.subscriptionId) {
		throw new Error('未发现可用 Azure 订阅，请确认 Service Principal 已分配订阅权限');
	}
	return selected.subscriptionId;
}

export async function validateAzureCredentials(
	tenantId: string,
	clientId: string,
	clientSecret: string,
	proxy?: ProxyRuntimeConfig | string | null
): Promise<AzureCredentialValidationResult> {
	const runtimeProxy = typeof proxy === 'string' ? parseProxyUrl(proxy) : proxy;
	const clientOptions = azureClientOptions(runtimeProxy);
	const credential = new ClientSecretCredential(tenantId, clientId, clientSecret, clientOptions);
	const subscriptionId = await discoverSubscriptionId(credential, clientOptions);
	const client = new ComputeManagementClient(credential, subscriptionId, clientOptions);
	await client.virtualMachines.listAll().next();
	return { subscriptionId };
}

export async function listAccountSubscriptions(
	account: AzureAccount,
	proxy?: ProxyRuntimeConfig | null
): Promise<AzureSubscription[]> {
	const { credential, clientOptions } = createCredentialAndOptions(account, proxy);
	const subscriptions = await collectArmPages<AzureSubscription>(
		credential,
		clientOptions,
		`${ARM_ENDPOINT}/subscriptions?api-version=${SUBSCRIPTIONS_API_VERSION}`
	);
	return subscriptions.sort((a, b) => {
		const enabledA = a.state?.toLowerCase() === 'enabled' ? 0 : 1;
		const enabledB = b.state?.toLowerCase() === 'enabled' ? 0 : 1;
		if (enabledA !== enabledB) return enabledA - enabledB;
		return (a.displayName ?? a.subscriptionId ?? '').localeCompare(
			b.displayName ?? b.subscriptionId ?? ''
		);
	});
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
	const normalized = name.toLowerCase();
	return (
		sku.capabilities?.find((capability) => capability.name?.toLowerCase() === normalized)?.value ?? ''
	);
}

function capabilityNumber(sku: ResourceSku, name: string): number {
	const value = Number(capabilityValue(sku, name));
	return Number.isFinite(value) ? value : 0;
}

function capabilityNumberAny(sku: ResourceSku, names: string[]): number {
	for (const name of names) {
		const value = capabilityNumber(sku, name);
		if (value > 0) return value;
	}
	return 0;
}

function normalizeLocationName(location: string) {
	return location.toLowerCase().replace(/\s+/g, '');
}

function restrictionLocations(restriction: ResourceSkuRestrictions) {
	return [
		...(restriction.restrictionInfo?.locations ?? []),
		...(restriction.values ?? [])
	].filter(Boolean);
}

function restrictionAppliesToLocation(restriction: ResourceSkuRestrictions, location: string): boolean {
	const normalized = normalizeLocationName(location);
	const locations = restrictionLocations(restriction);
	return (
		locations.length === 0 ||
		locations.some((item) => normalizeLocationName(item) === normalized)
	);
}

function isLocationWideRestriction(restriction: ResourceSkuRestrictions) {
	return restriction.type !== 'Zone';
}

function skuLocations(sku: ResourceSku) {
	return [
		...(sku.locations ?? []),
		...(sku.locationInfo?.map((info) => info.location ?? '') ?? [])
	]
		.map((location) => normalizeLocationName(location))
		.filter(Boolean);
}

function skuAppliesToLocation(sku: ResourceSku, location: string) {
	const normalized = normalizeLocationName(location);
	const locations = skuLocations(sku);
	return locations.length === 0 || locations.some((item) => item === normalized);
}

function isLocationRestricted(sku: ResourceSku, location: string): boolean {
	return (
		sku.restrictions?.some((restriction) => {
			return (
				restrictionAppliesToLocation(restriction, location) &&
				isLocationWideRestriction(restriction)
			);
		}) ?? false
	);
}

function restrictionReasons(sku: ResourceSku, location: string): string[] {
	return (
		sku.restrictions
			?.filter((restriction) => {
				return restrictionAppliesToLocation(restriction, location);
			})
			.map((restriction) => {
				const reason = restriction.reasonCode ?? restriction.type ?? 'Restricted';
				return restriction.type === 'Zone' ? `Zone:${reason}` : reason;
			})
			.filter(Boolean) ?? []
	);
}

function vmSizeToCapability(size: VirtualMachineSize): VmCapability {
	const memoryGB = Math.round(((size.memoryInMB ?? 0) / 1024) * 100) / 100;
	return {
		name: size.name ?? '',
		source: 'VirtualMachineSizes',
		family: '',
		tier: '',
		cores: size.numberOfCores ?? 0,
		memoryGB,
		maxDataDiskCount: size.maxDataDiskCount ?? 0,
		acceleratedNetworking: null,
		hyperVGenerations: '',
		restricted: false,
		restrictionReasons: [],
		quotaName: '',
		quotaLocalizedName: '',
		quotaRemaining: 0,
		totalQuotaRemaining: 0,
		quotaRequired: size.numberOfCores ?? 0,
		quotaRestricted: false
	};
}

function skuToCapability(sku: ResourceSku, location: string): VmCapability {
	const accelerated = capabilityValue(sku, 'AcceleratedNetworkingEnabled');
	const quotaVcpus = capabilityNumber(sku, 'vCPUs');
	const displayVcpus = capabilityNumberAny(sku, ['vCPUsAvailable', 'vCPUs']);
	return {
		name: sku.name ?? '',
		source: 'ResourceSkus',
		family: sku.family ?? '',
		tier: sku.tier ?? '',
		cores: displayVcpus,
		memoryGB: capabilityNumber(sku, 'MemoryGB'),
		maxDataDiskCount: capabilityNumber(sku, 'MaxDataDiskCount'),
		acceleratedNetworking: accelerated ? accelerated.toLowerCase() === 'true' : null,
		hyperVGenerations: capabilityValue(sku, 'HyperVGenerations'),
		restricted: isLocationRestricted(sku, location),
		restrictionReasons: restrictionReasons(sku, location),
		quotaName: '',
		quotaLocalizedName: '',
		quotaRemaining: 0,
		totalQuotaRemaining: 0,
		quotaRequired: quotaVcpus || displayVcpus,
		quotaRestricted: false
	};
}

function mergeSource(a: string, b: string) {
	return [...new Set([a, b].filter(Boolean).flatMap((source) => source.split('+')))].join('+');
}

function mergeCapability(a: VmCapability, b: VmCapability): VmCapability {
	return {
		...a,
		source: mergeSource(a.source, b.source),
		family: a.family || b.family,
		tier: a.tier || b.tier,
		cores: a.cores || b.cores,
		memoryGB: a.memoryGB || b.memoryGB,
		maxDataDiskCount: a.maxDataDiskCount || b.maxDataDiskCount,
		acceleratedNetworking: a.acceleratedNetworking ?? b.acceleratedNetworking,
		hyperVGenerations: a.hyperVGenerations || b.hyperVGenerations,
		restricted: a.restricted || b.restricted,
		restrictionReasons: [...new Set([...a.restrictionReasons, ...b.restrictionReasons])],
		quotaRequired: a.quotaRequired || b.quotaRequired || a.cores || b.cores
	};
}

function mergeVmCapabilities(...groups: VmCapability[][]) {
	const byName = new Map<string, VmCapability>();
	for (const group of groups) {
		for (const capability of group) {
			if (!capability.name) continue;
			const key = capability.name.toLowerCase();
			const existing = byName.get(key);
			byName.set(key, existing ? mergeCapability(existing, capability) : capability);
		}
	}
	return [...byName.values()];
}

function mergeAuthoritativeCapabilities(authoritative: VmCapability[], supplemental: VmCapability[]) {
	const authoritativeNames = new Set(authoritative.map((item) => item.name.toLowerCase()));
	return mergeVmCapabilities(
		authoritative,
		supplemental.filter((item) => authoritativeNames.has(item.name.toLowerCase()))
	);
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

function isAzureRegionOption(region: AzureRegionOption | null): region is AzureRegionOption {
	return region !== null;
}

function azureErrorMessage(err: unknown) {
	if (err instanceof Error && err.message) return err.message;
	const record = err as {
		message?: unknown;
		code?: unknown;
		statusCode?: unknown;
		body?: { error?: { message?: unknown; code?: unknown } };
	};
	const bodyMessage = record?.body?.error?.message;
	const bodyCode = record?.body?.error?.code;
	if (bodyMessage) return String(bodyMessage);
	if (record?.message) return String(record.message);
	if (bodyCode) return String(bodyCode);
	if (record?.code) return String(record.code);
	if (record?.statusCode) return `Azure 请求失败 (${record.statusCode})`;
	return String(err);
}

function rankRegionEntries(entries: [string, VmCapability[]][]) {
	const rank = new Map(REGION_SCAN_PRIORITY.map((name, index) => [name, index]));
	return [...entries].sort(([a], [b]) => {
		const rankA = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
		const rankB = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
		if (rankA !== rankB) return rankA - rankB;
		return displayLocationName(a).localeCompare(displayLocationName(b));
	});
}

function quotaKey(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function compactVmFamily(value: string) {
	let key = quotaKey(value);
	key = key.replace(/^standard/, '');
	let previous = '';
	while (previous !== key) {
		previous = key;
		key = key
			.replace(/families$/, '')
			.replace(/family$/, '')
			.replace(/series$/, '')
			.replace(/vcpus$/, '')
			.replace(/vcpu$/, '')
			.replace(/cores$/, '');
	}
	return key;
}

function fallbackVmFamilyCandidatesFromName(name: string) {
	const candidates = new Set<string>();
	const raw = name.replace(/^Standard_/i, '');
	const version = raw.match(/_(v\d+)$/i)?.[1] ?? '';
	const base = raw.replace(/_(v\d+)$/i, '');
	const normalized = base.replace(/^([A-Za-z]+)\d+(?:-\d+)?([A-Za-z]*)$/i, '$1$2');

	for (const candidate of [normalized + version, normalized]) {
		const compact = compactVmFamily(candidate);
		if (compact) candidates.add(compact);
	}

	return [...candidates].filter(Boolean);
}

function vmFamilyCandidates(capability: VmCapability) {
	const family = compactVmFamily(capability.family);
	if (family) return { exact: [family], fallback: [] };

	const fallback = fallbackVmFamilyCandidatesFromName(capability.name);
	return { exact: [], fallback };
}

function quotaFamilyKeys(quota: ComputeQuota) {
	return [
		quotaKey(quota.name),
		quotaKey(quota.localizedName),
		compactVmFamily(quota.name),
		compactVmFamily(quota.localizedName)
	].filter(Boolean);
}

function matchesFamilyQuotaKey(candidate: string, keys: string[], allowPrefix: boolean) {
	if (keys.some((key) => key === candidate || key === `${candidate}vcpus`)) return true;
	if (!allowPrefix || candidate.length < 2) return false;
	return keys.some((key) => key.startsWith(candidate) || candidate.startsWith(key));
}

function findQuotaByFamilyCandidate(
	candidates: string[],
	quotas: ComputeQuota[],
	options: { allowPrefix: boolean }
) {
	for (const candidate of candidates) {
		const quota = quotas.find((item) =>
			matchesFamilyQuotaKey(candidate, quotaFamilyKeys(item), options.allowPrefix)
		);
		if (quota) return quota;
	}
	return undefined;
}

function isTotalRegionalVcpuQuota(quota: ComputeQuota) {
	const name = quotaKey(quota.name);
	const localized = quotaKey(quota.localizedName);
	return (
		name === 'cores' ||
		name === 'totalregionalvcpus' ||
		name === 'totalregionalcores' ||
		localized === 'cores' ||
		localized === 'totalregionalvcpus' ||
		localized === 'totalregionalcores' ||
		(localized.includes('total') &&
			localized.includes('regional') &&
			(localized.includes('vcpu') || localized.includes('core')))
	);
}

function findTotalRegionalVcpuQuota(quotas: ComputeQuota[]) {
	return quotas.find(isTotalRegionalVcpuQuota);
}

function findFamilyQuota(capability: VmCapability, quotas: ComputeQuota[]) {
	const families = vmFamilyCandidates(capability);
	return (
		findQuotaByFamilyCandidate(families.exact, quotas, { allowPrefix: false }) ??
		findQuotaByFamilyCandidate(families.fallback, quotas, { allowPrefix: true })
	);
}

function applyQuotaToCapabilities(capabilities: VmCapability[], quotas: ComputeQuota[]) {
	const totalQuota = findTotalRegionalVcpuQuota(quotas);
	const totalRemaining = totalQuota?.remaining ?? 0;

	return capabilities.map((capability) => {
		const reasons = [...capability.restrictionReasons];
		const required = capability.quotaRequired || capability.cores;
		const familyQuota = findFamilyQuota(capability, quotas);
		const effectiveQuota = familyQuota ?? totalQuota;
		let quotaRestricted = false;

		if (required <= 0) {
			quotaRestricted = true;
			reasons.push('MissingCoreCount');
		}
		if (!totalQuota) {
			quotaRestricted = true;
			reasons.push('MissingTotalRegionalVcpuQuota');
		} else if (totalQuota.remaining < required) {
			quotaRestricted = true;
			reasons.push(`TotalRegionalVcpusRemaining:${totalQuota.remaining}`);
		}
		if (capability.family) {
			if (!familyQuota) {
				reasons.push(`UnmatchedFamilyQuota:${capability.family}`);
			} else if (familyQuota.remaining < required) {
				quotaRestricted = true;
				reasons.push(`${familyQuota.name || familyQuota.localizedName}Remaining:${familyQuota.remaining}`);
			}
		}

		return {
			...capability,
			restricted: capability.restricted || quotaRestricted,
			restrictionReasons: [...new Set(reasons)],
			quotaName: effectiveQuota?.name ?? '',
			quotaLocalizedName: effectiveQuota?.localizedName ?? '',
			quotaRemaining: effectiveQuota?.remaining ?? 0,
			totalQuotaRemaining: totalRemaining,
			quotaRequired: required,
			quotaRestricted
		};
	});
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	mapper: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await mapper(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

async function listResourceSkuCapabilitiesForLocation(
	clients: AzureClients,
	location: string
): Promise<VmCapability[]> {
	const capabilities: VmCapability[] = [];
	for await (const sku of clients.compute.resourceSkus.list({
		filter: `location eq '${location}'`
	})) {
		if (sku.resourceType !== 'virtualMachines' || !sku.name) continue;
		if (!skuAppliesToLocation(sku, location)) continue;
		capabilities.push(skuToCapability(sku, location));
	}
	return capabilities;
}

async function listVmSizeCapabilitiesForLocation(
	clients: AzureClients,
	location: string
): Promise<VmCapability[]> {
	const capabilities: VmCapability[] = [];
	for await (const size of clients.compute.virtualMachineSizes.list(location)) {
		if (!size.name) continue;
		capabilities.push(vmSizeToCapability(size));
	}
	return capabilities;
}

function resourceGroupToInfo(group: ResourceGroup): AzureResourceGroupInfo {
	return {
		id: group.id ?? '',
		name: group.name ?? '',
		location: group.location ?? '',
		provisioningState: group.properties?.provisioningState ?? ''
	};
}

function resourceToInfo(resource: GenericResourceExpanded): AzureResourceInfo {
	return {
		id: resource.id ?? '',
		name: resource.name ?? parseResourceName(resource.id ?? ''),
		type: resource.type ?? '',
		location: resource.location ?? '',
		resourceGroup: parseResourceGroup(resource.id ?? ''),
		kind: resource.kind ?? '',
		skuName: resource.sku?.name ?? '',
		provisioningState:
			resource.provisioningState ??
			((resource.properties as { provisioningState?: string } | undefined)?.provisioningState ?? '')
	};
}

function providerToStatus(provider: Provider, fallbackNamespace = ''): AzureProviderStatus {
	const locations = new Set<string>();
	for (const resourceType of provider.resourceTypes ?? []) {
		for (const location of resourceType.locations ?? []) {
			if (location) locations.add(location);
		}
	}
	return {
		namespace: provider.namespace ?? fallbackNamespace,
		registrationState: provider.registrationState ?? '',
		registrationPolicy: provider.registrationPolicy ?? '',
		resourceTypeCount: provider.resourceTypes?.length ?? 0,
		locations: [...locations].sort((a, b) => a.localeCompare(b))
	};
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
	const [resourceSkus, legacySizes, quotas] = await Promise.all([
		listResourceSkuCapabilitiesForLocation(clients, location),
		listVmSizeCapabilitiesForLocation(clients, location).catch(() => []),
		listComputeQuotas(clients, location)
	]);
	const merged = mergeAuthoritativeCapabilities(resourceSkus, legacySizes);
	const quotaAware = applyQuotaToCapabilities(merged, quotas);
	const available = quotaAware
		.filter((sku) => !sku.restricted)
		.sort((a, b) => byCapacity(a, b));
	const restricted = quotaAware
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

	try {
		for await (const sku of clients.compute.resourceSkus.list()) {
			if (sku.resourceType !== 'virtualMachines' || !sku.name) continue;
			for (const region of skuLocations(sku)) {
				const location = normalizeLocationName(region);
				const capability = skuToCapability(sku, location);
				if (capability.restricted) continue;
				const list = byRegion.get(location) ?? [];
				list.push(capability);
				byRegion.set(location, list);
			}
		}
	} catch (err) {
		throw new Error(`查询 Azure 官方可用规格失败：${azureErrorMessage(err)}`);
	}

	if (byRegion.size === 0) {
		throw new Error('Azure 官方 API 没有返回当前订阅可创建 VM 的区域');
	}

	const configuredScanLimit = Number(readEnv('AZURE_REGION_SCAN_LIMIT') ?? byRegion.size);
	const maxScan =
		Number.isFinite(configuredScanLimit) && configuredScanLimit > 0
			? Math.min(byRegion.size, Math.max(1, configuredScanLimit))
			: byRegion.size;
	const entries = rankRegionEntries([...byRegion.entries()]).slice(0, maxScan);
	const quotaErrors: string[] = [];
	const regions = await mapWithConcurrency(entries, 3, async ([name, candidates]) => {
		const quotas = await listComputeQuotas(clients, name).catch((err) => {
			quotaErrors.push(`${name}: ${azureErrorMessage(err)}`);
			return [];
		});
		if (quotas.length === 0) {
			return null;
		}
		const legacySizes = await listVmSizeCapabilitiesForLocation(clients, name).catch(() => []);
		const available = applyQuotaToCapabilities(mergeAuthoritativeCapabilities(candidates, legacySizes), quotas)
			.filter((capability) => !capability.restricted)
			.sort((a, b) => byCapacity(a, b));
		if (available.length === 0) return null;
		const region: AzureRegionOption = {
			name,
			displayName: displayLocationName(name),
			availableSizeCount: available.length,
			highestCoreSize: selectLargest(available, 'cores'),
			largestMemorySize: selectLargest(available, 'memoryGB')
		};
		return region;
	});

	const availableRegions = regions
		.filter(isAzureRegionOption)
		.sort((a, b) => a.displayName.localeCompare(b.displayName));
	if (availableRegions.length === 0) {
		const scanned = entries.map(([name]) => name).join('、');
		const failed = quotaErrors.slice(0, 5).join('；');
		throw new Error(
			`未识别到可创建 VM 的区域。已检查 ${entries.length}/${byRegion.size} 个候选区域：${scanned}。` +
				`请确认该订阅有 Compute vCPU 配额；如需扩大扫描可在 .env 设置 AZURE_REGION_SCAN_LIMIT=60。` +
				(failed ? ` 配额查询失败示例：${failed}` : '')
		);
	}
	return availableRegions;
}

export async function listResourceGroups(clients: AzureClients): Promise<AzureResourceGroupInfo[]> {
	const groups: AzureResourceGroupInfo[] = [];
	for await (const group of clients.resources.resourceGroups.list()) {
		groups.push(resourceGroupToInfo(group));
	}
	return groups.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listGenericResources(
	clients: AzureClients,
	resourceGroup?: string,
	resourceType?: string
): Promise<AzureResourceInfo[]> {
	const filter = resourceType ? `resourceType eq '${resourceType.replace(/'/g, "''")}'` : undefined;
	const iterator = resourceGroup
		? clients.resources.resources.listByResourceGroup(resourceGroup, {
				filter,
				expand: 'createdTime,changedTime,provisioningState'
			})
		: clients.resources.resources.list({
				filter,
				expand: 'createdTime,changedTime,provisioningState'
			});
	const resources: AzureResourceInfo[] = [];
	for await (const resource of iterator) {
		resources.push(resourceToInfo(resource));
	}
	return resources.sort((a, b) => {
		if (a.resourceGroup !== b.resourceGroup) return a.resourceGroup.localeCompare(b.resourceGroup);
		if (a.type !== b.type) return a.type.localeCompare(b.type);
		return a.name.localeCompare(b.name);
	});
}

export async function listProviderStatuses(
	clients: AzureClients,
	namespaces = DEFAULT_PROVIDER_NAMESPACES
): Promise<AzureProviderStatus[]> {
	const statuses: AzureProviderStatus[] = [];
	for (const namespace of namespaces) {
		try {
			statuses.push(providerToStatus(await clients.resources.providers.get(namespace), namespace));
		} catch (err) {
			statuses.push({
				namespace,
				registrationState: err instanceof Error ? err.message : 'Unknown',
				registrationPolicy: '',
				resourceTypeCount: 0,
				locations: []
			});
		}
	}
	return statuses;
}

export async function registerResourceProviders(
	clients: AzureClients,
	namespaces = DEFAULT_PROVIDER_NAMESPACES
): Promise<AzureProviderStatus[]> {
	const statuses: AzureProviderStatus[] = [];
	for (const namespace of namespaces) {
		try {
			const provider = await clients.resources.providers.get(namespace).catch(() => null);
			if (provider?.registrationState?.toLowerCase() === 'registered') {
				statuses.push(providerToStatus(provider, namespace));
				continue;
			}
			statuses.push(providerToStatus(await clients.resources.providers.register(namespace), namespace));
		} catch (err) {
			statuses.push({
				namespace,
				registrationState: err instanceof Error ? err.message : 'Failed',
				registrationPolicy: '',
				resourceTypeCount: 0,
				locations: []
			});
		}
	}
	return statuses;
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

function aiAccountToInfo(
	resource: AzureResourceInfo | GenericResourceExpanded | Record<string, unknown>
): AiAccountInfo {
	const record = resource as Record<string, unknown>;
	const properties = (record.properties ?? {}) as Record<string, unknown>;
	const sku = (record.sku ?? {}) as Record<string, unknown>;
	const id = String(record.id ?? '');
	return {
		id,
		name: String(record.name ?? parseResourceName(id)),
		resourceGroup: String(record.resourceGroup ?? parseResourceGroup(id)),
		location: String(record.location ?? ''),
		kind: String(record.kind ?? ''),
		skuName: String((record as AzureResourceInfo).skuName ?? sku.name ?? ''),
		endpoint: String(properties.endpoint ?? ''),
		provisioningState: String(
			(record as AzureResourceInfo).provisioningState ?? properties.provisioningState ?? ''
		),
		publicNetworkAccess: String(properties.publicNetworkAccess ?? '')
	};
}

function aiDeploymentToInfo(
	deployment: Record<string, unknown>,
	resourceGroup: string,
	accountName: string
): AiDeploymentInfo {
	const properties = (deployment.properties ?? {}) as Record<string, unknown>;
	const model = (properties.model ?? {}) as Record<string, unknown>;
	const scaleSettings = (properties.scaleSettings ?? {}) as Record<string, unknown>;
	const sku = (deployment.sku ?? {}) as Record<string, unknown>;
	return {
		id: String(deployment.id ?? ''),
		name: String(deployment.name ?? ''),
		resourceGroup,
		accountName,
		modelFormat: String(model.format ?? ''),
		modelName: String(model.name ?? ''),
		modelVersion: String(model.version ?? ''),
		scaleType: String(scaleSettings.scaleType ?? sku.name ?? ''),
		capacity: Number(sku.capacity ?? scaleSettings.capacity ?? 0),
		provisioningState: String(properties.provisioningState ?? '')
	};
}

export async function listAiAccounts(clients: AzureClients): Promise<AiAccountInfo[]> {
	const resources: GenericResourceExpanded[] = [];
	for await (const resource of clients.resources.resources.list({
		filter: "resourceType eq 'Microsoft.CognitiveServices/accounts'",
		expand: 'createdTime,changedTime,provisioningState'
	})) {
		resources.push(resource);
	}
	return resources.map(aiAccountToInfo).sort((a, b) => {
		if (a.resourceGroup !== b.resourceGroup) return a.resourceGroup.localeCompare(b.resourceGroup);
		return a.name.localeCompare(b.name);
	});
}

export async function createAiAccount(
	account: AzureAccount,
	proxy: ProxyRuntimeConfig | null,
	options: CreateAiAccountOptions
): Promise<AiAccountInfo> {
	const { credential, clientOptions } = createCredentialAndOptions(account, proxy);
	const clients = createAzureClients(account, proxy);
	await registerResourceProviders(clients, ['Microsoft.CognitiveServices']);
	await clients.resources.resourceGroups.createOrUpdate(options.resourceGroup, {
		location: options.location
	});
	const payload = (await sendArmRequest(credential, clientOptions, {
		method: 'PUT',
		pathOrUrl: `/subscriptions/${account.subscriptionId}/resourceGroups/${encodeURIComponent(
			options.resourceGroup
		)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(
			options.accountName
		)}?api-version=${COGNITIVE_SERVICES_API_VERSION}`,
		body: {
			location: options.location,
			kind: options.kind ?? 'OpenAI',
			sku: { name: options.skuName ?? 'S0' },
			properties: {
				customSubDomainName: sanitizeResourceName(options.accountName).toLowerCase(),
				publicNetworkAccess: 'Enabled'
			}
		}
	})) as Record<string, unknown>;
	return aiAccountToInfo(payload);
}

export async function getAiAccountKeys(
	account: AzureAccount,
	proxy: ProxyRuntimeConfig | null,
	resourceGroup: string,
	accountName: string
): Promise<AiAccountKeys> {
	const { credential, clientOptions } = createCredentialAndOptions(account, proxy);
	const accountResource = (await sendArmRequest(credential, clientOptions, {
		method: 'GET',
		pathOrUrl: `/subscriptions/${account.subscriptionId}/resourceGroups/${encodeURIComponent(
			resourceGroup
		)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(
			accountName
		)}?api-version=${COGNITIVE_SERVICES_API_VERSION}`
	})) as Record<string, unknown>;
	const keys = (await sendArmRequest(credential, clientOptions, {
		method: 'POST',
		pathOrUrl: `/subscriptions/${account.subscriptionId}/resourceGroups/${encodeURIComponent(
			resourceGroup
		)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(
			accountName
		)}/listKeys?api-version=${COGNITIVE_SERVICES_API_VERSION}`
	})) as { key1?: string; key2?: string };
	const properties = (accountResource.properties ?? {}) as Record<string, unknown>;
	return {
		endpoint: String(properties.endpoint ?? ''),
		key1: keys.key1 ?? '',
		key2: keys.key2 ?? ''
	};
}

export async function listAiDeployments(
	account: AzureAccount,
	proxy: ProxyRuntimeConfig | null,
	resourceGroup: string,
	accountName: string
): Promise<AiDeploymentInfo[]> {
	const { credential, clientOptions } = createCredentialAndOptions(account, proxy);
	const deployments = await collectArmPages<Record<string, unknown>>(
		credential,
		clientOptions,
		`${ARM_ENDPOINT}/subscriptions/${account.subscriptionId}/resourceGroups/${encodeURIComponent(
			resourceGroup
		)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(
			accountName
		)}/deployments?api-version=${COGNITIVE_SERVICES_API_VERSION}`
	);
	return deployments
		.map((deployment) => aiDeploymentToInfo(deployment, resourceGroup, accountName))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createAiDeployment(
	account: AzureAccount,
	proxy: ProxyRuntimeConfig | null,
	options: CreateAiDeploymentOptions
): Promise<AiDeploymentInfo> {
	const { credential, clientOptions } = createCredentialAndOptions(account, proxy);
	const deployment = (await sendArmRequest(credential, clientOptions, {
		method: 'PUT',
		pathOrUrl: `/subscriptions/${account.subscriptionId}/resourceGroups/${encodeURIComponent(
			options.resourceGroup
		)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(
			options.accountName
		)}/deployments/${encodeURIComponent(options.deploymentName)}?api-version=${COGNITIVE_SERVICES_API_VERSION}`,
		body: {
			sku: {
				name: options.scaleType ?? 'Standard',
				capacity: Math.max(1, Number(options.capacity ?? 1))
			},
			properties: {
				model: {
					format: options.modelFormat ?? 'OpenAI',
					name: options.modelName,
					version: options.modelVersion || undefined
				}
			}
		}
	})) as Record<string, unknown>;
	return aiDeploymentToInfo(deployment, options.resourceGroup, options.accountName);
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

export function randomAzureResourceName(prefix: string, maxLength = 64) {
	const cleanPrefix = sanitizeResourceName(prefix).toLowerCase().replace(/_/g, '-');
	const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const separator = '-';
	const available = Math.max(maxLength - suffix.length - separator.length, 1);
	return `${cleanPrefix.slice(0, available)}${separator}${suffix}`;
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
	await registerResourceProviders(clients, [
		'Microsoft.Compute',
		'Microsoft.Network',
		'Microsoft.Storage',
		'Microsoft.KeyVault'
	]);
	const capabilities = await listVmCapabilities(clients, location);
	const selectedCapability = capabilities.available.find((capability) => capability.name === vmSize);
	if (!selectedCapability) {
		const restricted = capabilities.restricted.find((capability) => capability.name === vmSize);
		const reason = restricted?.restrictionReasons.length
			? `：${restricted.restrictionReasons.join('、')}`
			: '';
		throw new Error(`当前账号在 ${location} 不支持创建 ${vmSize}${reason}`);
	}
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
