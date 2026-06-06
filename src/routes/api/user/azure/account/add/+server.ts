import { maskProxyUrl, validateAzureCredentials, validateProxyUrl } from '$lib/server/azure';
import { ensureClientIpProxyProfile } from '$lib/server/auto-client-ip-proxy';
import { encryptSecret } from '$lib/server/crypto';
import {
	findNotificationSettingsByUser,
	findProxyProfileByUser,
	insertAccount,
	listAccountsByUser,
	updateProxyProfileType
} from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import {
	parseProxyUrl,
	publicProxyProfile,
	proxyProfileToRuntimeReady,
	type ProxyRuntimeConfig,
	validateProxyConnection
} from '$lib/server/proxy';
import {
	buildAccountPoolAddedMessage,
	getTelegramCredentials,
	sendTelegramMessageToTargets
} from '$lib/server/telegram';
import type { RequestHandler } from './$types';

async function validateSavedProxyWithFallback(
	userId: number,
	proxyProfileId: number | null,
	proxy: ProxyRuntimeConfig,
	clientIp: string
) {
	try {
		return await validateProxyConnection(proxy, { clientIp, timeoutMs: 10_000 });
	} catch (err) {
		if (proxyProfileId && proxy.type === 'socks5') {
			const httpCandidate: ProxyRuntimeConfig = { ...proxy, type: 'http' };
			try {
				const validated = await validateProxyConnection(httpCandidate, { clientIp, timeoutMs: 10_000 });
				await updateProxyProfileType(userId, proxyProfileId, 'http');
				return validated;
			} catch {
				// Preserve the original SOCKS error because it best explains the selected profile.
			}
		}
		throw err;
	}
}

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
	let runtimeProxy = proxyProfile
		? await proxyProfileToRuntimeReady(proxyProfile, { clientIp })
		: proxyUrl;

	let subscriptionId = '';
	try {
		if (runtimeProxy && typeof runtimeProxy !== 'string') {
			runtimeProxy = await validateSavedProxyWithFallback(
				user.id,
				proxyProfile?.id ?? null,
				runtimeProxy,
				clientIp
			);
		} else if (runtimeProxy) {
			const parsedProxy = parseProxyUrl(runtimeProxy);
			if (parsedProxy) runtimeProxy = await validateProxyConnection(parsedProxy, { clientIp, timeoutMs: 10_000 });
		}
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
	const proxyLabel = publicProxy?.label ?? (proxyUrl ? maskProxyUrl(proxyUrl) : '');
	const poolCount = (await listAccountsByUser(user.id)).length;
	let telegramNotified = false;
	let telegramSent = 0;
	let telegramFailed = 0;
	let telegramError = '';

	try {
		const settings = await findNotificationSettingsByUser(user.id);
		const credentials = getTelegramCredentials(settings);
		if (credentials) {
			const result = await sendTelegramMessageToTargets({
				token: credentials.token,
				chatIds: credentials.chatIds,
				text: buildAccountPoolAddedMessage({
					account,
					poolCount,
					proxyLabel
				})
			});
			telegramSent = result.sent.length;
			telegramFailed = result.failed.length;
			telegramNotified = telegramSent > 0;
			telegramError = result.failed.map((item) => item.error).join('; ');
		} else {
			telegramError = 'Telegram 通知未启用或配置不完整';
		}
	} catch (err) {
		telegramError = err instanceof Error ? err.message : String(err);
		console.warn('[account] Telegram account pool notification failed:', err);
	}

	return ok({
		id: account.id,
		name: account.name,
		tenant_id: account.tenantId,
		client_id: account.clientId,
		subscription_id: account.subscriptionId,
		proxy_profile_id: account.proxyProfileId,
		proxy_enabled: Boolean(publicProxy || proxyUrl),
		proxy_name: publicProxy?.name ?? '',
		proxy_label: proxyLabel,
		pool_count: poolCount,
		telegram_notified: telegramNotified,
		telegram_sent: telegramSent,
		telegram_failed: telegramFailed,
		telegram_error: telegramError,
		remark: account.remark,
		created_at: account.createdAt
	});
};
