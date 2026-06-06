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
	type ProxyApiCandidate = {
		name: string;
		protocol: string;
		message: string;
		proxy: {
			type: ProxyType;
			host: string;
			port: number;
			username: string;
			password: string;
			method: string;
		} | null;
	};
	type ProxyApiParseResult = {
		mode: 'api_parse';
		raw_type: 'auto' | 'http' | 'socks5';
		total_candidates: number;
		errors: string[];
		proxies: ProxyApiCandidate[];
	};
	type ProxyCheckResult = {
		proxy_id: number;
		name: string;
		status: 'available' | 'deleted' | 'failed';
		deleted: boolean;
		message: string;
		error: string;
		proxy: ProxyProfile | null;
		runtime_type: string;
		checked_at: string;
		telegram_notified: boolean;
		telegram_sent: number;
		telegram_failed: number;
		telegram_error: string;
	};

	let proxies = $state<ProxyProfile[]>([]);
	let proxyApiUrl = $state('');
	let proxyApiLimit = $state(10);
	let rawProxyType = $state<'auto' | 'socks5' | 'http'>('auto');
	let saving = $state(false);
	let apiImportProgress = $state({ done: 0, total: 0, imported: 0, failed: 0 });
	let proxyChecking = $state(false);
	let checkingProxyId = $state<number | null>(null);
	let proxyCheckProgress = $state({ done: 0, total: 0, available: 0, deleted: 0, failed: 0 });
	let proxyCheckResults = $state<ProxyCheckResult[]>([]);
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
	let isProxyApiMode = $derived(Boolean(proxyApiUrl.trim()));
	let customProxies = $derived(proxies.filter((proxy) => proxy.source === 'fixed'));

	async function load() {
		proxies = await api<ProxyProfile[]>('/api/user/proxy/list');
	}

	function resetFormAfterSave() {
		proxyApiUrl = '';
		proxyApiLimit = 10;
		rawProxyType = 'auto';
		apiImportProgress = { done: 0, total: 0, imported: 0, failed: 0 };
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
	}

	async function importProxyApiSequentially() {
		const requestedName = form.name.trim();
		const parsed = await api<ProxyApiParseResult>('/api/user/proxy/api/parse', {
			method: 'POST',
			body: JSON.stringify({
				proxy_api_url: proxyApiUrl,
				proxy_api_limit: proxyApiLimit,
				raw_type: rawProxyType
			})
		});
		const importLimit = Math.min(100, Math.max(1, Number(proxyApiLimit) || 10));
		const candidates = parsed.proxies.filter((item) => item.proxy).slice(0, importLimit);
		const errors = [...parsed.errors];
		let imported = 0;
		apiImportProgress = { done: 0, total: candidates.length, imported, failed: errors.length };

		if (candidates.length === 0) {
			throw new Error(
				`代理 API 未解析到可导入代理。已识别 ${parsed.total_candidates} 条${
					errors.length ? `，错误：${errors.slice(0, 3).join('；')}` : ''
				}`
			);
		}

		for (const candidate of candidates) {
			try {
				const proxy = candidate.proxy;
				if (!proxy) throw new Error('代理内容为空');
				const saved = await api<ProxyProfile>('/api/user/proxy/add', {
					method: 'POST',
					body: JSON.stringify({
						name: requestedName ? `${requestedName}-${imported + 1}` : candidate.name || `API代理-${imported + 1}`,
						type: proxy.type,
						host: proxy.host,
						port: proxy.port,
						username: proxy.username,
						password: proxy.password,
						method: proxy.method,
						raw_type: candidate.protocol || rawProxyType,
						auto_detect_protocol: candidate.protocol === 'auto'
					})
				});
				imported += 1;
				proxies = [saved, ...proxies];
			} catch (err) {
				errors.push(
					`${candidate.name || candidate.proxy?.host || 'API代理'}: ${
						err instanceof Error ? err.message : String(err)
					}`
				);
			}
			apiImportProgress = {
				done: apiImportProgress.done + 1,
				total: candidates.length,
				imported,
				failed: errors.length
			};
			toast = `正在单线程导入代理 ${apiImportProgress.done}/${candidates.length}，成功 ${imported} 个，失败 ${errors.length} 个`;
		}

		if (imported === 0) {
			throw new Error(
				`代理 API 未导入任何可用代理。已识别 ${parsed.total_candidates} 条，错误：${
					errors.slice(0, 5).join('；') || '没有可解析的代理'
				}`
			);
		}

		toast = `代理 API 单线程导入完成：成功 ${imported} 个，失败 ${errors.length} 个，识别 ${parsed.total_candidates} 条${
			errors.length ? `；前几条错误：${errors.slice(0, 3).join('；')}` : ''
		}`;
	}

	async function submit(e: Event) {
		e.preventDefault();
		if (saving) return;
		saving = true;
		try {
			if (isProxyApiMode) {
				await importProxyApiSequentially();
				resetFormAfterSave();
				await load();
				return;
			}

			const result = await api<ProxyAddResult>('/api/user/proxy/add', {
				method: 'POST',
				body: JSON.stringify({
					...form,
					proxy_api_url: proxyApiUrl,
					proxy_api_limit: proxyApiLimit,
					raw_type: rawProxyType
				})
			});
			if ('mode' in result && result.mode === 'api') {
				toast = `代理 API 导入完成：成功 ${result.imported} 个，失败 ${result.failed} 个，识别 ${result.total_candidates} 条${
					result.errors.length ? `；前几条错误：${result.errors.slice(0, 3).join('；')}` : ''
				}`;
			} else {
				toast = '代理配置已添加';
			}
			resetFormAfterSave();
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '添加失败';
		} finally {
			saving = false;
			if (!proxyApiUrl.trim()) apiImportProgress = { done: 0, total: 0, imported: 0, failed: 0 };
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

	function proxyNotifyText(result: ProxyCheckResult) {
		if (result.telegram_notified) {
			return `；已通知 ${result.telegram_sent} 个 Telegram 目标${
				result.telegram_failed ? `，失败 ${result.telegram_failed} 个` : ''
			}`;
		}
		return result.telegram_error ? `；Telegram 未通知：${result.telegram_error}` : '';
	}

	async function checkProxyProfile(proxy: ProxyProfile, options: { notify?: boolean } = {}) {
		const result = await api<ProxyCheckResult>('/api/user/proxy/check', {
			method: 'POST',
			body: JSON.stringify({
				proxy_id: proxy.id,
				notify: options.notify !== false,
				silent: options.notify === false
			})
		});
		if (result.deleted) {
			proxies = proxies.filter((item) => item.id !== proxy.id);
		} else if (result.proxy) {
			proxies = proxies.map((item) => (item.id === result.proxy?.id ? result.proxy : item));
		}
		return result;
	}

	async function checkOneProxy(proxy: ProxyProfile) {
		if (proxyChecking) return;
		proxyChecking = true;
		checkingProxyId = proxy.id;
		proxyCheckProgress = { done: 0, total: 1, available: 0, deleted: 0, failed: 0 };
		proxyCheckResults = [];
		try {
			const result = await checkProxyProfile(proxy);
			proxyCheckResults = [result];
			proxyCheckProgress = {
				done: 1,
				total: 1,
				available: result.status === 'available' ? 1 : 0,
				deleted: result.status === 'deleted' ? 1 : 0,
				failed: result.status === 'failed' ? 1 : 0
			};
			toast = `${result.message}${proxyNotifyText(result)}`;
			await load();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			proxyCheckProgress = { done: 1, total: 1, available: 0, deleted: 0, failed: 1 };
			proxyCheckResults = [
				{
					proxy_id: proxy.id,
					name: proxy.name,
					status: 'failed' as const,
					deleted: false,
					message: `代理测活失败：${proxy.name}`,
					error: message,
					proxy: null,
					runtime_type: '',
					checked_at: new Date().toISOString(),
					telegram_notified: false,
					telegram_sent: 0,
					telegram_failed: 0,
					telegram_error: ''
				}
			];
			toast = message;
		} finally {
			proxyChecking = false;
			checkingProxyId = null;
		}
	}

	async function checkAllProxies() {
		if (proxyChecking) return;
		const targets = [...customProxies];
		if (targets.length === 0) {
			toast = '没有可测活的自定义固定代理';
			return;
		}

		proxyChecking = true;
		checkingProxyId = null;
		proxyCheckResults = [];
		let available = 0;
		let deleted = 0;
		let failed = 0;
		proxyCheckProgress = { done: 0, total: targets.length, available, deleted, failed };

		try {
			for (const proxy of targets) {
				checkingProxyId = proxy.id;
				try {
					const result = await checkProxyProfile(proxy, { notify: false });
					if (result.status === 'available') available += 1;
					else if (result.status === 'deleted') deleted += 1;
					else failed += 1;
					proxyCheckResults = [result, ...proxyCheckResults].slice(0, 8);
					toast = `正在静默单线程测活代理 ${proxyCheckProgress.done + 1}/${targets.length}：${result.message}`;
				} catch (err) {
					failed += 1;
					const message = err instanceof Error ? err.message : String(err);
					proxyCheckResults = [
						{
							proxy_id: proxy.id,
							name: proxy.name,
							status: 'failed' as const,
							deleted: false,
							message: `代理测活请求失败：${proxy.name}`,
							error: message,
							proxy: null,
							runtime_type: '',
							checked_at: new Date().toISOString(),
							telegram_notified: false,
							telegram_sent: 0,
							telegram_failed: 0,
							telegram_error: ''
						},
						...proxyCheckResults
					].slice(0, 8);
					toast = `代理 ${proxy.name} 测活请求失败：${message}`;
				}
				proxyCheckProgress = {
					done: proxyCheckProgress.done + 1,
					total: targets.length,
					available,
					deleted,
					failed
				};
			}
			toast = `代理静默单线程测活完成：可用 ${available} 个，已删除无效 ${deleted} 个，请求失败 ${failed} 个，未触发 Telegram 通知`;
			await load();
		} finally {
			proxyChecking = false;
			checkingProxyId = null;
		}
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
				这里配置固定自托管代理，支持手动添加 HTTP/SOCKS 代理，或通过代理 API 批量导入。
			</p>
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
				<select class="input" bind:value={rawProxyType}>
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

		{#if isProxyApiMode}
			<div class="flex flex-wrap items-center gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2">
				<button class="btn-primary" type="submit" disabled={saving}>
					{saving ? '单线程导入中...' : '拉取 API 并单线程导入'}
				</button>
				<span class="text-xs text-sky-100">
					无需填写主机和端口，将从 API 拉取代理后逐条识别、验证并保存，避免长请求超时。
				</span>
				{#if saving && apiImportProgress.total > 0}
					<div class="basis-full">
						<div class="progress-track running">
							<div
								class="progress-fill bg-primary"
								style={`width: ${Math.max(8, Math.round((apiImportProgress.done / apiImportProgress.total) * 100))}%`}
							></div>
						</div>
						<div class="mt-1 text-xs text-sky-100">
							已处理 {apiImportProgress.done}/{apiImportProgress.total}，成功 {apiImportProgress.imported} 个，失败 {apiImportProgress.failed} 个
						</div>
					</div>
				{/if}
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
				保存前会验证代理端口可连接，验证通过后可在账号、开机和补机流程中选择使用。
			</p>
			<button class="btn-primary" type="submit" disabled={saving}>
				{saving ? '提交中...' : proxyApiUrl.trim() ? '拉取 API 并批量导入' : '验证并提交'}
			</button>
		{/if}
	</form>

	<div class="card overflow-x-auto p-5">
		<div class="mb-4 flex flex-wrap items-start justify-between gap-3">
			<div>
				<h2 class="text-lg font-medium">代理档案</h2>
				<p class="mt-1 text-sm text-muted">
					Azure 账号选择“不使用代理”时，Azure 看到的是网站源站服务器的出站 IP。
					选择下面的代理档案后，验证、查询、开关机、自动补机会走代理出口。
				</p>
			</div>
			<button
				class="btn-secondary"
				type="button"
				disabled={proxyChecking || customProxies.length === 0}
				onclick={() => void checkAllProxies()}
			>
				{proxyChecking ? '静默测活中...' : '一键静默测活并删除无效代理'}
			</button>
		</div>

		{#if proxyChecking && proxyCheckProgress.total > 0}
			<div class="mb-4 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3">
				<div class="progress-track running">
					<div
						class="progress-fill bg-primary"
						style={`width: ${Math.max(8, Math.round((proxyCheckProgress.done / proxyCheckProgress.total) * 100))}%`}
					></div>
				</div>
				<div class="mt-2 text-xs text-sky-100">
					已处理 {proxyCheckProgress.done}/{proxyCheckProgress.total}，可用 {proxyCheckProgress.available} 个，已删除无效 {proxyCheckProgress.deleted} 个，请求失败 {proxyCheckProgress.failed} 个
				</div>
			</div>
		{/if}

		{#if proxyCheckResults.length > 0}
			<div class="mb-4 space-y-2 rounded-lg border border-border bg-background p-3 text-xs">
				<div class="font-medium">最近测活结果</div>
				{#each proxyCheckResults as result}
					<div class={result.status === 'available' ? 'text-emerald-300' : result.status === 'deleted' ? 'text-amber-300' : 'text-red-300'}>
						{result.name}: {result.message}{result.error ? `，错误：${result.error}` : ''}
					</div>
				{/each}
			</div>
		{/if}

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
								<div class="flex flex-wrap gap-2">
									<button
										class="btn-secondary"
										disabled={proxyChecking}
										onclick={() => void checkOneProxy(proxy)}
									>
										{checkingProxyId === proxy.id ? '测活中...' : '测活'}
									</button>
									<button class="btn-danger" disabled={proxyChecking} onclick={() => void remove(proxy.id)}>
										删除
									</button>
								</div>
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>
