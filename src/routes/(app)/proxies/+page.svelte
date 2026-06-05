<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type ProxyType = 'http' | 'https' | 'socks4' | 'socks5';

	type ProxyProfile = {
		id: number;
		name: string;
		type: ProxyType;
		host: string;
		port: number;
		auth_enabled: boolean;
		label: string;
	};

	let proxies = $state<ProxyProfile[]>([]);
	let form = $state({
		name: 'Clash Verge',
		type: 'http' as ProxyType,
		host: '127.0.0.1',
		port: 7890,
		username: '',
		password: ''
	});
	let toast = $state('');

	const typeLabels: Record<ProxyType, string> = {
		http: 'HTTP',
		https: 'HTTPS',
		socks4: 'SOCKS4',
		socks5: 'SOCKS5'
	};

	async function load() {
		proxies = await api<ProxyProfile[]>('/api/user/proxy/list');
	}

	async function submit(e: Event) {
		e.preventDefault();
		try {
			await api('/api/user/proxy/add', {
				method: 'POST',
				body: JSON.stringify(form)
			});
			toast = '代理配置已添加';
			form = {
				name: '',
				type: 'http',
				host: '127.0.0.1',
				port: 7890,
				username: '',
				password: ''
			};
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '添加失败';
		}
	}

	async function remove(id: number) {
		if (!confirm('确认删除这个代理配置吗？使用它的 Azure 账号会改回不使用代理。')) return;
		try {
			await api(`/api/user/proxy/delete?proxy_id=${id}`, { method: 'DELETE' });
			toast = '代理配置已删除';
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '删除失败';
		}
	}

	function usePreset(name: string, type: ProxyType, port: number) {
		form.name = name;
		form.type = type;
		form.host = '127.0.0.1';
		form.port = port;
	}

	onMount(() => {
		void load();
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">代理配置</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="grid gap-6 lg:grid-cols-[0.95fr_1.25fr]">
	<form class="card space-y-4 p-5" onsubmit={submit}>
		<div>
			<h2 class="text-lg font-medium">添加自托管代理</h2>
			<p class="mt-1 text-sm text-muted">
				这里配置的是后端服务器访问 Azure API 的出站代理。本机代理指部署网站那台服务器的
				127.0.0.1，不是浏览器电脑的本机。
			</p>
		</div>

		<div class="grid gap-2 sm:grid-cols-3">
			<button class="btn-secondary" type="button" onclick={() => usePreset('Clash Verge', 'http', 7890)}>
				Clash Verge
			</button>
			<button class="btn-secondary" type="button" onclick={() => usePreset('Clash mi', 'http', 7890)}>
				Clash mi
			</button>
			<button class="btn-secondary" type="button" onclick={() => usePreset('V2rayN', 'socks5', 10808)}>
				V2rayN
			</button>
		</div>

		<input class="input" bind:value={form.name} placeholder="名称，例如 Clash Verge / V2rayN" required />

		<div class="grid gap-3 sm:grid-cols-3">
			<select class="input" bind:value={form.type}>
				<option value="http">HTTP</option>
				<option value="https">HTTPS</option>
				<option value="socks4">SOCKS4</option>
				<option value="socks5">SOCKS5</option>
			</select>
			<input class="input sm:col-span-2" bind:value={form.host} placeholder="主机，例如 127.0.0.1" required />
		</div>

		<input
			class="input"
			bind:value={form.port}
			min="1"
			max="65535"
			type="number"
			placeholder="端口，例如 7890"
			required
		/>

		<div class="grid gap-3 sm:grid-cols-2">
			<input class="input" bind:value={form.username} placeholder="用户名（可选）" />
			<input class="input" bind:value={form.password} type="password" placeholder="密码（可选）" />
		</div>

		<p class="text-xs text-muted">
			示例：HTTP 127.0.0.1:7890、SOCKS5 127.0.0.1:10808、HTTP proxy.example.com:8080。
		</p>
		<button class="btn-primary" type="submit">保存代理配置</button>
	</form>

	<div class="card overflow-x-auto p-5">
		<div class="mb-4">
			<h2 class="text-lg font-medium">代理档案</h2>
			<p class="mt-1 text-sm text-muted">
				Azure 账号选择“不使用代理”时，Azure 看到的是网站源站服务器的出站 IP。
				选择下面的代理档案后，验证、查询、开关机、自动补机会走代理出口。
			</p>
		</div>

		<table class="w-full text-sm">
			<thead class="text-muted">
				<tr class="border-b border-border">
					<th class="p-3 text-left">名称</th>
					<th class="p-3 text-left">类型</th>
					<th class="p-3 text-left">主机</th>
					<th class="p-3 text-left">端口</th>
					<th class="p-3 text-left">认证</th>
					<th class="p-3 text-left">操作</th>
				</tr>
			</thead>
			<tbody>
				<tr class="border-b border-border/60">
					<td class="p-3 font-medium">不使用代理</td>
					<td class="p-3 text-muted">DIRECT</td>
					<td class="p-3 text-muted">服务器源站</td>
					<td class="p-3 text-muted">-</td>
					<td class="p-3 text-muted">-</td>
					<td class="p-3 text-muted">默认可选</td>
				</tr>
				{#if proxies.length === 0}
					<tr>
						<td class="p-3 text-muted" colspan="6">还没有自定义代理配置</td>
					</tr>
				{:else}
					{#each proxies as proxy}
						<tr class="border-b border-border/60">
							<td class="p-3">
								<div class="font-medium">{proxy.name}</div>
								<div class="text-xs text-muted">{proxy.label}</div>
							</td>
							<td class="p-3">{typeLabels[proxy.type]}</td>
							<td class="p-3">{proxy.host}</td>
							<td class="p-3">{proxy.port}</td>
							<td class="p-3">{proxy.auth_enabled ? '已配置' : '无'}</td>
							<td class="p-3">
								<button class="btn-danger" onclick={() => void remove(proxy.id)}>删除</button>
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>
