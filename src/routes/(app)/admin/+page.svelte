<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import { createTranslator, normalizeLanguage, type LanguageCode } from '$lib/i18n';

	type ManagedUser = {
		id: number;
		email: string;
		role: string;
		disabled: boolean;
		created_at: string;
		account_count: number;
		proxy_count: number;
		dns_config_count: number;
		dns_binding_count: number;
		workflow_count: number;
		execution_log_count: number;
	};

	type UserDetail = {
		user: {
			id: number;
			email: string;
			role: string;
			disabled: boolean;
			totp_enabled: boolean;
			created_at: string;
		};
		summary: Record<string, number>;
		accounts: Array<Record<string, unknown>>;
		proxies: Array<Record<string, unknown>>;
		dns_configs: Array<Record<string, unknown>>;
		dns_bindings: Array<Record<string, unknown>>;
		workflows: Array<Record<string, unknown>>;
		notification_settings: Record<string, unknown> | null;
		subscription_states: Array<Record<string, unknown>>;
		recent_logs: Array<Record<string, unknown>>;
	};

	let users = $state<ManagedUser[]>([]);
	let selectedIds = $state<number[]>([]);
	let loading = $state(false);
	let creating = $state(false);
	let deletingBatch = $state(false);
	let detailLoading = $state(false);
	let actionId = $state<number | null>(null);
	let currentUserId = $state(0);
	let message = $state('');
	let detail = $state<UserDetail | null>(null);
	let language = $state<LanguageCode>('zh');
	let t = $derived(createTranslator(language));
	let createForm = $state({
		email: '',
		password: '',
		role: 'user',
		disabled: false
	});

	const selectedCount = $derived(selectedIds.length);

	const createdAtFormatter = new Intl.DateTimeFormat('zh-CN', {
		timeZone: 'Asia/Shanghai',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});

	function syncLanguage() {
		language = normalizeLanguage(localStorage.getItem('language'));
	}

	function loadCurrentUserId() {
		try {
			const user = JSON.parse(localStorage.getItem('user') ?? '{}') as { id?: unknown };
			currentUserId = Number(user.id ?? 0);
		} catch {
			currentUserId = 0;
		}
	}

	async function loadUsers() {
		loading = true;
		message = '';
		try {
			users = await api<ManagedUser[]>('/api/admin/users');
			selectedIds = selectedIds.filter((id) => users.some((user) => user.id === id && user.id !== currentUserId));
		} catch (err) {
			message = err instanceof Error ? err.message : t('admin.load_failed');
		} finally {
			loading = false;
		}
	}

	async function createUser() {
		creating = true;
		message = '';
		try {
			await api('/api/admin/users', {
				method: 'POST',
				body: JSON.stringify(createForm)
			});
			createForm = { email: '', password: '', role: 'user', disabled: false };
			message = t('admin.create_success');
			await loadUsers();
		} catch (err) {
			message = err instanceof Error ? err.message : t('admin.create_failed');
		} finally {
			creating = false;
		}
	}

	async function updateUser(user: ManagedUser, payload: Record<string, unknown>) {
		actionId = user.id;
		message = '';
		try {
			await api(`/api/admin/users/${user.id}`, {
				method: 'PUT',
				body: JSON.stringify(payload)
			});
			await loadUsers();
			message = t('admin.update_success');
		} catch (err) {
			message = err instanceof Error ? err.message : t('admin.action_failed');
		} finally {
			actionId = null;
		}
	}

	async function deleteUser(user: ManagedUser) {
		const confirmed = confirm(t('admin.delete_confirm').replace('{email}', user.email));
		if (!confirmed) return;

		actionId = user.id;
		message = '';
		try {
			await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
			users = users.filter((item) => item.id !== user.id);
			selectedIds = selectedIds.filter((id) => id !== user.id);
			message = t('admin.delete_success');
		} catch (err) {
			message = err instanceof Error ? err.message : t('admin.delete_failed');
		} finally {
			actionId = null;
		}
	}

	async function batchDeleteUsers() {
		if (selectedIds.length === 0) return;
		const confirmed = confirm(t('admin.batch_delete_confirm').replace('{count}', String(selectedIds.length)));
		if (!confirmed) return;

		deletingBatch = true;
		message = '';
		try {
			const result = await api<{ deleted_count: number }>('/api/admin/users', {
				method: 'DELETE',
				body: JSON.stringify({ ids: selectedIds })
			});
			message = t('admin.batch_delete_success').replace('{count}', String(result.deleted_count ?? selectedIds.length));
			selectedIds = [];
			await loadUsers();
		} catch (err) {
			message = err instanceof Error ? err.message : t('admin.batch_delete_failed');
		} finally {
			deletingBatch = false;
		}
	}

	async function loadUserDetail(user: ManagedUser) {
		if (user.role === 'admin') {
			message = t('admin.detail_admin_blocked');
			return;
		}
		detailLoading = true;
		detail = null;
		message = '';
		try {
			detail = await api<UserDetail>(`/api/admin/users/${user.id}`);
		} catch (err) {
			message = err instanceof Error ? err.message : t('admin.detail_failed');
		} finally {
			detailLoading = false;
		}
	}

	function toggleSelected(user: ManagedUser) {
		if (user.id === currentUserId) return;
		selectedIds = selectedIds.includes(user.id)
			? selectedIds.filter((id) => id !== user.id)
			: [...selectedIds, user.id];
	}

	function selectableUsers() {
		return users.filter((user) => user.id !== currentUserId);
	}

	function allSelected() {
		const ids = selectableUsers().map((user) => user.id);
		return ids.length > 0 && ids.every((id) => selectedIds.includes(id));
	}

	function toggleAll() {
		const ids = selectableUsers().map((user) => user.id);
		selectedIds = allSelected() ? [] : ids;
	}

	function roleBadge(role: string) {
		return role === 'admin' ? 'bg-blue-900/50 text-blue-300' : 'bg-slate-800 text-slate-300';
	}

	function statusBadge(disabled: boolean) {
		return disabled ? 'bg-red-900/50 text-red-300' : 'bg-green-900/50 text-green-300';
	}

	function formatTime(value: string | null | undefined) {
		const date = new Date(value ?? '');
		if (Number.isNaN(date.getTime())) return value || '-';
		return createdAtFormatter.format(date);
	}

	function detailJson(value: unknown) {
		return JSON.stringify(value, null, 2);
	}

	onMount(() => {
		syncLanguage();
		loadCurrentUserId();
		void loadUsers();
		const onLanguage = () => syncLanguage();
		window.addEventListener('azure-panel-language-change', onLanguage);
		return () => window.removeEventListener('azure-panel-language-change', onLanguage);
	});
</script>

<div class="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
	<div>
		<h1 class="text-2xl font-semibold">{t('admin.title')}</h1>
		<p class="mt-1 text-sm text-muted">{t('admin.subtitle')}</p>
	</div>
	<div class="flex flex-wrap gap-2">
		<button class="btn-secondary whitespace-nowrap" onclick={() => void loadUsers()} disabled={loading}>
			{loading ? t('admin.refreshing') : t('admin.refresh')}
		</button>
		<button class="btn-danger whitespace-nowrap" onclick={() => void batchDeleteUsers()} disabled={deletingBatch || selectedCount === 0}>
			{t('admin.batch_delete')} ({selectedCount})
		</button>
	</div>
</div>

{#if message}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted">
		{message}
	</div>
{/if}

<form
	class="card mb-4 grid gap-3 p-5 lg:grid-cols-5"
	onsubmit={(event) => {
		event.preventDefault();
		void createUser();
	}}
>
	<div class="lg:col-span-5">
		<h2 class="text-lg font-medium">{t('admin.create_user')}</h2>
		<p class="mt-1 text-xs text-muted">{t('admin.create_hint')}</p>
	</div>
	<input class="input" bind:value={createForm.email} type="email" placeholder={t('admin.email')} required />
	<input class="input" bind:value={createForm.password} type="password" placeholder={t('admin.password')} required minlength="6" />
	<select class="input" bind:value={createForm.role}>
		<option value="user">{t('admin.role_user')}</option>
		<option value="admin">{t('admin.role_admin')}</option>
	</select>
	<label class="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted">
		<input type="checkbox" bind:checked={createForm.disabled} />
		{t('admin.create_disabled')}
	</label>
	<button class="btn-primary" type="submit" disabled={creating}>
		{creating ? t('admin.creating') : t('admin.create')}
	</button>
</form>

<div class="card overflow-x-auto">
	<table class="w-full text-sm">
		<thead class="text-muted">
			<tr class="border-b border-border">
				<th class="w-10 p-3 text-left">
					<input type="checkbox" checked={allSelected()} onchange={toggleAll} aria-label={t('admin.select_all')} />
				</th>
				<th class="p-3 text-left">{t('admin.user')}</th>
				<th class="p-3 text-left">{t('admin.role')}</th>
				<th class="p-3 text-left">{t('admin.status')}</th>
				<th class="p-3 text-left">{t('admin.resource_stats')}</th>
				<th class="p-3 text-left">{t('admin.created_at')}</th>
				<th class="p-3 text-left">{t('admin.actions')}</th>
			</tr>
		</thead>
		<tbody>
			{#if users.length === 0}
				<tr>
					<td class="p-3 text-muted" colspan="7">{loading ? t('admin.loading') : t('admin.empty')}</td>
				</tr>
			{:else}
				{#each users as user}
					<tr class="border-b border-border/60 align-top">
						<td class="p-3">
							<input
								type="checkbox"
								checked={selectedIds.includes(user.id)}
								disabled={user.id === currentUserId}
								onchange={() => toggleSelected(user)}
								aria-label={t('admin.select_user').replace('{email}', user.email)}
							/>
						</td>
						<td class="p-3">
							<div class="font-medium">{user.email}</div>
							<div class="text-xs text-muted">ID: {user.id}</div>
						</td>
						<td class="p-3">
							<span class={`badge ${roleBadge(user.role)}`}>{user.role}</span>
						</td>
						<td class="p-3">
							<span class={`badge ${statusBadge(user.disabled)}`}>
								{user.disabled ? t('admin.disabled') : t('admin.enabled')}
							</span>
						</td>
						<td class="p-3 text-xs text-muted">
							<div>{t('admin.stats_accounts')}: {user.account_count}，{t('admin.stats_proxies')}: {user.proxy_count}</div>
							<div>{t('admin.stats_dns_configs')}: {user.dns_config_count}，{t('admin.stats_dns_bindings')}: {user.dns_binding_count}</div>
							<div>{t('admin.stats_workflows')}: {user.workflow_count}，{t('admin.stats_logs')}: {user.execution_log_count}</div>
						</td>
						<td class="p-3">{formatTime(user.created_at)}</td>
						<td class="p-3">
							<div class="flex flex-wrap gap-2">
								<button
									class="btn-secondary px-2 py-1 text-xs"
									disabled={actionId === user.id}
									onclick={() => void updateUser(user, { disabled: !user.disabled })}
								>
									{user.disabled ? t('admin.enable') : t('admin.disable')}
								</button>
								<button
									class="btn-secondary px-2 py-1 text-xs"
									disabled={actionId === user.id}
									onclick={() =>
										void updateUser(user, { role: user.role === 'admin' ? 'user' : 'admin' })}
								>
									{user.role === 'admin' ? t('admin.demote') : t('admin.promote')}
								</button>
								<button
									class="btn-secondary px-2 py-1 text-xs"
									disabled={detailLoading || user.role === 'admin'}
									onclick={() => void loadUserDetail(user)}
								>
									{t('admin.view_detail')}
								</button>
								<button
									class="btn-danger px-2 py-1 text-xs"
									disabled={actionId === user.id || user.id === currentUserId}
									onclick={() => void deleteUser(user)}
								>
									{t('admin.delete')}
								</button>
							</div>
							{#if actionId === user.id}
								<div class="progress-track running mt-3">
									<div class="progress-fill bg-primary" style="width: 70%"></div>
								</div>
							{/if}
						</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>

{#if detail || detailLoading}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
		<div class="max-h-[86vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
			<div class="flex items-start justify-between gap-3 border-b border-border p-4">
				<div>
					<h2 class="text-xl font-semibold">{t('admin.detail_title')}</h2>
					<p class="mt-1 text-xs text-muted">{detail?.user.email || t('admin.detail_loading')}</p>
				</div>
				<button class="btn-secondary px-3 py-1 text-xs" onclick={() => (detail = null)}>{t('admin.close')}</button>
			</div>
			<div class="max-h-[72vh] space-y-4 overflow-y-auto p-4">
				{#if detailLoading}
					<div class="progress-track running">
						<div class="progress-fill bg-primary" style="width: 55%"></div>
					</div>
				{:else if detail}
					<div class="grid gap-3 md:grid-cols-3">
						<div class="rounded-lg border border-border bg-background/50 p-3">
							<div class="text-xs text-muted">{t('admin.detail_accounts')}</div>
							<div class="mt-1 text-2xl font-semibold">{detail.summary.account_count}</div>
						</div>
						<div class="rounded-lg border border-border bg-background/50 p-3">
							<div class="text-xs text-muted">{t('admin.detail_workflows')}</div>
							<div class="mt-1 text-2xl font-semibold">{detail.summary.workflow_count}</div>
						</div>
						<div class="rounded-lg border border-border bg-background/50 p-3">
							<div class="text-xs text-muted">{t('admin.detail_logs')}</div>
							<div class="mt-1 text-2xl font-semibold">{detail.summary.recent_log_count}</div>
						</div>
					</div>

					<section class="rounded-lg border border-border bg-background/50 p-3">
						<h3 class="font-medium">{t('admin.detail_user')}</h3>
						<div class="mt-2 grid gap-2 text-sm md:grid-cols-2">
							<div>Email: {detail.user.email}</div>
							<div>ID: {detail.user.id}</div>
							<div>{t('admin.status')}: {detail.user.disabled ? t('admin.disabled') : t('admin.enabled')}</div>
							<div>2FA: {detail.user.totp_enabled ? t('admin.enabled') : t('admin.disabled')}</div>
							<div>{t('admin.created_at')}: {formatTime(detail.user.created_at)}</div>
						</div>
					</section>

					<section class="rounded-lg border border-border bg-background/50 p-3">
						<h3 class="font-medium">{t('admin.detail_json')}</h3>
						<p class="mt-1 text-xs text-muted">{t('admin.detail_json_hint')}</p>
						<pre class="mt-3 max-h-[360px] overflow-auto rounded-lg bg-black/30 p-3 text-xs text-slate-200">{detailJson(detail)}</pre>
					</section>
				{/if}
			</div>
		</div>
	</div>
{/if}
