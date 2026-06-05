import { maskProxyUrl, validateAzureCredentials, validateProxyUrl } from '$lib/server/azure';
import { ensureClientIpProxyProfile } from '$lib/server/auto-client-ip-proxy';
import { encryptSecret } from '$lib/server/crypto';
import { findProxyProfileByUser, insertAccount } from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import { publicProxyProfile, proxyProfileToRuntimeReady } from '$lib/server/proxy';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();

	const rawName = String(body.name ?? '').trim();
	const tenantId = String(body.tenant_id ?? '');
	const clientId = String(body.client_id ?? '');
	const clientSecret = String(body.client_secret ?? '');
	const proxyUrl = String(body.proxy_url ?? '').trim();
	const proxyMode = String(body.proxy_mode ?? '');
	const proxyProfileId = Number(body.proxy_profile_id ?? 0) || null;
	const remark = String(body.remark ?? '');

	if (!tenantId || !clientId || !clientSecret) {
		return fail('请填写完整 Azure 凭据');
	}

	if (proxyUrl) {
		try {
			validateProxyUrl(proxyUrl);
		} catch (err) {
			return fail(err instanceof Error ? err.message : '代理地址无效');
		}
	}

	const clientIp = getRequestClientIp(event);
	let proxyProfile = null;
	try {
		proxyProfile =
			proxyMode === 'client_ip'
				? await ensureClientIpProxyProfile(user.id, clientIp)
				: proxyProfileId
					? await findProxyProfileByUser(user.id, proxyProfileId)
					: null;
	} catch (err) {
		return fail(err instanceof Error ? err.message : '当前访问 IP 代理自动识别失败');
	}
	if (proxyProfileId && !proxyProfile) return fail('代理配置不存在');
	const runtimeProxy = proxyProfile
		? await proxyProfileToRuntimeReady(proxyProfile, { clientIp })
		: proxyUrl;

	let subscriptionId = '';
	try {
		const validation = await validateAzureCredentials(tenantId, clientId, clientSecret, runtimeProxy);
		subscriptionId = validation.subscriptionId;
	} catch (err) {
		return fail(`Azure 凭据验证失败: ${String(err)}`, 400);
	}
	const name = rawName || `Azure ${clientId.slice(0, 8)}`;

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
