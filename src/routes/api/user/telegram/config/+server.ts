import { encryptSecret } from '$lib/server/crypto';
import {
	findNotificationSettingsByUser,
	upsertNotificationSettings
} from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import {
	normalizeSubscriptionCheckIntervalHours,
	publicTelegramSettings
} from '$lib/server/telegram';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const settings = await findNotificationSettingsByUser(user.id);
	return ok(publicTelegramSettings(settings));
};

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json();
	const enabled = body.enabled === true;
	const botToken = String(body.bot_token ?? '').trim();
	const chatId = String(body.telegram_chat_id ?? body.chat_id ?? '').trim();
	const intervalHours = normalizeSubscriptionCheckIntervalHours(
		body.subscription_check_interval_hours
	);
	const existing = await findNotificationSettingsByUser(user.id);

	if (enabled && !chatId) return fail('启用 Telegram 通知前请填写 Telegram UID / Chat ID');
	if (enabled && !botToken && !existing?.telegramBotTokenEncrypted) {
		return fail('启用 Telegram 通知前请填写 Bot API Token');
	}
	if (botToken && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
		return fail('Bot API Token 格式不正确，请检查是否完整复制');
	}
	if (chatId && !/^-?\d{5,32}$/.test(chatId)) {
		return fail('Telegram UID / Chat ID 格式不正确');
	}

	const settings = await upsertNotificationSettings(user.id, {
		enabled,
		telegramChatId: chatId,
		subscriptionCheckIntervalHours: intervalHours,
		...(botToken ? { telegramBotTokenEncrypted: encryptSecret(botToken) } : {})
	});

	return ok(publicTelegramSettings(settings));
};
