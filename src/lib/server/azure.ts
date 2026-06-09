import { ComputeManagementClient } from '@azure/arm-compute';
import { NetworkManagementClient } from '@azure/arm-network';
import { ResourceManagementClient } from '@azure/arm-resources';
import type {
	ResourceSku,
	ResourceSkuRestrictions,
	Usage,
	VirtualMachineImageResource,
	VirtualMachineSize
} from '@azure/arm-compute';
import type { GenericResourceExpanded, Provider, ResourceGroup } from '@azure/arm-resources';
import type {
	NetworkInterface,
	NetworkInterfaceIPConfiguration,
	NetworkSecurityGroup,
	PublicIPAddress,
	SecurityRule,
	Usage as NetworkUsage
} from '@azure/arm-network';
import {
	createDefaultHttpClient,
	createHttpHeaders,
	createPipelineFromOptions,
	createPipelineRequest,
	type PipelineOptions,
	type PipelineResponse
} from '@azure/core-rest-pipeline';
import type {
	AccessToken,
	GetTokenOptions,
	TokenCredential,
	TokenCredentialOptions
} from '@azure/identity';
import type { AzureAccount } from './db/schema';
import { decryptSecret } from './crypto';
import {
	maskProxy,
	parseProxyUrl,
	proxyClientOptions,
	type ProxyRuntimeConfig
} from './proxy';
import { readEnv } from './runtime-env';

export const DIRECT_PROXY = Symbol('DIRECT_PROXY');
export type AzureProxySelection = ProxyRuntimeConfig | typeof DIRECT_PROXY | null;

const DEFAULT_CREATE_IP_PREFIX = '85.211';
const DEFAULT_FIREWALL_ALLOW_ALL_PORT_RANGE = '0-65535';
const DEFAULT_FIREWALL_ALLOW_ALL_RULE_NAME = 'allow-in-0-to-65535';
const DEFAULT_FIREWALL_ALLOW_ALL_RULE_PRIORITY = 100;
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

export type VmPublicIpRefreshResult = {
	vmName: string;
	resourceGroup: string;
	publicIPv4: string;
	publicIPv6: string;
	nicName: string;
	nicResourceGroup: string;
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
	quotas: ComputeQuota[];
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
	enableAcceleratedNetworking?: boolean;
	openPorts?: string | string[];
	enableDdosProtection?: boolean;
	customData?: string;
	ipPrefix?: string;
	ipBrushMaxAttempts?: number;
	progress?: CreateVmProgressReporter;
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

export type CreateVmProgressStatus = 'running' | 'success' | 'error' | 'info';

export type CreateVmProgressEvent = {
	step: string;
	status: CreateVmProgressStatus;
	message: string;
	detail?: Record<string, string | number | boolean | null>;
	timestamp: string;
};

export type CreateVmProgressReporter = (
	event: CreateVmProgressEvent
) => void | Promise<void>;

export type DeleteResourceGroupProgressReporter = CreateVmProgressReporter;

export type VmPowerAction = 'start' | 'deallocate' | 'restart';

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

export type VmFirewallRuleInfo = {
	name: string;
	description: string;
	protocol: string;
	sourcePortRange: string;
	destinationPortRange: string;
	sourceAddressPrefix: string;
	destinationAddressPrefix: string;
	access: string;
	priority: number;
	direction: string;
	provisioningState: string;
};

export type VmFirewallRuleInput = {
	name?: string;
	description?: string;
	protocol?: string;
	sourcePortRange?: string;
	destinationPortRange: string;
	sourceAddressPrefix?: string;
	destinationAddressPrefix?: string;
	access?: string;
	priority?: number;
	direction?: string;
};

type VmNetworkSecurityGroupRef = { resourceGroup: string; name: string; id: string };

export type AzureClients = {
	compute: ComputeManagementClient;
	network: NetworkManagementClient;
	resources: ResourceManagementClient;
	credential: TokenCredential;
	clientOptions: AzureClientOptions;
	subscriptionId: string;
};

export type AzureCredentialValidationResult = {
	subscriptionId: string;
};

type AzureClientOptions = TokenCredentialOptions & PipelineOptions;
type ArmRequestMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type AzureSubscription = {
	subscriptionId?: string;
	displayName?: string;
	state?: string;
};

export type AzureAccountSubscriptionStatus = {
	subscriptionId: string;
	displayName: string;
	state: string;
	abnormal: boolean;
	isDefault: boolean;
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
const AZURE_AUTHORITY_HOST = 'https://login.microsoftonline.com';
const SUBSCRIPTIONS_API_VERSION = '2020-01-01';
const COMPUTE_RESOURCE_SKUS_API_VERSION = '2021-07-01';
const COGNITIVE_SERVICES_API_VERSION = '2024-10-01';
const CAPACITY_QUOTA_API_VERSION = '2020-10-25';
const NETWORK_PUBLIC_IP_API_VERSION = '2024-05-01';
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

const FAST_VM_SIZE_CANDIDATES: Array<{
	name: string;
	cores: number;
	memoryGB: number;
	maxDataDiskCount: number;
}> = [
	{ name: 'Standard_B1s', cores: 1, memoryGB: 1, maxDataDiskCount: 2 },
	{ name: 'Standard_B1ms', cores: 1, memoryGB: 2, maxDataDiskCount: 2 },
	{ name: 'Standard_B2s', cores: 2, memoryGB: 4, maxDataDiskCount: 4 },
	{ name: 'Standard_B2ms', cores: 2, memoryGB: 8, maxDataDiskCount: 4 },
	{ name: 'Standard_B4ms', cores: 4, memoryGB: 16, maxDataDiskCount: 8 }
];

type FeaturedImageCandidate = {
	label: string;
	publisher: string;
	offer: string;
	sku: string;
	osType: 'Linux' | 'Windows';
};

const FEATURED_IMAGE_CANDIDATES: FeaturedImageCandidate[] = [
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
];

const IMAGE_QUERY_CONCURRENCY = 4;
const IMAGE_DISCOVERY_CONCURRENCY = 3;
const DEFAULT_IMAGE_DISCOVERY_LIMIT = 80;

type ImageDiscoveryConfig = {
	publisher: string;
	osType: 'Linux' | 'Windows';
	offerMatches: (offer: string) => boolean;
	skuMatches: (offer: string, sku: string) => boolean;
	label: (offer: string, sku: string) => string;
};

const IMAGE_DISCOVERY_CONFIGS: ImageDiscoveryConfig[] = [
	{
		publisher: 'Canonical',
		osType: 'Linux',
		offerMatches: (offer) => /ubuntu/i.test(offer),
		skuMatches: (offer, sku) => isUbuntuServerLtsCandidate(offer, sku),
		label: (offer, sku) => ubuntuImageLabel(offer, sku)
	},
	{
		publisher: 'Debian',
		osType: 'Linux',
		offerMatches: (offer) => /debian/i.test(offer),
		skuMatches: (offer, sku) => Boolean(debianMajorFromOfferOrSku(offer, sku)),
		label: (offer, sku) => debianImageLabel(debianMajorFromOfferOrSku(offer, sku), sku)
	},
	{
		publisher: 'MicrosoftWindowsServer',
		osType: 'Windows',
		offerMatches: (offer) => /^windowsserver$/i.test(offer),
		skuMatches: (_offer, sku) => isWindowsServerCandidate(sku),
		label: (_offer, sku) => windowsServerImageLabel(sku)
	}
];

type TimedCacheEntry<T> = {
	expiresAt: number;
	value?: T;
	promise?: Promise<T>;
};

const azureQueryCache = new Map<string, TimedCacheEntry<unknown>>();

function cacheTtlMs(name: string, fallbackSeconds: number) {
	const value = Number(readEnv(name) ?? fallbackSeconds);
	return (Number.isFinite(value) && value > 0 ? value : fallbackSeconds) * 1000;
}

async function cachedAzureQuery<T>(
	key: string,
	ttlMs: number,
	loader: () => Promise<T>
): Promise<T> {
	const now = Date.now();
	const existing = azureQueryCache.get(key) as TimedCacheEntry<T> | undefined;
	if (existing && existing.expiresAt > now) {
		if (existing.value !== undefined) return existing.value;
		if (existing.promise) return existing.promise;
	}

	const promise = loader()
		.then((value) => {
			azureQueryCache.set(key, { value, expiresAt: Date.now() + ttlMs });
			return value;
		})
		.catch((err) => {
			azureQueryCache.delete(key);
			throw err;
		});
	azureQueryCache.set(key, { promise, expiresAt: now + ttlMs });

	if (azureQueryCache.size > 384) {
		for (const [cacheKey, entry] of azureQueryCache) {
			if (entry.expiresAt <= now) azureQueryCache.delete(cacheKey);
			if (azureQueryCache.size <= 256) break;
		}
	}

	return promise;
}

function vmImageOptionFromCandidate(candidate: FeaturedImageCandidate, version: string): VmImageOption {
	return {
		label: `${candidate.label} (${version})`,
		imageReference: `${candidate.publisher}:${candidate.offer}:${candidate.sku}:${version}`,
		publisher: candidate.publisher,
		offer: candidate.offer,
		sku: candidate.sku,
		version,
		osType: candidate.osType,
		architecture: '',
		hyperVGeneration: ''
	};
}

export function fallbackFeaturedVmImages(): VmImageOption[] {
	const images: VmImageOption[] = [];
	const seenImages = new Set<string>();
	for (const candidate of FEATURED_IMAGE_CANDIDATES) {
		const image = vmImageOptionFromCandidate(candidate, 'latest');
		const key = image.imageReference.toLowerCase();
		if (seenImages.has(key)) continue;
		seenImages.add(key);
		images.push(image);
	}
	return images;
}

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

function azureClientOptions(proxy?: ProxyRuntimeConfig | null): AzureClientOptions {
	return proxyClientOptions(proxy);
}

function parseTokenJson(bodyAsText?: string | null): Record<string, unknown> {
	if (!bodyAsText) return {};
	try {
		const payload = JSON.parse(bodyAsText);
		return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function tokenResponseError(status: number, bodyAsText?: string | null) {
	const payload = parseTokenJson(bodyAsText);
	const details = [
		payload.error ? String(payload.error) : '',
		payload.error_description ? String(payload.error_description) : ''
	]
		.filter(Boolean)
		.join(': ');
	return `Azure 登录令牌获取失败 (${status})${details ? `: ${details}` : ''}`;
}

class ProxyAwareClientSecretCredential implements TokenCredential {
	private readonly tokens = new Map<string, AccessToken>();

	constructor(
		private readonly tenantId: string,
		private readonly clientId: string,
		private readonly clientSecret: string,
		private readonly clientOptions: AzureClientOptions
	) {}

	async getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken | null> {
		const scopeList = (Array.isArray(scopes) ? scopes : [scopes]).filter(Boolean);
		const scope = scopeList.join(' ') || ARM_SCOPE;
		const tenantId = options?.tenantId?.trim() || this.tenantId;
		const cacheKey = `${tenantId}|${scope}`;
		const now = Date.now();
		const cached = this.tokens.get(cacheKey);
		if (cached && cached.expiresOnTimestamp - now > 120_000) return cached;

		const authorityHost = (this.clientOptions.authorityHost ?? AZURE_AUTHORITY_HOST).replace(
			/\/+$/,
			''
		);
		const body = new URLSearchParams({
			client_id: this.clientId,
			client_secret: this.clientSecret,
			grant_type: 'client_credentials',
			scope
		}).toString();

		const pipeline = createPipelineFromOptions(this.clientOptions);
		const httpClient = this.clientOptions.httpClient ?? createDefaultHttpClient();
		let response;
		try {
			response = await pipeline.sendRequest(
				httpClient,
				createPipelineRequest({
					url: `${authorityHost}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
					method: 'POST',
					body,
					timeout: options?.requestOptions?.timeout ?? 30_000,
					abortSignal: options?.abortSignal,
					headers: createHttpHeaders({
						accept: 'application/json',
						'content-type': 'application/x-www-form-urlencoded'
					})
				})
			);
		} catch (err) {
			throw new Error(
				`Azure 登录令牌网络请求失败，请检查代理是否可连通: ${
					err instanceof Error ? err.message : String(err)
				}`
			);
		}

		if (response.status < 200 || response.status >= 300) {
			throw new Error(tokenResponseError(response.status, response.bodyAsText));
		}

		const payload = parseTokenJson(response.bodyAsText);
		const token = String(payload.access_token ?? '');
		if (!token) throw new Error('Azure 登录令牌响应缺少 access_token，请检查凭据或代理返回内容');

		const expiresIn = Number(payload.expires_in ?? 3600);
		const ttlMs = Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000;
		const refreshAfterMs = Math.max(30_000, ttlMs - 300_000);
		const accessToken: AccessToken = {
			token,
			expiresOnTimestamp: now + ttlMs,
			refreshAfterTimestamp: now + refreshAfterMs,
			tokenType: 'Bearer'
		};
		this.tokens.set(cacheKey, accessToken);
		return accessToken;
	}
}

function createProxyAwareCredential(
	tenantId: string,
	clientId: string,
	clientSecret: string,
	clientOptions: AzureClientOptions
): TokenCredential {
	return new ProxyAwareClientSecretCredential(tenantId, clientId, clientSecret, clientOptions);
}

function decryptLegacyProxy(account: AzureAccount): ProxyRuntimeConfig | null {
	return account.proxyUrlEncrypted ? parseProxyUrl(decryptSecret(account.proxyUrlEncrypted)) : null;
}

export function createAzureClients(account: AzureAccount, proxy?: AzureProxySelection): AzureClients {
	const runtimeProxy = proxy === DIRECT_PROXY ? null : (proxy ?? decryptLegacyProxy(account));
	const clientOptions = azureClientOptions(runtimeProxy);
	const credential = createProxyAwareCredential(
		account.tenantId,
		account.clientId,
		decryptSecret(account.clientSecretEncrypted),
		clientOptions
	);
	return {
		compute: new ComputeManagementClient(credential, account.subscriptionId, clientOptions),
		network: new NetworkManagementClient(credential, account.subscriptionId, clientOptions),
		resources: new ResourceManagementClient(credential, account.subscriptionId, clientOptions),
		credential,
		clientOptions,
		subscriptionId: account.subscriptionId
	};
}

function createCredentialAndOptions(
	account: AzureAccount,
	proxy?: AzureProxySelection
): { credential: TokenCredential; clientOptions: AzureClientOptions } {
	const runtimeProxy = proxy === DIRECT_PROXY ? null : (proxy ?? decryptLegacyProxy(account));
	const clientOptions = azureClientOptions(runtimeProxy);
	const credential = createProxyAwareCredential(
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
	proxy?: AzureProxySelection
): AzureClients {
	const { credential, clientOptions } = createCredentialAndOptions(account, proxy);
	return {
		compute: new ComputeManagementClient(credential, subscriptionId, clientOptions),
		network: new NetworkManagementClient(credential, subscriptionId, clientOptions),
		resources: new ResourceManagementClient(credential, subscriptionId, clientOptions),
		credential,
		clientOptions,
		subscriptionId
	};
}

function armResponseError(status: number, bodyAsText?: string | null) {
	let detail = '';
	try {
		const parsed = bodyAsText ? JSON.parse(bodyAsText) : null;
		const error = parsed?.error ?? parsed;
		const details = Array.isArray(error?.details)
			? error.details
					.map((item: { code?: string; message?: string; target?: string }) =>
						[item.code, item.target, item.message].filter(Boolean).join(': ')
					)
					.filter(Boolean)
					.join(' | ')
			: '';
		detail = [error?.code, error?.message, details].filter(Boolean).join(' | ');
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

function collectAzureErrorParts(
	value: unknown,
	parts: string[],
	seen: WeakSet<object>,
	depth = 0
) {
	if (value === null || value === undefined || depth > 5) return;
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) return;
		if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
			try {
				collectAzureErrorParts(JSON.parse(text), parts, seen, depth + 1);
				return;
			} catch {
				// Fall through and keep the original text when it is not valid JSON.
			}
		}
		parts.push(text);
		return;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		parts.push(String(value));
		return;
	}
	if (typeof value !== 'object') return;
	if (seen.has(value)) return;
	seen.add(value);

	if (value instanceof Error) {
		collectAzureErrorParts(value.message, parts, seen, depth + 1);
	}

	const record = value as Record<string, unknown>;
	const status = record.statusCode ?? record.status;
	if (typeof status === 'number' || typeof status === 'string') {
		parts.push(`HTTP ${status}`);
	}
	for (const key of [
		'code',
		'message',
		'cause',
		'error',
		'innerError',
		'innererror',
		'details',
		'body',
		'bodyAsText',
		'parsedBody',
		'response'
	]) {
		collectAzureErrorParts(record[key], parts, seen, depth + 1);
	}
}

export function formatAzureError(err: unknown): string {
	const parts: string[] = [];
	collectAzureErrorParts(err, parts, new WeakSet<object>());
	const unique = Array.from(
		new Set(
			parts
				.map((part) => part.trim())
				.filter((part) => part && part !== '[object Object]')
				.map((part) => (part.length > 800 ? `${part.slice(0, 800)}...` : part))
		)
	);
	return unique.join(' | ') || (err instanceof Error ? err.message : String(err));
}

async function sendArmRequest(
	credential: TokenCredential,
	clientOptions: AzureClientOptions,
	options: {
		method: ArmRequestMethod;
		pathOrUrl: string;
		body?: unknown;
	}
) {
	const response = await sendArmPipelineRequest(credential, clientOptions, options);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(armResponseError(response.status, response.bodyAsText));
	}
	return parseArmJson(response.bodyAsText);
}

async function sendArmPipelineRequest(
	credential: TokenCredential,
	clientOptions: AzureClientOptions,
	options: {
		method: ArmRequestMethod;
		pathOrUrl: string;
		body?: unknown;
	}
): Promise<PipelineResponse> {
	const url = options.pathOrUrl.startsWith('http') ? options.pathOrUrl : `${ARM_ENDPOINT}${options.pathOrUrl}`;
	if (!url.toLowerCase().startsWith(`${ARM_ENDPOINT}/`)) {
		throw new Error('Azure ARM 请求地址不在 management.azure.com 范围内');
	}

	const token = await credential.getToken(ARM_SCOPE);
	if (!token?.token) throw new Error('无法获取 Azure 访问令牌，请检查 Tenant ID、Client ID 和 Client Secret');

	const pipeline = createPipelineFromOptions(clientOptions);
	const httpClient = clientOptions.httpClient ?? createDefaultHttpClient();
	return pipeline.sendRequest(
		httpClient,
		createPipelineRequest({
			url,
			method: options.method,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			headers: createHttpHeaders({
				accept: 'application/json',
				authorization: `Bearer ${token.token}`,
				...(options.body === undefined ? {} : { 'content-type': 'application/json' })
			})
		})
	);
}

async function collectArmPages<T>(
	credential: TokenCredential,
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
	credential: TokenCredential,
	clientOptions: AzureClientOptions
) {
	const token = await credential.getToken(ARM_SCOPE);
	if (!token?.token) throw new Error('无法获取 Azure 访问令牌，请检查 Tenant ID、Client ID 和 Client Secret');

	const pipeline = createPipelineFromOptions(clientOptions);
	const httpClient = clientOptions.httpClient ?? createDefaultHttpClient();
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

function isProviderRegistrationRequiredError(err: unknown) {
	const record = err as {
		code?: unknown;
		message?: unknown;
		body?: { error?: { code?: unknown; message?: unknown } };
	};
	const text = [
		record?.code,
		record?.message,
		record?.body?.error?.code,
		record?.body?.error?.message,
		err instanceof Error ? err.message : ''
	]
		.filter(Boolean)
		.join(' ');
	return /NoRegisteredProviderFound|MissingSubscriptionRegistration|not\s+registered|register.*resource\s+provider/i.test(
		text
	);
}

export async function validateAzureCredentials(
	tenantId: string,
	clientId: string,
	clientSecret: string,
	proxy?: ProxyRuntimeConfig | string | null
): Promise<AzureCredentialValidationResult> {
	const runtimeProxy = typeof proxy === 'string' ? parseProxyUrl(proxy) : proxy;
	const clientOptions = azureClientOptions(runtimeProxy);
	const credential = createProxyAwareCredential(tenantId, clientId, clientSecret, clientOptions);
	const subscriptionId = await discoverSubscriptionId(credential, clientOptions);
	try {
		const client = new ComputeManagementClient(credential, subscriptionId, clientOptions);
		await client.virtualMachines.listAll().next();
	} catch (err) {
		if (!isProviderRegistrationRequiredError(err)) throw err;
	}
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

export const DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES = 'banned,warning,warned,disabled';

function normalizeSubscriptionState(state: string) {
	const normalized = state.trim().toLowerCase();
	if (normalized === 'warned') return 'warning';
	return normalized;
}

export function normalizeSubscriptionTriggerStates(value?: string | null) {
	const raw = value?.trim() || DEFAULT_AZURE_SUBSCRIPTION_TRIGGER_STATES;
	const states = raw
		.split(/[,\s，]+/)
		.map(normalizeSubscriptionState)
		.filter(Boolean);
	return states.length ? [...new Set(states)] : ['banned', 'warning', 'disabled'];
}

export function isAzureSubscriptionAbnormal(state?: string | null) {
	const normalized = normalizeSubscriptionState(String(state ?? ''));
	return Boolean(normalized && normalized !== 'enabled');
}

export function isAzureSubscriptionTriggerState(state?: string | null, triggerStates?: string | null) {
	const normalized = normalizeSubscriptionState(String(state ?? ''));
	if (!normalized) return false;
	return normalizeSubscriptionTriggerStates(triggerStates).includes(normalized);
}

export async function getAccountSubscriptionStatus(
	account: AzureAccount,
	proxy?: ProxyRuntimeConfig | null
): Promise<AzureAccountSubscriptionStatus> {
	const subscriptions = await listAccountSubscriptions(account, proxy);
	const selected =
		subscriptions.find((subscription) => subscription.subscriptionId === account.subscriptionId) ??
		subscriptions[0];
	const subscriptionId = selected?.subscriptionId ?? account.subscriptionId;
	const state = selected?.state || 'Unknown';

	return {
		subscriptionId,
		displayName: selected?.displayName ?? '',
		state,
		abnormal: isAzureSubscriptionAbnormal(state),
		isDefault: subscriptionId === account.subscriptionId
	};
}

function parseResourceGroup(resourceId: string): string {
	const match = resourceId.match(/resourceGroups\/([^/]+)/i);
	return match?.[1] ?? '';
}

function parseResourceName(resourceId: string): string {
	const match = resourceId.match(/\/([^/]+)$/);
	return match ? decodeURIComponent(match[1]) : '';
}

function normalizeResourceToken(value: string) {
	try {
		return decodeURIComponent(value).toLowerCase();
	} catch {
		return value.toLowerCase();
	}
}

function isVirtualMachineResourceId(resourceId: string, resourceGroup: string, vmName: string) {
	if (!resourceId) return false;
	const normalizedVmName = normalizeResourceToken(vmName);
	const normalizedResourceGroup = normalizeResourceToken(resourceGroup);
	return (
		normalizeResourceToken(parseResourceName(resourceId)) === normalizedVmName &&
		normalizeResourceToken(parseResourceGroup(resourceId)) === normalizedResourceGroup
	);
}

function isTransientAzureReadError(err: unknown) {
	const statusCode = (err as { statusCode?: number }).statusCode;
	const message = formatAzureError(err).toLowerCase();
	return (
		statusCode === 404 ||
		statusCode === 409 ||
		statusCode === 429 ||
		(typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600) ||
		/network error|request_send_error|request send error|socket|timeout|econnreset|etimedout|fetch failed/.test(message)
	);
}

function parseVirtualNetworkFromSubnetId(subnetId: string) {
	const resourceGroup = parseResourceGroup(subnetId);
	const vnetMatch = subnetId.match(/\/virtualNetworks\/([^/]+)/i);
	const subnetMatch = subnetId.match(/\/subnets\/([^/]+)/i);
	return {
		resourceGroup,
		virtualNetworkName: vnetMatch ? decodeURIComponent(vnetMatch[1]) : '',
		subnetName: subnetMatch ? decodeURIComponent(subnetMatch[1]) : ''
	};
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

function resourceSkuRestUrl(subscriptionId: string, filter?: string) {
	const params = new URLSearchParams({ 'api-version': COMPUTE_RESOURCE_SKUS_API_VERSION });
	if (filter) params.set('$filter', filter);
	return `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Compute/skus?${params.toString()}`;
}

function isVirtualMachineSku(sku: ResourceSku) {
	return String(sku.resourceType ?? '').toLowerCase() === 'virtualmachines' && Boolean(sku.name);
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
				isLocationWideRestriction(restriction) &&
				restriction.reasonCode === 'NotAvailableForSubscription'
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
	const bIsVisibleVmSize = b.source.split('+').includes('VirtualMachineSizes') && !b.restricted;
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
		restricted: bIsVisibleVmSize ? false : a.restricted || b.restricted,
		restrictionReasons: bIsVisibleVmSize
			? [...new Set(b.restrictionReasons)]
			: [...new Set([...a.restrictionReasons, ...b.restrictionReasons])],
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

function mergeVisibleVmCapabilities(authoritative: VmCapability[], supplemental: VmCapability[]) {
	return mergeVmCapabilities(authoritative, supplemental);
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

function regionOptionFromLocation(location: string): AzureRegionOption | null {
	const name = normalizeLocationName(location);
	if (!name) return null;
	return {
		name,
		displayName: displayLocationName(name),
		availableSizeCount: 0,
		highestCoreSize: null,
		largestMemorySize: null
	};
}

function isAzureRegionOption(region: AzureRegionOption | null): region is AzureRegionOption {
	return region !== null;
}

export function fallbackAvailableVmRegions(): AzureRegionOption[] {
	return REGION_SCAN_PRIORITY.map(regionOptionFromLocation).filter(isAzureRegionOption);
}

function fallbackVmCapability(name: string, cores: number, memoryGB: number, maxDataDiskCount: number): VmCapability {
	return {
		name,
		source: 'Fallback',
		family: name.split('_')[1]?.replace(/\d.*$/, '') ?? '',
		tier: '',
		cores,
		memoryGB,
		maxDataDiskCount,
		acceleratedNetworking: null,
		hyperVGenerations: '',
		restricted: false,
		restrictionReasons: [],
		quotaName: '',
		quotaLocalizedName: '',
		quotaRemaining: 0,
		totalQuotaRemaining: 0,
		quotaRequired: cores,
		quotaRestricted: false
	};
}

export function fallbackVmCapabilities(location: string): VmCapabilitiesResult {
	const available = FAST_VM_SIZE_CANDIDATES.map((size) =>
		fallbackVmCapability(size.name, size.cores, size.memoryGB, size.maxDataDiskCount)
	).sort((a, b) => byCapacity(a, b));
	return {
		location,
		available,
		restricted: [],
		quotas: [],
		highestCoreSize: selectLargest(available, 'cores'),
		largestMemorySize: selectLargest(available, 'memoryGB')
	};
}

function azureErrorMessage(err: unknown) {
	const message = err instanceof Error && err.message ? err.message : '';
	if (/aborted|body stream|response as text|terminated|socket hang up/i.test(message)) {
		return `${message}。Azure 返回数据较大时代理链路可能中断，已尝试改用轻量官方 API 回退；如果仍失败，请切换直连或更稳定的代理后重试`;
	}
	if (message) return message;
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

function addQuotaCandidate(target: Set<string>, value: string) {
	const compact = compactVmFamily(value);
	if (compact) target.add(compact);
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

function parseVmSizeFamilyParts(name: string) {
	const raw = name
		.replace(/^Standard[_-]/i, '')
		.replace(/-/g, '_')
		.trim();
	const version = raw.match(/_v(\d+)$/i)?.[1] ?? '';
	const base = raw.replace(/_v\d+$/i, '');
	const match = base.match(/^([A-Za-z]+)(\d+(?:_\d+)?)(.*)$/);
	if (!match) return null;
	return {
		prefix: match[1],
		features: (match[3] ?? '').replace(/^_+/, ''),
		version: version ? `v${version}` : ''
	};
}

function vmFeatureVariants(features: string) {
	const normalized = features.replace(/[^A-Za-z0-9]/g, '');
	const variants = new Set<string>();
	if (normalized) variants.add(normalized);

	const letterOnly = normalized.replace(/[0-9]/g, '');
	const hardware = features
		.split(/_/)
		.map((part) => part.replace(/[^A-Za-z0-9]/g, ''))
		.filter(Boolean)
		.at(-1);
	if (hardware && /\d/.test(hardware)) variants.add(hardware);

	const optionalMarkers = ['d', 'l'];
	const markerMasks = 1 << optionalMarkers.length;
	for (let mask = 1; mask < markerMasks; mask += 1) {
		let candidate = normalized;
		for (let index = 0; index < optionalMarkers.length; index += 1) {
			if (mask & (1 << index)) {
				const marker = optionalMarkers[index];
				candidate = candidate.replace(new RegExp(marker, 'gi'), '');
			}
		}
		if (candidate) variants.add(candidate);
	}

	if (letterOnly && letterOnly !== normalized) variants.add(letterOnly);
	return [...variants];
}

function fallbackVmFamilyCandidatesFromName(name: string) {
	const candidates = new Set<string>();
	const parts = parseVmSizeFamilyParts(name);

	if (parts) {
		for (const features of vmFeatureVariants(parts.features)) {
			addQuotaCandidate(candidates, `${parts.prefix}${features}${parts.version}`);
			addQuotaCandidate(candidates, `${parts.prefix}${features}`);
		}
		addQuotaCandidate(candidates, `${parts.prefix}${parts.version}`);
		addQuotaCandidate(candidates, parts.prefix);
	}

	const raw = name.replace(/^Standard[_-]/i, '');
	const version = raw.match(/_(v\d+)$/i)?.[1] ?? '';
	const base = raw.replace(/_(v\d+)$/i, '');
	const normalized = base.replace(/^([A-Za-z]+)\d+(?:-\d+)?([A-Za-z]*)$/i, '$1$2');
	addQuotaCandidate(candidates, normalized + version);
	addQuotaCandidate(candidates, normalized);

	return [...candidates].filter(Boolean);
}

function vmFamilyCandidates(capability: VmCapability) {
	const exact = new Set<string>();
	if (capability.family) addQuotaCandidate(exact, capability.family);
	const fallback = fallbackVmFamilyCandidatesFromName(capability.name);
	for (const candidate of fallback) exact.add(candidate);
	return { exact: [...exact], fallback };
}

type QuotaIndexEntry = {
	quota: ComputeQuota;
	keys: string[];
};

type QuotaIndex = {
	totalQuota?: ComputeQuota;
	byKey: Map<string, ComputeQuota>;
	entries: QuotaIndexEntry[];
};

function quotaFamilyKeys(quota: ComputeQuota): string[] {
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
	return keys.some((key) => key.startsWith(candidate) || (key.length >= 2 && candidate.startsWith(key)));
}

function findQuotaByFamilyCandidate(
	candidates: string[],
	entries: QuotaIndexEntry[],
	options: { allowPrefix: boolean }
) {
	for (const candidate of candidates) {
		const entry = entries.find((item) =>
			matchesFamilyQuotaKey(candidate, item.keys, options.allowPrefix)
		);
		if (entry) return entry.quota;
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

function buildQuotaIndex(quotas: ComputeQuota[]): QuotaIndex {
	const entries = quotas.map((quota) => ({
		quota,
		keys: [...new Set(quotaFamilyKeys(quota))]
	}));
	const byKey = new Map<string, ComputeQuota>();
	for (const entry of entries) {
		for (const key of entry.keys) {
			if (!byKey.has(key)) byKey.set(key, entry.quota);
		}
	}
	return {
		totalQuota: findTotalRegionalVcpuQuota(quotas),
		byKey,
		entries
	};
}

function findFamilyQuota(capability: VmCapability, index: QuotaIndex) {
	const families = vmFamilyCandidates(capability);
	for (const candidate of families.exact) {
		const quota = index.byKey.get(candidate) ?? index.byKey.get(`${candidate}vcpus`);
		if (quota) return quota;
	}
	return (
		findQuotaByFamilyCandidate(families.exact, index.entries, { allowPrefix: false }) ??
		findQuotaByFamilyCandidate(families.fallback, index.entries, { allowPrefix: true })
	);
}

function applyQuotaToCapabilities(
	capabilities: VmCapability[],
	quotas: ComputeQuota[],
	options: { restrictByQuota?: boolean } = {}
) {
	const quotaIndex = buildQuotaIndex(quotas);
	const totalQuota = quotaIndex.totalQuota;
	const totalRemaining = totalQuota?.remaining ?? 0;
	const restrictByQuota = options.restrictByQuota ?? true;

	return capabilities.map((capability) => {
		const reasons = [...capability.restrictionReasons];
		const required = capability.quotaRequired || capability.cores;
		const familyQuota = findFamilyQuota(capability, quotaIndex);
		const effectiveQuota = familyQuota ?? totalQuota;
		let quotaRestricted = false;

		if (required <= 0) {
			quotaRestricted = true;
			reasons.push('MissingCoreCount');
		}
		if (!totalQuota && !familyQuota) {
			quotaRestricted = true;
			reasons.push('MissingComputeQuota');
		} else if (totalQuota && totalQuota.remaining < required) {
			quotaRestricted = true;
			reasons.push(`TotalRegionalVcpusRemaining:${totalQuota.remaining}`);
		}
		if (familyQuota && familyQuota.remaining < required) {
			quotaRestricted = true;
			reasons.push(`${familyQuota.name || familyQuota.localizedName}Remaining:${familyQuota.remaining}`);
		} else if (capability.family) {
			if (!familyQuota) {
				reasons.push(`UnmatchedFamilyQuota:${capability.family}`);
			}
		}

		return {
			...capability,
			restricted: capability.restricted || (restrictByQuota && quotaRestricted),
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

async function listResourceSkusBySdkForLocation(
	clients: AzureClients,
	normalizedLocation: string
): Promise<ResourceSku[]> {
	const skus: ResourceSku[] = [];
	for await (const sku of clients.compute.resourceSkus.list({
		filter: `location eq '${normalizedLocation}'`
	})) {
		if (!isVirtualMachineSku(sku)) continue;
		if (!skuAppliesToLocation(sku, normalizedLocation)) continue;
		skus.push(sku);
	}
	return skus;
}

async function listResourceSkusByRestForLocation(
	clients: AzureClients,
	normalizedLocation: string
): Promise<ResourceSku[]> {
	const skus = await collectArmPages<ResourceSku>(
		clients.credential,
		clients.clientOptions,
		resourceSkuRestUrl(clients.subscriptionId, `location eq '${normalizedLocation}'`)
	);
	return skus.filter((sku) => isVirtualMachineSku(sku) && skuAppliesToLocation(sku, normalizedLocation));
}

async function listResourceSkusForLocation(
	clients: AzureClients,
	normalizedLocation: string
): Promise<ResourceSku[]> {
	let sdkError: unknown = null;
	try {
		const skus = await listResourceSkusBySdkForLocation(clients, normalizedLocation);
		if (skus.length > 0) return skus;
	} catch (err) {
		sdkError = err;
	}

	try {
		const skus = await listResourceSkusByRestForLocation(clients, normalizedLocation);
		if (skus.length > 0 || !sdkError) return skus;
	} catch (restErr) {
		if (sdkError) {
			throw new Error(
				`ResourceSkus SDK 查询失败：${azureErrorMessage(sdkError)}；REST 兜底查询失败：${azureErrorMessage(restErr)}`
			);
		}
		throw restErr;
	}

	return [];
}

async function listResourceSkusBySdk(clients: AzureClients): Promise<ResourceSku[]> {
	const skus: ResourceSku[] = [];
	for await (const sku of clients.compute.resourceSkus.list()) {
		if (isVirtualMachineSku(sku)) skus.push(sku);
	}
	return skus;
}

async function listResourceSkusByRest(clients: AzureClients): Promise<ResourceSku[]> {
	const skus = await collectArmPages<ResourceSku>(
		clients.credential,
		clients.clientOptions,
		resourceSkuRestUrl(clients.subscriptionId)
	);
	return skus.filter(isVirtualMachineSku);
}

async function listResourceSkus(clients: AzureClients): Promise<ResourceSku[]> {
	let sdkError: unknown = null;
	try {
		const skus = await listResourceSkusBySdk(clients);
		if (skus.length > 0) return skus;
	} catch (err) {
		sdkError = err;
	}

	try {
		const skus = await listResourceSkusByRest(clients);
		if (skus.length > 0 || !sdkError) return skus;
	} catch (restErr) {
		if (sdkError) {
			throw new Error(
				`ResourceSkus SDK 查询失败：${azureErrorMessage(sdkError)}；REST 兜底查询失败：${azureErrorMessage(restErr)}`
			);
		}
		throw restErr;
	}

	return [];
}

async function listResourceSkuCapabilitiesForLocation(
	clients: AzureClients,
	location: string
): Promise<VmCapability[]> {
	const normalizedLocation = normalizeLocationName(location);
	const key = `vm-skus:${clients.subscriptionId}:${normalizedLocation}`;
	const capabilities = await cachedAzureQuery(key, cacheTtlMs('AZURE_SKU_CACHE_TTL_SECONDS', 300), async () => {
		const skus = await listResourceSkusForLocation(clients, normalizedLocation);
		return skus.map((sku) => skuToCapability(sku, normalizedLocation));
	});
	return capabilities.map((capability) => ({
		...capability,
		restrictionReasons: [...capability.restrictionReasons]
	}));
}

async function listResourceSkuCapabilitiesForLocationSafe(
	clients: AzureClients,
	location: string
): Promise<VmCapability[]> {
	try {
		return await listResourceSkuCapabilitiesForLocation(clients, location);
	} catch (err) {
		console.warn(
			`[azure] ResourceSkus location query failed for ${location}, falling back to VirtualMachineSizes:`,
			azureErrorMessage(err)
		);
		return [];
	}
}

async function listResourceSkuCapabilitiesByRegion(
	clients: AzureClients
): Promise<Map<string, VmCapability[]>> {
	const key = `vm-skus-by-region:${clients.subscriptionId}`;
	const byRegion = await cachedAzureQuery(
		key,
		cacheTtlMs('AZURE_SKU_CACHE_TTL_SECONDS', 300),
		async () => {
			const grouped = new Map<string, VmCapability[]>();
			for (const sku of await listResourceSkus(clients)) {
				for (const region of skuLocations(sku)) {
					const location = normalizeLocationName(region);
					const capability = skuToCapability(sku, location);
					if (capability.restricted) continue;
					const list = grouped.get(location) ?? [];
					list.push(capability);
					grouped.set(location, list);
				}
			}
			return grouped;
		}
	);

	const copy = new Map<string, VmCapability[]>();
	for (const [region, capabilities] of byRegion) {
		copy.set(
			region,
			capabilities.map((capability) => ({
				...capability,
				restrictionReasons: [...capability.restrictionReasons]
			}))
		);
	}
	return copy;
}

async function listVmSizeCapabilitiesForLocation(
	clients: AzureClients,
	location: string
): Promise<VmCapability[]> {
	const normalizedLocation = normalizeLocationName(location);
	const key = `vm-sizes:${clients.subscriptionId}:${normalizedLocation}`;
	const capabilities = await cachedAzureQuery(
		key,
		cacheTtlMs('AZURE_VM_SIZE_CACHE_TTL_SECONDS', 300),
		async () => {
			const list: VmCapability[] = [];
			for await (const size of clients.compute.virtualMachineSizes.list(normalizedLocation)) {
				if (!size.name) continue;
				list.push(vmSizeToCapability(size));
			}
			return list;
		}
	);
	return capabilities.map((capability) => ({
		...capability,
		restrictionReasons: [...capability.restrictionReasons]
	}));
}

async function listProviderVmRegions(clients: AzureClients): Promise<AzureRegionOption[]> {
	const key = `provider-vm-regions:${clients.subscriptionId}`;
	const regions = await cachedAzureQuery(
		key,
		cacheTtlMs('AZURE_REGION_CACHE_TTL_SECONDS', 300),
		async () => {
			const computeProvider = await clients.resources.providers.get('Microsoft.Compute');
			const virtualMachines = computeProvider.resourceTypes?.find(
				(resourceType) => resourceType.resourceType?.toLowerCase() === 'virtualmachines'
			);
			const fromProvider =
				virtualMachines?.locations?.map(regionOptionFromLocation).filter(isAzureRegionOption) ?? [];
			if (fromProvider.length > 0) return fromProvider;

			const providerTypes = await clients.resources.providerResourceTypes.list('Microsoft.Compute');
			const vmType = providerTypes.value?.find(
				(resourceType) => resourceType.resourceType?.toLowerCase() === 'virtualmachines'
			);
			return vmType?.locations?.map(regionOptionFromLocation).filter(isAzureRegionOption) ?? [];
		}
	);

	const byName = new Map<string, AzureRegionOption>();
	for (const region of regions) {
		if (!byName.has(region.name)) byName.set(region.name, { ...region });
	}
	return [...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
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

function imageResourceName(resource: VirtualMachineImageResource) {
	return String(resource.name ?? parseResourceName(resource.id ?? '')).trim();
}

function debianMajorFromOfferOrSku(offer: string, sku = '') {
	const text = `${offer} ${sku}`;
	return text.match(/\b(1[0-9]|[7-9])\b/)?.[1] ?? '';
}

function debianImageLabel(major: string, sku: string) {
	const genText = /gen2|gensecond/i.test(sku) ? ' Gen2' : '';
	return `Debian ${major}${genText}`;
}

function ubuntuVersionFromOfferOrSku(offer: string, sku = '') {
	const text = `${offer} ${sku}`;
	const match = text.match(/\b(\d{2}[_-]?\d{2})\b/i);
	return match?.[1]?.replace('-', '.').replace('_', '.') ?? '';
}

function isUbuntuServerLtsCandidate(offer: string, sku: string) {
	const text = `${offer} ${sku}`.toLowerCase();
	const version = ubuntuVersionFromOfferOrSku(offer, sku);
	if (!version) return false;
	if (!/lts|server/.test(text)) return false;
	if (!version.endsWith('.04')) return false;
	return !/minimal|daily|pro|fips|cvm|confidential|arm64|raspi|desktop/i.test(text);
}

function ubuntuImageLabel(offer: string, sku: string) {
	const version = ubuntuVersionFromOfferOrSku(offer, sku);
	const genText = /gen2|gensecond|server/i.test(sku) && !/^server$/i.test(sku) ? ' Gen2' : '';
	return version ? `Ubuntu ${version} LTS${genText}` : `Ubuntu ${sku}`;
}

function windowsServerVersionFromSku(sku: string) {
	return sku.match(/\b(20\d{2})\b/)?.[1] ?? '';
}

function isWindowsServerCandidate(sku: string) {
	const version = Number(windowsServerVersionFromSku(sku));
	if (!Number.isFinite(version) || version < 2016) return false;
	return /datacenter/i.test(sku) && !/core|smalldisk|zh-cn|de-de|fr-fr|ja-jp|ko-kr|es-es/i.test(sku);
}

function windowsServerImageLabel(sku: string) {
	const version = windowsServerVersionFromSku(sku);
	const azureEdition = /azure-edition/i.test(sku) ? ' Azure Edition' : '';
	const genText = /g2|gen2|gensecond/i.test(sku) ? ' Gen2' : '';
	return version
		? `Windows Server ${version}${azureEdition} Datacenter${genText}`
		: `Windows Server ${sku}`;
}

function imageCandidateRank(candidate: FeaturedImageCandidate) {
	const text = `${candidate.offer} ${candidate.sku}`.toLowerCase();
	let osRank = 900;
	if (candidate.publisher === 'Canonical') {
		const version = ubuntuVersionFromOfferOrSku(candidate.offer, candidate.sku);
		const versionNumber = Number(version.replace('.', ''));
		osRank = Number.isFinite(versionNumber) ? Math.max(0, 3000 - versionNumber) : 90;
	} else if (candidate.publisher === 'Debian') {
		const major = debianMajorFromOfferOrSku(candidate.offer, candidate.sku);
		osRank = major ? Math.max(0, 130 - Number(major)) : 130;
	} else if (candidate.publisher === 'MicrosoftWindowsServer') {
		const version = windowsServerVersionFromSku(candidate.sku);
		osRank = version ? Math.max(0, 4200 - Number(version)) : 230;
	}
	const genRank = /gen2|gensecond|g2|server/i.test(text) ? 0 : 5;
	const azureRank = /azure-edition/i.test(text) ? 0 : 1;
	return osRank + genRank + azureRank;
}

async function discoverFeaturedImageCandidates(
	clients: AzureClients,
	location: string
): Promise<FeaturedImageCandidate[]> {
	const discovered = await mapWithConcurrency(
		IMAGE_DISCOVERY_CONFIGS,
		IMAGE_DISCOVERY_CONCURRENCY,
		async (config) => {
			const offers = await clients.compute.virtualMachineImages
				.listOffers(location, config.publisher)
				.catch(() => []);
			const matchingOffers = offers.map(imageResourceName).filter((offer) => config.offerMatches(offer));
			const nested = await mapWithConcurrency(
				matchingOffers,
				IMAGE_DISCOVERY_CONCURRENCY,
				async (offer) => {
					const skus = await clients.compute.virtualMachineImages
						.listSkus(location, config.publisher, offer)
						.catch(() => []);
					return skus
						.map(imageResourceName)
						.filter((sku) => config.skuMatches(offer, sku))
						.map((sku) => ({
							label: config.label(offer, sku),
							publisher: config.publisher,
							offer,
							sku,
							osType: config.osType
						}));
				}
			);
			return nested.flat();
		}
	);
	const byKey = new Map<string, FeaturedImageCandidate>();
	for (const candidate of [...FEATURED_IMAGE_CANDIDATES, ...discovered.flat()]) {
		const key = `${candidate.publisher}:${candidate.offer}:${candidate.sku}`.toLowerCase();
		if (!byKey.has(key)) byKey.set(key, candidate);
	}
	const configuredLimit = Number(readEnv('AZURE_IMAGE_DISCOVERY_LIMIT') ?? DEFAULT_IMAGE_DISCOVERY_LIMIT);
	const limit =
		Number.isFinite(configuredLimit) && configuredLimit > 0
			? Math.min(200, Math.max(1, configuredLimit))
			: DEFAULT_IMAGE_DISCOVERY_LIMIT;
	return [...byKey.values()]
		.sort((a, b) => {
			const rank = imageCandidateRank(a) - imageCandidateRank(b);
			if (rank !== 0) return rank;
			return `${a.label}:${a.offer}:${a.sku}`.localeCompare(`${b.label}:${b.offer}:${b.sku}`, undefined, {
				numeric: true,
				sensitivity: 'base'
			});
		})
		.slice(0, limit);
}

function isPublicIpResourceIPv6(pip: PublicIPAddress) {
	const raw = pip as PublicIPAddress & {
		properties?: { publicIPAddressVersion?: string; ipAddress?: string };
	};
	const version = String(pip.publicIPAddressVersion ?? raw.properties?.publicIPAddressVersion ?? '').toLowerCase();
	if (version === 'ipv6') return true;
	if (version === 'ipv4') return false;
	return Boolean(publicIpAddressValue(pip).includes(':'));
}

function publicIpAddressValue(pip: PublicIPAddress) {
	const raw = pip as PublicIPAddress & { properties?: { ipAddress?: string } };
	return String(pip.ipAddress ?? raw.properties?.ipAddress ?? '').trim();
}

function publicIpIpConfigurationId(pip: PublicIPAddress) {
	const raw = pip as PublicIPAddress & { properties?: { ipConfiguration?: { id?: string } } };
	return String(pip.ipConfiguration?.id ?? raw.properties?.ipConfiguration?.id ?? '').trim();
}

function publicIpProvisioningState(pip: PublicIPAddress) {
	const raw = pip as PublicIPAddress & { properties?: { provisioningState?: string } };
	return String(pip.provisioningState ?? raw.properties?.provisioningState ?? '').trim();
}

function networkUsageName(usage: NetworkUsage) {
	return `${usage.name?.value ?? ''} ${usage.name?.localizedValue ?? ''}`.trim();
}

function isPublicIpUsage(usage: NetworkUsage) {
	return /public\s*ip|publicip|公网\s*ip|公共\s*ip|公共.*地址/i.test(networkUsageName(usage));
}

async function ensurePublicIpQuotaAvailable(
	clients: AzureClients,
	location: string,
	progress: CreateVmProgressReporter | undefined,
	step: string,
	detail: CreateVmProgressEvent['detail']
) {
	try {
		const usages = await cachedAzureQuery(
			`network-usages:${clients.subscriptionId}:${location}`,
			cacheTtlMs('AZURE_NETWORK_USAGE_CACHE_TTL_SECONDS', 60),
			async () => {
				const list: NetworkUsage[] = [];
				for await (const usage of clients.network.usages.list(location)) {
					list.push(usage);
				}
				return list;
			}
		);
		const publicIpUsage = usages.find(isPublicIpUsage);
		if (!publicIpUsage) return;
		const current = Number(publicIpUsage.currentValue ?? 0);
		const limit = Number(publicIpUsage.limit ?? 0);
		if (!Number.isFinite(current) || !Number.isFinite(limit) || limit <= 0) return;
		await reportCreateVmProgress(progress, `${step}-quota`, 'info', '公网 IP 配额预检完成', {
			...detail,
			usageName: networkUsageName(publicIpUsage),
			current,
			limit,
			remaining: limit - current
		});
		if (current >= limit) {
			throw new Error(
				`公网 IP 区域配额不足 ${networkUsageName(publicIpUsage) || 'Public IP'}: 已用 ${current}/${limit}`
			);
		}
	} catch (err) {
		if (isPublicIpQuotaFailure(formatAzureError(err))) throw err;
		const message = formatAzureError(err);
		await reportCreateVmProgress(progress, `${step}-quota`, 'info', '公网 IP 配额预检失败，继续尝试创建', {
			...detail,
			error: message.length > 800 ? `${message.slice(0, 800)}...` : message
		});
	}
}

async function describePublicIpAfterCreateFailure(
	clients: AzureClients,
	resourceGroup: string,
	publicIpName: string
) {
	const pip = await getPublicIpWithRawFallback(clients, resourceGroup, publicIpName).catch(() => null);
	if (!pip?.id) return '';
	const state = publicIpProvisioningState(pip);
	const address = publicIpAddressValue(pip);
	const ipConfig = publicIpIpConfigurationId(pip);
	return [
		`Public IP residual resource exists`,
		state ? `provisioningState=${state}` : '',
		address ? `ip=${address}` : 'ip=-',
		ipConfig ? `ipConfiguration=${parseResourceName(ipConfig) || ipConfig}` : 'ipConfiguration=-'
	]
		.filter(Boolean)
		.join('；');
}

type ArmPublicIpResource = {
	id?: string;
	name?: string;
	location?: string;
	properties?: {
		ipAddress?: string;
		publicIPAddressVersion?: string;
		ipConfiguration?: { id?: string };
		provisioningState?: string;
	};
};

function armPublicIpToModel(resource: ArmPublicIpResource): PublicIPAddress {
	return {
		id: resource.id ?? '',
		name: resource.name ?? parseResourceName(resource.id ?? ''),
		location: resource.location ?? '',
		ipAddress: resource.properties?.ipAddress,
		publicIPAddressVersion: resource.properties?.publicIPAddressVersion as PublicIPAddress['publicIPAddressVersion'],
		ipConfiguration: resource.properties?.ipConfiguration,
		provisioningState: resource.properties?.provisioningState,
		properties: resource.properties
	} as PublicIPAddress & { properties?: ArmPublicIpResource['properties'] };
}

function mergePublicIpModel(base: PublicIPAddress, fallback: PublicIPAddress): PublicIPAddress {
	const baseRaw = base as PublicIPAddress & { properties?: ArmPublicIpResource['properties'] };
	const fallbackRaw = fallback as PublicIPAddress & { properties?: ArmPublicIpResource['properties'] };
	const baseIpConfiguration = base.ipConfiguration?.id ? base.ipConfiguration : baseRaw.properties?.ipConfiguration;
	const fallbackIpConfiguration = fallback.ipConfiguration?.id
		? fallback.ipConfiguration
		: fallbackRaw.properties?.ipConfiguration;
	return {
		...base,
		...fallback,
		id: fallback.id || base.id,
		name: fallback.name || base.name,
		location: fallback.location || base.location,
		ipAddress: publicIpAddressValue(base) || publicIpAddressValue(fallback) || undefined,
		publicIPAddressVersion: base.publicIPAddressVersion ?? fallback.publicIPAddressVersion,
		ipConfiguration: baseIpConfiguration ?? fallbackIpConfiguration,
		provisioningState: base.provisioningState ?? fallback.provisioningState,
		properties: {
			...(baseRaw.properties ?? {}),
			...(fallbackRaw.properties ?? {})
		}
	} as PublicIPAddress & { properties?: ArmPublicIpResource['properties'] };
}

function publicIpArmPath(clients: AzureClients, resourceGroup: string, publicIpName: string) {
	return (
		`/subscriptions/${encodeURIComponent(clients.subscriptionId)}` +
		`/resourceGroups/${encodeURIComponent(resourceGroup)}` +
		`/providers/Microsoft.Network/publicIPAddresses/${encodeURIComponent(publicIpName)}` +
		`?api-version=${NETWORK_PUBLIC_IP_API_VERSION}`
	);
}

function publicIpListArmPath(clients: AzureClients, resourceGroup: string) {
	return (
		`/subscriptions/${encodeURIComponent(clients.subscriptionId)}` +
		`/resourceGroups/${encodeURIComponent(resourceGroup)}` +
		`/providers/Microsoft.Network/publicIPAddresses` +
		`?api-version=${NETWORK_PUBLIC_IP_API_VERSION}`
	);
}

function armHeader(response: PipelineResponse, name: string) {
	return String(response.headers.get(name) ?? '').trim();
}

function armBodySummary(bodyAsText?: string | null) {
	return formatAzureError(parseArmJson(bodyAsText));
}

function publicIpCreateBody(options: {
	location: string;
	version: 'IPv4' | 'IPv6';
	ddosProtectionPlanId?: string;
}) {
	return {
		location: options.location,
		sku: { name: 'Standard' },
		properties: {
			publicIPAllocationMethod: 'Static',
			publicIPAddressVersion: options.version,
			deleteOption: 'Delete',
			...(options.ddosProtectionPlanId
				? {
						ddosSettings: {
							protectionMode: 'Enabled',
							ddosProtectionPlan: { id: options.ddosProtectionPlanId }
						}
					}
				: {})
		}
	};
}

function publicIpLroStatus(payload: unknown) {
	const record = payload as Record<string, unknown>;
	const properties = record.properties as Record<string, unknown> | undefined;
	return String(record.status ?? properties?.provisioningState ?? '').trim().toLowerCase();
}

async function createPublicIpViaArm(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		location: string;
		name: string;
		version: 'IPv4' | 'IPv6';
		ddosProtectionPlanId?: string;
		progress?: CreateVmProgressReporter;
		step: string;
		detail: CreateVmProgressEvent['detail'];
	}
): Promise<{ pip: PublicIPAddress; polls: number }> {
	const response = await sendArmPipelineRequest(clients.credential, clients.clientOptions, {
		method: 'PUT',
		pathOrUrl: publicIpArmPath(clients, options.resourceGroup, options.name),
		body: publicIpCreateBody(options)
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(armResponseError(response.status, response.bodyAsText));
	}

	const asyncOperationUrl = armHeader(response, 'Azure-AsyncOperation');
	const locationUrl = armHeader(response, 'Location');
	const requestId = armHeader(response, 'x-ms-request-id');
	const pollUrl = asyncOperationUrl || locationUrl;
	let polls = 0;

	if (pollUrl) {
		await reportCreateVmProgress(
			options.progress,
			`${options.step}-polling`,
			'running',
			`${options.version} 公网 IP 创建中，已获取 Azure 长任务地址`,
			{
				...options.detail,
				name: options.name,
				requestId: requestId || null,
				pollMode: asyncOperationUrl ? 'Azure-AsyncOperation' : 'Location'
			}
		);
		for (polls = 1; polls <= 120; polls++) {
			await sleep(2000);
			const pollResponse = await sendArmPipelineRequest(clients.credential, clients.clientOptions, {
				method: 'GET',
				pathOrUrl: pollUrl
			});
			const payload = parseArmJson(pollResponse.bodyAsText);
			const status = publicIpLroStatus(payload);
			await reportCreateVmProgress(
				options.progress,
				`${options.step}-polling`,
				'running',
				`${options.version} 公网 IP 创建中，轮询第 ${polls} 次`,
				{
					...options.detail,
					name: options.name,
					status: status || String(pollResponse.status),
					polls
				}
			);
			if (pollResponse.status < 200 || pollResponse.status >= 300) {
				throw new Error(`Public IP LRO poll failed: ${armResponseError(pollResponse.status, pollResponse.bodyAsText)}`);
			}
			if (status === 'failed' || status === 'canceled' || status === 'cancelled') {
				throw new Error(`Public IP LRO ${status}: ${armBodySummary(pollResponse.bodyAsText)}`);
			}
			if (status === 'succeeded' || status === 'success') break;
		}
		if (polls > 120) throw new Error('Public IP LRO polling timed out after 120 attempts');
	} else if (response.status !== 200 && response.status !== 201) {
		throw new Error(`Azure 未返回 Public IP 长任务地址: HTTP ${response.status}`);
	}

	const pip = await getPublicIpWithRawFallback(clients, options.resourceGroup, options.name);
	return { pip, polls };
}

async function getPublicIpViaArm(
	clients: AzureClients,
	resourceGroup: string,
	publicIpName: string
): Promise<PublicIPAddress> {
	const payload = (await sendArmRequest(clients.credential, clients.clientOptions, {
		method: 'GET',
		pathOrUrl: publicIpArmPath(clients, resourceGroup, publicIpName)
	})) as ArmPublicIpResource;
	return armPublicIpToModel(payload);
}

async function getPublicIpWithRawFallback(
	clients: AzureClients,
	resourceGroup: string,
	publicIpName: string
): Promise<PublicIPAddress> {
	const pip = await clients.network.publicIPAddresses.get(resourceGroup, publicIpName);
	if (publicIpAddressValue(pip) && publicIpIpConfigurationId(pip)) return pip;
	const raw = await getPublicIpViaArm(clients, resourceGroup, publicIpName).catch(() => null);
	return raw ? mergePublicIpModel(pip, raw) : pip;
}

async function listPublicIpsViaArm(clients: AzureClients, resourceGroup: string) {
	const resources = await collectArmPages<ArmPublicIpResource>(
		clients.credential,
		clients.clientOptions,
		publicIpListArmPath(clients, resourceGroup)
	);
	return resources.map(armPublicIpToModel);
}

function rememberPublicIp(ips: { publicIPv4: string; publicIPv6: string }, pip: PublicIPAddress) {
	const address = publicIpAddressValue(pip);
	if (!address) return false;
	if (isPublicIpResourceIPv6(pip)) {
		if (!ips.publicIPv6) ips.publicIPv6 = address;
		return Boolean(ips.publicIPv6);
	}
	if (!ips.publicIPv4) ips.publicIPv4 = address;
	return Boolean(ips.publicIPv4);
}

function publicIpReferencesNic(
	pip: PublicIPAddress,
	nics: { nicResourceGroup: string; nicName: string; nic: NetworkInterface }[]
) {
	const ipConfigId = normalizeResourceToken(publicIpIpConfigurationId(pip));
	if (!ipConfigId) return false;
	return nics.some(({ nicName, nic }) => {
		const nicId = normalizeResourceToken(nic.id ?? '');
		const normalizedNicName = normalizeResourceToken(nicName || nic.name || '');
		return (
			(Boolean(nicId) && ipConfigId.includes(nicId)) ||
			(Boolean(normalizedNicName) && ipConfigId.includes(`/networkinterfaces/${normalizedNicName}/`))
		);
	});
}

function publicIpNameMatchesVm(pip: PublicIPAddress, vmName: string) {
	const pipName = normalizeResourceToken(pip.name ?? parseResourceName(pip.id ?? ''));
	const cleanVmName = normalizeResourceToken(sanitizeResourceName(vmName));
	const rawVmName = normalizeResourceToken(vmName);
	return (
		pipName.startsWith(`${cleanVmName}-pip`) ||
		pipName.startsWith(`${rawVmName}-pip`) ||
		(pipName.includes(rawVmName) && pipName.includes('pip'))
	);
}

function publicIpIpConfigurationName(pip: PublicIPAddress) {
	const ipConfigId = publicIpIpConfigurationId(pip);
	const match = ipConfigId.match(/\/ipConfigurations\/([^/]+)/i);
	return match ? decodeURIComponent(match[1]) : '';
}

type NicPublicIpBinding = {
	publicIpId: string;
	publicIpName: string;
	publicIpResourceGroup: string;
	publicIPv4: string;
	ipConfigName: string;
	source: string;
};

async function findNicIPv4PublicIpBinding(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		vmName: string;
		nicResourceGroup: string;
		nicName: string;
		nic: NetworkInterface;
		preferredIpConfigName?: string;
		progress?: CreateVmProgressReporter;
		step?: string;
	}
): Promise<NicPublicIpBinding | null> {
	const resourceGroups = [
		...new Set([options.nicResourceGroup, options.resourceGroup].filter(Boolean))
	];
	const candidatesByKey = new Map<string, PublicIPAddress>();
	const rememberCandidate = (candidate: PublicIPAddress) => {
		const key =
			normalizeResourceToken(candidate.id ?? '') ||
			normalizeResourceToken(candidate.name ?? '') ||
			`anonymous-${candidatesByKey.size + 1}`;
		const existing = candidatesByKey.get(key);
		candidatesByKey.set(key, existing ? mergePublicIpModel(existing, candidate) : candidate);
	};

	for (const resourceGroup of resourceGroups) {
		for await (const listed of clients.network.publicIPAddresses.list(resourceGroup)) {
			const pipName = listed.name ?? parseResourceName(listed.id ?? '');
			const pip =
				pipName && (!publicIpAddressValue(listed) || !publicIpIpConfigurationId(listed))
					? await getPublicIpWithRawFallback(clients, resourceGroup, pipName).catch(() => listed)
					: listed;
			rememberCandidate(pip);
		}
		for (const raw of await listPublicIpsViaArm(clients, resourceGroup).catch(() => [])) {
			rememberCandidate(raw);
		}
	}

	const nics = [{ nicResourceGroup: options.nicResourceGroup, nicName: options.nicName, nic: options.nic }];
	const matches = [...candidatesByKey.values()]
		.filter((pip) => !isPublicIpResourceIPv6(pip))
		.filter((pip) => publicIpReferencesNic(pip, nics))
		.map((pip) => {
			const publicIpId = pip.id ?? '';
			const publicIpName = pip.name ?? parseResourceName(publicIpId);
			const publicIpResourceGroup = parseResourceGroup(publicIpId) || options.nicResourceGroup;
			const ipConfigName = publicIpIpConfigurationName(pip);
			return {
				publicIpId,
				publicIpName,
				publicIpResourceGroup,
				publicIPv4: publicIpAddressValue(pip),
				ipConfigName,
				source: 'public-ip-reverse'
			};
		})
		.filter((binding) => binding.publicIpId && binding.publicIpName && binding.publicIpResourceGroup)
		.sort((a, b) => {
			const preferred = normalizeResourceToken(options.preferredIpConfigName ?? '');
			const aExact = preferred && normalizeResourceToken(a.ipConfigName) === preferred ? 1 : 0;
			const bExact = preferred && normalizeResourceToken(b.ipConfigName) === preferred ? 1 : 0;
			return bExact - aExact;
		});

	const selected = matches[0] ?? null;
	if (selected) {
		await reportCreateVmProgress(
			options.progress,
			options.step ?? 'replace-ip-prepare',
			'info',
			'已通过 Public IP 反向识别当前网卡 IPv4 绑定',
			{
				nicName: options.nicName,
				ipConfigName: selected.ipConfigName || '-',
				publicIpName: selected.publicIpName,
				publicIPv4: selected.publicIPv4 || '-'
			}
		);
	}
	return selected;
}

async function collectPublicIpsFromResourceGroup(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		vmName: string;
		nics: { nicResourceGroup: string; nicName: string; nic: NetworkInterface }[];
		ips: { publicIPv4: string; publicIPv6: string };
		progress?: CreateVmProgressReporter;
		progressStep?: string;
	}
) {
	if (!options.resourceGroup || !options.vmName) return;
	let fallbackIPv4 = '';
	let fallbackIPv6 = '';
	let fallbackIPv4Count = 0;
	let fallbackIPv6Count = 0;
	let associatedIPv4 = '';
	let associatedIPv6 = '';
	let associatedIPv4Count = 0;
	let associatedIPv6Count = 0;
	const candidatesByKey = new Map<string, PublicIPAddress>();

	const rememberCandidate = (candidate: PublicIPAddress) => {
		const key =
			normalizeResourceToken(candidate.id ?? '') ||
			normalizeResourceToken(candidate.name ?? '') ||
			`anonymous-${candidatesByKey.size + 1}`;
		const existing = candidatesByKey.get(key);
		candidatesByKey.set(key, existing ? mergePublicIpModel(existing, candidate) : candidate);
	};

	const inspectPublicIp = async (candidate: PublicIPAddress) => {
		const pipName = candidate.name ?? parseResourceName(candidate.id ?? '');
		const pip = candidate;
		const linkedToNic = publicIpReferencesNic(pip, options.nics);
		const nameMatchesVm = publicIpNameMatchesVm(pip, options.vmName);
		if (!linkedToNic && !nameMatchesVm) {
			const address = publicIpAddressValue(pip);
			if (address) {
				const associatedWithAnyNic =
					Boolean(publicIpIpConfigurationId(pip)) &&
					normalizeResourceToken(publicIpIpConfigurationId(pip)).includes('/networkinterfaces/');
				if (isPublicIpResourceIPv6(pip)) {
					fallbackIPv6 = address;
					fallbackIPv6Count += 1;
					if (associatedWithAnyNic) {
						associatedIPv6 = address;
						associatedIPv6Count += 1;
					}
				} else {
					fallbackIPv4 = address;
					fallbackIPv4Count += 1;
					if (associatedWithAnyNic) {
						associatedIPv4 = address;
						associatedIPv4Count += 1;
					}
				}
			}
			return;
		}
		if (options.progress && pipName) {
			await reportCreateVmProgress(
				options.progress,
				options.progressStep ?? 'refresh-ip-public-ip',
				'running',
				'Reverse lookup public IP resources from resource group',
				{
					publicIpName: pipName,
					resourceGroup: options.resourceGroup,
					matchedBy: linkedToNic ? 'nic' : 'name'
				}
			);
		}
		rememberPublicIp(options.ips, pip);
	};

	for await (const listed of clients.network.publicIPAddresses.list(options.resourceGroup)) {
		const pipName = listed.name ?? parseResourceName(listed.id ?? '');
		const pip =
			pipName && (!publicIpAddressValue(listed) || !publicIpIpConfigurationId(listed))
				? await getPublicIpWithRawFallback(clients, options.resourceGroup, pipName).catch(() => listed)
				: listed;
		rememberCandidate(pip);
	}

	const rawPublicIps = await listPublicIpsViaArm(clients, options.resourceGroup).catch(() => []);
	for (const pip of rawPublicIps) {
		rememberCandidate(pip);
	}

	for (const pip of candidatesByKey.values()) {
		if (options.ips.publicIPv4 && options.ips.publicIPv6) break;
		await inspectPublicIp(pip);
	}

	if (!options.ips.publicIPv4 && associatedIPv4Count === 1) options.ips.publicIPv4 = associatedIPv4;
	if (!options.ips.publicIPv6 && associatedIPv6Count === 1) options.ips.publicIPv6 = associatedIPv6;
	if (!options.ips.publicIPv4 && fallbackIPv4Count === 1) options.ips.publicIPv4 = fallbackIPv4;
	if (!options.ips.publicIPv6 && fallbackIPv6Count === 1) options.ips.publicIPv6 = fallbackIPv6;
}

async function collectPublicIps(
	clients: AzureClients,
	vm: {
		networkProfile?: { networkInterfaces?: { id?: string }[] };
		name?: string;
		id?: string;
	},
	resourceGroupHint?: string
) {
	const ips = { publicIPv4: '', publicIPv6: '' };
	const nicRefs = vm.networkProfile?.networkInterfaces ?? [];
	const nics: { nicResourceGroup: string; nicName: string; nic: NetworkInterface }[] = [];

	for (const nicRef of nicRefs) {
		const nicId = nicRef.id ?? '';
		const nicName = parseResourceName(nicId);
		const nicResourceGroup = parseResourceGroup(nicId);
		if (!nicName || !nicResourceGroup) continue;
		try {
			nics.push({
				nicResourceGroup,
				nicName,
				nic: await clients.network.networkInterfaces.get(nicResourceGroup, nicName)
			});
		} catch {
			// Keep listing resilient even if one NIC/IP has been removed concurrently.
		}
	}

	if (nics.length === 0 && vm.name) {
		const vmResourceGroup = resourceGroupHint || parseResourceGroup(vm.id ?? '');
		if (vmResourceGroup) {
			try {
				const resolved = await findVmNetworkInterface(clients, vmResourceGroup, vm.name);
				nics.push(resolved);
			} catch {
				// Keep listing resilient even if Azure does not expose a NIC for this VM yet.
			}
		}
	}

	for (const { nicResourceGroup, nicName, nic } of nics) {
		const fromNic = await readPublicIpsFromNic(clients, { nicResourceGroup, nicName, nic }).catch(() => null);
		if (fromNic?.ips.publicIPv4 && !ips.publicIPv4) ips.publicIPv4 = fromNic.ips.publicIPv4;
		if (fromNic?.ips.publicIPv6 && !ips.publicIPv6) ips.publicIPv6 = fromNic.ips.publicIPv6;
	}
	if ((!ips.publicIPv4 || !ips.publicIPv6) && vm.name) {
		const vmResourceGroup = resourceGroupHint || parseResourceGroup(vm.id ?? '');
		try {
			await collectPublicIpsFromResourceGroup(clients, {
				resourceGroup: vmResourceGroup,
				vmName: vm.name,
				nics,
				ips
			});
		} catch {
			// Listing VMs should stay resilient even if Public IP reverse lookup is temporarily unavailable.
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
		const fullVm = vm.name
			? await clients.compute.virtualMachines.get(rg, vm.name).catch(() => vm)
			: vm;
		const view = await clients.compute.virtualMachines.instanceView(rg, vm.name!);
		const power =
			view.statuses?.find((s) => s.code?.startsWith('PowerState/'))?.code?.replace('PowerState/', '') ??
			'unknown';
		const publicIps = await collectPublicIps(clients, fullVm, rg);
		items.push({
			name: fullVm.name ?? vm.name ?? '',
			resourceGroup: rg,
			location: fullVm.location ?? vm.location ?? '',
			vmSize: fullVm.hardwareProfile?.vmSize ?? vm.hardwareProfile?.vmSize ?? '',
			powerState: power,
			provisioningState: fullVm.provisioningState ?? vm.provisioningState ?? '',
			publicIPv4: publicIps.publicIPv4,
			publicIPv6: publicIps.publicIPv6
		});
	}
	return items;
}

export async function refreshVmPublicIps(
	clients: AzureClients,
	resourceGroup: string,
	vmName: string,
	progress?: CreateVmProgressReporter
): Promise<VmPublicIpRefreshResult> {
	await reportCreateVmProgress(progress, 'refresh-ip-prepare', 'running', '重读 VM 网卡配置', {
		resourceGroup,
		vmName
	});
	const { nicResourceGroup, nicName, nic } = await getPrimaryNicAndIPv4Config(
		clients,
		resourceGroup,
		vmName,
		progress
	);
	await reportCreateVmProgress(progress, 'refresh-ip-nic', 'success', '已定位 VM 网卡', {
		nicName,
		nicResourceGroup
	});

	const ips = { publicIPv4: '', publicIPv6: '' };
	const fromNic = await readPublicIpsFromNic(clients, { nicResourceGroup, nicName, nic }).catch(() => null);
	if (fromNic?.ips.publicIPv4) ips.publicIPv4 = fromNic.ips.publicIPv4;
	if (fromNic?.ips.publicIPv6) ips.publicIPv6 = fromNic.ips.publicIPv6;

	if (!ips.publicIPv4 || !ips.publicIPv6) {
		await collectPublicIpsFromResourceGroup(clients, {
			resourceGroup,
			vmName,
			nics: [{ nicResourceGroup, nicName, nic }],
			ips,
			progress,
			progressStep: 'refresh-ip-public-ip'
		}).catch(() => undefined);
	}
	await reportCreateVmProgress(progress, 'refresh-ip-complete', 'success', 'Public IP refresh complete', {
		vmName,
		publicIPv4: ips.publicIPv4 || '-',
		publicIPv6: ips.publicIPv6 || '-',
		nicName
	});
	return {
		vmName,
		resourceGroup,
		publicIPv4: ips.publicIPv4,
		publicIPv6: ips.publicIPv6,
		nicName,
		nicResourceGroup
	};
}

export async function listVmCapabilities(
	clients: AzureClients,
	location: string,
	options: { includeQuotas?: boolean } = {}
): Promise<VmCapabilitiesResult> {
	const includeQuotas = options.includeQuotas ?? true;
	const [resourceSkus, legacySizes, quotas] = await Promise.all([
		listResourceSkuCapabilitiesForLocationSafe(clients, location),
		listVmSizeCapabilitiesForLocation(clients, location).catch(() => []),
		includeQuotas ? listComputeQuotas(clients, location) : Promise.resolve([])
	]);
	const merged = mergeVisibleVmCapabilities(resourceSkus, legacySizes);
	if (merged.length === 0) {
		throw new Error(`Azure 官方 API 没有返回 ${location} 可创建 VM 的规格，请检查区域、订阅权限或 Microsoft.Compute 注册状态`);
	}
	const quotaAware = includeQuotas
		? applyQuotaToCapabilities(merged, quotas, { restrictByQuota: false })
		: merged;
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
		quotas,
		highestCoreSize: selectLargest(available, 'cores'),
		largestMemorySize: selectLargest(available, 'memoryGB')
	};
}

export async function listAvailableVmRegions(clients: AzureClients): Promise<AzureRegionOption[]> {
	let byRegion: Map<string, VmCapability[]>;

	try {
		byRegion = await listResourceSkuCapabilitiesByRegion(clients);
	} catch (err) {
		const fallbackRegions = await listProviderVmRegions(clients).catch(() => []);
		if (fallbackRegions.length > 0) {
			console.warn(
				'[azure] ResourceSkus region discovery failed, falling back to provider locations:',
				azureErrorMessage(err)
			);
			return fallbackRegions;
		}
		throw new Error(`查询 Azure 官方可用区域失败：${azureErrorMessage(err)}`);
	}

	if (byRegion.size === 0) {
		throw new Error('Azure 官方 API 没有返回当前订阅可创建 VM 的区域');
	}

	const availableRegions: AzureRegionOption[] = [];
	for (const [name, candidates] of byRegion) {
		const available = candidates
			.filter((capability) => !capability.restricted)
			.sort((a, b) => byCapacity(a, b));
		if (available.length === 0) continue;
		availableRegions.push({
			name,
			displayName: displayLocationName(name),
			availableSizeCount: available.length,
			highestCoreSize: selectLargest(available, 'cores'),
			largestMemorySize: selectLargest(available, 'memoryGB')
		});
	}
	availableRegions.sort((a, b) => a.displayName.localeCompare(b.displayName));

	if (availableRegions.length === 0) {
		throw new Error('Azure 官方 API 没有返回当前订阅可创建 VM 的区域');
	}
	return availableRegions;
}

export async function listQuotaFilteredVmRegions(clients: AzureClients): Promise<AzureRegionOption[]> {
	const byRegion = await listResourceSkuCapabilitiesByRegion(clients);
	const configuredScanLimit = Number(readEnv('AZURE_REGION_SCAN_LIMIT') ?? byRegion.size);
	const configuredConcurrency = Number(readEnv('AZURE_REGION_SCAN_CONCURRENCY') ?? 6);
	const maxScan =
		Number.isFinite(configuredScanLimit) && configuredScanLimit > 0
			? Math.min(byRegion.size, Math.max(1, configuredScanLimit))
			: byRegion.size;
	const concurrency =
		Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
			? Math.min(12, Math.max(1, configuredConcurrency))
			: 6;
	const entries = rankRegionEntries([...byRegion.entries()]).slice(0, maxScan);
	const quotaErrors: string[] = [];
	const regions = await mapWithConcurrency(entries, concurrency, async ([name, candidates]) => {
		const quotas = await listComputeQuotas(clients, name).catch((err) => {
			quotaErrors.push(`${name}: ${azureErrorMessage(err)}`);
			return [];
		});
		if (quotas.length === 0) {
			return null;
		}
		const available = applyQuotaToCapabilities(candidates, quotas)
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
	namespaces = DEFAULT_PROVIDER_NAMESPACES,
	progress?: CreateVmProgressReporter,
	options: { skipStatusCheck?: boolean } = {}
): Promise<AzureProviderStatus[]> {
	const statuses: AzureProviderStatus[] = [];
	for (const [index, namespace] of namespaces.entries()) {
		const step = `provider-${namespace.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
		const detail = {
			namespace,
			index: index + 1,
			total: namespaces.length
		};
		try {
			let provider: Provider | null = null;
			if (options.skipStatusCheck) {
				await reportCreateVmProgress(
					progress,
					`${step}-check`,
					'info',
					`跳过 ${namespace} 状态读取，直接提交注册请求`,
					detail
				);
			} else {
				await reportCreateVmProgress(progress, `${step}-check`, 'running', `检查 ${namespace} 注册状态`, detail);
				provider = await clients.resources.providers.get(namespace).catch(() => null);
			}
			if (provider?.registrationState?.toLowerCase() === 'registered') {
				const status = providerToStatus(provider, namespace);
				statuses.push(status);
				await reportCreateVmProgress(progress, `${step}-check`, 'success', `${namespace} 已注册，跳过提交`, {
					...detail,
					registrationState: status.registrationState
				});
				continue;
			}
			await reportCreateVmProgress(progress, `${step}-register`, 'running', `提交 ${namespace} 注册请求`, {
				...detail,
				registrationState: provider?.registrationState ?? 'NotRegistered'
			});
			const status = providerToStatus(await clients.resources.providers.register(namespace), namespace);
			statuses.push(status);
			const state = status.registrationState.toLowerCase();
			await reportCreateVmProgress(
				progress,
				`${step}-register`,
				state === 'registered' ? 'success' : state === 'registering' ? 'info' : 'success',
				state === 'registering'
					? `${namespace} 已提交注册，等待 Azure 后台生效`
					: `${namespace} 注册状态：${status.registrationState || '-'}`,
				{
					...detail,
					registrationState: status.registrationState
				}
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Failed';
			const status = {
				namespace,
				registrationState: message,
				registrationPolicy: '',
				resourceTypeCount: 0,
				locations: []
			};
			statuses.push(status);
			await reportCreateVmProgress(progress, `${step}-register`, 'error', `${namespace} 注册失败: ${message}`, {
				...detail,
				registrationState: message
			});
		}
	}
	return statuses;
}

export async function listFeaturedVmImages(
	clients: AzureClients,
	location: string
): Promise<VmImageOption[]> {
	const normalizedLocation = normalizeLocationName(location);
	const cacheKey = `vm-images:${clients.subscriptionId}:${normalizedLocation}`;
	return cachedAzureQuery(
		cacheKey,
		cacheTtlMs('AZURE_IMAGE_CACHE_TTL_SECONDS', 3600),
		async () => {
			const candidates = await discoverFeaturedImageCandidates(clients, location).catch(() => [
				...FEATURED_IMAGE_CANDIDATES
			]);
			const images = await mapWithConcurrency(
				candidates,
				IMAGE_QUERY_CONCURRENCY,
				async (candidate) => {
					try {
						const versions = await clients.compute.virtualMachineImages.list(
							location,
							candidate.publisher,
							candidate.offer,
							candidate.sku,
							{ top: 1, orderby: 'name desc' }
						);
						const version = latestImageVersion(versions);
						if (!version) return null;

						const image = vmImageOptionFromCandidate(candidate, version);
						try {
							const detail = await clients.compute.virtualMachineImages.get(
								location,
								candidate.publisher,
								candidate.offer,
								candidate.sku,
								version
							);
							image.architecture = detail.architecture ?? '';
							image.hyperVGeneration = detail.hyperVGeneration ?? '';
						} catch {
							// Version listing is enough for creation; details only enrich the dropdown.
						}
						return image;
					} catch {
						return null;
					}
				}
			);

			const seenImages = new Set<string>();
			const uniqueImages = images.filter((image): image is VmImageOption => {
				if (!image) return false;
				const key = image.imageReference.toLowerCase();
				if (seenImages.has(key)) return false;
				seenImages.add(key);
				return true;
			});

			if (uniqueImages.length === 0) {
				throw new Error(`Azure 官方镜像 API 没有返回 ${location} 可创建 VM 的系统镜像`);
			}
			return uniqueImages;
		}
	);
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

type CapacityQuotaItem = {
	name?: string;
	properties?: {
		name?: {
			value?: string;
			localizedValue?: string;
		};
		resourceName?: string;
		currentValue?: number;
		limit?: number;
		unit?: string;
	};
};

function numericQuotaValue(value: unknown) {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}

function capacityQuotaToComputeQuota(item: CapacityQuotaItem): ComputeQuota {
	const properties = item.properties ?? {};
	const current = numericQuotaValue(properties.currentValue);
	const limit = numericQuotaValue(properties.limit);
	const name = properties.name?.value ?? properties.resourceName ?? item.name ?? '';
	return {
		name,
		localizedName: properties.name?.localizedValue ?? name,
		current,
		limit,
		remaining: Math.max(limit - current, 0),
		unit: properties.unit ?? 'Count'
	};
}

async function listCapacityComputeQuotas(
	clients: AzureClients,
	location: string
): Promise<ComputeQuota[]> {
	const normalizedLocation = normalizeLocationName(location);
	const path =
		`/subscriptions/${encodeURIComponent(clients.subscriptionId)}` +
		'/providers/Microsoft.Capacity/resourceProviders/Microsoft.Compute' +
		`/locations/${encodeURIComponent(normalizedLocation)}` +
		`/serviceLimits?api-version=${CAPACITY_QUOTA_API_VERSION}`;
	const items = await collectArmPages<CapacityQuotaItem>(
		clients.credential,
		clients.clientOptions,
		path
	);
	return items
		.map(capacityQuotaToComputeQuota)
		.filter((quota) => quota.name || quota.localizedName);
}

async function listUsageComputeQuotas(
	clients: AzureClients,
	location: string
): Promise<ComputeQuota[]> {
	const normalizedLocation = normalizeLocationName(location);
	const list: ComputeQuota[] = [];
	for await (const usage of clients.compute.usageOperations.list(normalizedLocation)) {
		list.push(usageToQuota(usage));
	}
	return list;
}

function sortComputeQuotas(quotas: ComputeQuota[]) {
	return [...quotas].sort((a, b) => {
		const nameA = a.localizedName || a.name;
		const nameB = b.localizedName || b.name;
		return nameA.localeCompare(nameB);
	});
}

export async function listComputeQuotas(clients: AzureClients, location: string): Promise<ComputeQuota[]> {
	const normalizedLocation = normalizeLocationName(location);
	const key = `compute-quotas:${clients.subscriptionId}:${normalizedLocation}`;
	const quotas = await cachedAzureQuery(key, cacheTtlMs('AZURE_QUOTA_CACHE_TTL_SECONDS', 120), async () => {
		try {
			const capacityQuotas = await listCapacityComputeQuotas(clients, normalizedLocation);
			if (capacityQuotas.length > 0) return sortComputeQuotas(capacityQuotas);
		} catch {
			// Older tenants can lack Microsoft.Capacity access; Compute usages is the safe fallback.
		}
		return sortComputeQuotas(await listUsageComputeQuotas(clients, normalizedLocation));
	});
	return quotas.map((quota) => ({ ...quota }));
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

export async function powerVmWithProgress(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		vmName: string;
		action: VmPowerAction;
		progress?: CreateVmProgressReporter;
	}
) {
	const labels: Record<VmPowerAction, string> = {
		start: '开机',
		deallocate: '关机并释放',
		restart: '重启'
	};
	const step = `power-${options.action}`;
	const label = labels[options.action];
	await reportCreateVmProgress(options.progress, step, 'running', `正在向 Azure 提交 ${label} 请求`, {
		resourceGroup: options.resourceGroup,
		vmName: options.vmName
	});

	const poller =
		options.action === 'start'
			? await clients.compute.virtualMachines.beginStart(options.resourceGroup, options.vmName, {
					updateIntervalInMs: 3000
				})
			: options.action === 'deallocate'
				? await clients.compute.virtualMachines.beginDeallocate(options.resourceGroup, options.vmName, {
						updateIntervalInMs: 3000
					})
				: await clients.compute.virtualMachines.beginRestart(options.resourceGroup, options.vmName, {
						updateIntervalInMs: 3000
					});

	await reportCreateVmProgress(options.progress, `${step}-submitted`, 'success', `Azure 已接受 ${label} 请求`, {
		resourceGroup: options.resourceGroup,
		vmName: options.vmName,
		status: poller.getOperationState().status
	});

	let polls = 0;
	while (!poller.isDone()) {
		polls += 1;
		await reportCreateVmProgress(options.progress, `${step}-polling`, 'running', `${label}执行中，轮询第 ${polls} 次`, {
			resourceGroup: options.resourceGroup,
			vmName: options.vmName,
			status: poller.getOperationState().status,
			polls
		});
		await poller.poll();
		if (!poller.isDone()) await sleep(3000);
	}

	const state = poller.getOperationState();
	if (state.error) throw state.error;
	await reportCreateVmProgress(options.progress, step, 'success', `${label}操作已完成`, {
		resourceGroup: options.resourceGroup,
		vmName: options.vmName,
		status: state.status,
		polls
	});
	return { message: `${label}操作已完成: ${options.vmName}` };
}

export async function deleteResourceGroup(clients: AzureClients, resourceGroup: string) {
	await clients.resources.resourceGroups.beginDeleteAndWait(resourceGroup, {
		forceDeletionTypes: FORCE_DELETE_RESOURCE_GROUP_TYPES
	});
}

const FORCE_DELETE_RESOURCE_GROUP_TYPES =
	'Microsoft.Compute/virtualMachines,Microsoft.Compute/virtualMachineScaleSets';

function shortAzureError(err: unknown, maxLength = 900) {
	const message = formatAzureError(err);
	return message.length > maxLength ? `${message.slice(0, maxLength)}...` : message;
}

function isAzureResourceGroupMissing(err: unknown) {
	const message = formatAzureError(err);
	return /HTTP 404|ResourceGroupNotFound|could not be found|not found/i.test(message);
}

function summarizeRemainingResources(resources: AzureResourceInfo[], limit = 10) {
	if (resources.length === 0) return '无剩余资源';
	const shown = resources
		.slice(0, limit)
		.map((resource) => {
			const state = resource.provisioningState ? `/${resource.provisioningState}` : '';
			return `${resource.type || '-'}:${resource.name || '-'}${state}`;
		})
		.join('；');
	return resources.length > limit ? `${shown}；另有 ${resources.length - limit} 个资源` : shown;
}

async function reportResourceGroupDeleteFailure(
	clients: AzureClients,
	resourceGroup: string,
	progress: DeleteResourceGroupProgressReporter | undefined,
	step: string,
	err: unknown,
	polls: number
) {
	const message = shortAzureError(err);
	if (isAzureResourceGroupMissing(err)) {
		await reportCreateVmProgress(progress, 'delete-resource-group', 'success', '资源组已不存在，视为删除完成', {
			resourceGroup,
			polls
		});
		return { missing: true, message, remainingSummary: '', remainingCount: 0 };
	}

	await reportCreateVmProgress(progress, step, 'error', `Azure 资源组删除失败: ${message}`, {
		resourceGroup,
		polls,
		error: message
	});

	try {
		const remaining = await listGenericResources(clients, resourceGroup);
		const remainingSummary = summarizeRemainingResources(remaining);
		await reportCreateVmProgress(
			progress,
			'delete-remaining-resources',
			remaining.length > 0 ? 'info' : 'success',
			remaining.length > 0
				? `删除失败后资源组仍剩余 ${remaining.length} 个资源: ${remainingSummary}`
				: '删除失败后未发现剩余资源，Azure 后台可能已完成清理',
			{
				resourceGroup,
				remainingCount: remaining.length,
				remainingSummary: remainingSummary.slice(0, 900)
			}
		);
		return { missing: false, message, remainingSummary, remainingCount: remaining.length };
	} catch (listErr) {
		if (isAzureResourceGroupMissing(listErr)) {
			await reportCreateVmProgress(progress, 'delete-resource-group', 'success', '资源组已不存在，视为删除完成', {
				resourceGroup,
				polls
			});
			return { missing: true, message, remainingSummary: '', remainingCount: 0 };
		}
		const listMessage = shortAzureError(listErr, 500);
		await reportCreateVmProgress(progress, 'delete-remaining-resources', 'info', `删除失败后查询剩余资源也失败: ${listMessage}`, {
			resourceGroup,
			error: listMessage
		});
		return {
			missing: false,
			message,
			remainingSummary: `剩余资源查询失败: ${listMessage}`,
			remainingCount: -1
		};
	}
}

export async function deleteResourceGroupWithProgress(
	clients: AzureClients,
	resourceGroup: string,
	progress?: DeleteResourceGroupProgressReporter
) {
	await reportCreateVmProgress(progress, 'delete-resource-group', 'running', '正在向 Azure 提交资源组删除请求', {
		resourceGroup
	});

	let poller;
	try {
		poller = await clients.resources.resourceGroups.beginDelete(resourceGroup, {
			forceDeletionTypes: FORCE_DELETE_RESOURCE_GROUP_TYPES,
			updateIntervalInMs: 3000
		});
	} catch (err) {
		const failure = await reportResourceGroupDeleteFailure(
			clients,
			resourceGroup,
			progress,
			'delete-submit-failed',
			err,
			0
		);
		if (failure.missing) return;
		throw new Error(
			`资源组删除请求提交失败 ${resourceGroup}: ${failure.message}` +
				(failure.remainingSummary ? `；剩余资源: ${failure.remainingSummary}` : '')
		);
	}
	await reportCreateVmProgress(progress, 'delete-submitted', 'success', 'Azure 已接受资源组删除请求', {
		resourceGroup,
		status: poller.getOperationState().status,
		forceDeletionTypes: FORCE_DELETE_RESOURCE_GROUP_TYPES
	});

	let polls = 0;
	while (!poller.isDone()) {
		polls += 1;
		await reportCreateVmProgress(progress, 'delete-polling', 'running', `等待 Azure 后台删除完成，状态检查第 ${polls} 次`, {
			resourceGroup,
			status: poller.getOperationState().status,
			polls
		});
		try {
			await poller.poll();
		} catch (err) {
			const failure = await reportResourceGroupDeleteFailure(
				clients,
				resourceGroup,
				progress,
				'delete-polling',
				err,
				polls
			);
			if (failure.missing) return;
			throw new Error(
				`资源组删除轮询失败 ${resourceGroup}: ${failure.message}` +
					(failure.remainingSummary ? `；剩余资源: ${failure.remainingSummary}` : '')
			);
		}
		if (!poller.isDone()) await sleep(3000);
	}

	const state = poller.getOperationState();
	if (state.error) {
		const failure = await reportResourceGroupDeleteFailure(
			clients,
			resourceGroup,
			progress,
			'delete-resource-group',
			state.error,
			polls
		);
		if (failure.missing) return;
		throw new Error(
			`资源组删除失败 ${resourceGroup}: ${failure.message}` +
				(failure.remainingSummary ? `；剩余资源: ${failure.remainingSummary}` : '')
		);
	}
	await reportCreateVmProgress(progress, 'delete-resource-group', 'success', 'Azure 资源组删除已完成', {
		resourceGroup,
		status: state.status,
		polls
	});
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

function subnetResourceId(clients: AzureClients, resourceGroup: string, vnetName: string, subnetName: string) {
	return (
		`/subscriptions/${clients.subscriptionId}` +
		`/resourceGroups/${resourceGroup}` +
		'/providers/Microsoft.Network' +
		`/virtualNetworks/${vnetName}` +
		`/subnets/${subnetName}`
	);
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

function normalizeCreateIpPrefix(prefix?: string) {
	return normalizeIpPrefix(prefix) || DEFAULT_CREATE_IP_PREFIX;
}

function normalizeAttempts(value?: number, fallback = 30) {
	const parsed = Math.floor(Number(value ?? fallback));
	if (!Number.isFinite(parsed) || parsed < 1) return fallback;
	return Math.min(parsed, 500);
}

function normalizeOpenPorts(value?: string | string[]) {
	const rawParts = Array.isArray(value)
		? value
		: String(value ?? '')
				.split(/[\s,;，；]+/)
				.filter(Boolean);
	const ports = rawParts
		.map((part) => String(part).trim())
		.filter(Boolean);
	const normalized = ports.length > 0 ? ports : [DEFAULT_FIREWALL_ALLOW_ALL_PORT_RANGE];
	const unique: string[] = [DEFAULT_FIREWALL_ALLOW_ALL_PORT_RANGE];

	for (const port of normalized) {
		if (port === '*') {
			if (!unique.includes(DEFAULT_FIREWALL_ALLOW_ALL_PORT_RANGE)) {
				unique.push(DEFAULT_FIREWALL_ALLOW_ALL_PORT_RANGE);
			}
			continue;
		}

		const range = port.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
		if (!range) throw new Error(`端口格式不正确: ${port}`);
		const start = Number(range[1]);
		const end = Number(range[2] ?? range[1]);
		if (start < 0 || start > 65535 || end < 0 || end > 65535 || start > end) {
			throw new Error(`端口范围不正确: ${port}`);
		}
		const normalizedPort = start === end ? String(start) : `${start}-${end}`;
		if (!unique.includes(normalizedPort)) unique.push(normalizedPort);
	}

	return unique.slice(0, 200);
}

function securityRuleName(port: string, index: number) {
	if (port === DEFAULT_FIREWALL_ALLOW_ALL_PORT_RANGE) return DEFAULT_FIREWALL_ALLOW_ALL_RULE_NAME;
	const safePort = port === '*' ? 'all' : port.replace(/-/g, '-to-');
	return `allow-in-${safePort}-${index + 1}`;
}

function normalizeSecurityPortRange(value: string | undefined, fallback = '*') {
	const raw = String(value ?? '').trim() || fallback;
	if (raw === '*') return raw;
	const range = raw.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
	if (!range) throw new Error(`端口范围格式不正确: ${raw}`);
	const start = Number(range[1]);
	const end = Number(range[2] ?? range[1]);
	if (start < 0 || start > 65535 || end < 0 || end > 65535 || start > end) {
		throw new Error(`端口范围不正确: ${raw}`);
	}
	return start === end ? String(start) : `${start}-${end}`;
}

function normalizeSecurityRuleName(value: string | undefined, destinationPortRange: string) {
	const fallback = `allow-in-${destinationPortRange === '*' ? 'all' : destinationPortRange.replace(/-/g, '-to-')}`;
	const clean = sanitizeResourceName(String(value ?? '').trim() || fallback).slice(0, 80);
	return clean || fallback;
}

function normalizeSecurityProtocol(value?: string) {
	const protocol = String(value ?? '*').trim();
	const allowed = new Set(['*', 'Tcp', 'Udp', 'Icmp', 'Esp', 'Ah']);
	if (!allowed.has(protocol)) throw new Error('协议只支持 *, Tcp, Udp, Icmp, Esp, Ah');
	return protocol;
}

function normalizeSecurityAccess(value?: string) {
	const access = String(value ?? 'Allow').trim();
	if (access !== 'Allow' && access !== 'Deny') throw new Error('访问策略只支持 Allow 或 Deny');
	return access;
}

function normalizeSecurityDirection(value?: string) {
	const direction = String(value ?? 'Inbound').trim();
	if (direction !== 'Inbound' && direction !== 'Outbound') throw new Error('方向只支持 Inbound 或 Outbound');
	return direction;
}

function normalizeSecurityPriority(value?: number) {
	const priority = Math.floor(Number(value ?? 1000));
	if (!Number.isFinite(priority) || priority < 100 || priority > 4096) {
		throw new Error('优先级必须在 100-4096 之间');
	}
	return priority;
}

function normalizeSecurityAddressPrefix(value: string | undefined, fallback = '*') {
	const prefix = String(value ?? '').trim();
	return prefix || fallback;
}

function toVmFirewallRuleInfo(rule: SecurityRule): VmFirewallRuleInfo {
	return {
		name: rule.name ?? '',
		description: rule.description ?? '',
		protocol: rule.protocol ?? '*',
		sourcePortRange: rule.sourcePortRange ?? rule.sourcePortRanges?.join(',') ?? '*',
		destinationPortRange:
			rule.destinationPortRange ?? rule.destinationPortRanges?.join(',') ?? '*',
		sourceAddressPrefix: rule.sourceAddressPrefix ?? rule.sourceAddressPrefixes?.join(',') ?? '*',
		destinationAddressPrefix:
			rule.destinationAddressPrefix ?? rule.destinationAddressPrefixes?.join(',') ?? '*',
		access: rule.access ?? 'Allow',
		priority: rule.priority ?? 0,
		direction: rule.direction ?? 'Inbound',
		provisioningState: rule.provisioningState ?? ''
	};
}

async function reportCreateVmProgress(
	reporter: CreateVmProgressReporter | undefined,
	step: string,
	status: CreateVmProgressStatus,
	message: string,
	detail?: CreateVmProgressEvent['detail']
) {
	if (!reporter) return;
	await reporter({
		step,
		status,
		message,
		detail,
		timestamp: new Date().toISOString()
	});
}

async function waitForPublicIpAddress(
	clients: AzureClients,
	resourceGroup: string,
	publicIpName: string,
	options: {
		attempts?: number;
		delayMs?: number;
		progress?: CreateVmProgressReporter;
		step?: string;
		version?: 'IPv4' | 'IPv6';
		detail?: CreateVmProgressEvent['detail'];
	} = {}
): Promise<PublicIPAddress> {
	const attempts = Math.max(1, Math.min(options.attempts ?? 20, 60));
	const delayMs = Math.max(500, options.delayMs ?? 1500);
	const step = options.step ?? `public-ip-${(options.version ?? 'IPv4').toLowerCase()}`;
	let pip = await getPublicIpWithRawFallback(clients, resourceGroup, publicIpName);
	for (let i = 0; i < attempts && !publicIpAddressValue(pip); i++) {
		await reportCreateVmProgress(
			options.progress,
			step,
			'running',
			`等待 Azure 分配 ${options.version ?? 'IPv4'} 公网 IP 地址，第 ${i + 1}/${attempts} 次`,
			{
				...(options.detail ?? {}),
				name: publicIpName,
				publicIpName,
				ip: '',
				waitAttempt: i + 1,
				waitAttempts: attempts
			}
		);
		await sleep(delayMs);
		pip = await getPublicIpWithRawFallback(clients, resourceGroup, publicIpName);
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
		ddosProtectionPlanId?: string;
		progress?: CreateVmProgressReporter;
		step?: string;
		progressDetail?: CreateVmProgressEvent['detail'];
		waitForAddress?: boolean;
		addressWaitAttempts?: number;
		addressWaitDelayMs?: number;
		failureProgressStatus?: CreateVmProgressStatus;
	}
): Promise<PublicIPAddress> {
	const step = options.step ?? `public-ip-${options.version.toLowerCase()}`;
	const failureProgressStatus = options.failureProgressStatus ?? 'error';
	const originalProgress = options.progress;
	if (originalProgress && failureProgressStatus !== 'error') {
		options.progress = async (event) => {
			await originalProgress(
				event.step === step && event.status === 'error'
					? { ...event, status: failureProgressStatus }
					: event
			);
		};
	}
	const contextDetail = options.progressDetail ?? {};
	const withPublicIpDetail = (detail: CreateVmProgressEvent['detail'] = {}) => ({
		...contextDetail,
		...detail
	});
	await reportCreateVmProgress(options.progress, step, 'running', `创建 ${options.version} 公网 IP`, withPublicIpDetail({
		name: options.name,
		version: options.version,
		ddosProtection: Boolean(options.ddosProtectionPlanId)
	}));
	try {
		if (options.version === 'IPv4') {
			await ensurePublicIpQuotaAvailable(
				clients,
				options.location,
				options.progress,
				step,
				withPublicIpDetail({
					name: options.name,
					version: options.version
				})
			);
		}
		const { pip: pollerResult, polls } = await createPublicIpViaArm(clients, {
			resourceGroup: options.resourceGroup,
			location: options.location,
			name: options.name,
			version: options.version,
			ddosProtectionPlanId: options.ddosProtectionPlanId,
			progress: options.progress,
			step,
			detail: withPublicIpDetail({
				name: options.name,
				version: options.version,
				ddosProtection: Boolean(options.ddosProtectionPlanId)
			})
		});
		const pip =
			publicIpAddressValue(pollerResult) && publicIpIpConfigurationId(pollerResult)
				? pollerResult
				: await getPublicIpWithRawFallback(clients, options.resourceGroup, options.name);
		const ready = options.waitForAddress === true && !publicIpAddressValue(pip)
			? await waitForPublicIpAddress(clients, options.resourceGroup, options.name, {
					attempts: options.addressWaitAttempts ?? (options.version === 'IPv4' ? 30 : 20),
					delayMs: options.addressWaitDelayMs ?? 1500,
					progress: options.progress,
					step,
					version: options.version,
					detail: withPublicIpDetail({
						version: options.version,
						ddosProtection: Boolean(options.ddosProtectionPlanId)
					})
				})
			: pip;
		if (!ready.id) throw new Error(`Azure 未返回 ${options.version} 公网 IP 资源 ID`);
		if (options.waitForAddress === true && !publicIpAddressValue(ready)) {
			throw new Error(
				`Azure 已创建 ${options.version} 公网 IP 资源 ${options.name}，但等待 ${
					options.addressWaitAttempts ?? (options.version === 'IPv4' ? 30 : 20)
				} 次后仍未返回 IP 地址`
			);
		}
		await reportCreateVmProgress(options.progress, step, 'success', `${options.version} 公网 IP 已创建`, withPublicIpDetail({
			name: options.name,
			ip: publicIpAddressValue(ready),
			ddosProtection: Boolean(options.ddosProtectionPlanId),
			polls
		}));
		return ready;
	} catch (err) {
		const failureDetail = await describePublicIpAfterCreateFailure(
			clients,
			options.resourceGroup,
			options.name
		).catch(() => '');
		const rawMessage = [formatAzureError(err), failureDetail].filter(Boolean).join(' | ');
		const message = enrichPublicIpCreateFailureMessage(options.version, rawMessage);
		const recovered = await recoverPublicIpAfterCreateFailure(clients, options);
		if (recovered) {
			await reportCreateVmProgress(
				options.progress,
				step,
				'success',
				`${options.version} Public IP recovered after Azure LRO failure`,
				withPublicIpDetail({
					name: options.name,
					ip: publicIpAddressValue(recovered),
					recoveredAfterLroFailure: true
				})
			);
			return recovered;
		}
		await deletePublicIpByName(clients, options.resourceGroup, options.name).catch(() => undefined);
		const shortMessage = conciseProgressError(message);
		await reportCreateVmProgress(options.progress, step, 'error', `${options.version} 公网 IP 创建失败`, withPublicIpDetail({
			name: options.name,
			version: options.version,
			failureProgressStatus,
			reason: shortMessage,
			error: message.length > 800 ? `${message.slice(0, 800)}...` : message
		}));
		throw new Error(`${options.version} 公网 IP 创建失败 ${options.name}: ${message}`);
	}
}

async function recoverPublicIpAfterCreateFailure(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		name: string;
		version: 'IPv4' | 'IPv6';
		waitForAddress?: boolean;
	}
) {
	const pip = await getPublicIpWithRawFallback(clients, options.resourceGroup, options.name).catch(() => null);
	if (!pip?.id) return null;
	if (String(pip.provisioningState ?? '').toLowerCase() === 'failed') return null;
	const versionMatches =
		options.version === 'IPv6' ? isPublicIpResourceIPv6(pip) : !isPublicIpResourceIPv6(pip);
	if (!versionMatches) return null;
	if (options.waitForAddress && !publicIpAddressValue(pip)) return null;
	return pip;
}

function enrichPublicIpCreateFailureMessage(version: 'IPv4' | 'IPv6', message: string) {
	if (!/long-running operation has failed|operation failed|failed/i.test(message)) return message;
	return (
		`${message}. Azure changes a VM public IP by creating an available Public IP resource first, ` +
		`then updating the NIC ipConfiguration publicIPAddress reference. This failed before NIC binding while creating the new ${version} Public IP. ` +
		`Common causes: regional Public IP capacity, Public IP quota, subscription/policy restrictions, or Microsoft.Network provider issues.`
	);
}

function conciseProgressError(message: string, maxLength = 240) {
	const singleLine = message.replace(/\s+/g, ' ').trim();
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, maxLength)}...`;
}

function isPublicIpQuotaFailure(message: string) {
	return (
		/publicipaddresscountlimitreached|publicipcountlimitreached|public\s*ip\s*(address\s*)?count\s*(limit|quota)|quota\s*(exceeded|limit|reached|不足)|limit\s*(exceeded|reached)|exceed(s|ed|ing)?\s+(the\s+)?(approved\s+)?(quota|limit)|maximum\s+.*\s+(reached|exceeded)/i.test(
			message
		) || /公网\s*IP.*(配额|额度).*不足|(配额|额度).*不足|超过.*(配额|额度|上限|限制)|达到.*(上限|限制)/i.test(message)
	);
}

async function deletePublicIpById(clients: AzureClients, publicIpId?: string) {
	if (!publicIpId) return;
	const name = parseResourceName(publicIpId);
	const resourceGroup = parseResourceGroup(publicIpId);
	if (!name || !resourceGroup) return;
	await deletePublicIpByName(clients, resourceGroup, name);
}

async function deletePublicIpByName(clients: AzureClients, resourceGroup: string, publicIpName: string) {
	if (!resourceGroup || !publicIpName) return;
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= 8; attempt++) {
		try {
			await clients.network.publicIPAddresses.beginDeleteAndWait(resourceGroup, publicIpName);
			return;
		} catch (err) {
			const statusCode = (err as { statusCode?: number }).statusCode;
			if (statusCode === 404) return;
			lastError = err;
			if (!isTransientAzureReadError(err) && !isPublicIpDeletePropagationError(err)) throw err;
			await sleep(2500 * attempt);
		}
	}
	if (lastError) throw lastError;
}

function isPublicIpDeletePropagationError(err: unknown) {
	const message = formatAzureError(err).toLowerCase();
	return /in use|being used|still associated|still attached|cannot be deleted|is referenced|referenced by|publicipaddresscannotbedeleted/.test(
		message
	);
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
		ddosProtectionPlanId?: string;
		fallbackToLastOnMiss?: boolean;
		failureProgressStatus?: CreateVmProgressStatus;
		progress?: CreateVmProgressReporter;
	}
): Promise<{ pip: PublicIPAddress; attempts: number; matched: boolean }> {
	const targetPrefix = normalizeIpPrefix(options.targetPrefix);
	const maxAttempts = targetPrefix ? normalizeAttempts(options.maxAttempts) : normalizeAttempts(options.maxAttempts, 1);
	const salt = options.nameSalt ?? String(Date.now());
	await reportCreateVmProgress(
		options.progress,
		'public-ipv4',
		'running',
		targetPrefix
			? `开始刷 IPv4 前缀 ${targetPrefix}，最多 ${maxAttempts} 次`
			: '创建 IPv4 公网 IP',
		{ targetPrefix: targetPrefix || null, maxAttempts }
	);

	let lastCreateError = '';
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const name = resourceName(options.vmName, `pip4-${salt}-${attempt}`);
		await reportCreateVmProgress(options.progress, 'public-ipv4', 'running', `创建 IPv4 公网 IP，第 ${attempt}/${maxAttempts} 次`, {
			attempt,
			maxAttempts,
			targetPrefix: targetPrefix || null,
			publicIpName: name,
			name
		});
		let pip: PublicIPAddress;
		try {
			pip = await createPublicIp(clients, {
				resourceGroup: options.resourceGroup,
				location: options.location,
				name,
				version: 'IPv4',
				ddosProtectionPlanId: options.ddosProtectionPlanId,
				progress: options.progress,
				step: 'public-ipv4',
				waitForAddress: Boolean(targetPrefix),
				addressWaitAttempts: targetPrefix ? 12 : undefined,
				failureProgressStatus: options.failureProgressStatus,
				progressDetail: {
					attempt,
					maxAttempts,
					targetPrefix: targetPrefix || null,
					publicIpName: name,
					matched: null,
					kept: null,
					deleted: null
				}
			});
		} catch (err) {
			lastCreateError = formatAzureError(err);
			const shortError = conciseProgressError(lastCreateError);
			await reportCreateVmProgress(
				options.progress,
				'public-ipv4',
				attempt >= maxAttempts ? 'error' : 'info',
				`第 ${attempt}/${maxAttempts} 次 IPv4 公网 IP 创建失败：${shortError}，${
					attempt >= maxAttempts ? '已达到最大次数' : '将继续尝试下一次'
				}`,
				{
					attempt,
					maxAttempts,
					targetPrefix: targetPrefix || null,
					publicIpName: name,
					error: lastCreateError.length > 800 ? `${lastCreateError.slice(0, 800)}...` : lastCreateError
				}
			);
			await deletePublicIpByName(clients, options.resourceGroup, name).catch(() => undefined);
			if (attempt < maxAttempts) await sleep(Math.min(12000, 2000 + attempt * 500));
			continue;
		}
		const address = publicIpAddressValue(pip);
		const matched = !targetPrefix || address.startsWith(targetPrefix);
		if (matched) {
			await reportCreateVmProgress(
				options.progress,
				'public-ipv4',
				'success',
				targetPrefix ? `IPv4 ${address} 命中目标前缀` : `IPv4 ${address || '-'} 已创建`,
				{
					attempt,
					maxAttempts,
					ip: address,
					targetPrefix: targetPrefix || null,
					publicIpName: name,
					matched: Boolean(targetPrefix),
					kept: true,
					deleted: false
				}
			);
			return { pip, attempts: attempt, matched: Boolean(targetPrefix) };
		}

		if (options.fallbackToLastOnMiss && attempt >= maxAttempts) {
			await reportCreateVmProgress(
				options.progress,
				'public-ipv4',
				'info',
				`IPv4 ${address || '-'} 未命中 ${targetPrefix}，作为最终 IPv4 使用`,
				{
					attempt,
					maxAttempts,
					ip: address,
					targetPrefix,
					publicIpName: name,
					matched: false,
					kept: true,
					deleted: false,
					brushRecordOnly: true
				}
			);
			return { pip, attempts: attempt, matched: false };
		}

		await reportCreateVmProgress(
			options.progress,
			'public-ipv4',
			'info',
			`IPv4 ${address || '-'} 未命中 ${targetPrefix}，删除后继续`,
			{
				attempt,
				maxAttempts,
				ip: address,
				targetPrefix,
				publicIpName: name,
				matched: false,
				kept: false,
				deleted: true,
				brushRecordOnly: true
			}
		);
		await deletePublicIpById(clients, pip.id);
	}

	throw new Error(
		`刷 IP 未匹配 ${targetPrefix}，已达到最大尝试次数 ${maxAttempts}` +
			(lastCreateError ? `；最近一次创建失败: ${lastCreateError}` : '')
	);
}

async function getPrimaryNicAndIPv4Config(
	clients: AzureClients,
	resourceGroup: string,
	vmName: string,
	progress?: CreateVmProgressReporter,
	options: {
		step?: string;
		allowCreateIPv4Config?: boolean;
	} = {}
): Promise<{
	vmLocation: string;
	nicResourceGroup: string;
	nicName: string;
	nic: NetworkInterface;
	ipConfig: NetworkInterfaceIPConfiguration;
}> {
	let lastError = '';
	const step = options.step ?? 'nic-ipv4-prepare';
	for (let attempt = 1; attempt <= 12; attempt++) {
		try {
			const vm = await clients.compute.virtualMachines.get(resourceGroup, vmName);
			const nicRef =
				vm.networkProfile?.networkInterfaces?.find((networkInterface) => networkInterface.primary) ??
				vm.networkProfile?.networkInterfaces?.[0];
			const nicId = nicRef?.id ?? '';
			let nicName = parseResourceName(nicId);
			let nicResourceGroup = parseResourceGroup(nicId);
			let nic: NetworkInterface | null = null;

			if (nicName && nicResourceGroup) {
				nic = await clients.network.networkInterfaces.get(nicResourceGroup, nicName);
			} else {
				const resolved = await findVmNetworkInterface(clients, resourceGroup, vmName);
				nic = resolved.nic;
				nicName = resolved.nicName;
				nicResourceGroup = resolved.nicResourceGroup;
			}

			const prepared = await ensureNicIPv4Config(clients, {
				nicResourceGroup,
				nicName,
				nic,
				progress,
				step,
				allowCreate: Boolean(options.allowCreateIPv4Config)
			});

			return {
				vmLocation: vm.location ?? nic.location ?? '',
				nicResourceGroup,
				nicName,
				nic: prepared.nic,
				ipConfig: prepared.ipConfig
			};
		} catch (err) {
			lastError = formatAzureError(err);
			if (!isTransientAzureReadError(err) && !/未找到 VM 主网卡|未找到网卡 IPv4 配置/.test(lastError)) {
				throw err;
			}
			await reportCreateVmProgress(
				progress,
				step,
				'info',
				`VM 网卡信息暂未就绪，等待后重试 ${attempt}/12`,
				{
					resourceGroup,
					vmName,
					error: lastError.length > 600 ? `${lastError.slice(0, 600)}...` : lastError
				}
			);
			await sleep(5000);
		}
	}

	throw new Error(`读取 VM 网卡和 IPv4 配置失败: ${lastError || 'Azure 未返回网卡信息'}`);
}

function isNicIPv4Config(config: NetworkInterfaceIPConfiguration) {
	const version = String(config.privateIPAddressVersion ?? '').toLowerCase();
	if (version === 'ipv6') return false;
	if (version === 'ipv4') return true;
	const name = String(config.name ?? '').toLowerCase();
	if (name.includes('ipv6') && !name.includes('ipv4')) return false;
	return Boolean(config.subnet?.id || config.privateIPAddress || config.publicIPAddress?.id || name.includes('ipv4'));
}

function pickNicIPv4ConfigFromList(
	configs: NetworkInterfaceIPConfiguration[],
	preferredName?: string
): NetworkInterfaceIPConfiguration | undefined {
	return (
		configs.find((config) => preferredName && config.name === preferredName && isNicIPv4Config(config)) ??
		configs.find((config) => isNicIPv4Config(config) && config.primary) ??
		configs.find((config) => isNicIPv4Config(config)) ??
		configs.find((config) => config.name?.toLowerCase().includes('ipv4'))
	);
}

function mergeNicIpConfig(
	current: NetworkInterfaceIPConfiguration | undefined,
	incoming: NetworkInterfaceIPConfiguration
): NetworkInterfaceIPConfiguration {
	if (!current) return incoming;
	return {
		...current,
		...incoming,
		subnet: incoming.subnet?.id ? incoming.subnet : current.subnet,
		publicIPAddress: incoming.publicIPAddress?.id ? incoming.publicIPAddress : current.publicIPAddress,
		privateIPAddress: incoming.privateIPAddress ?? current.privateIPAddress,
		privateIPAddressVersion: incoming.privateIPAddressVersion ?? current.privateIPAddressVersion,
		privateIPAllocationMethod: incoming.privateIPAllocationMethod ?? current.privateIPAllocationMethod,
		primary: incoming.primary ?? current.primary
	};
}

async function loadNetworkInterfaceIpConfigurations(
	clients: AzureClients,
	nicResourceGroup: string,
	nicName: string,
	nic: NetworkInterface,
	options: { forceList?: boolean } = {}
) {
	const byName = new Map<string, NetworkInterfaceIPConfiguration>();
	for (const config of nic.ipConfigurations ?? []) {
		const key = config.name || `config-${byName.size + 1}`;
		byName.set(key, config);
	}

	if (options.forceList || byName.size === 0 || !pickNicIPv4ConfigFromList([...byName.values()])) {
		for await (const config of clients.network.networkInterfaceIPConfigurations.list(nicResourceGroup, nicName)) {
			const key = config.name || `config-${byName.size + 1}`;
			byName.set(key, mergeNicIpConfig(byName.get(key), config));
		}
	}

	const configs = [...byName.values()];
	nic.ipConfigurations = configs;
	return configs;
}

async function ensureNicIPv4Config(
	clients: AzureClients,
	options: {
		nicResourceGroup: string;
		nicName: string;
		nic: NetworkInterface;
		progress?: CreateVmProgressReporter;
		step: string;
		allowCreate: boolean;
	}
): Promise<{ nic: NetworkInterface; ipConfig: NetworkInterfaceIPConfiguration }> {
	const configs = await loadNetworkInterfaceIpConfigurations(
		clients,
		options.nicResourceGroup,
		options.nicName,
		options.nic
	);
	const ipConfig = pickNicIPv4ConfigFromList(configs);
	if (ipConfig) return { nic: options.nic, ipConfig };
	if (!options.allowCreate) throw new Error('未找到网卡 IPv4 配置');

	const subnetId = configs.find((config) => config.subnet?.id)?.subnet?.id ?? '';
	if (!subnetId) throw new Error('未找到网卡 IPv4 配置，且无法从现有网卡配置确定子网');

	await reportCreateVmProgress(options.progress, options.step, 'info', '未找到 IPv4 网卡配置，正在自动补建 IPv4 配置', {
		nicName: options.nicName,
		subnetId
	});
	const latestNic = await clients.network.networkInterfaces.get(options.nicResourceGroup, options.nicName);
	const latestConfigs = await loadNetworkInterfaceIpConfigurations(
		clients,
		options.nicResourceGroup,
		options.nicName,
		latestNic
	);
	const existing = pickNicIPv4ConfigFromList(latestConfigs);
	if (existing) return { nic: latestNic, ipConfig: existing };

	const configName = latestConfigs.some((config) => config.name === 'ipconfig-ipv4')
		? `ipconfig-ipv4-${Date.now().toString(36)}`
		: 'ipconfig-ipv4';
	const createdConfig: NetworkInterfaceIPConfiguration = {
		name: configName,
		primary: true,
		subnet: { id: subnetId },
		privateIPAllocationMethod: 'Dynamic',
		privateIPAddressVersion: 'IPv4'
	};
	latestNic.ipConfigurations = [
		...latestConfigs.map((config) => ({ ...config, primary: false })),
		createdConfig
	];
	const updatedNic = await clients.network.networkInterfaces.beginCreateOrUpdateAndWait(
		options.nicResourceGroup,
		options.nicName,
		latestNic
	);
	const updatedConfigs = await loadNetworkInterfaceIpConfigurations(
		clients,
		options.nicResourceGroup,
		options.nicName,
		updatedNic
	).catch(() => updatedNic.ipConfigurations ?? []);
	const updatedConfig =
		updatedConfigs.find((config) => config.name === configName) ?? pickNicIPv4ConfigFromList(updatedConfigs) ?? createdConfig;
	await reportCreateVmProgress(options.progress, options.step, 'success', 'IPv4 网卡配置已补建', {
		nicName: options.nicName,
		ipConfigName: updatedConfig.name ?? configName
	});
	return { nic: updatedNic, ipConfig: updatedConfig };
}

function pickNicIPv4Config(
	nic: NetworkInterface,
	preferredName?: string
): NetworkInterfaceIPConfiguration | undefined {
	return pickNicIPv4ConfigFromList(nic.ipConfigurations ?? [], preferredName);
}

function cleanSubResource<T extends { id?: string } | undefined>(resource: T): T {
	if (!resource?.id) return undefined as T;
	return { id: resource.id } as T;
}

function cleanSubResourceList<T extends { id?: string }>(resources?: T[]): T[] | undefined {
	const list = (resources ?? [])
		.map((resource) => cleanSubResource(resource))
		.filter((resource): resource is T => Boolean(resource?.id));
	return list.length ? list : undefined;
}

function cleanNicIpConfigForUpdate(
	config: NetworkInterfaceIPConfiguration,
	publicIpId?: string
): NetworkInterfaceIPConfiguration {
	const publicIPAddress =
		publicIpId !== undefined
			? publicIpId
				? ({ id: publicIpId } as PublicIPAddress)
				: undefined
			: cleanSubResource(config.publicIPAddress);
	const cleaned: NetworkInterfaceIPConfiguration = {
		name: config.name,
		primary: config.primary,
		privateIPAllocationMethod: config.privateIPAllocationMethod ?? 'Dynamic',
		privateIPAddressVersion: config.privateIPAddressVersion,
		subnet: cleanSubResource(config.subnet),
		applicationSecurityGroups: cleanSubResourceList(config.applicationSecurityGroups),
		loadBalancerBackendAddressPools: cleanSubResourceList(config.loadBalancerBackendAddressPools),
		loadBalancerInboundNatRules: cleanSubResourceList(config.loadBalancerInboundNatRules),
		applicationGatewayBackendAddressPools: cleanSubResourceList(
			config.applicationGatewayBackendAddressPools
		),
		virtualNetworkTaps: cleanSubResourceList(config.virtualNetworkTaps),
		gatewayLoadBalancer: cleanSubResource(config.gatewayLoadBalancer)
	};
	if (publicIPAddress) cleaned.publicIPAddress = publicIPAddress;
	if (config.privateIPAllocationMethod === 'Static' && config.privateIPAddress) {
		cleaned.privateIPAddress = config.privateIPAddress;
	}
	if (config.privateIPAddressPrefixLength) cleaned.privateIPAddressPrefixLength = config.privateIPAddressPrefixLength;
	return cleaned;
}

function cleanNicForUpdate(nic: NetworkInterface): NetworkInterface {
	return {
		location: nic.location,
		extendedLocation: nic.extendedLocation,
		networkSecurityGroup: cleanSubResource(nic.networkSecurityGroup),
		ipConfigurations: (nic.ipConfigurations ?? []).map((config) => cleanNicIpConfigForUpdate(config)),
		dnsSettings: nic.dnsSettings,
		enableAcceleratedNetworking: nic.enableAcceleratedNetworking,
		disableTcpStateTracking: nic.disableTcpStateTracking,
		enableIPForwarding: nic.enableIPForwarding,
		workloadType: nic.workloadType,
		nicType: nic.nicType
	};
}

function isNicIPv6Config(config: NetworkInterfaceIPConfiguration) {
	const version = String(config.privateIPAddressVersion ?? '').toLowerCase();
	if (version === 'ipv6') return true;
	if (version === 'ipv4') return false;
	const name = String(config.name ?? '').toLowerCase();
	return name.includes('ipv6') && !name.includes('ipv4');
}

async function rememberPublicIpFromConfig(
	clients: AzureClients,
	ips: { publicIPv4: string; publicIPv6: string },
	config: NetworkInterfaceIPConfiguration
) {
	const pipId = config.publicIPAddress?.id;
	if (!pipId) return;
	const pipName = parseResourceName(pipId);
	const pipResourceGroup = parseResourceGroup(pipId);
	if (!pipName || !pipResourceGroup) return;
	const pip = await getPublicIpWithRawFallback(clients, pipResourceGroup, pipName);
	rememberPublicIp(ips, pip);
}

async function readPublicIpsFromNic(
	clients: AzureClients,
	options: {
		nicResourceGroup: string;
		nicName: string;
		nic: NetworkInterface;
	}
) {
	const ips = { publicIPv4: '', publicIPv6: '' };
	const configs = await loadNetworkInterfaceIpConfigurations(
		clients,
		options.nicResourceGroup,
		options.nicName,
		options.nic,
		{ forceList: true }
	).catch(() => options.nic.ipConfigurations ?? []);

	for (const config of configs) {
		await rememberPublicIpFromConfig(clients, ips, config).catch(() => undefined);
	}
	return { ips, configs };
}

async function createNetworkInterfaceWithRetry(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		nicName: string;
		nic: NetworkInterface;
		progress?: CreateVmProgressReporter;
	}
): Promise<NetworkInterface> {
	let lastError = '';
	for (let attempt = 1; attempt <= 5; attempt++) {
		try {
			const nic = await clients.network.networkInterfaces.beginCreateOrUpdateAndWait(
				options.resourceGroup,
				options.nicName,
				options.nic
			);
			if (!nic.id) throw new Error('Azure 未返回网卡资源 ID');
			return nic;
		} catch (err) {
			lastError = formatAzureError(err);
			await reportCreateVmProgress(
				options.progress,
				'nic',
				attempt >= 5 ? 'error' : 'info',
				attempt >= 5 ? '网卡创建失败' : `网卡创建暂未完成，等待后重试 ${attempt}/5`,
				{
					nicName: options.nicName,
					attempt,
					error: lastError.length > 800 ? `${lastError.slice(0, 800)}...` : lastError
				}
			);
			if (!isTransientAzureReadError(err) && attempt >= 2) throw err;
			if (attempt < 5) await sleep(4000);
		}
	}
	throw new Error(`网卡创建失败 ${options.nicName}: ${lastError || 'Azure 未返回创建结果'}`);
}

async function findVmNetworkInterface(
	clients: AzureClients,
	resourceGroup: string,
	vmName: string
): Promise<{
	nicResourceGroup: string;
	nicName: string;
	nic: NetworkInterface;
}> {
	const nics: NetworkInterface[] = [];
	for await (const nic of clients.network.networkInterfaces.list(resourceGroup)) {
		nics.push(nic);
	}

	const exact =
		nics.find((nic) => isVirtualMachineResourceId(nic.virtualMachine?.id ?? '', resourceGroup, vmName)) ??
		null;
	const named =
		nics.find((nic) => normalizeResourceToken(nic.name ?? '') === normalizeResourceToken(resourceName(vmName, 'nic'))) ??
		nics.find((nic) => normalizeResourceToken(nic.name ?? '').includes(normalizeResourceToken(vmName))) ??
		null;
	const selected = exact ?? named ?? (nics.length === 1 ? nics[0] : null);
	if (!selected?.name) {
		throw new Error(
			`未找到 VM 主网卡，Azure VM 未返回网卡引用，资源组内可候选网卡 ${nics.length} 个`
		);
	}

	return {
		nicResourceGroup: parseResourceGroup(selected.id ?? '') || resourceGroup,
		nicName: selected.name,
		nic: selected
	};
}

async function updateNicIPv4PublicIp(
	clients: AzureClients,
	options: {
		nicResourceGroup: string;
		nicName: string;
		nic: NetworkInterface;
		ipConfig: NetworkInterfaceIPConfiguration;
		publicIpId?: string;
		progress?: CreateVmProgressReporter;
		step?: string;
		actionLabel?: string;
	}
) {
	const step = options.step ?? 'brush-ip-attach';
	const actionLabel = options.actionLabel ?? (options.publicIpId ? '绑定公网 IPv4' : '解绑公网 IPv4');
	const targetPublicIpId = options.publicIpId ?? '';
	const targetIpConfigName = options.ipConfig.name ?? '';
	let lastError = '';
	for (let attempt = 1; attempt <= 8; attempt++) {
		try {
			const latestNic = await clients.network.networkInterfaces
				.get(options.nicResourceGroup, options.nicName)
				.catch(() => options.nic);
			const latestConfigs = await loadNetworkInterfaceIpConfigurations(
				clients,
				options.nicResourceGroup,
				options.nicName,
				latestNic
			).catch(() => latestNic.ipConfigurations ?? []);
			const latestIpConfig =
				latestConfigs.find((config) => config.name === options.ipConfig.name) ??
				pickNicIPv4Config(latestNic, options.ipConfig.name) ??
				options.ipConfig;
			const targetName = latestIpConfig.name ?? options.ipConfig.name ?? 'ipconfig-ipv4';
			const updateNic = cleanNicForUpdate(latestNic);
			updateNic.ipConfigurations = latestConfigs.map((config) =>
				config.name === targetName || config === latestIpConfig
					? cleanNicIpConfigForUpdate({ ...config, name: targetName }, targetPublicIpId)
					: cleanNicIpConfigForUpdate(config)
			);
			if (!updateNic.ipConfigurations.some((config) => config.name === targetName)) {
				updateNic.ipConfigurations.push(
					cleanNicIpConfigForUpdate({ ...latestIpConfig, name: targetName }, targetPublicIpId)
				);
			}
			await clients.network.networkInterfaces.beginCreateOrUpdateAndWait(
				options.nicResourceGroup,
				options.nicName,
				updateNic,
				{ updateIntervalInMs: 3000 }
			);
			return;
		} catch (err) {
			lastError = formatAzureError(err);
			if (
				await nicPublicIpUpdateReachedTarget(clients, {
					nicResourceGroup: options.nicResourceGroup,
					nicName: options.nicName,
					ipConfigName: targetIpConfigName,
					publicIpId: targetPublicIpId
				})
			) {
				await reportCreateVmProgress(
					options.progress,
					step,
					'success',
					`NIC ${actionLabel} already reached target after Azure LRO failure`,
					{
						nicName: options.nicName,
						attempt,
						ipConfigName: targetIpConfigName,
						publicIpId: targetPublicIpId || null,
						lroError: lastError.length > 1000 ? `${lastError.slice(0, 1000)}...` : lastError
					}
				);
				return;
			}
			await reportCreateVmProgress(
				options.progress,
				step,
				attempt >= 8 ? 'error' : 'info',
				attempt >= 8
					? `网卡${actionLabel}失败`
					: `网卡${actionLabel}暂未完成，等待后重试 ${attempt}/8`,
				{
					nicName: options.nicName,
					attempt,
					ipConfigName: options.ipConfig.name ?? '',
					publicIpId: targetPublicIpId || null,
					error: lastError.length > 1000 ? `${lastError.slice(0, 1000)}...` : lastError
				}
			);
			await sleep(4000);
		}
	}
	throw new Error(`网卡${actionLabel}失败: ${lastError || 'Azure 未返回更新结果'}`);
}

async function nicPublicIpUpdateReachedTarget(
	clients: AzureClients,
	options: {
		nicResourceGroup: string;
		nicName: string;
		ipConfigName: string;
		publicIpId: string;
	}
) {
	const nic = await clients.network.networkInterfaces
		.get(options.nicResourceGroup, options.nicName)
		.catch(() => null);
	if (!nic) return false;
	await loadNetworkInterfaceIpConfigurations(
		clients,
		options.nicResourceGroup,
		options.nicName,
		nic,
		{ forceList: true }
	).catch(() => nic.ipConfigurations ?? []);
	const ipConfig =
		(nic.ipConfigurations ?? []).find((config) => config.name === options.ipConfigName) ??
		pickNicIPv4Config(nic, options.ipConfigName);
	const currentPublicIpId = normalizeResourceToken(ipConfig?.publicIPAddress?.id ?? '');
	const expectedPublicIpId = normalizeResourceToken(options.publicIpId);
	return expectedPublicIpId ? currentPublicIpId === expectedPublicIpId : !currentPublicIpId;
}

async function attachPublicIpToNic(
	clients: AzureClients,
	options: {
		nicResourceGroup: string;
		nicName: string;
		nic: NetworkInterface;
		ipConfig: NetworkInterfaceIPConfiguration;
		publicIpId: string;
		progress?: CreateVmProgressReporter;
		step?: string;
	}
) {
	await updateNicIPv4PublicIp(clients, {
		...options,
		publicIpId: options.publicIpId,
		actionLabel: '绑定公网 IPv4'
	});
}

async function detachPublicIpFromNic(
	clients: AzureClients,
	options: {
		nicResourceGroup: string;
		nicName: string;
		nic: NetworkInterface;
		ipConfig: NetworkInterfaceIPConfiguration;
		progress?: CreateVmProgressReporter;
		step?: string;
	}
) {
	await updateNicIPv4PublicIp(clients, {
		...options,
		publicIpId: '',
		actionLabel: '解绑旧公网 IPv4'
	});
}

async function releaseOldIPv4PublicIpForRetry(
	clients: AzureClients,
	options: {
		nicResourceGroup: string;
		nicName: string;
		nic: NetworkInterface;
		ipConfig: NetworkInterfaceIPConfiguration;
		oldPublicIpId: string;
		oldPublicIpName: string;
		oldPublicIPv4: string;
		progress?: CreateVmProgressReporter;
		prefix: 'replace-ip' | 'brush-ip';
		reason: string;
	}
) {
	if (!options.oldPublicIpId) throw new Error(options.reason);
	await reportCreateVmProgress(
		options.progress,
		`${options.prefix}-single-quota-fallback`,
		'info',
		'New IPv4 Public IP creation failed; release old IPv4 and retry without VM shutdown',
		{
			oldPublicIpName: options.oldPublicIpName,
			oldPublicIPv4: options.oldPublicIPv4,
			fallbackReason: 'new-public-ip-create-failed'
		}
	);
	await detachPublicIpFromNic(clients, {
		nicResourceGroup: options.nicResourceGroup,
		nicName: options.nicName,
		nic: options.nic,
		ipConfig: options.ipConfig,
		progress: options.progress,
		step: `${options.prefix}-release-old`
	}).catch(async (err) => {
		const message = formatAzureError(err);
		await reportCreateVmProgress(
			options.progress,
			`${options.prefix}-release-old`,
			'error',
			'Release old IPv4 public IP binding failed',
			{
				nicName: options.nicName,
				oldPublicIpName: options.oldPublicIpName,
				oldPublicIPv4: options.oldPublicIPv4,
				error: message.length > 1000 ? `${message.slice(0, 1000)}...` : message
			}
		);
		throw new Error(`release old IPv4 public IP binding failed (${options.prefix}-release-old): ${message}`);
	});
	await reportCreateVmProgress(
		options.progress,
		`${options.prefix}-delete-old`,
		'running',
		'Delete old IPv4 Public IP to release quota',
		{
			oldPublicIpName: options.oldPublicIpName,
			oldPublicIPv4: options.oldPublicIPv4
		}
	);
	await deletePublicIpById(clients, options.oldPublicIpId).catch(async (err) => {
		const message = formatAzureError(err);
		await reportCreateVmProgress(
			options.progress,
			`${options.prefix}-delete-old`,
			'info',
			'Delete old IPv4 Public IP has not completed; continue retrying new IPv4 creation',
			{
				oldPublicIpName: options.oldPublicIpName,
				oldPublicIPv4: options.oldPublicIPv4,
				error: message.length > 1000 ? `${message.slice(0, 1000)}...` : message
			}
		);
	});
}

async function resolveCurrentNicIPv4PublicIp(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		vmName: string;
		nicResourceGroup: string;
		nicName: string;
		nic: NetworkInterface;
		ipConfig: NetworkInterfaceIPConfiguration;
		progress?: CreateVmProgressReporter;
		step?: string;
	}
): Promise<NicPublicIpBinding | null> {
	const directPublicIpId = options.ipConfig.publicIPAddress?.id ?? '';
	if (directPublicIpId) {
		const publicIpName = parseResourceName(directPublicIpId);
		const publicIpResourceGroup = parseResourceGroup(directPublicIpId);
		const pip =
			publicIpName && publicIpResourceGroup
				? await getPublicIpWithRawFallback(clients, publicIpResourceGroup, publicIpName).catch(() => null)
				: null;
		return {
			publicIpId: directPublicIpId,
			publicIpName,
			publicIpResourceGroup,
			publicIPv4: pip ? publicIpAddressValue(pip) : '',
			ipConfigName: options.ipConfig.name ?? '',
			source: 'nic-ip-config'
		};
	}

	return findNicIPv4PublicIpBinding(clients, {
		resourceGroup: options.resourceGroup,
		vmName: options.vmName,
		nicResourceGroup: options.nicResourceGroup,
		nicName: options.nicName,
		nic: options.nic,
		preferredIpConfigName: options.ipConfig.name,
		progress: options.progress,
		step: options.step
	});
}

async function detachOldPublicIpOrSwapDirectly(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		vmName: string;
		nicResourceGroup: string;
		nicName: string;
		nic: NetworkInterface;
		ipConfig: NetworkInterfaceIPConfiguration;
		oldPublicIpId: string;
		oldPublicIpName: string;
		oldPublicIPv4: string;
		newPublicIpId: string;
		progress?: CreateVmProgressReporter;
		prefix: 'replace-ip' | 'brush-ip';
	}
): Promise<'detached' | 'swapped' | 'none'> {
	await reportCreateVmProgress(
		options.progress,
		`${options.prefix}-swap`,
		'running',
		'Replace NIC IPv4 public IP binding',
		{
			nicName: options.nicName,
			oldPublicIpName: options.oldPublicIpName,
			oldPublicIPv4: options.oldPublicIPv4,
			publicIpName: parseResourceName(options.newPublicIpId)
		}
	);
	await attachPublicIpToNic(clients, {
		nicResourceGroup: options.nicResourceGroup,
		nicName: options.nicName,
		nic: options.nic,
		ipConfig: options.ipConfig,
		publicIpId: options.newPublicIpId,
		progress: options.progress,
		step: `${options.prefix}-swap`
	});
	await reportCreateVmProgress(
		options.progress,
		`${options.prefix}-swap`,
		'success',
		'NIC IPv4 public IP binding replaced',
		{
			nicName: options.nicName,
			oldPublicIpName: options.oldPublicIpName,
			publicIpName: parseResourceName(options.newPublicIpId)
		}
	);
	return options.oldPublicIpId ? 'swapped' : 'none';

	if (!options.oldPublicIpId) return 'none';

	await reportCreateVmProgress(
		options.progress,
		`${options.prefix}-detach`,
		'running',
		'从网卡解绑旧 IPv4 公网 IP',
		{
			nicName: options.nicName,
			oldPublicIpName: options.oldPublicIpName,
			oldPublicIPv4: options.oldPublicIPv4
		}
	);
	try {
		await detachPublicIpFromNic(clients, {
			nicResourceGroup: options.nicResourceGroup,
			nicName: options.nicName,
			nic: options.nic,
			ipConfig: options.ipConfig,
			progress: options.progress,
			step: `${options.prefix}-detach`
		});
		return 'detached';
	} catch (detachErr) {
		const detachMessage = formatAzureError(detachErr);
		await reportCreateVmProgress(
			options.progress,
			`${options.prefix}-detach-fallback`,
			'info',
			'解绑旧 IPv4 失败，改用同一网卡配置直接替换为新 IPv4',
			{
				nicName: options.nicName,
				oldPublicIpName: options.oldPublicIpName,
				error: detachMessage.length > 900 ? `${detachMessage.slice(0, 900)}...` : detachMessage
			}
		);

		await sleep(3000);
		const currentBinding = await resolveCurrentNicIPv4PublicIp(clients, {
			resourceGroup: options.resourceGroup,
			vmName: options.vmName,
			nicResourceGroup: options.nicResourceGroup,
			nicName: options.nicName,
			nic: options.nic,
			ipConfig: options.ipConfig,
			progress: options.progress,
			step: `${options.prefix}-detach-fallback`
		}).catch(() => null);
		if (!currentBinding?.publicIpId) return 'detached';

		await attachPublicIpToNic(clients, {
			nicResourceGroup: options.nicResourceGroup,
			nicName: options.nicName,
			nic: options.nic,
			ipConfig: options.ipConfig,
			publicIpId: options.newPublicIpId,
			progress: options.progress,
			step: `${options.prefix}-swap`
		});
		await reportCreateVmProgress(
			options.progress,
			`${options.prefix}-swap`,
			'success',
			'已直接替换网卡公网 IPv4 绑定',
			{
				nicName: options.nicName,
				oldPublicIpName: options.oldPublicIpName,
				publicIpName: parseResourceName(options.newPublicIpId)
			}
		);
		return 'swapped';
	}
}

async function waitForNicAttachedPublicIPv4(
	clients: AzureClients,
	options: {
		nicResourceGroup: string;
		nicName: string;
		ipConfigName?: string;
		fallbackPublicIpId?: string;
		progress?: CreateVmProgressReporter;
		step?: string;
	}
): Promise<{ publicIPv4: string; publicIpName: string; publicIpId: string }> {
	const step = options.step ?? 'brush-ip-complete';
	let lastError = '';
	for (let attempt = 1; attempt <= 12; attempt++) {
		try {
			const nic = await clients.network.networkInterfaces.get(options.nicResourceGroup, options.nicName);
			await loadNetworkInterfaceIpConfigurations(
				clients,
				options.nicResourceGroup,
				options.nicName,
				nic
			).catch(() => nic.ipConfigurations ?? []);
			const ipConfig = pickNicIPv4Config(nic, options.ipConfigName);
			const publicIpId = ipConfig?.publicIPAddress?.id ?? options.fallbackPublicIpId ?? '';
			const publicIpName = parseResourceName(publicIpId);
			const publicIpResourceGroup = parseResourceGroup(publicIpId);
			if (!publicIpName || !publicIpResourceGroup) {
				throw new Error('网卡尚未返回已绑定的 IPv4 公网 IP');
			}
			const pip = await getPublicIpWithRawFallback(clients, publicIpResourceGroup, publicIpName);
			const publicIPv4 = publicIpAddressValue(pip);
			if (publicIPv4) {
				return {
					publicIPv4,
					publicIpName: pip.name ?? publicIpName,
					publicIpId: pip.id ?? publicIpId
				};
			}
			lastError = '公网 IPv4 已绑定但 Azure 尚未返回 IP 地址';
		} catch (err) {
			lastError = formatAzureError(err);
			if (!isTransientAzureReadError(err) && !/尚未返回|尚未分配|尚未绑定/.test(lastError) && attempt >= 2) {
				throw err;
			}
		}
		await reportCreateVmProgress(
			options.progress,
			step,
			'info',
			`等待 Azure 返回最终 IPv4 地址 ${attempt}/12`,
			{
				nicName: options.nicName,
				error: lastError.length > 600 ? `${lastError.slice(0, 600)}...` : lastError
			}
		);
		await sleep(3000);
	}
	throw new Error(`读取最终 IPv4 地址失败: ${lastError || 'Azure 未返回公网 IP 地址'}`);
}

async function createDdosProtectionPlanForVm(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		location: string;
		vmName: string;
		progress?: CreateVmProgressReporter;
	}
) {
	const planName = resourceName(options.vmName, 'ddos', 80);
	await reportCreateVmProgress(options.progress, 'ddos-plan', 'running', '创建 Azure DDoS 防护计划', {
		planName
	});
	let plan;
	try {
		plan = await clients.network.ddosProtectionPlans.beginCreateOrUpdateAndWait(
			options.resourceGroup,
			planName,
			{
				location: options.location
			}
		);
	} catch (err) {
		const message = formatAzureError(err);
		await reportCreateVmProgress(
			options.progress,
			'ddos-plan',
			'info',
			'Azure DDoS 防护计划创建失败，已跳过并继续创建 VM',
			{
				planName,
				error: message.length > 600 ? `${message.slice(0, 600)}...` : message
			}
		);
		return null;
	}
	if (!plan.id) {
		await reportCreateVmProgress(
			options.progress,
			'ddos-plan',
			'info',
			'DDoS 防护计划未返回资源 ID，已跳过并继续创建 VM',
			{ planName }
		);
		return null;
	}
	await reportCreateVmProgress(options.progress, 'ddos-plan', 'success', 'Azure DDoS 防护计划已创建', {
		planName,
		planId: plan.id
	});
	return plan;
}

async function createRequiredDdosProtectionPlanForVm(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		location: string;
		vmName: string;
		progress?: CreateVmProgressReporter;
	}
) {
	const planName = resourceName(options.vmName, 'ddos', 80);
	await reportCreateVmProgress(options.progress, 'ddos-plan', 'running', '创建 Azure DDoS 防护计划', {
		planName,
		resourceGroup: options.resourceGroup,
		location: options.location
	});
	const plan = await clients.network.ddosProtectionPlans.beginCreateOrUpdateAndWait(
		options.resourceGroup,
		planName,
		{
			location: options.location
		}
	);
	if (!plan.id) throw new Error('DDoS 防护计划创建成功但未返回资源 ID');
	await reportCreateVmProgress(options.progress, 'ddos-plan', 'success', 'Azure DDoS 防护计划已就绪', {
		planName,
		planId: plan.id
	});
	return plan;
}

export async function enableVmDdosProtection(
	clients: AzureClients,
	resourceGroup: string,
	vmName: string,
	progress?: CreateVmProgressReporter
): Promise<{
	vmName: string;
	resourceGroup: string;
	ddosProtectionPlanName: string;
	ddosProtectionPlanId: string;
	virtualNetworkName: string;
	virtualNetworkResourceGroup: string;
	publicIPv4: string;
	publicIPv4DdosEnabled: boolean;
}> {
	await reportCreateVmProgress(progress, 'ddos-inspect-vm', 'running', '读取 VM 网卡、子网和公网 IP 信息', {
		resourceGroup,
		vmName
	});
	const { vmLocation, ipConfig } = await getPrimaryNicAndIPv4Config(clients, resourceGroup, vmName);
	const subnetId = ipConfig.subnet?.id ?? '';
	const publicIpId = ipConfig.publicIPAddress?.id ?? '';
	const vnetRef = parseVirtualNetworkFromSubnetId(subnetId);
	if (!vnetRef.resourceGroup || !vnetRef.virtualNetworkName) {
		throw new Error('未能从 VM 子网信息中识别虚拟网络，无法关联 DDoS 防护计划');
	}
	await reportCreateVmProgress(progress, 'ddos-inspect-vm', 'success', '已定位 VM 所属虚拟网络', {
		virtualNetwork: vnetRef.virtualNetworkName,
		virtualNetworkResourceGroup: vnetRef.resourceGroup,
		subnet: vnetRef.subnetName || '-'
	});

	await reportCreateVmProgress(progress, 'ddos-vnet-load', 'running', '读取虚拟网络当前配置', {
		virtualNetwork: vnetRef.virtualNetworkName,
		resourceGroup: vnetRef.resourceGroup
	});
	const vnet = await clients.network.virtualNetworks.get(
		vnetRef.resourceGroup,
		vnetRef.virtualNetworkName
	);
	const vnetLocation = vnet.location ?? vmLocation ?? '';
	await reportCreateVmProgress(progress, 'ddos-vnet-load', 'success', '虚拟网络配置已读取', {
		virtualNetwork: vnetRef.virtualNetworkName,
		location: vnetLocation
	});

	const existingPlanId = vnet.ddosProtectionPlan?.id ?? '';
	const plan = existingPlanId
		? { id: existingPlanId, name: parseResourceName(existingPlanId) }
		: await createRequiredDdosProtectionPlanForVm(clients, {
				resourceGroup: vnetRef.resourceGroup,
				location: vnetLocation,
				vmName,
				progress
			});
	if (existingPlanId) {
		await reportCreateVmProgress(progress, 'ddos-plan', 'success', '虚拟网络已关联 DDoS 防护计划，复用现有计划', {
			planName: plan.name ?? parseResourceName(existingPlanId),
			planId: existingPlanId
		});
	}

	await reportCreateVmProgress(progress, 'ddos-vnet-attach', 'running', '关联 DDoS 防护计划到虚拟网络', {
		virtualNetwork: vnetRef.virtualNetworkName,
		planId: plan.id ?? ''
	});
	vnet.enableDdosProtection = true;
	vnet.ddosProtectionPlan = { id: plan.id };
	const updatedVnet = await clients.network.virtualNetworks.beginCreateOrUpdateAndWait(
		vnetRef.resourceGroup,
		vnetRef.virtualNetworkName,
		vnet
	);
	await reportCreateVmProgress(progress, 'ddos-vnet-attach', 'success', 'DDoS 防护已关联到虚拟网络', {
		virtualNetwork: updatedVnet.name ?? vnetRef.virtualNetworkName,
		provisioningState: updatedVnet.provisioningState ?? ''
	});

	let publicIPv4 = '';
	let publicIPv4DdosEnabled = false;
	if (publicIpId) {
		const publicIpResourceGroup = parseResourceGroup(publicIpId);
		const publicIpName = parseResourceName(publicIpId);
		await reportCreateVmProgress(progress, 'ddos-public-ip', 'running', '开启当前 IPv4 公网 IP 的 DDoS 保护模式', {
			publicIpName,
			resourceGroup: publicIpResourceGroup
		});
		const publicIp = await getPublicIpWithRawFallback(clients, publicIpResourceGroup, publicIpName);
		publicIPv4 = publicIpAddressValue(publicIp);
		publicIp.ddosSettings = {
			protectionMode: 'Enabled',
			ddosProtectionPlan: { id: plan.id }
		};
		const updatedPublicIp = await clients.network.publicIPAddresses.beginCreateOrUpdateAndWait(
			publicIpResourceGroup,
			publicIpName,
			publicIp
		);
		publicIPv4 = publicIpAddressValue(updatedPublicIp) || publicIPv4;
		publicIPv4DdosEnabled = true;
		await reportCreateVmProgress(progress, 'ddos-public-ip', 'success', '当前 IPv4 公网 IP 已启用 DDoS 保护模式', {
			publicIpName,
			ip: publicIPv4 || '-'
		});
	} else {
		await reportCreateVmProgress(progress, 'ddos-public-ip', 'info', 'VM 未绑定 IPv4 公网 IP，已跳过公网 IP DDoS 设置');
	}

	await reportCreateVmProgress(progress, 'ddos-complete', 'success', 'VM DDoS 防护开启流程完成', {
		vmName,
		virtualNetwork: vnetRef.virtualNetworkName,
		planName: plan.name ?? parseResourceName(plan.id ?? '')
	});
	return {
		vmName,
		resourceGroup,
		ddosProtectionPlanName: plan.name ?? parseResourceName(plan.id ?? ''),
		ddosProtectionPlanId: plan.id ?? '',
		virtualNetworkName: vnetRef.virtualNetworkName,
		virtualNetworkResourceGroup: vnetRef.resourceGroup,
		publicIPv4,
		publicIPv4DdosEnabled
	};
}

async function createNetworkSecurityGroupForVm(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		location: string;
		vmName: string;
		openPorts?: string | string[];
		progress?: CreateVmProgressReporter;
	}
): Promise<NetworkSecurityGroup> {
	const nsgName = resourceName(options.vmName, 'nsg', 80);
	const openPorts = normalizeOpenPorts(options.openPorts);
	const securityRules: SecurityRule[] = openPorts.map((port, index) => ({
		name: securityRuleName(port, index),
		description: port === '*' ? 'Allow inbound traffic to all ports' : `Allow inbound ${port}`,
		protocol: '*',
		sourcePortRange: '*',
		destinationPortRange: port,
		sourceAddressPrefix: '*',
		destinationAddressPrefix: '*',
		access: 'Allow',
		priority: 100 + index,
		direction: 'Inbound'
	}));

	await reportCreateVmProgress(options.progress, 'nsg', 'running', '创建网络安全组并放行入站端口', {
		nsgName,
		openPorts: openPorts.join(',')
	});
	let nsg: NetworkSecurityGroup;
	try {
		nsg = await clients.network.networkSecurityGroups.beginCreateOrUpdateAndWait(
			options.resourceGroup,
			nsgName,
			{
				location: options.location,
				securityRules
			}
		);
	} catch (err) {
		const message = formatAzureError(err);
		await reportCreateVmProgress(options.progress, 'nsg', 'error', '网络安全组创建失败', {
			nsgName,
			openPorts: openPorts.join(','),
			error: message.length > 800 ? `${message.slice(0, 800)}...` : message
		});
		throw new Error(`网络安全组创建失败 ${nsgName}: ${message}`);
	}
	if (!nsg.id) throw new Error('网络安全组创建失败');
	await reportCreateVmProgress(options.progress, 'nsg', 'success', '网络安全组已创建并配置入站规则', {
		nsgName,
		openPorts: openPorts.join(',')
	});
	return nsg;
}

async function ensureVmNetworkSecurityGroup(
	clients: AzureClients,
	resourceGroup: string,
	vmName: string,
	options: { createIfMissing?: boolean; progress?: CreateVmProgressReporter } = {}
): Promise<VmNetworkSecurityGroupRef | null> {
	const { vmLocation, nicResourceGroup, nicName, nic } = await getPrimaryNicAndIPv4Config(
		clients,
		resourceGroup,
		vmName
	);
	const existingNsgId = nic.networkSecurityGroup?.id ?? '';
	const existingNsgName = parseResourceName(existingNsgId);
	const existingNsgResourceGroup = parseResourceGroup(existingNsgId);
	if (existingNsgName && existingNsgResourceGroup) {
		await reportCreateVmProgress(options.progress, 'firewall-nsg', 'success', 'VM 已绑定网络安全组', {
			networkSecurityGroup: existingNsgName,
			networkSecurityGroupResourceGroup: existingNsgResourceGroup,
			vmName
		});
		return {
			resourceGroup: existingNsgResourceGroup,
			name: existingNsgName,
			id: existingNsgId
		};
	}
	if (!options.createIfMissing) return null;

	const nsgName = resourceName(vmName, 'nsg', 80);
	await reportCreateVmProgress(options.progress, 'firewall-nsg-create', 'running', 'VM 尚未绑定 NSG，正在创建网络安全组', {
		networkSecurityGroup: nsgName,
		resourceGroup: nicResourceGroup,
		vmName
	});
	const nsg = await clients.network.networkSecurityGroups.beginCreateOrUpdateAndWait(
		nicResourceGroup,
		nsgName,
		{
			location: vmLocation || nic.location || ''
		}
	);
	if (!nsg.id) throw new Error('网络安全组创建失败');
	await reportCreateVmProgress(options.progress, 'firewall-nsg-create', 'success', '网络安全组已创建', {
		networkSecurityGroup: nsgName,
		resourceGroup: nicResourceGroup
	});
	nic.networkSecurityGroup = { id: nsg.id };
	await reportCreateVmProgress(options.progress, 'firewall-nsg-attach', 'running', '正在把网络安全组绑定到 VM 网卡', {
		networkSecurityGroup: nsgName,
		nicName
	});
	await clients.network.networkInterfaces.beginCreateOrUpdateAndWait(
		nicResourceGroup,
		nicName,
		nic
	);
	await reportCreateVmProgress(options.progress, 'firewall-nsg-attach', 'success', '网络安全组已绑定到 VM 网卡', {
		networkSecurityGroup: nsgName,
		nicName
	});
	return {
		resourceGroup: nicResourceGroup,
		name: nsgName,
		id: nsg.id
	};
}

async function listNetworkSecurityRules(
	clients: AzureClients,
	nsg: VmNetworkSecurityGroupRef
): Promise<SecurityRule[]> {
	const rules: SecurityRule[] = [];
	for await (const rule of clients.network.securityRules.list(nsg.resourceGroup, nsg.name)) {
		rules.push(rule);
	}
	return rules;
}

function nextAvailableSecurityPriority(rules: SecurityRule[], preferred = DEFAULT_FIREWALL_ALLOW_ALL_RULE_PRIORITY) {
	const used = new Set(
		rules
			.map((rule) => Math.floor(Number(rule.priority ?? 0)))
			.filter((priority) => priority >= 100 && priority <= 4096)
	);
	if (!used.has(preferred)) return preferred;
	for (let priority = 101; priority <= 4096; priority++) {
		if (!used.has(priority)) return priority;
	}
	throw new Error('NSG 已无可用安全规则优先级，无法同步全端口放行策略');
}

async function ensureVmAllowAllInboundFirewall(
	clients: AzureClients,
	resourceGroup: string,
	vmName: string,
	progress?: CreateVmProgressReporter,
	stepPrefix = 'firewall-allow-all'
): Promise<VmFirewallRuleInfo | null> {
	await reportCreateVmProgress(progress, stepPrefix, 'running', '同步 VM 防火墙全端口放行策略', {
		vmName,
		destinationPortRange: DEFAULT_FIREWALL_ALLOW_ALL_PORT_RANGE
	});
	const nsg = await ensureVmNetworkSecurityGroup(clients, resourceGroup, vmName, {
		createIfMissing: true,
		progress
	});
	if (!nsg) return null;

	const rules = await listNetworkSecurityRules(clients, nsg);
	const existingAllowAll = rules.find((rule) => rule.name === DEFAULT_FIREWALL_ALLOW_ALL_RULE_NAME);
	const ruleName = existingAllowAll?.name || DEFAULT_FIREWALL_ALLOW_ALL_RULE_NAME;
	const priority = existingAllowAll?.priority ?? nextAvailableSecurityPriority(rules);
	const destinationPortRange = DEFAULT_FIREWALL_ALLOW_ALL_PORT_RANGE;

	await reportCreateVmProgress(progress, `${stepPrefix}-rule`, 'running', '下发 0-65535 全端口入站放行规则', {
		networkSecurityGroup: nsg.name,
		ruleName,
		destinationPortRange,
		priority
	});
	const poller = await clients.network.securityRules.beginCreateOrUpdate(
		nsg.resourceGroup,
		nsg.name,
		ruleName,
		{
			name: ruleName,
			description: 'Azure-Panel default allow inbound traffic to all ports 0-65535',
			protocol: '*',
			sourcePortRange: '*',
			destinationPortRange,
			sourceAddressPrefix: '*',
			destinationAddressPrefix: '*',
			access: 'Allow',
			priority,
			direction: 'Inbound'
		},
		{ updateIntervalInMs: 2000 }
	);
	let polls = 0;
	while (!poller.isDone()) {
		polls += 1;
		await reportCreateVmProgress(progress, `${stepPrefix}-polling`, 'running', `全端口防火墙规则同步中，轮询第 ${polls} 次`, {
			networkSecurityGroup: nsg.name,
			ruleName,
			status: poller.getOperationState().status,
			polls
		});
		await poller.poll();
		if (!poller.isDone()) await sleep(2000);
	}
	const state = poller.getOperationState();
	if (state.error) throw state.error;
	const rule = await clients.network.securityRules.get(nsg.resourceGroup, nsg.name, ruleName);
	await reportCreateVmProgress(progress, stepPrefix, 'success', 'VM 防火墙已放行 0-65535 全部入站端口', {
		networkSecurityGroup: nsg.name,
		ruleName,
		destinationPortRange: rule.destinationPortRange ?? destinationPortRange,
		priority,
		polls
	});
	return toVmFirewallRuleInfo(rule);
}

export async function listVmFirewallRules(
	clients: AzureClients,
	resourceGroup: string,
	vmName: string,
	progress?: CreateVmProgressReporter
): Promise<{ networkSecurityGroup: string; networkSecurityGroupResourceGroup: string; rules: VmFirewallRuleInfo[] }> {
	await reportCreateVmProgress(progress, 'firewall-nsg', 'running', '读取 VM 网卡和网络安全组绑定', {
		resourceGroup,
		vmName
	});
	const nsg = await ensureVmNetworkSecurityGroup(clients, resourceGroup, vmName, { progress });
	if (!nsg) {
		await reportCreateVmProgress(progress, 'firewall-list', 'info', 'VM 尚未绑定网络安全组，暂无自定义防火墙规则', {
			resourceGroup,
			vmName
		});
		return {
			networkSecurityGroup: '',
			networkSecurityGroupResourceGroup: '',
			rules: []
		};
	}
	await reportCreateVmProgress(progress, 'firewall-list', 'running', '正在从 Azure 查询 NSG 安全规则', {
		networkSecurityGroup: nsg.name,
		networkSecurityGroupResourceGroup: nsg.resourceGroup
	});
	const rules: VmFirewallRuleInfo[] = [];
	for await (const rule of clients.network.securityRules.list(nsg.resourceGroup, nsg.name)) {
		rules.push(toVmFirewallRuleInfo(rule));
	}
	rules.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
	await reportCreateVmProgress(progress, 'firewall-list', 'success', '防火墙规则已加载', {
		networkSecurityGroup: nsg.name,
		ruleCount: rules.length
	});
	return {
		networkSecurityGroup: nsg.name,
		networkSecurityGroupResourceGroup: nsg.resourceGroup,
		rules
	};
}

export async function upsertVmFirewallRule(
	clients: AzureClients,
	resourceGroup: string,
	vmName: string,
	input: VmFirewallRuleInput,
	progress?: CreateVmProgressReporter
): Promise<VmFirewallRuleInfo> {
	const destinationPortRange = normalizeSecurityPortRange(input.destinationPortRange);
	const sourcePortRange = normalizeSecurityPortRange(input.sourcePortRange, '*');
	const name = normalizeSecurityRuleName(input.name, destinationPortRange);
	await reportCreateVmProgress(progress, 'firewall-rule-prepare', 'running', '校验并整理防火墙规则参数', {
		ruleName: name,
		destinationPortRange,
		vmName
	});
	const nsg = await ensureVmNetworkSecurityGroup(clients, resourceGroup, vmName, {
		createIfMissing: true,
		progress
	});
	if (!nsg) throw new Error('网络安全组创建失败');
	await reportCreateVmProgress(progress, 'firewall-rule-upsert', 'running', '正在向 Azure 提交防火墙规则', {
		networkSecurityGroup: nsg.name,
		ruleName: name,
		destinationPortRange
	});
	const poller = await clients.network.securityRules.beginCreateOrUpdate(
		nsg.resourceGroup,
		nsg.name,
		name,
		{
			name,
			description: String(input.description ?? '').trim().slice(0, 140),
			protocol: normalizeSecurityProtocol(input.protocol),
			sourcePortRange,
			destinationPortRange,
			sourceAddressPrefix: normalizeSecurityAddressPrefix(input.sourceAddressPrefix),
			destinationAddressPrefix: normalizeSecurityAddressPrefix(input.destinationAddressPrefix),
			access: normalizeSecurityAccess(input.access),
			priority: normalizeSecurityPriority(input.priority),
			direction: normalizeSecurityDirection(input.direction)
		},
		{ updateIntervalInMs: 2000 }
	);
	let polls = 0;
	while (!poller.isDone()) {
		polls += 1;
		await reportCreateVmProgress(progress, 'firewall-rule-polling', 'running', `防火墙规则下发中，轮询第 ${polls} 次`, {
			networkSecurityGroup: nsg.name,
			ruleName: name,
			status: poller.getOperationState().status,
			polls
		});
		await poller.poll();
		if (!poller.isDone()) await sleep(2000);
	}
	const state = poller.getOperationState();
	if (state.error) throw state.error;
	const rule = await clients.network.securityRules.get(nsg.resourceGroup, nsg.name, name);
	await reportCreateVmProgress(progress, 'firewall-rule-upsert', 'success', '防火墙规则已保存并生效', {
		networkSecurityGroup: nsg.name,
		ruleName: name,
		status: state.status,
		polls
	});
	return toVmFirewallRuleInfo(rule);
}

export async function deleteVmFirewallRule(
	clients: AzureClients,
	resourceGroup: string,
	vmName: string,
	ruleName: string,
	progress?: CreateVmProgressReporter
) {
	const cleanName = sanitizeResourceName(ruleName.trim());
	if (!cleanName) throw new Error('缺少规则名称');
	await reportCreateVmProgress(progress, 'firewall-rule-delete-prepare', 'running', '校验防火墙规则并读取 NSG', {
		ruleName: cleanName,
		vmName
	});
	const nsg = await ensureVmNetworkSecurityGroup(clients, resourceGroup, vmName, { progress });
	if (!nsg) throw new Error('VM 尚未绑定网络安全组');
	await reportCreateVmProgress(progress, 'firewall-rule-delete', 'running', '正在向 Azure 提交删除防火墙规则请求', {
		networkSecurityGroup: nsg.name,
		ruleName: cleanName
	});
	const poller = await clients.network.securityRules.beginDelete(nsg.resourceGroup, nsg.name, cleanName, {
		updateIntervalInMs: 2000
	});
	let polls = 0;
	while (!poller.isDone()) {
		polls += 1;
		await reportCreateVmProgress(progress, 'firewall-rule-delete-polling', 'running', `防火墙规则删除中，轮询第 ${polls} 次`, {
			networkSecurityGroup: nsg.name,
			ruleName: cleanName,
			status: poller.getOperationState().status,
			polls
		});
		await poller.poll();
		if (!poller.isDone()) await sleep(2000);
	}
	const state = poller.getOperationState();
	if (state.error) throw state.error;
	await reportCreateVmProgress(progress, 'firewall-rule-delete', 'success', '防火墙规则已删除', {
		networkSecurityGroup: nsg.name,
		ruleName: cleanName,
		status: state.status,
		polls
	});
	return { networkSecurityGroup: nsg.name, ruleName: cleanName };
}

async function createNetworkForVm(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		location: string;
		vmName: string;
		enableIpv6: boolean;
		enableAcceleratedNetworking?: boolean;
		openPorts?: string | string[];
		enableDdosProtection?: boolean;
		ipPrefix?: string;
		ipBrushMaxAttempts?: number;
		progress?: CreateVmProgressReporter;
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

	await reportCreateVmProgress(options.progress, 'resource-group', 'running', '创建或确认资源组', {
		resourceGroup: options.resourceGroup,
		location: options.location
	});
	try {
		await clients.resources.resourceGroups.createOrUpdate(options.resourceGroup, {
			location: options.location
		});
	} catch (err) {
		const message = formatAzureError(err);
		await reportCreateVmProgress(options.progress, 'resource-group', 'error', '资源组创建或确认失败', {
			resourceGroup: options.resourceGroup,
			error: message.length > 800 ? `${message.slice(0, 800)}...` : message
		});
		throw new Error(`资源组创建或确认失败 ${options.resourceGroup}: ${message}`);
	}
	await reportCreateVmProgress(options.progress, 'resource-group', 'success', '资源组已就绪', {
		resourceGroup: options.resourceGroup
	});

	const ddosPlan = options.enableDdosProtection
		? await createDdosProtectionPlanForVm(clients, {
				resourceGroup: options.resourceGroup,
				location: options.location,
				vmName: options.vmName,
				progress: options.progress
			})
		: null;
	if (!options.enableDdosProtection) {
		await reportCreateVmProgress(options.progress, 'ddos-plan', 'info', '未启用 Azure DDoS 防护，跳过防护计划创建');
	}

	await reportCreateVmProgress(options.progress, 'vnet', 'running', '创建虚拟网络和子网', {
		vnetName,
		subnetName,
		enableIpv6: options.enableIpv6,
		enableDdosProtection: Boolean(ddosPlan)
	});
	if (ddosPlan) {
		await reportCreateVmProgress(options.progress, 'ddos-vnet', 'running', '关联 DDoS 防护到虚拟网络', {
			vnetName,
			planId: ddosPlan.id ?? ''
		});
	}
	try {
		await clients.network.virtualNetworks.beginCreateOrUpdateAndWait(options.resourceGroup, vnetName, {
			location: options.location,
			addressSpace: { addressPrefixes },
			subnets: [{ name: subnetName, addressPrefixes: subnetAddressPrefixes }],
			enableDdosProtection: Boolean(ddosPlan),
			...(ddosPlan?.id ? { ddosProtectionPlan: { id: ddosPlan.id } } : {})
		});
	} catch (err) {
		const message = formatAzureError(err);
		await reportCreateVmProgress(options.progress, 'vnet', 'error', '虚拟网络和子网创建失败', {
			vnetName,
			subnetName,
			error: message.length > 800 ? `${message.slice(0, 800)}...` : message
		});
		throw new Error(`虚拟网络和子网创建失败 ${vnetName}: ${message}`);
	}
	await reportCreateVmProgress(options.progress, 'vnet', 'success', '虚拟网络和子网已创建', {
		vnetName,
		subnetName,
		ddosProtection: Boolean(ddosPlan)
	});
	if (ddosPlan) {
		await reportCreateVmProgress(options.progress, 'ddos-vnet', 'success', 'DDoS 防护已关联到虚拟网络', {
			vnetName
		});
	}

	const nsg = await createNetworkSecurityGroupForVm(clients, {
		resourceGroup: options.resourceGroup,
		location: options.location,
		vmName: options.vmName,
		openPorts: options.openPorts,
		progress: options.progress
	});

	const createIpPrefix = normalizeIpPrefix(options.ipPrefix);
	const ipv4Result = createIpPrefix
		? await createMatchingIPv4PublicIp(clients, {
				resourceGroup: options.resourceGroup,
				location: options.location,
				vmName: options.vmName,
				targetPrefix: createIpPrefix,
				maxAttempts: options.ipBrushMaxAttempts,
				ddosProtectionPlanId: ddosPlan?.id,
				nameSalt: String(Date.now()),
				fallbackToLastOnMiss: true,
				progress: options.progress
			})
		: {
				pip: await createPublicIp(clients, {
					resourceGroup: options.resourceGroup,
					location: options.location,
					name: resourceName(options.vmName, 'pip4'),
					version: 'IPv4',
					ddosProtectionPlanId: ddosPlan?.id,
					progress: options.progress,
					step: 'public-ipv4'
				}),
				attempts: 0,
				matched: false
			};
	const ipv4 = ipv4Result.pip;
	if (!ipv4.id) throw new Error('IPv4 公网 IP 创建失败');

	let ipv6: PublicIPAddress | null = null;
	if (options.enableIpv6) {
		const ipv6Name = resourceName(options.vmName, 'pip6');
		try {
			ipv6 = await createPublicIp(clients, {
				resourceGroup: options.resourceGroup,
				location: options.location,
				name: ipv6Name,
				version: 'IPv6',
				progress: options.progress,
				step: 'public-ipv6'
			});
			if (!ipv6.id) throw new Error('IPv6 公网 IP 创建失败');
		} catch (err) {
			const message = formatAzureError(err);
			await deletePublicIpByName(clients, options.resourceGroup, ipv6Name).catch(() => undefined);
			await reportCreateVmProgress(options.progress, 'public-ipv6', 'info', 'IPv6 公网 IP 创建失败，已降级为仅 IPv4 继续创建', {
				name: ipv6Name,
				error: message.length > 800 ? `${message.slice(0, 800)}...` : message
			});
			ipv6 = null;
		}
	}
	await reportCreateVmProgress(options.progress, 'subnet', 'running', '读取子网信息并准备网卡配置', {
		vnetName,
		subnetName
	});
	let vnet: { subnets?: Array<{ name?: string; id?: string }> };
	try {
		vnet = await clients.network.virtualNetworks.get(options.resourceGroup, vnetName);
	} catch (err) {
		const message = formatAzureError(err);
		await reportCreateVmProgress(options.progress, 'subnet', 'error', '读取虚拟网络子网失败', {
			vnetName,
			subnetName,
			error: message.length > 800 ? `${message.slice(0, 800)}...` : message
		});
		throw new Error(`读取虚拟网络子网失败 ${vnetName}/${subnetName}: ${message}`);
	}
	let subnetId =
		vnet.subnets?.find((subnet) => subnet.name === subnetName)?.id ??
		vnet.subnets?.[0]?.id ??
		'';
	if (!subnetId) {
		subnetId = subnetResourceId(clients, options.resourceGroup, vnetName, subnetName);
		await reportCreateVmProgress(
			options.progress,
			'subnet',
			'info',
			'Azure 未返回子网 ID，已按标准 ARM 资源路径继续',
			{ subnetId }
		);
	}
	await reportCreateVmProgress(options.progress, 'subnet', 'success', '子网信息已确认', {
		subnetId
	});

	const ipConfigurations: NetworkInterfaceIPConfiguration[] = [
		{
			name: 'ipconfig-ipv4',
			primary: true,
			subnet: { id: subnetId },
			privateIPAllocationMethod: 'Dynamic',
			privateIPAddressVersion: 'IPv4',
			publicIPAddress: { id: ipv4.id }
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

	await reportCreateVmProgress(options.progress, 'nic', 'running', '创建网卡并准备 VM 网络配置', {
		nicName,
		ipv4: publicIpAddressValue(ipv4),
		ipv6: ipv6 ? publicIpAddressValue(ipv6) : '',
		acceleratedNetworking: Boolean(options.enableAcceleratedNetworking)
	});
	let nic: NetworkInterface;
	try {
		nic = await createNetworkInterfaceWithRetry(clients, {
			resourceGroup: options.resourceGroup,
			nicName,
			progress: options.progress,
			nic: {
				location: options.location,
				networkSecurityGroup: { id: nsg.id },
				ipConfigurations,
				enableAcceleratedNetworking: Boolean(options.enableAcceleratedNetworking)
			}
		});
	} catch (err) {
		const message = formatAzureError(err);
		await reportCreateVmProgress(options.progress, 'nic', 'error', '网卡创建失败', {
			nicName,
			subnetId,
			ipv4PublicIpId: ipv4.id,
			ipv6PublicIpId: ipv6?.id ?? '',
			acceleratedNetworking: Boolean(options.enableAcceleratedNetworking),
			error: message.length > 800 ? `${message.slice(0, 800)}...` : message
		});
		throw new Error(`网卡创建失败 ${nicName}: ${message}`);
	}

	await reportCreateVmProgress(options.progress, 'nic', 'success', '网卡已创建', {
		nicName,
		nicId: nic.id ?? '',
		acceleratedNetworking: Boolean(nic.enableAcceleratedNetworking)
	});

	const createdIps = {
		publicIPv4: publicIpAddressValue(ipv4),
		publicIPv6: ipv6 ? publicIpAddressValue(ipv6) : ''
	};
	if (!createdIps.publicIPv4 || (ipv6?.id && !createdIps.publicIPv6)) {
		const fromNic = await readPublicIpsFromNic(clients, {
			nicResourceGroup: options.resourceGroup,
			nicName,
			nic
		}).catch(() => null);
		if (fromNic?.ips.publicIPv4) createdIps.publicIPv4 = fromNic.ips.publicIPv4;
		if (fromNic?.ips.publicIPv6) createdIps.publicIPv6 = fromNic.ips.publicIPv6;
	}
	if (!createdIps.publicIPv4 || (ipv6?.id && !createdIps.publicIPv6)) {
		await collectPublicIpsFromResourceGroup(clients, {
			resourceGroup: options.resourceGroup,
			vmName: options.vmName,
			nics: [{ nicResourceGroup: options.resourceGroup, nicName, nic }],
			ips: createdIps
		}).catch(() => undefined);
	}

	return {
		nic,
		publicIPv4: createdIps.publicIPv4,
		publicIPv6: createdIps.publicIPv6,
		ipBrushAttempts: ipv4Result.attempts,
		ipBrushMatched: ipv4Result.matched
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
	await reportCreateVmProgress(options.progress, 'providers', 'running', '注册并确认 Azure 资源提供商', {
		providers: 'Microsoft.Compute, Microsoft.Network, Microsoft.Storage, Microsoft.KeyVault'
	});
	await registerResourceProviders(clients, [
		'Microsoft.Compute',
		'Microsoft.Network',
		'Microsoft.Storage',
		'Microsoft.KeyVault'
	]);
	await reportCreateVmProgress(options.progress, 'providers', 'success', '资源提供商已就绪');
	await reportCreateVmProgress(options.progress, 'image', 'running', '解析安装系统镜像', {
		imageReference
	});
	const { publisher, offer, sku, version } = parseImageReference(imageReference);
	const customData = encodeCustomData(options.customData);
	await reportCreateVmProgress(options.progress, 'image', 'success', '安装系统镜像已确认', {
		publisher,
		offer,
		sku,
		version
	});
	if (customData) {
		await reportCreateVmProgress(options.progress, 'userdata', 'success', 'UserData 已编码并准备注入', {
			bytes: Buffer.byteLength(options.customData ?? '', 'utf8')
		});
	} else {
		await reportCreateVmProgress(options.progress, 'userdata', 'info', '未填写 UserData，跳过脚本注入');
	}
	const network = await createNetworkForVm(clients, {
		resourceGroup,
		location,
		vmName,
		enableIpv6: options.enableIpv6 === true,
		enableAcceleratedNetworking: options.enableAcceleratedNetworking === true,
		openPorts: options.openPorts,
		enableDdosProtection: options.enableDdosProtection === true,
		ipPrefix: options.ipPrefix,
		ipBrushMaxAttempts: options.ipBrushMaxAttempts,
		progress: options.progress
	});

	await reportCreateVmProgress(options.progress, 'vm', 'running', '创建 Azure VM 实例', {
		vmName,
		vmSize,
		location
	});
	try {
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
	} catch (err) {
		const message = formatAzureError(err);
		await reportCreateVmProgress(options.progress, 'vm', 'error', 'Azure VM 实例创建失败', {
			vmName,
			vmSize,
			location,
			imageReference,
			error: message.length > 800 ? `${message.slice(0, 800)}...` : message
		});
		throw new Error(`Azure VM 实例创建失败 ${vmName}: ${message}`);
	}
	await reportCreateVmProgress(options.progress, 'vm', 'success', 'Azure VM 实例已创建', {
		vmName
	});
	let refreshedIps: VmPublicIpRefreshResult | null = null;
	try {
		refreshedIps = await refreshVmPublicIps(clients, resourceGroup, vmName);
	} catch {
		// Public IP assignment can lag behind VM creation; listing/refresh actions can read it later.
	}

	const result = {
		name: vmName,
		resourceGroup,
		location,
		publicIPv4: refreshedIps?.publicIPv4 || network.publicIPv4,
		publicIPv6: refreshedIps?.publicIPv6 || network.publicIPv6,
		ipBrushAttempts: network.ipBrushAttempts,
		ipBrushMatched: network.ipBrushMatched
	};
	await reportCreateVmProgress(options.progress, 'complete', 'success', '创建流程完成', {
		vmName,
		publicIPv4: result.publicIPv4,
		publicIPv6: result.publicIPv6,
		ipBrushAttempts: result.ipBrushAttempts,
		ipBrushMatched: result.ipBrushMatched
	});
	return result;
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
	vmName: string,
	progress?: CreateVmProgressReporter
): Promise<ReplaceIpResult> {
	await reportCreateVmProgress(progress, 'replace-ip-prepare', 'running', '读取 VM 网卡和当前 IPv4 配置', {
		resourceGroup,
		vmName
	});
	const { vmLocation, nicResourceGroup, nicName, nic, ipConfig } = await getPrimaryNicAndIPv4Config(
		clients,
		resourceGroup,
		vmName,
		progress,
		{ step: 'replace-ip-prepare', allowCreateIPv4Config: true }
	);
	const oldBinding = await resolveCurrentNicIPv4PublicIp(clients, {
		resourceGroup,
		vmName,
		nicResourceGroup,
		nicName,
		nic,
		ipConfig,
		progress,
		step: 'replace-ip-prepare'
	});
	const oldPublicIpId = oldBinding?.publicIpId ?? '';
	const oldPublicIpName = oldBinding?.publicIpName ?? '';
	const oldPublicIPv4 = oldBinding?.publicIPv4 ?? '';
	const targetIpConfig =
		oldBinding?.ipConfigName && oldBinding.ipConfigName !== ipConfig.name
			? ({ ...ipConfig, name: oldBinding.ipConfigName } as NetworkInterfaceIPConfiguration)
			: ipConfig;
	const newPublicIpName = resourceName(vmName, `pip4-${Date.now()}`);
	await reportCreateVmProgress(progress, 'replace-ip-create', 'running', '创建新的 IPv4 公网 IP', {
		resourceGroup: nicResourceGroup,
		vmName,
		oldPublicIPv4,
		oldPublicIpName,
		publicIpName: newPublicIpName,
		ipConfigName: targetIpConfig.name ?? '',
		oldPublicIpSource: oldBinding?.source ?? 'none'
	});
	let created: PublicIPAddress;
	try {
		created = await createPublicIp(clients, {
			resourceGroup: nicResourceGroup,
			location: vmLocation,
			name: newPublicIpName,
			version: 'IPv4',
			progress,
			step: 'replace-ip-create',
			waitForAddress: true,
			failureProgressStatus: 'info'
		});
	} catch (err) {
		const createFailureMessage = formatAzureError(err);
		if (isPublicIpQuotaFailure(createFailureMessage)) {
			await releaseOldIPv4PublicIpForRetry(clients, {
				nicResourceGroup,
				nicName,
				nic,
				ipConfig: targetIpConfig,
				oldPublicIpId,
				oldPublicIpName,
				oldPublicIPv4,
				progress,
				prefix: 'replace-ip',
				reason: createFailureMessage
			});
		}
		created = await createPublicIp(clients, {
			resourceGroup: nicResourceGroup,
			location: vmLocation,
			name: resourceName(vmName, `pip4-${Date.now()}-retry`),
			version: 'IPv4',
			progress,
			step: 'replace-ip-create-retry',
			waitForAddress: true
		}).catch((retryErr) => {
			throw new Error(`retry create IPv4 public IP failed (replace-ip-create-retry): ${formatAzureError(retryErr)}`);
		});
	}
	if (!created.id) throw new Error('新公网 IPv4 创建失败');

	try {
		const switchMode = await detachOldPublicIpOrSwapDirectly(clients, {
			resourceGroup,
			vmName,
			nicResourceGroup,
			nicName,
			nic,
			ipConfig: targetIpConfig,
			oldPublicIpId,
			oldPublicIpName,
			oldPublicIPv4,
			newPublicIpId: created.id,
			progress,
			prefix: 'replace-ip'
		});
		if (switchMode !== 'swapped') {
			await reportCreateVmProgress(progress, 'replace-ip-attach', 'running', '绑定新的 IPv4 到网卡', {
				nicName,
				publicIpName: parseResourceName(created.id),
				publicIPv4: publicIpAddressValue(created),
				mode: switchMode
			});
			await attachPublicIpToNic(clients, {
				nicResourceGroup,
				nicName,
				nic,
				ipConfig: targetIpConfig,
				publicIpId: created.id,
				progress,
				step: 'replace-ip-attach'
			});
		}
		if (oldPublicIpId) {
			await reportCreateVmProgress(progress, 'replace-ip-cleanup', 'running', '删除旧 IPv4 公网 IP', {
				oldPublicIpName,
				oldPublicIPv4,
				mode: switchMode
			});
			await deletePublicIpById(clients, oldPublicIpId).catch(async (err) => {
				const message = formatAzureError(err);
				await reportCreateVmProgress(progress, 'replace-ip-cleanup', 'error', '删除旧 IPv4 公网 IP 失败', {
					oldPublicIpName,
					oldPublicIPv4,
					error: message.length > 1000 ? `${message.slice(0, 1000)}...` : message
				});
				throw new Error(`delete old IPv4 public IP failed (replace-ip-cleanup): ${message}`);
			});
		}
	} catch (err) {
		await reportCreateVmProgress(progress, 'replace-ip-recover', 'info', 'IPv4 更换绑定失败，新 IPv4 已保留以便手动恢复', {
			publicIpName: parseResourceName(created.id),
			publicIPv4: publicIpAddressValue(created),
			error: formatAzureError(err).slice(0, 800)
		});
		throw err;
	}

	const fresh = await waitForNicAttachedPublicIPv4(clients, {
		nicResourceGroup,
		nicName,
		ipConfigName: targetIpConfig.name,
		fallbackPublicIpId: created.id,
		progress,
		step: 'replace-ip-complete'
	}).catch(async (err) => {
		const message = formatAzureError(err);
		await reportCreateVmProgress(progress, 'replace-ip-complete', 'error', '读取更换后的 IPv4 地址失败', {
			nicName,
			publicIpName: parseResourceName(created.id ?? ''),
			error: message.length > 1000 ? `${message.slice(0, 1000)}...` : message
		});
		throw new Error(`read replaced IPv4 failed (replace-ip-complete): ${message}`);
	});
	const createdPublicIPv4 = publicIpAddressValue(created);
	const finalPublicIPv4 = fresh.publicIPv4 || createdPublicIPv4;
	try {
		await ensureVmAllowAllInboundFirewall(clients, resourceGroup, vmName, progress, 'replace-ip-firewall');
	} catch (err) {
		const message = formatAzureError(err);
		await reportCreateVmProgress(progress, 'replace-ip-firewall', 'error', 'IPv4 changed, but firewall allow-all sync failed', {
			publicIPv4: finalPublicIPv4,
			error: message.length > 1000 ? `${message.slice(0, 1000)}...` : message
		});
		throw new Error(`IPv4 changed to ${finalPublicIPv4 || '-'}, but firewall allow-all sync failed: ${message}`);
	}
	await reportCreateVmProgress(progress, 'replace-ip-complete', 'success', 'IPv4 更换完成', {
		oldPublicIPv4,
		publicIPv4: finalPublicIPv4
	});
	return {
		vmName,
		resourceGroup,
		publicIPv4: finalPublicIPv4,
		oldPublicIPv4,
		publicIpName: fresh.publicIpName || parseResourceName(created.id)
	};
}

export async function brushVmPublicIPv4Prefix(
	clients: AzureClients,
	options: {
		resourceGroup: string;
		vmName: string;
		ipPrefix: string;
		maxAttempts?: number;
		progress?: CreateVmProgressReporter;
	}
): Promise<BrushIpResult> {
	const targetPrefix = normalizeIpPrefix(options.ipPrefix);
	if (!targetPrefix) throw new Error('缺少 IPv4 前缀');

	await reportCreateVmProgress(options.progress, 'brush-ip-prepare', 'running', '读取 VM 网卡和当前 IPv4 配置', {
		resourceGroup: options.resourceGroup,
		vmName: options.vmName,
		targetPrefix
	});
	const { vmLocation, nicResourceGroup, nicName, nic, ipConfig } = await getPrimaryNicAndIPv4Config(
		clients,
		options.resourceGroup,
		options.vmName,
		options.progress,
		{ step: 'brush-ip-prepare', allowCreateIPv4Config: true }
	);
	const oldBinding = await resolveCurrentNicIPv4PublicIp(clients, {
		resourceGroup: options.resourceGroup,
		vmName: options.vmName,
		nicResourceGroup,
		nicName,
		nic,
		ipConfig,
		progress: options.progress,
		step: 'brush-ip-prepare'
	});
	const oldPublicIpId = oldBinding?.publicIpId ?? '';
	const oldPublicIpName = oldBinding?.publicIpName ?? '';
	const oldPublicIPv4 = oldBinding?.publicIPv4 ?? '';
	const targetIpConfig =
		oldBinding?.ipConfigName && oldBinding.ipConfigName !== ipConfig.name
			? ({ ...ipConfig, name: oldBinding.ipConfigName } as NetworkInterfaceIPConfiguration)
			: ipConfig;
	let created: { pip: PublicIPAddress; attempts: number; matched: boolean };
	try {
		created = await createMatchingIPv4PublicIp(clients, {
			resourceGroup: nicResourceGroup,
			location: vmLocation,
			vmName: options.vmName,
			targetPrefix,
			maxAttempts: options.maxAttempts,
			nameSalt: String(Date.now()),
			fallbackToLastOnMiss: true,
			failureProgressStatus: 'info',
			progress: options.progress
		});
	} catch (err) {
		const createFailureMessage = formatAzureError(err);
		if (!isPublicIpQuotaFailure(createFailureMessage)) throw err;
		await releaseOldIPv4PublicIpForRetry(clients, {
			nicResourceGroup,
			nicName,
			nic,
			ipConfig: targetIpConfig,
			oldPublicIpId,
			oldPublicIpName,
			oldPublicIPv4,
			progress: options.progress,
			prefix: 'brush-ip',
			reason: createFailureMessage
		});
		created = await createMatchingIPv4PublicIp(clients, {
			resourceGroup: nicResourceGroup,
			location: vmLocation,
			vmName: options.vmName,
			targetPrefix,
			maxAttempts: options.maxAttempts,
			nameSalt: `${Date.now()}-retry`,
			fallbackToLastOnMiss: true,
			progress: options.progress
		}).catch((retryErr) => {
			throw new Error(`retry brush IPv4 public IP failed (brush-ip-create-retry): ${formatAzureError(retryErr)}`);
		});
	}
	if (!created.pip.id) throw new Error('匹配公网 IPv4 创建失败');

	try {
		const switchMode = await detachOldPublicIpOrSwapDirectly(clients, {
			resourceGroup: options.resourceGroup,
			vmName: options.vmName,
			nicResourceGroup,
			nicName,
			nic,
			ipConfig: targetIpConfig,
			oldPublicIpId,
			oldPublicIpName,
			oldPublicIPv4,
			newPublicIpId: created.pip.id,
			progress: options.progress,
			prefix: 'brush-ip'
		});
		if (switchMode !== 'swapped') {
			if (oldPublicIpId) {
				await reportCreateVmProgress(options.progress, 'brush-ip-cleanup', 'running', '删除旧 IPv4 公网 IP', {
					oldPublicIpName,
					oldPublicIPv4,
					mode: switchMode
				});
				await deletePublicIpById(clients, oldPublicIpId).catch(async (err) => {
					const message = formatAzureError(err);
					await reportCreateVmProgress(options.progress, 'brush-ip-cleanup', 'error', '删除旧 IPv4 公网 IP 失败', {
						oldPublicIpName,
						oldPublicIPv4,
						error: message.length > 1000 ? `${message.slice(0, 1000)}...` : message
					});
					throw new Error(`delete old IPv4 public IP failed (brush-ip-cleanup): ${message}`);
				});
			}

			await reportCreateVmProgress(
				options.progress,
				'brush-ip-attach',
				'running',
				created.matched ? '绑定命中的 IPv4 到网卡' : '未命中目标前缀，绑定最后一次刷到的 IPv4 到网卡',
				{
					nicName,
					publicIpName: parseResourceName(created.pip.id),
					attempts: created.attempts,
					matched: created.matched
				}
			);
			await attachPublicIpToNic(clients, {
				nicResourceGroup,
				nicName,
				nic,
				ipConfig: targetIpConfig,
				publicIpId: created.pip.id,
				progress: options.progress,
				step: 'brush-ip-attach'
			});
		}
		if (switchMode === 'swapped') {
			await reportCreateVmProgress(options.progress, 'brush-ip-cleanup', 'running', '删除旧 IPv4 公网 IP', {
				oldPublicIpName,
				oldPublicIPv4,
				mode: switchMode
			});
			await deletePublicIpById(clients, oldPublicIpId).catch(async (err) => {
				const message = formatAzureError(err);
				await reportCreateVmProgress(options.progress, 'brush-ip-cleanup', 'error', '删除旧 IPv4 公网 IP 失败', {
					oldPublicIpName,
					oldPublicIPv4,
					error: message.length > 1000 ? `${message.slice(0, 1000)}...` : message
				});
				throw new Error(`delete old IPv4 public IP failed (brush-ip-cleanup): ${message}`);
			});
		}
	} catch (err) {
		if (oldPublicIpId) {
			await reportCreateVmProgress(options.progress, 'brush-ip-recover', 'info', '刷 IPv4 失败，新 IPv4 已保留以便手动恢复', {
				publicIpName: parseResourceName(created.pip.id),
				error: formatAzureError(err).slice(0, 800)
			});
		} else {
			await deletePublicIpById(clients, created.pip.id);
		}
		throw err;
	}

	const fresh = await waitForNicAttachedPublicIPv4(clients, {
		nicResourceGroup,
		nicName,
		ipConfigName: targetIpConfig.name,
		fallbackPublicIpId: created.pip.id,
		progress: options.progress,
		step: 'brush-ip-complete'
	}).catch(async (err) => {
		const message = formatAzureError(err);
		await reportCreateVmProgress(options.progress, 'brush-ip-complete', 'error', '读取刷 IP 后的 IPv4 地址失败', {
			nicName,
			publicIpName: parseResourceName(created.pip.id ?? ''),
			error: message.length > 1000 ? `${message.slice(0, 1000)}...` : message
		});
		throw new Error(`read brushed IPv4 failed (brush-ip-complete): ${message}`);
	});
	const createdPublicIPv4 = publicIpAddressValue(created.pip);
	const finalPublicIPv4 = fresh.publicIPv4 || createdPublicIPv4;
	try {
		await ensureVmAllowAllInboundFirewall(clients, options.resourceGroup, options.vmName, options.progress, 'brush-ip-firewall');
	} catch (err) {
		const message = formatAzureError(err);
		await reportCreateVmProgress(options.progress, 'brush-ip-firewall', 'error', 'IPv4 changed, but firewall allow-all sync failed', {
			publicIPv4: finalPublicIPv4,
			targetPrefix,
			matched: created.matched,
			error: message.length > 1000 ? `${message.slice(0, 1000)}...` : message
		});
		throw new Error(`IPv4 changed to ${finalPublicIPv4 || '-'}, but firewall allow-all sync failed: ${message}`);
	}
	await reportCreateVmProgress(options.progress, 'brush-ip-complete', 'success', '刷 IPv4 段完成', {
		publicIPv4: finalPublicIPv4,
		targetPrefix,
		attempts: created.attempts,
		matched: created.matched
	});
	return {
		vmName: options.vmName,
		resourceGroup: options.resourceGroup,
		publicIPv4: finalPublicIPv4,
		oldPublicIPv4,
		publicIpName: fresh.publicIpName || parseResourceName(created.pip.id),
		targetPrefix,
		attempts: created.attempts,
		matched: created.matched
	};
}
