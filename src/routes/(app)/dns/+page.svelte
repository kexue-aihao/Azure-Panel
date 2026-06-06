<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type DnsConfig = {
		id: number;
		name: string;
		base_url: string;
		username_set: boolean;
		auth_mode: 'password' | 'api';
		enabled: boolean;
		created_at: string;
	};
	type DnsDomain = {
		id: number;
		name: string;
		typename?: string;
		recordcount?: number;
		is_sso?: number;
	};
	type DnsDomainDetail = DnsDomain & {
		recordLine?: Array<{ id: string | number; name: string; parent?: string | number | null }>;
		minTTL?: string;
		loginurl?: string;
	};
	type DnsRecord = {
		RecordId: string;
		Domain: string;
		Name: string;
		Type: string;
		Value: string;
		Line: string;
		LineName: string;
		TTL: number;
		Status: string;
		Remark: string | null;
		UpdateTime: string;
	};
	type DnsBinding = {
		id: number;
		config_id: number;
		name: string;
		domain_id: number;
		domain_name: string;
		subdomain: string;
		record_type: string;
		line: string;
		ttl: number;
		remark: string;
		enabled: boolean;
		last_ipv4: string;
		last_ipv6: string;
		last_synced_at: string | null;
		fqdn: string;
	};

	let configs = $state<DnsConfig[]>([]);
	let domains = $state<DnsDomain[]>([]);
	let records = $state<DnsRecord[]>([]);
	let bindings = $state<DnsBinding[]>([]);
	let selectedConfigId = $state<number | null>(null);
	let selectedDomainId = $state<number | null>(null);
	let selectedDomain = $state<DnsDomainDetail | null>(null);
	let loading = $state(false);
	let recordLoading = $state(false);
	let toast = $state('');
	let loginUrl = $state('');
	let manualSync = $state({ binding_id: '', ipv4: '', ipv6: '' });
	let configForm = $state({
		id: 0,
		name: '',
		base_url: '',
		username: '',
		password: '',
		enabled: true
	});
	let recordForm = $state({
		record_id: '',
		name: '@',
		type: 'A',
		value: '',
		line: 'default',
		ttl: 60,
		remark: ''
	});
	let bindingForm = $state({
		id: 0,
		config_id: '',
		name: '',
		domain_id: '',
		domain_name: '',
		subdomain: '@',
		record_type: 'A',
		line: 'default',
		ttl: 60,
		remark: '',
		enabled: true
	});

	const selectedConfig = $derived(configs.find((item) => item.id === selectedConfigId) ?? null);
	const recordLines = $derived(selectedDomain?.recordLine ?? [{ id: 'default', name: '默认' }]);

	function configParams(extra: Record<string, string> = {}) {
		return new URLSearchParams({
			config_id: String(selectedConfigId ?? ''),
			...extra
		});
	}

	function formatDate(value: string | null) {
		return value ? new Date(value).toLocaleString() : '-';
	}

	function editConfig(config: DnsConfig) {
		configForm = {
			id: config.id,
			name: config.name,
			base_url: config.base_url,
			username: '',
			password: '',
			enabled: config.enabled
		};
	}

	function resetConfigForm() {
		configForm = { id: 0, name: '', base_url: '', username: '', password: '', enabled: true };
	}

	function resetRecordForm() {
		recordForm = {
			record_id: '',
			name: '@',
			type: 'A',
			value: '',
			line: selectedDomain?.recordLine?.[0]?.id ? String(selectedDomain.recordLine[0].id) : 'default',
			ttl: Number(selectedDomain?.minTTL ?? 60),
			remark: ''
		};
	}

	function editRecord(record: DnsRecord) {
		recordForm = {
			record_id: record.RecordId,
			name: record.Name,
			type: record.Type,
			value: record.Value,
			line: record.Line,
			ttl: record.TTL,
			remark: record.Remark ?? ''
		};
	}

	function fillBindingFromDomain() {
		if (!selectedDomain) return;
		bindingForm.config_id = String(selectedConfigId ?? '');
		bindingForm.domain_id = String(selectedDomain.id);
		bindingForm.domain_name = selectedDomain.name;
		if (!bindingForm.name) bindingForm.name = `${selectedDomain.name} 自动解析`;
		bindingForm.line = selectedDomain.recordLine?.[0]?.id
			? String(selectedDomain.recordLine[0].id)
			: 'default';
		bindingForm.ttl = Number(selectedDomain.minTTL ?? 60);
	}

	function editBinding(binding: DnsBinding) {
		bindingForm = {
			id: binding.id,
			config_id: String(binding.config_id),
			name: binding.name,
			domain_id: String(binding.domain_id),
			domain_name: binding.domain_name,
			subdomain: binding.subdomain,
			record_type: binding.record_type,
			line: binding.line,
			ttl: binding.ttl,
			remark: binding.remark ?? '',
			enabled: binding.enabled
		};
	}

	function resetBindingForm() {
		bindingForm = {
			id: 0,
			config_id: selectedConfigId ? String(selectedConfigId) : '',
			name: '',
			domain_id: selectedDomain ? String(selectedDomain.id) : '',
			domain_name: selectedDomain?.name ?? '',
			subdomain: '@',
			record_type: 'A',
			line: selectedDomain?.recordLine?.[0]?.id ? String(selectedDomain.recordLine[0].id) : 'default',
			ttl: Number(selectedDomain?.minTTL ?? 60),
			remark: '',
			enabled: true
		};
	}

	async function loadConfigs() {
		configs = await api<DnsConfig[]>('/api/user/dns/config/list');
		if (!selectedConfigId && configs.length) selectedConfigId = configs[0].id;
		if (selectedConfigId && !configs.some((config) => config.id === selectedConfigId)) {
			selectedConfigId = configs[0]?.id ?? null;
		}
	}

	async function loadBindings() {
		bindings = await api<DnsBinding[]>('/api/user/dns/binding/list');
	}

	async function saveConfig(e: Event) {
		e.preventDefault();
		loading = true;
		try {
			const saved = await api<DnsConfig>('/api/user/dns/config/save', {
				method: 'POST',
				body: JSON.stringify(configForm)
			});
			toast = 'DNS 配置已保存';
			selectedConfigId = saved.id;
			resetConfigForm();
			await loadConfigs();
			await loadDomains();
		} catch (err) {
			toast = err instanceof Error ? err.message : 'DNS 配置保存失败';
		} finally {
			loading = false;
		}
	}

	async function testConfig(config?: DnsConfig) {
		loading = true;
		try {
			const result = await api<{ ok: boolean; total: number }>('/api/user/dns/config/test', {
				method: 'POST',
				body: JSON.stringify(
					config
						? { config_id: config.id }
						: {
								base_url: configForm.base_url,
								username: configForm.username,
								password: configForm.password
							}
				)
			});
			toast = `连接成功，当前可管理域名数：${result.total}`;
		} catch (err) {
			toast = err instanceof Error ? err.message : 'DNS 连接测试失败';
		} finally {
			loading = false;
		}
	}

	async function deleteConfig(config: DnsConfig) {
		if (!confirm(`确认删除 DNS 配置 ${config.name} 吗？相关自动解析绑定也会删除。`)) return;
		loading = true;
		try {
			await api('/api/user/dns/config/delete', {
				method: 'POST',
				body: JSON.stringify({ id: config.id })
			});
			toast = 'DNS 配置已删除';
			if (selectedConfigId === config.id) selectedConfigId = null;
			await Promise.all([loadConfigs(), loadBindings()]);
		} catch (err) {
			toast = err instanceof Error ? err.message : 'DNS 配置删除失败';
		} finally {
			loading = false;
		}
	}

	async function loadDomains() {
		if (!selectedConfigId) {
			domains = [];
			return;
		}
		loading = true;
		try {
			const result = await api<{ total: number; rows: DnsDomain[] }>(
				`/api/user/dns/domain/list?${configParams()}`
			);
			domains = result.rows ?? [];
			if (!selectedDomainId && domains.length) selectedDomainId = domains[0].id;
			if (selectedDomainId) await selectDomain(selectedDomainId);
		} catch (err) {
			toast = err instanceof Error ? err.message : '域名列表加载失败';
		} finally {
			loading = false;
		}
	}

	async function selectDomain(domainId: number) {
		if (!selectedConfigId || !domainId) return;
		selectedDomainId = domainId;
		try {
			selectedDomain = await api<DnsDomainDetail>(
				`/api/user/dns/domain/detail?${configParams({
					domain_id: String(domainId)
				})}`
			);
			resetRecordForm();
			resetBindingForm();
			await loadRecords();
		} catch (err) {
			toast = err instanceof Error ? err.message : '域名详情加载失败';
		}
	}

	async function openDomainLogin() {
		if (!selectedConfigId || !selectedDomainId) return;
		try {
			const detail = await api<DnsDomainDetail>(
				`/api/user/dns/domain/detail?${configParams({
					domain_id: String(selectedDomainId),
					loginurl: '1'
				})}`
			);
			loginUrl = detail.loginurl ?? '';
			if (!loginUrl) toast = '该域名未返回一键登录地址，可能未开启 SSO';
		} catch (err) {
			toast = err instanceof Error ? err.message : '获取一键登录地址失败';
		}
	}

	async function loadRecords() {
		if (!selectedConfigId || !selectedDomainId) {
			records = [];
			return;
		}
		recordLoading = true;
		try {
			const result = await api<{ total: number; rows: DnsRecord[] }>(
				`/api/user/dns/record/list?${configParams({
					domain_id: String(selectedDomainId),
					limit: '100'
				})}`
			);
			records = result.rows ?? [];
		} catch (err) {
			toast = err instanceof Error ? err.message : '解析记录加载失败';
		} finally {
			recordLoading = false;
		}
	}

	async function saveRecord(e: Event) {
		e.preventDefault();
		if (!selectedConfigId || !selectedDomainId) return;
		recordLoading = true;
		try {
			await api('/api/user/dns/record/save', {
				method: 'POST',
				body: JSON.stringify({
					config_id: selectedConfigId,
					domain_id: selectedDomainId,
					...recordForm,
					ttl: Number(recordForm.ttl)
				})
			});
			toast = recordForm.record_id ? '解析记录已更新' : '解析记录已新增';
			resetRecordForm();
			await loadRecords();
		} catch (err) {
			toast = err instanceof Error ? err.message : '解析记录保存失败';
		} finally {
			recordLoading = false;
		}
	}

	async function deleteRecord(record: DnsRecord) {
		if (!selectedConfigId || !selectedDomainId) return;
		if (!confirm(`确认删除解析 ${record.Name} ${record.Type} ${record.Value} 吗？`)) return;
		try {
			await api('/api/user/dns/record/delete', {
				method: 'POST',
				body: JSON.stringify({
					config_id: selectedConfigId,
					domain_id: selectedDomainId,
					record_id: record.RecordId
				})
			});
			toast = '解析记录已删除';
			await loadRecords();
		} catch (err) {
			toast = err instanceof Error ? err.message : '解析记录删除失败';
		}
	}

	async function toggleRecord(record: DnsRecord) {
		if (!selectedConfigId || !selectedDomainId) return;
		try {
			await api('/api/user/dns/record/status', {
				method: 'POST',
				body: JSON.stringify({
					config_id: selectedConfigId,
					domain_id: selectedDomainId,
					record_id: record.RecordId,
					status: record.Status === '1' ? '0' : '1'
				})
			});
			toast = '解析状态已更新';
			await loadRecords();
		} catch (err) {
			toast = err instanceof Error ? err.message : '解析状态更新失败';
		}
	}

	async function saveBinding(e: Event) {
		e.preventDefault();
		loading = true;
		try {
			await api('/api/user/dns/binding/save', {
				method: 'POST',
				body: JSON.stringify({
					...bindingForm,
					config_id: Number(bindingForm.config_id),
					domain_id: Number(bindingForm.domain_id),
					ttl: Number(bindingForm.ttl)
				})
			});
			toast = '自动解析绑定已保存';
			resetBindingForm();
			await loadBindings();
		} catch (err) {
			toast = err instanceof Error ? err.message : '自动解析绑定保存失败';
		} finally {
			loading = false;
		}
	}

	async function deleteBinding(binding: DnsBinding) {
		if (!confirm(`确认删除自动解析绑定 ${binding.name} 吗？`)) return;
		try {
			await api('/api/user/dns/binding/delete', {
				method: 'POST',
				body: JSON.stringify({ id: binding.id })
			});
			toast = '自动解析绑定已删除';
			await loadBindings();
		} catch (err) {
			toast = err instanceof Error ? err.message : '自动解析绑定删除失败';
		}
	}

	async function syncBinding() {
		if (!manualSync.binding_id) return;
		loading = true;
		try {
			const result = await api<{ fqdn: string; created: string[]; updated: string[] }>(
				'/api/user/dns/binding/sync',
				{
					method: 'POST',
					body: JSON.stringify({
						binding_id: Number(manualSync.binding_id),
						ipv4: manualSync.ipv4,
						ipv6: manualSync.ipv6
					})
				}
			);
			toast = `已同步 ${result.fqdn}，新增 ${result.created.join(',') || '-'}，更新 ${result.updated.join(',') || '-'}`;
			await loadBindings();
		} catch (err) {
			toast = err instanceof Error ? err.message : '手动同步失败';
		} finally {
			loading = false;
		}
	}

	async function changeConfig() {
		selectedDomainId = null;
		selectedDomain = null;
		records = [];
		loginUrl = '';
		resetBindingForm();
		await loadDomains();
	}

	onMount(async () => {
		await Promise.all([loadConfigs(), loadBindings()]);
		if (selectedConfigId) await loadDomains();
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">DNS 管理</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="mb-4 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
	<section class="card space-y-4 p-5">
		<div>
			<h2 class="text-lg font-medium">彩虹 DNS 面板连接</h2>
			<p class="mt-1 text-sm text-muted">
				使用彩虹 DNS 面板的登录账号和密码连接；密码会加密保存，后端会自动登录并调用后台接口管理域名和解析。
			</p>
		</div>
		<form class="grid gap-3 md:grid-cols-2" onsubmit={saveConfig}>
			<input class="input" bind:value={configForm.name} placeholder="配置名称，例如 主 DNS 面板" required />
			<input class="input" bind:value={configForm.base_url} placeholder="https://dns.example.com" required />
			<input class="input" bind:value={configForm.username} placeholder={configForm.id ? '用户名，重新输入后保存' : '用户名'} required />
			<input
				class="input"
				type="password"
				bind:value={configForm.password}
				placeholder={configForm.id ? '留空表示不更换密码' : '密码'}
				required={!configForm.id}
			/>
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={configForm.enabled} /> 启用此配置
			</label>
			<div class="flex flex-wrap gap-2 md:col-span-2">
				<button class="btn-primary" type="submit" disabled={loading}>
					{loading ? '处理中...' : configForm.id ? '保存配置' : '新增配置'}
				</button>
				<button class="btn-secondary" type="button" onclick={() => void testConfig()} disabled={loading}>
					测试当前填写
				</button>
				<button class="btn-secondary" type="button" onclick={resetConfigForm}>清空</button>
			</div>
		</form>

		<div class="space-y-2">
			{#each configs as config}
				<div class="rounded-lg border border-border p-3 text-sm">
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div>
							<div class="font-medium">{config.name}</div>
							<div class="mt-1 break-all text-xs text-muted">
								{config.base_url} / {config.auth_mode === 'password' ? '账号密码登录' : '旧 API 签名模式'}
							</div>
						</div>
						<span class="badge {config.enabled ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'}">
							{config.enabled ? '启用' : '停用'}
						</span>
					</div>
					<div class="mt-3 flex flex-wrap gap-2">
						<button class="btn-secondary px-2 py-1 text-xs" onclick={() => editConfig(config)}>编辑</button>
						<button class="btn-secondary px-2 py-1 text-xs" onclick={() => void testConfig(config)}>测试</button>
						<button class="btn-danger px-2 py-1 text-xs" onclick={() => void deleteConfig(config)}>删除</button>
					</div>
				</div>
			{/each}
			{#if configs.length === 0}
				<p class="text-sm text-muted">还没有 DNS 配置，先填写面板地址、用户名和密码。</p>
			{/if}
		</div>
	</section>

	<section class="card space-y-4 p-5">
		<div class="flex flex-wrap items-end gap-3">
			<div>
				<label class="text-sm text-muted" for="dns-config-select">当前 DNS 配置</label>
				<select
					id="dns-config-select"
					class="input mt-1 min-w-[260px]"
					bind:value={selectedConfigId}
					onchange={() => void changeConfig()}
				>
					<option value={null}>选择 DNS 配置</option>
					{#each configs as config}
						<option value={config.id}>{config.name} - {config.base_url}</option>
					{/each}
				</select>
			</div>
			<button class="btn-primary" onclick={() => void loadDomains()} disabled={!selectedConfig || loading}>
				刷新域名
			</button>
		</div>

		<div class="grid gap-3 md:grid-cols-2">
			<div>
				<label class="text-sm text-muted" for="dns-domain-select">可管理域名</label>
				<select
					id="dns-domain-select"
					class="input mt-1"
					bind:value={selectedDomainId}
					onchange={() => selectedDomainId && void selectDomain(selectedDomainId)}
					disabled={domains.length === 0}
				>
					<option value={null}>选择域名</option>
					{#each domains as domain}
						<option value={domain.id}>{domain.name} ({domain.typename || '-'})</option>
					{/each}
				</select>
			</div>
			<div class="flex items-end gap-2">
				<button class="btn-secondary" onclick={() => void openDomainLogin()} disabled={!selectedDomainId}>
					嵌入式登录面板
				</button>
				<button class="btn-secondary" onclick={fillBindingFromDomain} disabled={!selectedDomain}>
					填入自动解析绑定
				</button>
			</div>
		</div>

		{#if selectedDomain}
			<div class="rounded-lg border border-border bg-background p-3 text-sm">
				<div class="font-medium">{selectedDomain.name}</div>
				<div class="mt-1 text-xs text-muted">
					最小 TTL：{selectedDomain.minTTL || '-'}，线路数：{recordLines.length}，记录数：{selectedDomain.recordcount ?? '-'}
				</div>
				<div class="mt-2 flex flex-wrap gap-2 text-xs">
					{#each recordLines as line}
						<span class="rounded bg-border px-2 py-1">{line.name} / {line.id}</span>
					{/each}
				</div>
			</div>
		{/if}

		{#if loginUrl}
			<div class="rounded-xl border border-border bg-background p-3">
				<div class="mb-2 flex items-center justify-between gap-3">
					<div class="text-sm font-medium">彩虹 DNS 一键登录</div>
					<a class="btn-secondary text-xs" href={loginUrl} target="_blank" rel="noreferrer">新窗口打开</a>
				</div>
				<iframe title="彩虹 DNS 面板" src={loginUrl} class="h-[520px] w-full rounded-lg border border-border"></iframe>
			</div>
		{/if}
	</section>
</div>

<div class="mb-4 grid gap-4 xl:grid-cols-[1fr_0.9fr]">
	<section class="card space-y-4 p-5">
		<div class="flex items-center justify-between gap-3">
			<h2 class="text-lg font-medium">解析记录</h2>
			<button class="btn-secondary" onclick={() => void loadRecords()} disabled={!selectedDomainId || recordLoading}>
				{recordLoading ? '加载中...' : '刷新记录'}
			</button>
		</div>
		<form class="grid gap-3 lg:grid-cols-6" onsubmit={saveRecord}>
			<input class="input" bind:value={recordForm.name} placeholder="主机记录，例如 @ 或 www" required />
			<select class="input" bind:value={recordForm.type}>
				<option value="A">A</option>
				<option value="AAAA">AAAA</option>
				<option value="CNAME">CNAME</option>
				<option value="TXT">TXT</option>
				<option value="MX">MX</option>
			</select>
			<input class="input lg:col-span-2" bind:value={recordForm.value} placeholder="记录值" required />
			<select class="input" bind:value={recordForm.line}>
				{#each recordLines as line}
					<option value={String(line.id)}>{line.name} / {line.id}</option>
				{/each}
			</select>
			<input class="input" type="number" min="1" bind:value={recordForm.ttl} placeholder="TTL" required />
			<input class="input lg:col-span-5" bind:value={recordForm.remark} placeholder="备注，可选" />
			<div class="flex gap-2">
				<button class="btn-primary" type="submit" disabled={!selectedDomainId || recordLoading}>
					{recordForm.record_id ? '更新记录' : '新增记录'}
				</button>
				<button class="btn-secondary" type="button" onclick={resetRecordForm}>清空</button>
			</div>
		</form>

		<div class="overflow-x-auto rounded-xl border border-border">
			<table class="w-full text-xs">
				<thead class="text-muted">
					<tr class="border-b border-border">
						<th class="p-2 text-left">主机</th>
						<th class="p-2 text-left">类型</th>
						<th class="p-2 text-left">值</th>
						<th class="p-2 text-left">线路</th>
						<th class="p-2 text-left">TTL</th>
						<th class="p-2 text-left">状态</th>
						<th class="p-2 text-left">操作</th>
					</tr>
				</thead>
				<tbody>
					{#if records.length === 0}
						<tr><td class="p-3 text-muted" colspan="7">暂无解析记录</td></tr>
					{:else}
						{#each records as record}
							<tr class="border-b border-border/60">
								<td class="p-2">{record.Name}</td>
								<td class="p-2">{record.Type}</td>
								<td class="max-w-[280px] break-all p-2">{record.Value}</td>
								<td class="p-2">{record.LineName || record.Line}</td>
								<td class="p-2">{record.TTL}</td>
								<td class="p-2">{record.Status === '1' ? '启用' : '暂停'}</td>
								<td class="space-x-2 whitespace-nowrap p-2">
									<button class="btn-secondary px-2 py-1 text-xs" onclick={() => editRecord(record)}>编辑</button>
									<button class="btn-secondary px-2 py-1 text-xs" onclick={() => void toggleRecord(record)}>
										{record.Status === '1' ? '暂停' : '启用'}
									</button>
									<button class="btn-danger px-2 py-1 text-xs" onclick={() => void deleteRecord(record)}>删除</button>
								</td>
							</tr>
						{/each}
					{/if}
				</tbody>
			</table>
		</div>
	</section>

	<section class="card space-y-4 p-5">
		<div>
			<h2 class="text-lg font-medium">开机后自动解析绑定</h2>
			<p class="mt-1 text-sm text-muted">
				创建 VM 时选择这里的绑定，系统会在拿到公网 IP 后自动新增或更新 A / AAAA 记录。
			</p>
		</div>
		<form class="grid gap-3 md:grid-cols-2" onsubmit={saveBinding}>
			<input class="input" bind:value={bindingForm.name} placeholder="绑定名称" required />
			<select class="input" bind:value={bindingForm.config_id} required>
				<option value="">DNS 配置</option>
				{#each configs as config}
					<option value={String(config.id)}>{config.name}</option>
				{/each}
			</select>
			<input class="input" bind:value={bindingForm.domain_id} placeholder="域名 ID" required />
			<input class="input" bind:value={bindingForm.domain_name} placeholder="主域名，例如 example.com" required />
			<input class="input" bind:value={bindingForm.subdomain} placeholder="主机记录，例如 @ 或 vm" required />
			<select class="input" bind:value={bindingForm.record_type}>
				<option value="A">只同步 IPv4 A</option>
				<option value="AAAA">只同步 IPv6 AAAA</option>
				<option value="A+AAAA">同步 IPv4 + IPv6</option>
			</select>
			<select class="input" bind:value={bindingForm.line}>
				{#each recordLines as line}
					<option value={String(line.id)}>{line.name} / {line.id}</option>
				{/each}
			</select>
			<input class="input" type="number" min="1" bind:value={bindingForm.ttl} placeholder="TTL" required />
			<input class="input md:col-span-2" bind:value={bindingForm.remark} placeholder="备注，可选" />
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={bindingForm.enabled} /> 启用自动解析
			</label>
			<div class="flex gap-2">
				<button class="btn-primary" type="submit" disabled={loading}>
					{bindingForm.id ? '保存绑定' : '新增绑定'}
				</button>
				<button class="btn-secondary" type="button" onclick={resetBindingForm}>清空</button>
			</div>
		</form>

		<div class="rounded-xl border border-border bg-background p-3">
			<div class="mb-2 text-sm font-medium">手动同步测试</div>
			<div class="grid gap-2 md:grid-cols-2">
				<select class="input md:col-span-2" bind:value={manualSync.binding_id}>
					<option value="">选择绑定</option>
					{#each bindings as binding}
						<option value={String(binding.id)}>{binding.name} - {binding.fqdn}</option>
					{/each}
				</select>
				<input class="input" bind:value={manualSync.ipv4} placeholder="IPv4，例如 1.2.3.4" />
				<input class="input" bind:value={manualSync.ipv6} placeholder="IPv6，可选" />
				<button class="btn-secondary md:col-span-2" onclick={() => void syncBinding()} disabled={loading}>
					同步到 DNS
				</button>
			</div>
		</div>

		<div class="space-y-2">
			{#each bindings as binding}
				<div class="rounded-lg border border-border p-3 text-sm">
					<div class="flex flex-wrap items-start justify-between gap-3">
						<div>
							<div class="font-medium">{binding.name}</div>
							<div class="mt-1 break-all text-xs text-muted">
								{binding.fqdn} / {binding.record_type} / line {binding.line} / TTL {binding.ttl}
							</div>
							<div class="mt-1 text-xs text-muted">
								最近同步：IPv4 {binding.last_ipv4 || '-'} / IPv6 {binding.last_ipv6 || '-'} / {formatDate(binding.last_synced_at)}
							</div>
						</div>
						<span class="badge {binding.enabled ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'}">
							{binding.enabled ? '启用' : '停用'}
						</span>
					</div>
					<div class="mt-3 flex flex-wrap gap-2">
						<button class="btn-secondary px-2 py-1 text-xs" onclick={() => editBinding(binding)}>编辑</button>
						<button class="btn-danger px-2 py-1 text-xs" onclick={() => void deleteBinding(binding)}>删除</button>
					</div>
				</div>
			{/each}
			{#if bindings.length === 0}
				<p class="text-sm text-muted">暂无自动解析绑定。</p>
			{/if}
		</div>
	</section>
</div>
