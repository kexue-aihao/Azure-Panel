import {
	deleteProxyProfile,
	findNotificationSettingsByUser,
	findProxyProfileByUser
} from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
import { stopManagedProxyForProfile } from '$lib/server/managed-proxy-core';
import {
	proxyProfileToAzureReady,
	proxySource,
	publicProxyProfile,
	type PublicProxyProfile
} from '$lib/server/proxy';
import {
	getTelegramCredentials,
	maskMiddle,
	sendTelegramMessageToTargets
} from '$lib/server/telegram';
import type { ProxyProfile } from '$lib/server/db/schema';
import type { RequestHandler } from './$types';

type ProxyCheckStatus = 'available' | 'deleted' | 'failed';

function buildProxyHealthMessage(input: {
	profile: ProxyProfile;
	publicProfile: PublicProxyProfile;
	status: ProxyCheckStatus;
	error?: string;
	checkedAt: Date;
}) {
	return [
		'Azure Panel 代理测活通知',
		`代理: ${maskMiddle(input.profile.name, 2, 2)}`,
		`类型: ${input.publicProfile.type.toUpperCase()}`,
		`出口: ${input.publicProfile.label}`,
		`结果: ${
			input.status === 'available'
				? '可用，已保留'
				: input.status === 'deleted'
					? '不可用，已自动删除，并解除绑定该代理的 Azure 账号'
					: '不可用，未自动删除，等待用户确认'
		}`,
		input.error ? `错误: ${input.error.slice(0, 800)}` : '',
		`时间: ${input.checkedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
	]
		.filter(Boolean)
		.join('\n');
}

async function notifyProxyHealth(input: {
	userId: number;
	profile: ProxyProfile;
	publicProfile: PublicProxyProfile;
	status: ProxyCheckStatus;
	error?: string;
	checkedAt: Date;
}) {
	const settings = await findNotificationSettingsByUser(input.userId);
	const credentials = getTelegramCredentials(settings);
	if (!credentials) {
		return {
			telegram_notified: false,
			telegram_sent: 0,
			telegram_failed: 0,
			telegram_error: 'Telegram 通知未启用或配置不完整'
		};
	}

	try {
		const result = await sendTelegramMessageToTargets({
			token: credentials.token,
			chatIds: credentials.chatIds,
			text: buildProxyHealthMessage(input)
		});
		return {
			telegram_notified: result.sent.length > 0,
			telegram_sent: result.sent.length,
			telegram_failed: result.failed.length,
			telegram_error: result.failed.map((item) => item.error).join('; ')
		};
	} catch (err) {
		return {
			telegram_notified: false,
			telegram_sent: 0,
			telegram_failed: credentials.chatIds.length,
			telegram_error: err instanceof Error ? err.message : String(err)
		};
	}
}

function silentProxyHealthNotification() {
	return {
		telegram_notified: false,
		telegram_sent: 0,
		telegram_failed: 0,
		telegram_error: ''
	};
}

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = (await event.request.json().catch(() => ({}))) as {
		proxy_id?: unknown;
		delete_on_fail?: unknown;
		notify?: unknown;
		silent?: unknown;
	};
	const proxyProfileId = Number(body.proxy_id ?? 0) || 0;
	if (!proxyProfileId) return fail('缺少 proxy_id');
	const deleteOnFail = body.delete_on_fail !== false;
	const notifyEnabled = body.notify !== false && body.silent !== true;

	const profile = await findProxyProfileByUser(user.id, proxyProfileId);
	if (!profile) return fail('代理配置不存在', 404);
	if (proxySource(profile) === 'client_ip') return fail('当前访问网站 IP 代理为动态代理，不支持后台测活删除');

	const publicProfile = publicProxyProfile(profile);
	const checkedAt = new Date();

	try {
		const runtimeProxy = await proxyProfileToAzureReady(profile, {
			clientIp: getRequestClientIp(event),
			timeoutMs: 10_000,
			autoDetectHttpSocks: true,
			updateProfileType: true
		});
		const refreshed = (await findProxyProfileByUser(user.id, proxyProfileId)) ?? profile;
		const resultProfile = publicProxyProfile(refreshed);
		const notify = notifyEnabled
			? await notifyProxyHealth({
					userId: user.id,
					profile: refreshed,
					publicProfile: resultProfile,
					status: 'available',
					checkedAt
				})
			: silentProxyHealthNotification();

		return ok({
			proxy_id: proxyProfileId,
			name: refreshed.name,
			status: 'available',
			deleted: false,
			message: `代理可用，已保留：${resultProfile.label}`,
			error: '',
			proxy: resultProfile,
			runtime_type: runtimeProxy.type,
			checked_at: checkedAt.toISOString(),
			...notify
		});
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		if (!deleteOnFail) {
			const notify = notifyEnabled
				? await notifyProxyHealth({
						userId: user.id,
						profile,
						publicProfile,
						status: 'failed',
						error,
						checkedAt
					})
				: silentProxyHealthNotification();

			return ok({
				proxy_id: proxyProfileId,
				name: profile.name,
				status: 'failed',
				deleted: false,
				message: `代理不可用，未保存：${profile.name}`,
				error,
				proxy: publicProfile,
				runtime_type: '',
				checked_at: checkedAt.toISOString(),
				...notify
			});
		}

		await stopManagedProxyForProfile(profile).catch(() => undefined);
		await deleteProxyProfile(user.id, proxyProfileId);
		const notify = notifyEnabled
			? await notifyProxyHealth({
					userId: user.id,
					profile,
					publicProfile,
					status: 'deleted',
					error,
					checkedAt
				})
			: silentProxyHealthNotification();

		return ok({
			proxy_id: proxyProfileId,
			name: profile.name,
			status: 'deleted',
			deleted: true,
			message: `代理不可用，已自动删除：${profile.name}`,
			error,
			proxy: null,
			runtime_type: '',
			checked_at: checkedAt.toISOString(),
			...notify
		});
	}
};
