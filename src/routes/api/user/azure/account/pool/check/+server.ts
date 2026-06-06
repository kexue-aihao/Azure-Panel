import {
	findNotificationSettingsByUser,
	listAccountsByUser
} from '$lib/server/db/repo';
import { ok, requireUser } from '$lib/server/http';
import {
	buildAccountPoolCountMessage,
	getTelegramCredentials,
	sendTelegramMessageToTargets
} from '$lib/server/telegram';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accounts = await listAccountsByUser(user.id);
	const poolCount = accounts.length;
	let notified = false;
	let notifyError = '';
	let sent = 0;
	let failed = 0;

	try {
		const settings = await findNotificationSettingsByUser(user.id);
		const credentials = getTelegramCredentials(settings);
		if (!credentials) {
			notifyError = 'Telegram 通知未启用或配置不完整';
		} else {
			const result = await sendTelegramMessageToTargets({
				token: credentials.token,
				chatIds: credentials.chatIds,
				text: buildAccountPoolCountMessage({ poolCount })
			});
			sent = result.sent.length;
			failed = result.failed.length;
			notified = sent > 0;
			notifyError = result.failed.map((item) => item.error).join('; ');
		}
	} catch (err) {
		notifyError = err instanceof Error ? err.message : String(err);
	}

	return ok({
		pool_count: poolCount,
		notified,
		sent,
		failed,
		notify_error: notifyError
	});
};
