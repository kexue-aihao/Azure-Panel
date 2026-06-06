import { findNotificationSettingsByUser } from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import { getTelegramCredentials, sendTelegramMessage } from '$lib/server/telegram';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const settings = await findNotificationSettingsByUser(user.id);
	const credentials = getTelegramCredentials(settings);
	if (!credentials) return fail('Telegram 通知未启用或配置不完整');

	try {
		await sendTelegramMessage({
			...credentials,
			text: [
				'Azure Panel Telegram 通知测试',
				'这是一条测试消息，表示 Bot Token 和 Telegram UID / Chat ID 可用。',
				`时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
			].join('\n')
		});
		return ok({ ok: true });
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
