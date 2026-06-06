import { findNotificationSettingsByUser } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import { getTelegramCredentials, sendTelegramMessageToTargets } from '$lib/server/telegram';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const settings = await findNotificationSettingsByUser(user.id);
	const credentials = getTelegramCredentials(settings);
	if (!credentials) return fail('Telegram 通知未启用或配置不完整');

	try {
		const result = await sendTelegramMessageToTargets({
			token: credentials.token,
			chatIds: credentials.chatIds,
			text: [
				'Azure Panel Telegram 通知测试',
				'这是一条测试消息，会同时发送给个人 UID / Chat ID 和已配置的群组。',
				`时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
			].join('\n')
		});
		return ok({ ok: true, sent: result.sent.length, failed: result.failed.length });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
