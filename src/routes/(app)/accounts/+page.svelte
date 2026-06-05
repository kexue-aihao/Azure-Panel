<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Account = {
		id: number;
		name: string;
		tenant_id: string;
		client_id: string;
		subscription_id: string;
		proxy_enabled: boolean;
		proxy_label: string;
		remark: string;
	};

	let accounts = $state<Account[]>([]);
	let form = $state({
		name: '',
		tenant_id: '',
		client_id: '',
		client_secret: '',
		subscription_id: '',
		proxy_url: '',
		remark: ''
	});
	let toast = $state('');

	async function load() {
		accounts = await api<Account[]>('/api/user/azure/account/list');
	}

	async function submit(e: Event) {
		e.preventDefault();
		try {
			await api('/api/user/azure/account/add', {
				method: 'POST',
				body: JSON.stringify(form)
			});
			toast = '账号添加成功';
			form = {
				name: '',
				tenant_id: '',
				client_id: '',
				client_secret: '',
				subscription_id: '',
				proxy_url: '',
				remark: ''
			};
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '添加失败';
		}
	}

	async function remove(id: number) {
		if (!confirm('确认删除这个账号吗？')) return;
		try {
			await api(`/api/user/azure/account/delete?account_id=${id}`, { method: 'DELETE' });
			toast = '已删除';
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '删除失败';
		}
	}

	onMount(() => {
		void load();
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">Azure 账号</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="grid gap-6 lg:grid-cols-2">
	<form class="card space-y-3 p-5" onsubmit={submit}>
		<h2 class="text-lg font-medium">添加 Service Principal</h2>
		<p class="text-sm text-muted">
			默认由部署本网站的服务器直接请求 Azure API，Azure 侧看到的是服务器源站出站 IP。
			填写代理后，此账号的验证、VM 查询、开关机和自动补机会走代理出口 IP。
		</p>
		<input class="input" bind:value={form.name} placeholder="账号名称" required />
		<input class="input" bind:value={form.tenant_id} placeholder="Tenant ID" required />
		<input class="input" bind:value={form.client_id} placeholder="Client ID" required />
		<input
			class="input"
			bind:value={form.client_secret}
			type="password"
			placeholder="Client Secret"
			required
		/>
		<input class="input" bind:value={form.subscription_id} placeholder="Subscription ID" required />
		<input
			class="input"
			bind:value={form.proxy_url}
			placeholder="自托管代理（可选）：http://user:pass@host:port"
		/>
		<p class="text-xs text-muted">支持 HTTP/HTTPS 代理；如需认证，可把用户名密码写在代理 URL 中。</p>
		<input class="input" bind:value={form.remark} placeholder="备注（可选）" />
		<button class="btn-primary" type="submit">保存账号</button>
	</form>

	<div class="card space-y-3 p-5">
		<h2 class="text-lg font-medium">已添加账号</h2>
		{#if accounts.length === 0}
			<p class="text-sm text-muted">还没有账号</p>
		{:else}
			{#each accounts as account}
				<div class="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
					<div>
						<div class="font-medium">{account.name}</div>
						<div class="mt-1 text-xs text-muted">订阅: {account.subscription_id}</div>
						<div class="text-xs text-muted">租户: {account.tenant_id}</div>
						<div class="text-xs text-muted">
							出站: {account.proxy_enabled ? `代理 ${account.proxy_label}` : '服务器源站 IP'}
						</div>
					</div>
					<button class="btn-danger" onclick={() => void remove(account.id)}>删除</button>
				</div>
			{/each}
		{/if}
	</div>
</div>
