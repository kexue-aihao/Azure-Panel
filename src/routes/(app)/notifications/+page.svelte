<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type TelegramSettings = {
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
		last_subscription_checked_at: string | null;
		created_at: string;
	} | null;

	type DiscoveredChat = {
		chat_id: string;
		title: string;
		type: string;
		username: string;
	};

	let settings = $state<TelegramSettings>(null);
	let loading = $state(false);
	let testing = $state(false);
	let syncingGroups = $state(false);
	let toast = $state('');
	let discoveredChats = $state<DiscoveredChat[]>([]);
	let form = $state({
		enabled: false,
		bot_token: '',
		telegram_chat_id: '',
		telegram_group_chat_ids: '',
		subscription_check_interval_hours: ''
	});

	function fillForm(data: TelegramSettings) {
		form = {
			enabled: data?.enabled ?? false,
			bot_token: '',
			telegram_chat_id: data?.telegram_chat_id ?? '',
			telegram_group_chat_ids: data?.telegram_group_chat_ids ?? '',
			subscription_check_interval_hours: data?.subscription_check_interval_hours
				? String(data.subscription_check_interval_hours)
				: ''
		};
	}

	function formatDate(value: string | null | undefined) {
		return value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-';
	}

	function targetCount() {
		return (form.telegram_chat_id.trim() ? 1 : 0) + splitChatIds(form.telegram_group_chat_ids).length;
	}

	function splitChatIds(value: string) {
		return [
			...new Set(
				value
					.split(/[\s,;，；]+/)
					.map((item) => item.trim())
					.filter(Boolean)
			)
		];
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
					telegram_group_chat_ids: form.telegram_group_chat_ids,
					subscription_check_interval_hours: form.subscription_check_interval_hours
				})
			});
			fillForm(settings);
			toast = `Telegram 通知配置已保存，当前通知目标 ${targetCount()} 个`;
		} catch (err) {
			toast = err instanceof Error ? err.message : 'Telegram 通知配置保存失败';
		} finally {
			loading = false;
		}
	}

	async function syncGroups() {
		syncingGroups = true;
		try {
			const result = await api<{ chats: DiscoveredChat[]; settings: TelegramSettings }>(
				'/api/user/telegram/groups',
				{
					method: 'POST',
					body: JSON.stringify({ bot_token: form.bot_token })
				}
			);
			discoveredChats = result.chats ?? [];
			settings = result.settings;
			fillForm(settings);
			toast = discoveredChats.length
				? `已同步 ${discoveredChats.length} 个群组/频道 Chat ID`
				: '暂未识别到群组，请在目标群里发送一条消息或重新把机器人加入群后再同步';
		} catch (err) {
			toast = err instanceof Error ? err.message : '同步群组失败';
		} finally {
			syncingGroups = false;
		}
	}

	async function testSend() {
		testing = true;
		try {
			const result = await api<{ sent: number; failed: number }>('/api/user/telegram/test', {
				method: 'POST'
			});
			toast = `测试消息已发送：成功 ${result.sent ?? 0} 个目标，失败 ${result.failed ?? 0} 个目标`;
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
				支持同时通知个人 UID / Chat ID 和已添加机器人的群组。账号、订阅和 IP 会在消息里自动打码。
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
			<label class="mb-1 block text-xs text-muted" for="telegram-chat-id">个人 Telegram UID / Chat ID</label>
			<input
				id="telegram-chat-id"
				class="input"
				bind:value={form.telegram_chat_id}
				placeholder="例如 6034235722，可留空只通知群组"
			/>
		</div>

		<div>
			<div class="mb-1 flex items-center justify-between gap-3">
				<label class="block text-xs text-muted" for="telegram-group-chat-ids">群组 / 频道 Chat ID</label>
				<button
					class="btn-secondary px-2 py-1 text-xs"
					type="button"
					onclick={() => void syncGroups()}
					disabled={syncingGroups || (!form.bot_token && !settings?.bot_token_configured)}
				>
					{syncingGroups ? '同步中...' : '从 Bot 更新里同步群组'}
				</button>
			</div>
			<textarea
				id="telegram-group-chat-ids"
				class="input min-h-28 font-mono text-xs"
				bind:value={form.telegram_group_chat_ids}
				placeholder={`每行一个群组 Chat ID，例如：\n-1001234567890\n-987654321`}
			></textarea>
			<p class="mt-1 text-xs text-muted">
				群组 Chat ID 通常是负数。若自动同步为空，请先在群里发送一条消息或重新把机器人加入群，再点同步。
			</p>
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
				{testing ? '发送中...' : '发送测试消息到全部目标'}
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
				<div class="text-xs text-muted">个人目标</div>
				<div class="mt-1 font-medium">{settings?.telegram_chat_id_masked || '-'}</div>
			</div>
			<div class="rounded-lg border border-border bg-background p-3">
				<div class="text-xs text-muted">群组目标数</div>
				<div class="mt-1 font-medium">{settings?.telegram_group_chat_id_list.length ?? 0} 个</div>
			</div>
			<div class="rounded-lg border border-border bg-background p-3 md:col-span-2">
				<div class="text-xs text-muted">上次订阅检测</div>
				<div class="mt-1 font-medium">{formatDate(settings?.last_subscription_checked_at)}</div>
			</div>
		</div>

		{#if settings?.telegram_group_chat_id_masked_list.length}
			<div>
				<h3 class="mb-2 text-sm font-medium">已保存群组 Chat ID</h3>
				<div class="flex flex-wrap gap-2 text-xs">
					{#each settings.telegram_group_chat_id_masked_list as chatId}
						<span class="rounded bg-border px-2 py-1">{chatId}</span>
					{/each}
				</div>
			</div>
		{/if}

		{#if discoveredChats.length}
			<div>
				<h3 class="mb-2 text-sm font-medium">本次同步识别到的群组</h3>
				<div class="space-y-2">
					{#each discoveredChats as chat}
						<div class="rounded-lg border border-border bg-background p-3 text-xs">
							<div class="font-medium">{chat.title}</div>
							<div class="mt-1 text-muted">{chat.type} / {chat.chat_id}</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<p class="text-sm text-muted">
			如果个人能收到但群收不到，通常是群组 Chat ID 未配置、机器人在群里没有发言权限，或群里还没有产生 Bot 可读取的 update。
		</p>
	</section>
</div>
