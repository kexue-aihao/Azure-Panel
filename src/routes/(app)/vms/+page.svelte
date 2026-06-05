<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Account = { id: number; name: string };
	type Vm = {
		name: string;
		resource_group: string;
		location: string;
		vm_size: string;
		power_state: string;
	};

	let accounts = $state<Account[]>([]);
	let vms = $state<Vm[]>([]);
	let accountId = $state<number | null>(null);
	let resourceGroup = $state('');
	let loading = $state(false);
	let toast = $state('');

	async function loadAccounts() {
		accounts = await api<Account[]>('/api/user/azure/account/list');
		if (!accountId && accounts.length) accountId = accounts[0].id;
	}

	async function loadVms() {
		if (!accountId) {
			vms = [];
			return;
		}
		loading = true;
		try {
			const params = new URLSearchParams({ account_id: String(accountId) });
			if (resourceGroup) params.set('resource_group', resourceGroup);
			vms = await api<Vm[]>(`/api/user/azure/resource/list?${params}`);
		} catch (err) {
			toast = err instanceof Error ? err.message : '加载失败';
		} finally {
			loading = false;
		}
	}

	async function power(action: 'on' | 'off' | 'restart', vm: Vm) {
		if (!accountId) return;
		try {
			await api(`/api/user/azure/vm/power/${action}`, {
				method: 'POST',
				body: JSON.stringify({
					account_id: accountId,
					resource_group: vm.resource_group,
					vm_name: vm.name
				})
			});
			toast = `已触发 ${vm.name} 操作`;
			setTimeout(loadVms, 1500);
		} catch (err) {
			toast = err instanceof Error ? err.message : '操作失败';
		}
	}

	function badge(state: string) {
		if (state === 'running' || state === 'starting') return 'bg-green-900/50 text-green-300';
		if (state === 'deallocated' || state === 'stopped') return 'bg-red-900/50 text-red-300';
		return 'bg-yellow-900/50 text-yellow-300';
	}

	onMount(async () => {
		await loadAccounts();
		await loadVms();
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">VM 管理</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="mb-4 flex flex-wrap items-end gap-3">
	<div>
		<label class="text-sm text-muted">Azure 账号</label>
		<select
			class="input mt-1 min-w-[220px]"
			bind:value={accountId}
			onchange={loadVms}
		>
			<option value={null}>选择账号</option>
			{#each accounts as account}
				<option value={account.id}>{account.name}</option>
			{/each}
		</select>
	</div>
	<div>
		<label class="text-sm text-muted">资源组（可选）</label>
		<input class="input mt-1" bind:value={resourceGroup} placeholder="my-rg" />
	</div>
	<button class="btn-primary" onclick={loadVms} disabled={loading}>刷新 VM</button>
</div>

<div class="card overflow-x-auto">
	<table class="w-full text-sm">
		<thead class="text-muted">
			<tr class="border-b border-border">
				<th class="p-3 text-left">名称</th>
				<th class="p-3 text-left">资源组</th>
				<th class="p-3 text-left">区域</th>
				<th class="p-3 text-left">规格</th>
				<th class="p-3 text-left">状态</th>
				<th class="p-3 text-left">操作</th>
			</tr>
		</thead>
		<tbody>
			{#if vms.length === 0}
				<tr><td class="p-3 text-muted" colspan="6">暂无 VM</td></tr>
			{:else}
				{#each vms as vm}
					<tr class="border-b border-border/60">
						<td class="p-3">{vm.name}</td>
						<td class="p-3">{vm.resource_group}</td>
						<td class="p-3">{vm.location}</td>
						<td class="p-3">{vm.vm_size}</td>
						<td class="p-3">
							<span class="badge {badge(vm.power_state)}">{vm.power_state}</span>
						</td>
						<td class="space-x-2 p-3">
							<button class="btn-primary" onclick={() => power('on', vm)}>开机</button>
							<button class="btn-secondary" onclick={() => power('off', vm)}>关机</button>
							<button class="btn-secondary" onclick={() => power('restart', vm)}>重启</button>
						</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>
