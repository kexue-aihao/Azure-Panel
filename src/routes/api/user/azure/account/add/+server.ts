import { validateAzureCredentials } from '$lib/server/azure';
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
	const remark = String(body.remark ?? '');

	if (!name || !tenantId || !clientId || !clientSecret || !subscriptionId) {
		return fail('请填写完整 Azure 凭据');
	}

	try {
		await validateAzureCredentials(tenantId, clientId, clientSecret, subscriptionId);
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
		remark
	});

	return ok({
		id: account.id,
		name: account.name,
		tenant_id: account.tenantId,
		client_id: account.clientId,
		subscription_id: account.subscriptionId,
		remark: account.remark,
		created_at: account.createdAt
	});
};
