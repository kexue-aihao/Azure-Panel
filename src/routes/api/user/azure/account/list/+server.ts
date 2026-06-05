import { listUserAccounts } from '$lib/server/accounts';
import { maskProxyUrl } from '$lib/server/azure';
import { decryptSecret } from '$lib/server/crypto';
import { listProxyProfilesByUser } from '$lib/server/db/repo';
import { ok, requireUser } from '$lib/server/http';
import { publicProxyProfile } from '$lib/server/proxy';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accounts = await listUserAccounts(user);
	const proxies = await listProxyProfilesByUser(user.id);
	const proxyById = new Map(proxies.map((profile) => [profile.id, publicProxyProfile(profile)]));
	return ok(
		accounts.map((a) => {
			const proxy = a.proxyProfileId ? proxyById.get(a.proxyProfileId) : null;
			const legacyProxyLabel = a.proxyUrlEncrypted ? maskProxyUrl(decryptSecret(a.proxyUrlEncrypted)) : '';
			return {
				id: a.id,
				name: a.name,
				tenant_id: a.tenantId,
				client_id: a.clientId,
				subscription_id: a.subscriptionId,
				proxy_profile_id: a.proxyProfileId,
				proxy_enabled: Boolean(proxy || legacyProxyLabel),
				proxy_name: proxy?.name ?? (legacyProxyLabel ? '兼容代理' : ''),
				proxy_label: proxy?.label ?? legacyProxyLabel,
				remark: a.remark,
				created_at: a.createdAt
			};
		})
	);
};
