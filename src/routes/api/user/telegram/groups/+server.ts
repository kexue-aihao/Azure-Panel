import { decryptSecret, encryptSecret } from '$lib/server/crypto';
import {
	findNotificationSettingsByUser,
	upsertNotificationSettings
} from '$lib/server/db/repo';
import { fail, ok, requireUser } from '$lib/server/http';
import {
	discoverTelegramGroupChats,
	parseTelegramChatIds,
	publicTelegramSettings,
	serializeTelegramGroupChatIds
} from '$lib/server/telegram';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const body = await event.request.json().catch(() => ({}));
	const settings = await findNotificationSettingsByUser(user.id);
	const botToken = String(body.bot_token ?? '').trim();
	const token = botToken
		? botToken
		: settings?.telegramBotTokenEncrypted
			? decryptSecret(settings.telegramBotTokenEncrypted)
			: '';

	if (!token) return fail('请先保存或填写 Bot API Token');

	try {
		const chats = await discoverTelegramGroupChats(token);
		const existingGroupIds = parseTelegramChatIds(settings?.telegramGroupChatIds ?? '');
		const discoveredIds = chats.map((chat) => chat.chat_id);
		const mergedGroupIds = serializeTelegramGroupChatIds([...existingGroupIds, ...discoveredIds]);
		const saved = await upsertNotificationSettings(user.id, {
			telegramGroupChatIds: mergedGroupIds,
			...(botToken ? { telegramBotTokenEncrypted: encryptSecret(botToken) } : {})
		});

		return ok({
			chats,
			settings: publicTelegramSettings(saved)
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err), 500);
	}
};
