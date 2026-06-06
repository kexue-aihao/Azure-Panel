<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

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

	let users = $state<ManagedUser[]>([]);
	let loading = $state(false);
	let actionId = $state<number | null>(null);
	let message = $state('');

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

	async function loadUsers() {
		loading = true;
		message = '';
		try {
			users = await api<ManagedUser[]>('/api/admin/users');
		} catch (err) {
			message = err instanceof Error ? err.message : '加载用户失败';
		} finally {
			loading = false;
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
			message = '用户状态已更新';
		} catch (err) {
			message = err instanceof Error ? err.message : '操作失败';
		} finally {
			actionId = null;
		}
	}

	async function deleteUser(user: ManagedUser) {
		const confirmed = confirm(
			`确定删除用户 ${user.email} 吗？该用户的 Azure 账号、代理、DNS、补机策略和日志会一并删除。`
		);
		if (!confirmed) return;

		actionId = user.id;
		message = '';
		try {
			await api(`/api/admin/users/${user.id}`, { method: 'DELETE' });
			users = users.filter((item) => item.id !== user.id);
			message = '用户已删除';
		} catch (err) {
			message = err instanceof Error ? err.message : '删除失败';
		} finally {
			actionId = null;
		}
	}

	function roleBadge(role: string) {
		return role === 'admin' ? 'bg-blue-900/50 text-blue-300' : 'bg-slate-800 text-slate-300';
	}

	function statusBadge(disabled: boolean) {
		return disabled ? 'bg-red-900/50 text-red-300' : 'bg-green-900/50 text-green-300';
	}

	function formatTime(value: string) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value || '-';
		return createdAtFormatter.format(date);
	}

	onMount(() => {
		void loadUsers();
	});
</script>

<div class="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
	<div>
		<h1 class="text-2xl font-semibold">管理员后台</h1>
		<p class="mt-1 text-sm text-muted">管理所有注册用户，并查看每个用户占用的账号、代理、DNS、补机策略和日志数量。</p>
	</div>
	<button class="btn-secondary whitespace-nowrap" onclick={() => void loadUsers()} disabled={loading}>
		{loading ? '刷新中...' : '刷新用户'}
	</button>
</div>

{#if message}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted">
		{message}
	</div>
{/if}

<div class="card overflow-x-auto">
	<table class="w-full text-sm">
		<thead class="text-muted">
			<tr class="border-b border-border">
				<th class="p-3 text-left">用户</th>
				<th class="p-3 text-left">角色</th>
				<th class="p-3 text-left">状态</th>
				<th class="p-3 text-left">资源统计</th>
				<th class="p-3 text-left">注册时间 (UTC+8)</th>
				<th class="p-3 text-left">操作</th>
			</tr>
		</thead>
		<tbody>
			{#if users.length === 0}
				<tr>
					<td class="p-3 text-muted" colspan="6">{loading ? '正在加载用户...' : '暂无用户'}</td>
				</tr>
			{:else}
				{#each users as user}
					<tr class="border-b border-border/60 align-top">
						<td class="p-3">
							<div class="font-medium">{user.email}</div>
							<div class="text-xs text-muted">ID: {user.id}</div>
						</td>
						<td class="p-3">
							<span class={`badge ${roleBadge(user.role)}`}>{user.role}</span>
						</td>
						<td class="p-3">
							<span class={`badge ${statusBadge(user.disabled)}`}>
								{user.disabled ? '已禁用' : '正常'}
							</span>
						</td>
						<td class="p-3 text-xs text-muted">
							<div>Azure 账号: {user.account_count}，代理: {user.proxy_count}</div>
							<div>DNS 配置: {user.dns_config_count}，DNS 绑定: {user.dns_binding_count}</div>
							<div>补机策略: {user.workflow_count}，执行日志: {user.execution_log_count}</div>
						</td>
						<td class="p-3">{formatTime(user.created_at)}</td>
						<td class="p-3">
							<div class="flex flex-wrap gap-2">
								<button
									class="btn-secondary px-2 py-1 text-xs"
									disabled={actionId === user.id}
									onclick={() => void updateUser(user, { disabled: !user.disabled })}
								>
									{user.disabled ? '启用' : '禁用'}
								</button>
								<button
									class="btn-secondary px-2 py-1 text-xs"
									disabled={actionId === user.id}
									onclick={() =>
										void updateUser(user, { role: user.role === 'admin' ? 'user' : 'admin' })}
								>
									{user.role === 'admin' ? '降为用户' : '设为管理员'}
								</button>
								<button
									class="btn-danger px-2 py-1 text-xs"
									disabled={actionId === user.id}
									onclick={() => void deleteUser(user)}
								>
									删除
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
