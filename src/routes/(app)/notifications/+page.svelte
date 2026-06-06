<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type TelegramSettings = {
		id: number;
		enabled: boolean;
		telegram_chat_id: string;
		telegram_chat_id_masked: string;
		bot_token_configured: boolean;
		bot_token_masked: string;
		subscription_check_interval_hours: number;
		last_subscription_checked_at: string | null;
		created_at: string;
	} | null;

	let settings = $state<TelegramSettings>(null);
	let loading = $state(false);
	let testing = $state(false);
	let toast = $state('');
	let form = $state({
		enabled: false,
		bot_token: '',
		telegram_chat_id: '',
		subscription_check_interval_hours: ''
	});

	function fillForm(data: TelegramSettings) {
		form = {
			enabled: data?.enabled ?? false,
			bot_token: '',
			telegram_chat_id: data?.telegram_chat_id ?? '',
			subscription_check_interval_hours: data?.subscription_check_interval_hours
				? String(data.subscription_check_interval_hours)
				: ''
		};
	}

	function formatDate(value: string | null | undefined) {
		return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-';
	}

	async function load() {
		settings = await api<TelegramSettings>('/api/user/telegram/config');
		fillForm(settings);
	}

	async function save(e: Event) {
		e.preventDefault();
		loading = true;
		try {
			settings = await api<TelegramSettings>('/api/user/telegram/config', {
				method: 'POST',
				body: JSON.stringify({
					enabled: form.enabled,
					bot_token: form.bot_token,
					telegram_chat_id: form.telegram_chat_id,
					subscription_check_interval_hours: form.subscription_check_interval_hours
				})
			});
			fillForm(settings);
			toast = 'Telegram 通知配置已保存';
		} catch (err) {
			toast = err instanceof Error ? err.message : 'Telegram 通知配置保存失败';
		} finally {
			loading = false;
		}
	}

	async function testSend() {
		testing = true;
		try {
			await api('/api/user/telegram/test', { method: 'POST' });
			toast = '测试消息已发送，请查看 Telegram';
		} catch (err) {
			toast = err instanceof Error ? err.message : '测试消息发送失败';
		} finally {
			testing = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">通知设置</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
	<form class="card space-y-4 p-5" onsubmit={save}>
		<div>
			<h2 class="text-lg font-medium">Telegram 机器人通知</h2>
			<p class="mt-1 text-sm text-muted">
				用于账号订阅变为 warned、warning、banned 时通知，以及自动补机成功后发送新机器信息。账号、订阅和 IP 会在消息里自动打码。
			</p>
		</div>

		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" bind:checked={form.enabled} /> 启用 Telegram 通知
		</label>

		<div>
			<label class="mb-1 block text-xs text-muted" for="telegram-token">Bot API Token</label>
			<input
				id="telegram-token"
				class="input"
				type="password"
				bind:value={form.bot_token}
				placeholder={settings?.bot_token_configured
					? `已保存 ${settings.bot_token_masked}，留空表示不更换`
					: '例如 8263****741:****hBTTdVUI***AsdYTSz09Uuk'}
				required={form.enabled && !settings?.bot_token_configured}
			/>
		</div>

		<div>
			<label class="mb-1 block text-xs text-muted" for="telegram-chat-id">Telegram UID / Chat ID</label>
			<input
				id="telegram-chat-id"
				class="input"
				bind:value={form.telegram_chat_id}
				placeholder="例如 6034235722"
				required={form.enabled}
			/>
		</div>

		<div>
			<label class="mb-1 block text-xs text-muted" for="telegram-interval">
				订阅状态定时检测间隔，单位小时
			</label>
			<input
				id="telegram-interval"
				class="input"
				type="number"
				min="1"
				max="720"
				bind:value={form.subscription_check_interval_hours}
				placeholder="留空默认 6 小时"
			/>
			<p class="mt-1 text-xs text-muted">
				worker 会检测当前补机策略正在使用的账号，也会检测账号池里未使用的账号；同一账号同一异常状态只通知一次。
			</p>
		</div>

		<div class="flex flex-wrap gap-2">
			<button class="btn-primary" type="submit" disabled={loading}>
				{loading ? '保存中...' : '保存通知配置'}
			</button>
			<button
				class="btn-secondary"
				type="button"
				onclick={() => void testSend()}
				disabled={testing || !settings?.enabled || !settings?.bot_token_configured}
			>
				{testing ? '发送中...' : '发送测试消息'}
			</button>
		</div>
	</form>

	<section class="card space-y-4 p-5">
		<h2 class="text-lg font-medium">当前状态</h2>
		<div class="grid gap-3 text-sm md:grid-cols-2">
			<div class="rounded-lg border border-border bg-background p-3">
				<div class="text-xs text-muted">通知状态</div>
				<div class="mt-1 font-medium">{settings?.enabled ? '已启用' : '未启用'}</div>
			</div>
			<div class="rounded-lg border border-border bg-background p-3">
				<div class="text-xs text-muted">Bot Token</div>
				<div class="mt-1 break-all font-medium">{settings?.bot_token_masked || '-'}</div>
			</div>
			<div class="rounded-lg border border-border bg-background p-3">
				<div class="text-xs text-muted">Telegram UID / Chat ID</div>
				<div class="mt-1 font-medium">{settings?.telegram_chat_id_masked || '-'}</div>
			</div>
			<div class="rounded-lg border border-border bg-background p-3">
				<div class="text-xs text-muted">检测间隔</div>
				<div class="mt-1 font-medium">{settings?.subscription_check_interval_hours ?? 6} 小时</div>
			</div>
			<div class="rounded-lg border border-border bg-background p-3 md:col-span-2">
				<div class="text-xs text-muted">上次订阅检测</div>
				<div class="mt-1 font-medium">{formatDate(settings?.last_subscription_checked_at)}</div>
			</div>
		</div>
		<p class="text-sm text-muted">
			提醒：如果 Bot 无法发消息，通常是 Telegram UID / Chat ID 不正确，或用户还没有主动给机器人发送过任意消息。
		</p>
	</section>
</div>
