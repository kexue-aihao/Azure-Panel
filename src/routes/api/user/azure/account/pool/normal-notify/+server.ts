import { getAccountSubscriptionStatus } from '$lib/server/azure';
import { getUserAccountWithProxy } from '$lib/server/accounts';
import { findNotificationSettingsByUser, listAccountsByUser } from '$lib/server/db/repo';
import { fail, getRequestClientIp, ok, requireUser } from '$lib/server/http';
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

type AccountCheckResult = {
	account_id: number;
	status: 'success' | 'failed' | 'check_failed';
	state: string;
	subscription_id: string;
	display_name: string;
	error: string;
	checked_at: string;
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
	const body = (await event.request.json().catch(() => ({}))) as { account_id?: unknown };
	const accountId = Number(body.account_id ?? 0) || 0;
	const allAccounts = await listAccountsByUser(user.id);
	const accounts = accountId ? allAccounts.filter((account) => account.id === accountId) : allAccounts;
	if (accountId && accounts.length === 0) return fail('账号不存在或不属于当前用户', 404);

	const clientIp = getRequestClientIp(event);
	const normalAccounts: NormalAccount[] = [];
	let abnormalCount = 0;
	let checkFailedCount = 0;
	let sent = 0;
	let notifyFailed = 0;
	const notifyErrors: string[] = [];
	const accountResults: AccountCheckResult[] = [];
	const settings = await findNotificationSettingsByUser(user.id);
	const credentials = getTelegramCredentials(settings);

	for (const account of accounts) {
		const checkedAt = new Date();
		try {
			const { account: runtimeAccount, proxy } = await getUserAccountWithProxy(user.id, account.id, {
				clientIp,
				validateProxy: true,
				timeoutMs: 10_000
			});
			const status = await getAccountSubscriptionStatus(runtimeAccount, proxy);
			if (!status.abnormal) {
				const normalAccount: NormalAccount = {
					account: runtimeAccount,
					subscriptionId: status.subscriptionId,
					displayName: status.displayName,
					state: status.state
				};
				normalAccounts.push(normalAccount);
				accountResults.push({
					account_id: runtimeAccount.id,
					status: 'success',
					state: status.state || 'Enabled',
					subscription_id: status.subscriptionId || runtimeAccount.subscriptionId,
					display_name: status.displayName || '',
					error: '',
					checked_at: checkedAt.toISOString()
				});
				if (!credentials) {
					notifyErrors.push('Telegram 通知未启用或配置不完整');
				} else {
					try {
						const result = await sendTelegramMessageToTargets({
							token: credentials.token,
							chatIds: credentials.chatIds,
							text: buildNormalSubscriptionMessage({
								totalCount: 1,
								normalAccounts: [normalAccount],
								abnormalCount: 0,
								failedCount: 0,
								checkedAt
							})
						});
						sent += result.sent.length;
						notifyFailed += result.failed.length;
						notifyErrors.push(...result.failed.map((item) => item.error));
					} catch (err) {
						notifyFailed += credentials.chatIds.length;
						notifyErrors.push(err instanceof Error ? err.message : String(err));
					}
				}
			} else {
				abnormalCount += 1;
				accountResults.push({
					account_id: runtimeAccount.id,
					status: 'failed',
					state: status.state || 'Unknown',
					subscription_id: status.subscriptionId || runtimeAccount.subscriptionId,
					display_name: status.displayName || '',
					error: '',
					checked_at: checkedAt.toISOString()
				});
			}
		} catch (err) {
			checkFailedCount += 1;
			accountResults.push({
				account_id: account.id,
				status: 'check_failed',
				state: '',
				subscription_id: account.subscriptionId,
				display_name: '',
				error: err instanceof Error ? err.message : String(err),
				checked_at: checkedAt.toISOString()
			});
		}
	}

	const notifyError =
		normalAccounts.length === 0
			? '没有检测到订阅正常的账号，未发送 Telegram 通知'
			: [...new Set(notifyErrors.filter(Boolean))].join('; ');

	return ok({
		total_count: accounts.length,
		normal_count: normalAccounts.length,
		abnormal_count: abnormalCount,
		check_failed: checkFailedCount,
		notified: sent > 0,
		sent,
		notify_failed: notifyFailed,
		notify_error: notifyError,
		accounts: accountResults
	});
};
