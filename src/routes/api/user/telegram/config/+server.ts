import { encryptSecret } from '$lib/server/crypto';
import {
	findNotificationSettingsByUser,
	upsertNotificationSettings
} from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import {
	normalizeSubscriptionCheckIntervalHours,
	parseTelegramChatIds,
	publicTelegramSettings,
	serializeTelegramGroupChatIds,
	validateTelegramChatIds
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
	const groupChatIds = parseTelegramChatIds(body.telegram_group_chat_ids ?? body.group_chat_ids ?? '');
	const intervalHours = normalizeSubscriptionCheckIntervalHours(
		body.subscription_check_interval_hours
	);
	const existing = await findNotificationSettingsByUser(user.id);

	if (enabled && !chatId && groupChatIds.length === 0) {
		return fail('启用 Telegram 通知前请至少填写个人 UID / Chat ID 或群组 Chat ID');
	}
	if (enabled && !botToken && !existing?.telegramBotTokenEncrypted) {
		return fail('启用 Telegram 通知前请填写 Bot API Token');
	}
	if (botToken && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
		return fail('Bot API Token 格式不正确，请检查是否完整复制');
	}
	if (chatId && !/^-?\d{5,32}$/.test(chatId)) {
		return fail('Telegram UID / Chat ID 格式不正确');
	}
	if (!validateTelegramChatIds(groupChatIds)) {
		return fail('群组 Chat ID 格式不正确，请填写类似 -1001234567890 的数字 ID');
	}

	const settings = await upsertNotificationSettings(user.id, {
		enabled,
		telegramChatId: chatId,
		telegramGroupChatIds: serializeTelegramGroupChatIds(groupChatIds),
		subscriptionCheckIntervalHours: intervalHours,
		...(botToken ? { telegramBotTokenEncrypted: encryptSecret(botToken) } : {})
	});

	return ok(publicTelegramSettings(settings));
};
