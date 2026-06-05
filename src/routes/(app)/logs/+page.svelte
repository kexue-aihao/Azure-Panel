<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Log = {
		id: number;
		policy_id: number;
		action: string;
		status: string;
		message: string;
		created_at: string;
	};

	let logs = $state<Log[]>([]);

	async function load() {
		logs = await api<Log[]>('/api/user/workflow/logs');
	}

	onMount(() => {
		load();
		const timer = setInterval(load, 10_000);
		return () => clearInterval(timer);
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">执行日志</h1>

<div class="card overflow-x-auto">
	<table class="w-full text-sm">
		<thead class="text-muted">
			<tr class="border-b border-border">
				<th class="p-3 text-left">时间</th>
				<th class="p-3 text-left">策略</th>
				<th class="p-3 text-left">动作</th>
				<th class="p-3 text-left">状态</th>
				<th class="p-3 text-left">消息</th>
			</tr>
		</thead>
		<tbody>
			{#if logs.length === 0}
				<tr><td class="p-3 text-muted" colspan="5">暂无日志</td></tr>
			{:else}
				{#each logs as log}
					<tr class="border-b border-border/60">
						<td class="p-3">{new Date(log.created_at).toLocaleString()}</td>
						<td class="p-3">#{log.policy_id}</td>
						<td class="p-3">{log.action}</td>
						<td class="p-3">
							<span class="badge {log.status === 'success' ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'}">
								{log.status}
							</span>
						</td>
						<td class="p-3">{log.message}</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>
