import { getAccountSubscriptionStatus } from '$lib/server/azure';
import { getUserAccountWithProxy } from '$lib/server/accounts';
import { findNotificationSettingsByUser, listAccountsByUser } from '$lib/server/db/repo';
import { getRequestClientIp, ok, requireUser } from '$lib/server/http';
import {
	getTelegramCredentials,
	maskAccountName,
	maskMiddle,
	maskSubscriptionId,
	sendTelegramMessageToTargets
} from '$lib/server/telegram';
import type { AzureAccount } from '$lib/server/db/schema';
import type { RequestHandler } from './$types';

type NormalAccount = {
	account: AzureAccount;
	subscriptionId: string;
	displayName: string;
	state: string;
};

function buildNormalSubscriptionMessage(input: {
	totalCount: number;
	normalAccounts: NormalAccount[];
	abnormalCount: number;
	failedCount: number;
	checkedAt?: Date;
}) {
	const lines = input.normalAccounts.slice(0, 20).map((item, index) => {
		const displayName = item.displayName ? ` / ${maskMiddle(item.displayName, 2, 2)}` : '';
		return `${index + 1}. ${maskAccountName(item.account.name)} - ${maskSubscriptionId(
			item.subscriptionId || item.account.subscriptionId
		)}${displayName} - ${item.state || 'Enabled'}`;
	});
	if (input.normalAccounts.length > lines.length) {
		lines.push(`...还有 ${input.normalAccounts.length - lines.length} 个正常账号未展开`);
	}

	return [
		'Azure Panel 账号订阅正常检测',
		`检测账号: ${input.totalCount} 个`,
		`正常订阅: ${input.normalAccounts.length} 个`,
		`异常订阅: ${input.abnormalCount} 个`,
		`检测失败: ${input.failedCount} 个`,
		...(lines.length ? ['正常账号列表:', ...lines] : []),
		`时间: ${(input.checkedAt ?? new Date()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
	].join('\n');
}

export const POST: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const accounts = await listAccountsByUser(user.id);
	const clientIp = getRequestClientIp(event);
	const normalAccounts: NormalAccount[] = [];
	let abnormalCount = 0;
	let checkFailedCount = 0;
	let notifyError = '';
	let notified = false;
	let sent = 0;
	let notifyFailed = 0;

	for (const account of accounts) {
		try {
			const { account: runtimeAccount, proxy } = await getUserAccountWithProxy(user.id, account.id, {
				clientIp,
				validateProxy: true,
				timeoutMs: 10_000
			});
			const status = await getAccountSubscriptionStatus(runtimeAccount, proxy);
			if (!status.abnormal) {
				normalAccounts.push({
					account: runtimeAccount,
					subscriptionId: status.subscriptionId,
					displayName: status.displayName,
					state: status.state
				});
			} else {
				abnormalCount += 1;
			}
		} catch {
			checkFailedCount += 1;
		}
	}

	if (normalAccounts.length === 0) {
		notifyError = '没有检测到订阅正常的账号，未发送 Telegram 通知';
	} else {
		try {
			const settings = await findNotificationSettingsByUser(user.id);
			const credentials = getTelegramCredentials(settings);
			if (!credentials) {
				notifyError = 'Telegram 通知未启用或配置不完整';
			} else {
				const result = await sendTelegramMessageToTargets({
					token: credentials.token,
					chatIds: credentials.chatIds,
					text: buildNormalSubscriptionMessage({
						totalCount: accounts.length,
						normalAccounts,
						abnormalCount,
						failedCount: checkFailedCount
					})
				});
				sent = result.sent.length;
				notifyFailed = result.failed.length;
				notified = sent > 0;
				notifyError = result.failed.map((item) => item.error).join('; ');
			}
		} catch (err) {
			notifyError = err instanceof Error ? err.message : String(err);
		}
	}

	return ok({
		total_count: accounts.length,
		normal_count: normalAccounts.length,
		abnormal_count: abnormalCount,
		check_failed: checkFailedCount,
		notified,
		sent,
		notify_failed: notifyFailed,
		notify_error: notifyError
	});
};
