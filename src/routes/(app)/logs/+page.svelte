<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type Log = {
		id: number;
		source: string;
		policy_id: number | null;
		account_id: number | null;
		action: string;
		status: string;
		message: string;
		resource_group: string;
		vm_name: string;
		created_at: string;
	};

	let logs = $state<Log[]>([]);
	let exporting = $state(false);
	let exportMessage = $state('');
	const beijingTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
		timeZone: 'Asia/Shanghai',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});

	function beijingDateParts(date: Date) {
		return Object.fromEntries(
			beijingTimeFormatter.formatToParts(date).map((part) => [part.type, part.value])
		);
	}

	async function load() {
		logs = await api<Log[]>('/api/user/workflow/logs');
	}

	function buildExportFilename() {
		const now = new Date();
		const parts = beijingDateParts(now);
		return `azure-panel-logs-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}.csv`;
	}

	async function exportLogs() {
		if (exporting) return;
		exporting = true;
		exportMessage = '';
		try {
			const token = localStorage.getItem('token');
			const response = await fetch('/api/user/workflow/logs/export', {
				headers: {
					Accept: 'text/csv',
					...(token ? { Authorization: `Bearer ${token}` } : {})
				}
			});
			if (!response.ok) {
				const text = await response.text();
				let message = text || `导出失败 (${response.status})`;
				try {
					const body = JSON.parse(text) as { message?: string; detail?: string };
					message = body.message ?? body.detail ?? message;
				} catch {
					// Keep the raw server response when it is not JSON.
				}
				throw new Error(message);
			}
			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = buildExportFilename();
			document.body.appendChild(link);
			link.click();
			link.remove();
			URL.revokeObjectURL(url);
			exportMessage = '日志导出完成';
		} catch (error) {
			exportMessage = error instanceof Error ? error.message : '日志导出失败';
		} finally {
			exporting = false;
		}
	}

	onMount(() => {
		void load();
		const timer = setInterval(() => {
			void load();
		}, 10_000);
		return () => clearInterval(timer);
	});

	function sourceText(source: string) {
		if (source === 'workflow') return '自动补机';
		if (source === 'vm_create') return '创建 VM';
		if (source === 'vm_power') return '电源操作';
		return source || '手动操作';
	}

	function statusBadge(status: string) {
		if (status === 'success') return 'bg-green-900/50 text-green-300';
		if (status === 'running') return 'bg-yellow-900/50 text-yellow-300';
		if (status === 'info') return 'bg-blue-900/50 text-blue-300';
		return 'bg-red-900/50 text-red-300';
	}

	function formatBeijingTime(value: string) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value || '-';
		const parts = beijingDateParts(date);
		return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
	}
</script>

<div class="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
	<div>
		<h1 class="text-2xl font-semibold">执行日志</h1>
		<p class="mt-1 text-sm text-muted">可一键导出最近日志记录，便于核查开机、补机和代理检测流程。</p>
	</div>
	<div class="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
		{#if exportMessage}
			<span class="text-sm text-muted">{exportMessage}</span>
		{/if}
		<button class="btn-primary whitespace-nowrap" type="button" disabled={exporting} onclick={() => void exportLogs()}>
			{exporting ? '正在导出...' : '一键导出日志'}
		</button>
	</div>
</div>

<div class="card overflow-x-auto">
	<table class="w-full text-sm">
		<thead class="text-muted">
			<tr class="border-b border-border">
				<th class="min-w-[175px] whitespace-nowrap p-3 text-left">时间 (北京时间 UTC+8)</th>
				<th class="p-3 text-left">来源</th>
				<th class="p-3 text-left">策略/账号</th>
				<th class="p-3 text-left">资源</th>
				<th class="p-3 text-left">动作</th>
				<th class="p-3 text-left">状态</th>
				<th class="p-3 text-left">消息</th>
			</tr>
		</thead>
		<tbody>
			{#if logs.length === 0}
				<tr>
					<td class="p-3 text-muted" colspan="7">暂无日志</td>
				</tr>
			{:else}
				{#each logs as log}
					<tr class="border-b border-border/60">
						<td class="whitespace-nowrap p-3 font-mono text-xs tabular-nums">
							{formatBeijingTime(log.created_at)}
						</td>
						<td class="p-3">{sourceText(log.source)}</td>
						<td class="p-3">
							{#if log.policy_id}
								策略 #{log.policy_id}
							{:else if log.account_id}
								账号 #{log.account_id}
							{:else}
								-
							{/if}
						</td>
						<td class="p-3">
							<div>{log.vm_name || '-'}</div>
							<div class="text-xs text-muted">{log.resource_group || '-'}</div>
						</td>
						<td class="p-3">{log.action}</td>
						<td class="p-3">
							<span class={`badge ${statusBadge(log.status)}`}>
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
