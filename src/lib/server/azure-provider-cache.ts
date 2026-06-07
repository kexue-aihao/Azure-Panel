import type { AzureProviderStatus } from './azure';

export type ProviderStatusCache = Record<string, Record<string, AzureProviderStatus>>;

const CACHEABLE_PROVIDER_STATES = new Set([
	'notregistered',
	'registered',
	'registering',
	'unregistering'
]);

export function normalizeProviderSubscription(value: string) {
	return value.trim().toLowerCase();
}

export function normalizeProviderNamespace(value: string) {
	return value.trim().toLowerCase();
}

function normalizeProviderStatus(item: unknown): AzureProviderStatus | null {
	if (!item || typeof item !== 'object') return null;
	const provider = item as Partial<AzureProviderStatus>;
	const namespace = String(provider.namespace ?? '').trim();
	const registrationState = String(provider.registrationState ?? '').trim();
	if (!namespace || !registrationState) return null;

	return {
		namespace,
		registrationState,
		registrationPolicy: String(provider.registrationPolicy ?? ''),
		resourceTypeCount: Number(provider.resourceTypeCount) || 0,
		locations: Array.isArray(provider.locations) ? provider.locations.map(String).filter(Boolean) : []
	};
}

export function parseProviderStatusCache(raw: string | null | undefined): ProviderStatusCache {
	if (!raw?.trim()) return {};

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

		const cache: ProviderStatusCache = {};
		for (const [subscriptionId, providers] of Object.entries(parsed as Record<string, unknown>)) {
			const subscriptionKey = normalizeProviderSubscription(subscriptionId);
			if (!subscriptionKey || !providers || typeof providers !== 'object' || Array.isArray(providers)) {
				continue;
			}

			const subscriptionProviders: Record<string, AzureProviderStatus> = {};
			for (const [namespace, value] of Object.entries(providers as Record<string, unknown>)) {
				const provider = normalizeProviderStatus(value);
				const namespaceKey = normalizeProviderNamespace(provider?.namespace || namespace);
				if (!provider || !namespaceKey) continue;
				subscriptionProviders[namespaceKey] = provider;
			}

			if (Object.keys(subscriptionProviders).length > 0) {
				cache[subscriptionKey] = subscriptionProviders;
			}
		}
		return cache;
	} catch {
		return {};
	}
}

export function getCachedProviderStatuses(
	cache: ProviderStatusCache,
	subscriptionId: string,
	namespaces: string[]
): AzureProviderStatus[] | null {
	const subscriptionCache = cache[normalizeProviderSubscription(subscriptionId)];
	if (!subscriptionCache) return null;

	const providers = namespaces.map(
		(namespace) => subscriptionCache[normalizeProviderNamespace(namespace)] ?? null
	);
	return providers.every((provider): provider is AzureProviderStatus => provider !== null)
		? providers
		: null;
}

export function canCacheProviderStatuses(providers: AzureProviderStatus[]) {
	return (
		providers.length > 0 &&
		providers.every((provider) =>
			CACHEABLE_PROVIDER_STATES.has(normalizeProviderSubscription(provider.registrationState))
		)
	);
}

export function mergeProviderStatusCache(
	cache: ProviderStatusCache,
	subscriptionId: string,
	providers: AzureProviderStatus[]
) {
	const subscriptionKey = normalizeProviderSubscription(subscriptionId);
	const current = cache[subscriptionKey] ?? {};
	for (const provider of providers) {
		const namespaceKey = normalizeProviderNamespace(provider.namespace);
		if (namespaceKey) current[namespaceKey] = provider;
	}

	return {
		...cache,
		[subscriptionKey]: current
	};
}
