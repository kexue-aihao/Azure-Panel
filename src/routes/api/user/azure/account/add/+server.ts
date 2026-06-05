import { maskProxyUrl, validateAzureCredentials, validateProxyUrl } from '$lib/server/azure';
import { encryptSecret } from '$lib/server/crypto';
import { insertAccount } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
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

	try {
		await validateAzureCredentials(tenantId, clientId, clientSecret, subscriptionId, proxyUrl);
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
		proxyUrlEncrypted: proxyUrl ? encryptSecret(proxyUrl) : '',
		remark
	});

	return ok({
		id: account.id,
		name: account.name,
		tenant_id: account.tenantId,
		client_id: account.clientId,
		subscription_id: account.subscriptionId,
		proxy_enabled: Boolean(proxyUrl),
		proxy_label: proxyUrl ? maskProxyUrl(proxyUrl) : '',
		remark: account.remark,
		created_at: account.createdAt
	});
};
