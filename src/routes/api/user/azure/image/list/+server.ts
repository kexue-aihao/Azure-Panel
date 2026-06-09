import { getUserAccount, getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import {
	createAzureClients,
	fallbackFeaturedVmImages,
	listFeaturedVmImages,
	type VmImageOption
} from '$lib/server/azure';
import { updateAccountImageCache } from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

type VmImageCache = Record<string, VmImageOption[]>;
const IMAGE_CACHE_VERSION = 2;

function shouldRefreshCache(value: string | null) {
	return ['1', 'true', 'yes', 'force'].includes((value ?? '').trim().toLowerCase());
}

function shouldUseFastFallback(value: string | null) {
	return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

function normalizeLocation(value: string) {
	return value.trim().toLowerCase();
}

function isFallbackImageList(images: VmImageOption[]) {
	return images.length > 0 && images.every((image) => image.version === 'latest');
}

function normalizeImage(item: unknown): VmImageOption | null {
	if (!item || typeof item !== 'object') return null;
	const image = item as Partial<VmImageOption>;
	const publisher = String(image.publisher ?? '').trim();
	const offer = String(image.offer ?? '').trim();
	const sku = String(image.sku ?? '').trim();
	const version = String(image.version ?? '').trim();
	const imageReference = String(
		image.imageReference || [publisher, offer, sku, version].filter(Boolean).join(':')
	).trim();
	if (!publisher || !offer || !sku || !version || !imageReference) return null;

	const osType = image.osType === 'Linux' || image.osType === 'Windows' ? image.osType : 'Unknown';
	return {
		label: String(image.label || imageReference),
		imageReference,
		publisher,
		offer,
		sku,
		version,
		osType,
		architecture: String(image.architecture ?? ''),
		hyperVGeneration: String(image.hyperVGeneration ?? '')
	};
}

function parseImageCache(raw: string | null | undefined): { version: number; locations: VmImageCache } {
	if (!raw?.trim()) return { version: 0, locations: {} };

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: 0, locations: {} };

		const cache: VmImageCache = {};
		const version = Number((parsed as Record<string, unknown>).__version ?? 0) || 0;
		for (const [location, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (location === '__version') continue;
			const key = normalizeLocation(location);
			if (!key || !Array.isArray(value)) continue;
			const images = value.map(normalizeImage).filter((image): image is VmImageOption => image !== null);
			if (images.length > 0) cache[key] = images;
		}
		return { version, locations: cache };
	} catch {
		return { version: 0, locations: {} };
	}
}

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accountId = Number(event.url.searchParams.get('account_id'));
	const location = String(event.url.searchParams.get('location') ?? '').trim();
	if (!accountId || !location) return fail('缺少 account_id 或 location');

	try {
		const refresh = shouldRefreshCache(event.url.searchParams.get('refresh'));
		const locationKey = normalizeLocation(location);
		const cachedAccount = await getUserAccount(user.id, accountId);
		const cache = parseImageCache(cachedAccount.vmImageCache);
		if (!refresh && cache.version >= IMAGE_CACHE_VERSION && cache.locations[locationKey]?.length) {
			return ok(cache.locations[locationKey]);
		}
		if (!refresh && shouldUseFastFallback(event.url.searchParams.get('fast'))) {
			return ok(fallbackFeaturedVmImages());
		}

		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: event.url.searchParams.get('proxy_mode'),
			proxyProfileId: Number(event.url.searchParams.get('proxy_profile_id') ?? 0) || null
		});
		const images = await listFeaturedVmImages(createAzureClients(account, proxy), location).catch(() =>
			cache.locations[locationKey]?.length ? cache.locations[locationKey] : fallbackFeaturedVmImages()
		);
		if (images.length > 0 && !isFallbackImageList(images)) {
			await updateAccountImageCache(
				user.id,
				accountId,
				JSON.stringify({
					__version: IMAGE_CACHE_VERSION,
					...cache.locations,
					[locationKey]: images
				})
			);
		}
		return ok(images);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
