import { ensureClientIpProxyProfile } from '$lib/server/auto-client-ip-proxy';
import { getUserAccount } from '$lib/server/accounts';
import { findProxyProfileByUser, updateAccountProxy } from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import { proxyProfileToAzureReady, publicProxyProfile } from '$lib/server/proxy';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const accountId = Number(body.account_id);
	const proxyMode = String(body.proxy_mode ?? 'direct').trim();
	const proxyProfileId = Number(body.proxy_profile_id ?? 0) || null;

	if (!accountId) return fail('缺少账号 ID');
	await getUserAccount(user.id, accountId);

	try {
		let proxyProfile = null;
		const clientIp = getRequestClientIp(event);
		if (proxyMode === 'direct') {
			proxyProfile = null;
		} else if (proxyMode === 'client_ip') {
			proxyProfile = await ensureClientIpProxyProfile(user.id, clientIp);
		} else if (proxyMode === 'profile') {
			if (!proxyProfileId) return fail('请先选择一个自定义代理档案');
			proxyProfile = await findProxyProfileByUser(user.id, proxyProfileId);
			if (!proxyProfile) return fail('代理配置不存在');
		} else {
			return fail('代理选择无效');
		}

		if (proxyProfile) {
			try {
				await proxyProfileToAzureReady(proxyProfile, {
					clientIp,
					timeoutMs: 10_000,
					autoDetectHttpSocks: true,
					updateProfileType: true
				});
			} catch (err) {
				return fail(
					`代理测活失败，未保存账号代理: ${err instanceof Error ? err.message : String(err)}`,
					400
				);
			}
			if (proxyMode === 'profile') {
				proxyProfile = (await findProxyProfileByUser(user.id, proxyProfile.id)) ?? proxyProfile;
			}
		}

		const account = await updateAccountProxy(user.id, accountId, {
			proxyProfileId: proxyProfile?.id ?? null,
			proxyUrlEncrypted: ''
		});
		if (!account) return fail('Azure 账号不存在', 404);

		const publicProxy = proxyProfile ? publicProxyProfile(proxyProfile) : null;
		return ok({
			id: account.id,
			proxy_profile_id: account.proxyProfileId,
			proxy_enabled: Boolean(publicProxy),
			proxy_name: publicProxy?.name ?? '',
			proxy_label: publicProxy?.label ?? '',
			proxy_source: publicProxy?.source ?? ''
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
