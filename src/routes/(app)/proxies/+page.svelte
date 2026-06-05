<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type ProxyType = 'http' | 'https' | 'socks4' | 'socks4a' | 'socks5' | 'shadowsocks';
	type ProxySource = 'fixed' | 'client_ip';

	type ProxyProfile = {
		id: number;
		name: string;
		type: ProxyType;
		source: ProxySource;
		host: string;
		port: number;
		auth_enabled: boolean;
		label: string;
		method: string;
	};

	type ClientIpProxyStatus = {
		client_ip: string;
		available: boolean;
		message: string;
		profile: ProxyProfile | null;
		candidates: {
			type: string;
			port: number;
			label: string;
			available: boolean;
			error: string;
		}[];
	};

	let proxies = $state<ProxyProfile[]>([]);
	let clientIpProxy = $state<ClientIpProxyStatus | null>(null);
	let form = $state({
		name: '',
		type: 'http' as ProxyType,
		source: 'fixed' as ProxySource,
		host: '',
		port: 0,
		method: '',
		username: '',
		password: ''
	});
	let toast = $state('');

	const typeLabels: Record<ProxyType, string> = {
		http: 'http',
		https: 'https',
		socks4: 'socks4',
		socks4a: 'socks4a',
		socks5: 'socks5',
		shadowsocks: 'shadowsocks'
	};
	const shadowMethods = [
		'aes-128-gcm',
		'aes-192-gcm',
		'aes-256-gcm',
		'chacha20-ietf-poly1305'
	];

	let requiresUsername = $derived(form.type === 'http' || form.type === 'https' || form.type === 'socks5');
	let isShadowsocks = $derived(form.type === 'shadowsocks');
	let customProxies = $derived(proxies.filter((proxy) => proxy.source === 'fixed'));

	async function load() {
		const [proxyList, detected] = await Promise.all([
			api<ProxyProfile[]>('/api/user/proxy/list'),
			api<ClientIpProxyStatus>('/api/user/proxy/client-ip')
		]);
		proxies = proxyList;
		clientIpProxy = detected;
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
				source: 'fixed',
				host: '',
				port: 0,
				method: '',
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
		form.source = 'fixed';
		form.host = '127.0.0.1';
		form.port = port;
		form.method = '';
		form.username = '';
		form.password = '';
	}

	function changeType() {
		if (isShadowsocks) {
			form.method ||= shadowMethods[0];
			form.username = '';
			if (!form.port) form.port = 8388;
		} else {
			form.method = '';
			if ((form.type === 'socks4' || form.type === 'socks4a') && form.username) form.username = '';
			if (!form.port) form.port = form.type === 'https' ? 443 : form.type === 'http' ? 80 : 1080;
		}
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
				这里配置的是固定自托管代理，例如本机 Clash/V2rayN 或远程 HTTP/SOCKS 代理。
				当前访问网站 IP 会由系统自动识别，不需要在这里额外添加。
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

		<input class="input" bind:value={form.name} placeholder="标注" required />

		<div class={isShadowsocks ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-3'}>
			<select class="input" bind:value={form.type} onchange={changeType}>
				<option value="http">http</option>
				<option value="https">https</option>
				<option value="socks5">socks5</option>
				<option value="socks4a">socks4a</option>
				<option value="socks4">socks4</option>
				<option value="shadowsocks">shadowsocks</option>
			</select>
			{#if isShadowsocks}
				<select class="input" bind:value={form.method} required>
					<option value="">方法</option>
					{#each shadowMethods as method}
						<option value={method}>{method}</option>
					{/each}
				</select>
			{/if}
		</div>

		<div class="grid gap-3 sm:grid-cols-[1fr_130px]">
			<input
				class="input"
				bind:value={form.host}
				placeholder="主机名，例如 127.0.0.1"
				required
			/>
			<input
				class="input"
				bind:value={form.port}
				min="1"
				max="65535"
				type="number"
				placeholder="端口"
				required
			/>
		</div>

		{#if requiresUsername}
			<input class="input" bind:value={form.username} placeholder="用户名" />
		{/if}
		<input
			class="input"
			bind:value={form.password}
			type="password"
			placeholder={isShadowsocks || form.type === 'socks4' || form.type === 'socks4a' ? '密码' : '密码（可选）'}
			required={isShadowsocks}
		/>

		<p class="text-xs text-muted">
			保存前会验证代理端口可连接。账号添加页可直接选择“当前访问网站 IP（自动识别）”。
		</p>
		<button class="btn-primary" type="submit">验证并提交</button>
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
					<td class="p-3 text-muted">服务器源站 IP</td>
					<td class="p-3 text-muted">-</td>
					<td class="p-3 text-muted">-</td>
					<td class="p-3 text-muted">默认可选</td>
				</tr>
				<tr class="border-b border-border/60">
					<td class="p-3 font-medium">当前访问网站 IP</td>
					<td class="p-3 text-muted">AUTO</td>
					<td class="p-3 text-muted">{clientIpProxy?.client_ip || '识别中'}</td>
					<td class="p-3 text-muted">
						{clientIpProxy?.profile ? clientIpProxy.profile.port : '自动探测'}
					</td>
					<td class="p-3 text-muted">无</td>
					<td class="p-3 {clientIpProxy?.available ? 'text-emerald-300' : 'text-muted'}">
						{clientIpProxy?.message ?? '正在识别'}
					</td>
				</tr>
				{#if customProxies.length === 0}
					<tr>
						<td class="p-3 text-muted" colspan="6">还没有自定义代理配置</td>
					</tr>
				{:else}
					{#each customProxies as proxy}
						<tr class="border-b border-border/60">
							<td class="p-3">
								<div class="font-medium">{proxy.name}</div>
								<div class="text-xs text-muted">{proxy.label}</div>
							</td>
							<td class="p-3">{typeLabels[proxy.type]}</td>
							<td class="p-3">
								<div>{proxy.host}</div>
								{#if proxy.source === 'client_ip'}
									<div class="text-xs text-muted">请求时动态解析</div>
								{/if}
							</td>
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
