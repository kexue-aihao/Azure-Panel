import { beijingFileTimestamp, formatBeijingDateTime } from '$lib/server/beijing-time';
import { listUnifiedExecutionLogs } from '$lib/server/db/repo';
import { requireUser } from '$lib/server/http';
import type { RequestHandler } from './$types';

const EXPORT_LIMIT = 5000;

function sourceText(source: string) {
	if (source === 'workflow') return '自动补机';
	if (source === 'vm_create') return '创建 VM';
	if (source === 'vm_power') return '电源操作';
	return source || '手动操作';
}

function csvCell(value: unknown) {
	const text = String(value ?? '');
	if (!/[",\r\n]/.test(text)) return text;
	return `"${text.replaceAll('"', '""')}"`;
}

function csvLine(values: unknown[]) {
	return values.map(csvCell).join(',');
}

function exportFileName() {
	return `azure-panel-logs-${beijingFileTimestamp()}.csv`;
}

export const GET: RequestHandler = async (event) => {
	const user = await requireUser(event);
	const policyId = event.url.searchParams.get('policy_id');
	const parsedPolicyId = policyId ? Number(policyId) : undefined;
	const logs = await listUnifiedExecutionLogs(user.id, parsedPolicyId, EXPORT_LIMIT);
	const rows = [
		csvLine(['时间(UTC+8)', '来源', '策略ID', '账号ID', '资源组', 'VM名称', '动作', '状态', '消息']),
		...logs.map((log) =>
			csvLine([
				formatBeijingDateTime(log.createdAt),
				sourceText(log.source),
				log.policyId ?? '',
				log.accountId ?? '',
				log.resourceGroup,
				log.vmName,
				log.action,
				log.status,
				log.message
			])
		)
	];

	return new Response(`\ufeff${rows.join('\r\n')}\r\n`, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="${exportFileName()}"`
		}
	});
};
