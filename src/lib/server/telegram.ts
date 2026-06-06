import { decryptSecret } from './crypto';
import type { AzureAccount, NotificationSettings } from './db/schema';

export const DEFAULT_SUBSCRIPTION_CHECK_INTERVAL_HOURS = 6;

export type TelegramPublicSettings = {
	id: number;
	enabled: boolean;
	telegram_chat_id: string;
	telegram_chat_id_masked: string;
	bot_token_configured: boolean;
	bot_token_masked: string;
	subscription_check_interval_hours: number;
	last_subscription_checked_at: Date | null;
	created_at: Date;
};

function trimString(value: unknown) {
	return String(value ?? '').trim();
}

export function normalizeSubscriptionCheckIntervalHours(value: unknown) {
	if (value === '' || value === null || value === undefined) {
		return DEFAULT_SUBSCRIPTION_CHECK_INTERVAL_HOURS;
	}
	const hours = Number(value);
	return Number.isFinite(hours) && hours > 0
		? Math.min(Math.floor(hours), 24 * 30)
		: DEFAULT_SUBSCRIPTION_CHECK_INTERVAL_HOURS;
}

export function maskMiddle(value: string, left = 4, right = 4) {
	const raw = trimString(value);
	if (!raw) return '-';
	if (raw.length <= left + right + 3) return `${raw.slice(0, 2)}***`;
	return `${raw.slice(0, left)}****${raw.slice(-right)}`;
}

export function maskTelegramToken(token: string) {
	const raw = trimString(token);
	if (!raw) return '';
	const [prefix, secret] = raw.split(':');
	if (!secret) return maskMiddle(raw, 4, 4);
	return `${maskMiddle(prefix, 4, 3)}:${maskMiddle(secret, 4, 6)}`;
}

export function maskTelegramChatId(chatId: string) {
	return maskMiddle(chatId, 3, 3);
}

export function maskSubscriptionId(subscriptionId: string) {
	return maskMiddle(subscriptionId, 6, 6);
}

export function maskAccountName(name: string) {
	return maskMiddle(name, 2, 2);
}

export function maskIpAddress(ip: string | null | undefined) {
	const raw = trimString(ip);
	if (!raw) return '-';
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
		const parts = raw.split('.');
		return `${parts[0]}.${parts[1]}.*.*`;
	}
	if (raw.includes(':')) {
		const parts = raw.split(':').filter(Boolean);
		if (parts.length <= 2) return `${parts[0] ?? ''}:****`;
		return `${parts[0]}:${parts[1]}:****`;
	}
	return maskMiddle(raw, 3, 3);
}

export function publicTelegramSettings(
	settings: NotificationSettings | null
): TelegramPublicSettings | null {
	if (!settings) return null;
	const token = settings.telegramBotTokenEncrypted
		? decryptSecret(settings.telegramBotTokenEncrypted)
		: '';
	return {
		id: settings.id,
		enabled: Boolean(settings.enabled),
		telegram_chat_id: settings.telegramChatId,
		telegram_chat_id_masked: maskTelegramChatId(settings.telegramChatId),
		bot_token_configured: Boolean(token),
		bot_token_masked: maskTelegramToken(token),
		subscription_check_interval_hours: normalizeSubscriptionCheckIntervalHours(
			settings.subscriptionCheckIntervalHours
		),
		last_subscription_checked_at: settings.lastSubscriptionCheckedAt,
		created_at: settings.createdAt
	};
}

export function getTelegramCredentials(settings: NotificationSettings | null) {
	if (!settings || !settings.enabled) return null;
	const token = decryptSecret(settings.telegramBotTokenEncrypted);
	const chatId = trimString(settings.telegramChatId);
	if (!token || !chatId) return null;
	return { token, chatId };
}

export async function sendTelegramMessage(options: {
	token: string;
	chatId: string;
	text: string;
}): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const response = await fetch(`https://api.telegram.org/bot${options.token}/sendMessage`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json'
				},
				body: JSON.stringify({
					chat_id: options.chatId,
					text: options.text.slice(0, 3900),
					disable_web_page_preview: true
				}),
				signal: controller.signal
			});
		const text = await response.text();
		let payload: { ok?: boolean; description?: string } | null = null;
		try {
			payload = text ? JSON.parse(text) : null;
		} catch {
			payload = null;
		}
		if (!response.ok || payload?.ok === false) {
			throw new Error(payload?.description || `Telegram sendMessage failed (${response.status})`);
		}
	} finally {
		clearTimeout(timeout);
	}
}

export function buildSubscriptionAlertMessage(input: {
	account: AzureAccount;
	subscriptionId: string;
	displayName: string;
	state: string;
	checkedAt?: Date;
}) {
	return [
		'Azure Panel 订阅状态告警',
		`账号: ${maskAccountName(input.account.name)}`,
		`订阅: ${maskSubscriptionId(input.subscriptionId || input.account.subscriptionId)}`,
		`显示名: ${maskMiddle(input.displayName || '-', 2, 2)}`,
		`状态: ${input.state || 'Unknown'}`,
		`时间: ${(input.checkedAt ?? new Date()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
	].join('\n');
}

export function buildReplenishmentMessage(input: {
	policyName: string;
	account: AzureAccount;
	vmName: string;
	resourceGroup: string;
	vmSize: string;
	location: string;
	publicIPv4?: string | null;
	publicIPv6?: string | null;
}) {
	return [
		'Azure Panel 自动补机成功',
		`策略: ${maskMiddle(input.policyName, 2, 2)}`,
		`补机账号: ${maskAccountName(input.account.name)}`,
		`订阅: ${maskSubscriptionId(input.account.subscriptionId)}`,
		`VM: ${maskMiddle(input.vmName, 4, 4)}`,
		`资源组: ${maskMiddle(input.resourceGroup, 4, 4)}`,
		`规格/区域: ${input.vmSize} / ${input.location}`,
		`IPv4: ${maskIpAddress(input.publicIPv4)}`,
		`IPv6: ${maskIpAddress(input.publicIPv6)}`,
		`时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
	].join('\n');
}
