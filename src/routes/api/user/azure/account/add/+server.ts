import { maskProxyUrl, validateAzureCredentials, validateProxyUrl } from '$lib/server/azure';
import { encryptSecret } from '$lib/server/crypto';
import { findProxyProfileByUser, insertAccount } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import { publicProxyProfile, proxyProfileToRuntime } from '$lib/server/proxy';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();

	const name = String(body.name ?? '');
	const tenantId = String(body.tenant_id ?? '');
	const clientId = String(body.client_id ?? '');
	const clientSecret = String(body.client_secret ?? '');
	const subscriptionId = String(body.subscription_id ?? '');
	const proxyUrl = String(body.proxy_url ?? '').trim();
	const proxyProfileId = Number(body.proxy_profile_id ?? 0) || null;
	const remark = String(body.remark ?? '');

	if (!name || !tenantId || !clientId || !clientSecret || !subscriptionId) {
		return fail('请填写完整 Azure 凭据');
	}

	if (proxyUrl) {
		try {
			validateProxyUrl(proxyUrl);
		} catch (err) {
			return fail(err instanceof Error ? err.message : '代理地址无效');
		}
	}

	const proxyProfile = proxyProfileId ? await findProxyProfileByUser(user.id, proxyProfileId) : null;
	if (proxyProfileId && !proxyProfile) return fail('代理配置不存在');
	const runtimeProxy = proxyProfile ? proxyProfileToRuntime(proxyProfile) : proxyUrl;

	try {
		await validateAzureCredentials(tenantId, clientId, clientSecret, subscriptionId, runtimeProxy);
	} catch (err) {
		return fail(`Azure 凭据验证失败: ${String(err)}`, 400);
	}

	const account = await insertAccount({
		userId: user.id,
		name,
		tenantId,
		clientId,
		clientSecretEncrypted: encryptSecret(clientSecret),
		subscriptionId,
		proxyProfileId: proxyProfile?.id ?? null,
		proxyUrlEncrypted: proxyProfile ? '' : proxyUrl ? encryptSecret(proxyUrl) : '',
		remark
	});

	const publicProxy = proxyProfile ? publicProxyProfile(proxyProfile) : null;

	return ok({
		id: account.id,
		name: account.name,
		tenant_id: account.tenantId,
		client_id: account.clientId,
		subscription_id: account.subscriptionId,
		proxy_profile_id: account.proxyProfileId,
		proxy_enabled: Boolean(publicProxy || proxyUrl),
		proxy_name: publicProxy?.name ?? '',
		proxy_label: publicProxy?.label ?? (proxyUrl ? maskProxyUrl(proxyUrl) : ''),
		remark: account.remark,
		created_at: account.createdAt
	});
};
