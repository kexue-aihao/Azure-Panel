import { decryptSecret } from './crypto';
import type { AzureAccount, NotificationSettings } from './db/schema';

export const DEFAULT_SUBSCRIPTION_CHECK_INTERVAL_HOURS = 6;

export type TelegramPublicSettings = {
	id: number;
	enabled: boolean;
	telegram_chat_id: string;
	telegram_chat_id_masked: string;
	telegram_group_chat_ids: string;
	telegram_group_chat_id_list: string[];
	telegram_group_chat_id_masked_list: string[];
	bot_token_configured: boolean;
	bot_token_masked: string;
	subscription_check_interval_hours: number;
	last_subscription_checked_at: Date | null;
	created_at: Date;
};

function trimString(value: unknown) {
	return String(value ?? '').trim();
}

function compactList(values: string[]) {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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

export function parseTelegramChatIds(value: unknown): string[] {
	if (Array.isArray(value)) {
		return compactList(value.flatMap((item) => parseTelegramChatIds(item)));
	}
	return compactList(
		trimString(value)
			.split(/[\s,;，；]+/)
			.map((item) => item.trim())
	);
}

export function validateTelegramChatIds(chatIds: string[]) {
	return chatIds.every((chatId) => /^-?\d{5,32}$/.test(chatId));
}

export function serializeTelegramGroupChatIds(chatIds: string[]) {
	return parseTelegramChatIds(chatIds).join('\n');
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
		telegram_group_chat_ids: settings.telegramGroupChatIds ?? '',
		telegram_group_chat_id_list: parseTelegramChatIds(settings.telegramGroupChatIds),
		telegram_group_chat_id_masked_list: parseTelegramChatIds(settings.telegramGroupChatIds).map(
			maskTelegramChatId
		),
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
	const chatIds = compactList([chatId, ...parseTelegramChatIds(settings.telegramGroupChatIds)]);
	if (!token || chatIds.length === 0) return null;
	return { token, chatId, chatIds };
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

export async function sendTelegramMessageToTargets(options: {
	token: string;
	chatIds: string[];
	text: string;
}): Promise<{ sent: string[]; failed: Array<{ chatId: string; error: string }> }> {
	const sent: string[] = [];
	const failed: Array<{ chatId: string; error: string }> = [];
	for (const chatId of compactList(options.chatIds)) {
		try {
			await sendTelegramMessage({ token: options.token, chatId, text: options.text });
			sent.push(chatId);
		} catch (err) {
			failed.push({ chatId, error: err instanceof Error ? err.message : String(err) });
		}
	}
	if (sent.length === 0 && failed.length > 0) {
		throw new Error(failed.map((item) => `${maskTelegramChatId(item.chatId)}: ${item.error}`).join('; '));
	}
	return { sent, failed };
}

type TelegramChat = {
	id?: number;
	title?: string;
	username?: string;
	type?: string;
};

type TelegramUpdate = {
	update_id?: number;
	message?: { chat?: TelegramChat };
	edited_message?: { chat?: TelegramChat };
	channel_post?: { chat?: TelegramChat };
	my_chat_member?: { chat?: TelegramChat };
	chat_member?: { chat?: TelegramChat };
};

function chatFromUpdate(update: TelegramUpdate) {
	return (
		update.message?.chat ??
		update.edited_message?.chat ??
		update.channel_post?.chat ??
		update.my_chat_member?.chat ??
		update.chat_member?.chat ??
		null
	);
}

export async function discoverTelegramGroupChats(token: string) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				accept: 'application/json'
			},
			body: JSON.stringify({
				allowed_updates: ['message', 'edited_message', 'channel_post', 'my_chat_member', 'chat_member']
			}),
			signal: controller.signal
		});
		const text = await response.text();
		let payload: { ok?: boolean; description?: string; result?: TelegramUpdate[] } | null = null;
		try {
			payload = text ? JSON.parse(text) : null;
		} catch {
			payload = null;
		}
		if (!response.ok || payload?.ok === false) {
			throw new Error(payload?.description || `Telegram getUpdates failed (${response.status})`);
		}
		const chats = new Map<string, { chat_id: string; title: string; type: string; username: string }>();
		for (const update of payload?.result ?? []) {
			const chat = chatFromUpdate(update);
			const chatId = chat?.id ? String(chat.id) : '';
			const type = String(chat?.type ?? '');
			if (!chatId || !['group', 'supergroup', 'channel'].includes(type)) continue;
			chats.set(chatId, {
				chat_id: chatId,
				title: chat?.title || chat?.username || chatId,
				type,
				username: chat?.username ?? ''
			});
		}
		return [...chats.values()];
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

export function buildAccountPoolAddedMessage(input: {
	account: AzureAccount;
	poolCount: number;
	proxyLabel?: string;
	addedAt?: Date;
}) {
	return [
		'Azure Panel 账号池补充通知',
		`账号: ${maskAccountName(input.account.name)}`,
		`租户: ${maskMiddle(input.account.tenantId, 6, 6)}`,
		`Client ID: ${maskMiddle(input.account.clientId, 6, 6)}`,
		`订阅: ${maskSubscriptionId(input.account.subscriptionId)}`,
		`出站: ${input.proxyLabel || '服务器源站 IP'}`,
		`账号池剩余: ${Math.max(0, Math.floor(input.poolCount))} 个`,
		`时间: ${(input.addedAt ?? new Date()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
	].join('\n');
}

export function buildAccountPoolCountMessage(input: { poolCount: number; checkedAt?: Date }) {
	const count = Math.max(0, Math.floor(input.poolCount));
	return [
		'Azure Panel 账号池剩余检测',
		`账号池剩余: ${count} 个`,
		`状态: ${count > 0 ? '账号池不为空，自动补机会继续按添加顺序选择候选账号' : '账号池为空，请尽快补充账号'}`,
		`触发: 手动检测`,
		`时间: ${(input.checkedAt ?? new Date()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`
	].join('\n');
}
