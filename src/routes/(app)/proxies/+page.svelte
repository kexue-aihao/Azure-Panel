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
		managed_core: string;
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

	type ParsedShareLink = {
		supported: boolean;
		managed_supported: boolean;
		managed_core: 'sing-box' | 'xray' | '';
		protocol: string;
		name: string;
		message: string;
		proxy: {
			type: ProxyType;
			host: string;
			port: number;
			username: string;
			password: string;
			method: string;
		} | null;
		details: {
			host?: string;
			port?: number;
			security?: string;
			transport?: string;
			sni?: string;
			flow?: string;
			remark?: string;
		};
	};
	type ProxyAddResult =
		| ProxyProfile
		| {
				mode: 'api';
				raw_type: 'auto' | 'http' | 'socks5';
				total_candidates: number;
				imported: number;
				failed: number;
				errors: string[];
				proxies: ProxyProfile[];
		  };

	let proxies = $state<ProxyProfile[]>([]);
	let clientIpProxy = $state<ClientIpProxyStatus | null>(null);
	let shareLink = $state('');
	let proxyApiUrl = $state('');
	let proxyApiLimit = $state(10);
	let rawProxyType = $state<'auto' | 'socks5' | 'http'>('auto');
	let managedCore = $state<'sing-box' | 'xray'>('sing-box');
	let parsedShareLink = $state<ParsedShareLink | null>(null);
	let saving = $state(false);
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
	let isManagedShareLink = $derived(Boolean(parsedShareLink?.managed_supported && shareLink.trim()));
	let isProxyApiMode = $derived(Boolean(proxyApiUrl.trim()));
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
		if (saving) return;
		saving = true;
		try {
			const result = await api<ProxyAddResult>('/api/user/proxy/add', {
				method: 'POST',
				body: JSON.stringify({
					...form,
					share_link: shareLink,
					proxy_api_url: proxyApiUrl,
					proxy_api_limit: proxyApiLimit,
					raw_type: rawProxyType,
					managed_core: managedCore
				})
			});
			if ('mode' in result && result.mode === 'api') {
				toast = `代理 API 导入完成：成功 ${result.imported} 个，失败 ${result.failed} 个，识别 ${result.total_candidates} 条${
					result.errors.length ? `；前几条错误：${result.errors.slice(0, 3).join('；')}` : ''
				}`;
			} else {
				toast = '代理配置已添加';
			}
			shareLink = '';
			proxyApiUrl = '';
			proxyApiLimit = 10;
			rawProxyType = 'auto';
			managedCore = 'sing-box';
			parsedShareLink = null;
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
		} finally {
			saving = false;
		}
	}

	async function parseShareLink() {
		if (!shareLink.trim()) {
			parsedShareLink = null;
			toast = '请先粘贴代理分享链接';
			return;
		}

		try {
			parsedShareLink = await api<ParsedShareLink>('/api/user/proxy/parse', {
				method: 'POST',
				body: JSON.stringify({ share_link: shareLink, raw_type: rawProxyType })
			});
			toast = parsedShareLink.message;
			if (parsedShareLink.managed_core === 'sing-box' || parsedShareLink.managed_core === 'xray') {
				managedCore = parsedShareLink.managed_core;
			}
			if (parsedShareLink.supported && parsedShareLink.managed_supported) {
				form.name = form.name || parsedShareLink.name;
				form.type = 'http';
				form.source = 'fixed';
				form.host = '';
				form.port = 0;
				form.method = '';
				form.username = '';
				form.password = '';
			}
			if (parsedShareLink.supported && parsedShareLink.proxy) {
				form.name = parsedShareLink.name || form.name;
				form.type = parsedShareLink.proxy.type;
				form.source = 'fixed';
				form.host = parsedShareLink.proxy.host;
				form.port = parsedShareLink.proxy.port;
				form.method = parsedShareLink.proxy.method;
				form.username = parsedShareLink.proxy.username;
				form.password = parsedShareLink.proxy.password;
			}
		} catch (err) {
			parsedShareLink = null;
			toast = err instanceof Error ? err.message : '分享链接识别失败';
		}
	}

	function clearParsedShareLink() {
		parsedShareLink = null;
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
				VLESS/Reality 分享链接可由内置 sing-box/Xray 核心托管并转换为本机 HTTP 代理端口。
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

		<div class="space-y-2 rounded-lg border border-border bg-background p-3">
			<label class="text-sm text-muted" for="share-link">代理分享链接（可选）</label>
			<textarea
				id="share-link"
				class="input min-h-24 font-mono text-xs"
				bind:value={shareLink}
				oninput={clearParsedShareLink}
				placeholder="支持 http://、socks5://、ss://。VLESS/Reality 可由内置 sing-box/Xray 转换为本地 HTTP 代理端口。"
			></textarea>
			<div class="grid gap-2 sm:grid-cols-[160px_1fr]">
				<select class="input" bind:value={rawProxyType} onchange={clearParsedShareLink}>
					<option value="auto">自动识别 http/socks5</option>
					<option value="socks5">裸格式按 socks5</option>
					<option value="http">裸格式按 http</option>
				</select>
				<div class="text-xs text-muted">
					支持 us.miyaip.online:1111:用户名:密码 这种 host:port:user:pass 格式；字符串本身不带协议时用左侧选择决定。
				</div>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<button class="btn-secondary" type="button" onclick={() => void parseShareLink()}>
					识别并填入
				</button>
				{#if parsedShareLink}
					<span class={parsedShareLink.supported ? 'text-sm text-emerald-300' : 'text-sm text-yellow-300'}>
						{parsedShareLink.protocol.toUpperCase()} / {parsedShareLink.managed_supported
							? '内置核心托管'
							: parsedShareLink.supported
								? '可直接保存'
								: '暂不支持'}
					</span>
				{/if}
			</div>
			{#if parsedShareLink?.managed_supported}
				<div class="grid gap-2 sm:grid-cols-[150px_1fr]">
					<select class="input" bind:value={managedCore}>
						<option value="sing-box">sing-box</option>
						<option value="xray">Xray</option>
					</select>
					<div class="text-xs text-muted">
						保存时面板会自动准备并启动所选核心，只监听 127.0.0.1，并把该节点转换成本机 HTTP 代理。
					</div>
				</div>
			{/if}
			{#if parsedShareLink}
				<div class="rounded-lg border border-border px-3 py-2 text-xs text-muted">
					<div>{parsedShareLink.message}</div>
					{#if parsedShareLink.details.host}
						<div class="mt-1 break-all">
							节点: {parsedShareLink.details.host}{parsedShareLink.details.port
								? `:${parsedShareLink.details.port}`
								: ''}
							{parsedShareLink.details.security ? ` / ${parsedShareLink.details.security}` : ''}
							{parsedShareLink.details.transport ? ` / ${parsedShareLink.details.transport}` : ''}
							{parsedShareLink.details.flow ? ` / ${parsedShareLink.details.flow}` : ''}
							{parsedShareLink.details.sni ? ` / SNI ${parsedShareLink.details.sni}` : ''}
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<div class="space-y-2 rounded-lg border border-border bg-background p-3">
			<label class="text-sm text-muted" for="proxy-api-url">代理 API 链接（可选，支持批量导入）</label>
			<textarea
				id="proxy-api-url"
				class="input min-h-20 font-mono text-xs"
				bind:value={proxyApiUrl}
				placeholder="例如 https://www.miyaip.com/api/ProxyLogic/Generate?Num=10&SessionTime=30&Server=us&Format=0&Crc=...&GenType=socks5"
			></textarea>
			<div class="grid gap-2 sm:grid-cols-[160px_140px_1fr]">
				<select class="input" bind:value={rawProxyType} onchange={clearParsedShareLink}>
					<option value="auto">自动识别 http/socks5</option>
					<option value="socks5">API 返回按 socks5</option>
					<option value="http">API 返回按 http</option>
				</select>
				<input
					class="input"
					type="number"
					min="1"
					max="100"
					bind:value={proxyApiLimit}
					placeholder="导入数量"
				/>
				<div class="text-xs text-muted">
					API 返回支持一行一个代理、JSON 数组、或嵌套字段；若链接里有 GenType=socks5/http，会自动按该协议优先识别。
				</div>
			</div>
			<p class="text-xs text-muted">
				填写代理 API 链接后点击下方提交，会自动拉取、解析、逐条验证并保存可用代理；API Key 会只保存在页面请求中，不会写入数据库。
			</p>
		</div>

		<input class="input" bind:value={form.name} placeholder="标注或批量导入前缀" required={!isProxyApiMode} />

		{#if isManagedShareLink}
			<div class="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
				<button class="btn-primary" type="submit" disabled={saving}>
					{saving ? '保存中...' : '保存托管代理'}
				</button>
				<span class="text-xs text-emerald-200">
					无需填写主机和端口，保存后会出现在右侧代理档案中。
				</span>
			</div>
		{:else if isProxyApiMode}
			<div class="flex flex-wrap items-center gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2">
				<button class="btn-primary" type="submit" disabled={saving}>
					{saving ? '导入中...' : '拉取 API 并批量导入'}
				</button>
				<span class="text-xs text-sky-100">
					无需填写主机和端口，将从 API 拉取代理后自动识别、验证并保存。
				</span>
			</div>
		{:else}
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
				placeholder={isShadowsocks || form.type === 'socks4' || form.type === 'socks4a'
					? '密码'
					: '密码（可选）'}
				required={isShadowsocks}
			/>

			<p class="text-xs text-muted">
				保存前会验证代理端口可连接。账号添加页可直接选择“当前访问网站 IP（自动识别）”。
			</p>
			<button class="btn-primary" type="submit" disabled={saving}>
				{saving ? '提交中...' : proxyApiUrl.trim() ? '拉取 API 并批量导入' : '验证并提交'}
			</button>
		{/if}
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
						<div>{clientIpProxy?.message ?? '正在识别'}</div>
						{#if clientIpProxy?.candidates?.length}
							<div class="mt-1 max-w-[360px] text-xs text-muted">
								已尝试：{clientIpProxy.candidates.map((candidate) => candidate.label).join('、')}
							</div>
						{/if}
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
								{:else if proxy.managed_core}
									<div class="text-xs text-muted">{proxy.managed_core} 本机托管</div>
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
