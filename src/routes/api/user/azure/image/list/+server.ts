import { getUserAccount, getUserAccountWithSelectedProxy } from '$lib/server/accounts';
import { createAzureClients, listFeaturedVmImages, type VmImageOption } from '$lib/server/azure';
import { updateAccountImageCache } from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

type VmImageCache = Record<string, VmImageOption[]>;

function shouldRefreshCache(value: string | null) {
	return ['1', 'true', 'yes', 'force'].includes((value ?? '').trim().toLowerCase());
}

function normalizeLocation(value: string) {
	return value.trim().toLowerCase();
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

function parseImageCache(raw: string | null | undefined): VmImageCache {
	if (!raw?.trim()) return {};

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

		const cache: VmImageCache = {};
		for (const [location, value] of Object.entries(parsed as Record<string, unknown>)) {
			const key = normalizeLocation(location);
			if (!key || !Array.isArray(value)) continue;
			const images = value.map(normalizeImage).filter((image): image is VmImageOption => image !== null);
			if (images.length > 0) cache[key] = images;
		}
		return cache;
	} catch {
		return {};
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
		if (!refresh && cache[locationKey]?.length) return ok(cache[locationKey]);

		const { account, proxy } = await getUserAccountWithSelectedProxy(user.id, accountId, {
			clientIp: getRequestClientIp(event),
			proxyMode: event.url.searchParams.get('proxy_mode'),
			proxyProfileId: Number(event.url.searchParams.get('proxy_profile_id') ?? 0) || null
		});
		const images = await listFeaturedVmImages(createAzureClients(account, proxy), location);
		if (images.length > 0) {
			await updateAccountImageCache(
				user.id,
				accountId,
				JSON.stringify({
					...cache,
					[locationKey]: images
				})
			);
		}
		return ok(images);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
