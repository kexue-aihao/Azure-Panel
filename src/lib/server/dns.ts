import { createHash } from 'node:crypto';
import type { DnsConfig, DnsRecordBinding } from './db/schema';
import { decryptSecret } from './crypto';

export type RainbowDnsDomain = {
	id: number;
	name: string;
	addtime?: string;
	is_hide?: number;
	is_sso?: number;
	recordcount?: number;
	type?: string;
	typename?: string;
	regtime?: string;
	expiretime?: string;
};

export type RainbowDnsRecordLine = {
	id: string | number;
	name: string;
	parent?: string | number | null;
};

export type RainbowDnsDomainDetail = RainbowDnsDomain & {
	recordLine?: RainbowDnsRecordLine[];
	minTTL?: string;
	loginurl?: string;
};

export type RainbowDnsRecord = {
	RecordId: string;
	Domain: string;
	Name: string;
	Type: string;
	Value: string;
	Line: string;
	LineName: string;
	TTL: number;
	MX: number | null;
	Status: string;
	Weight: number | null;
	Remark: string | null;
	UpdateTime: string;
};

export type DnsSyncResult = {
	bindingId: number;
	fqdn: string;
	created: string[];
	updated: string[];
	skipped: string[];
	lastARecordId: string;
	lastAAAARecordId: string;
	lastIpv4: string;
	lastIpv6: string;
};

type RainbowDnsListResponse<T> = {
	total?: number;
	rows?: T[];
	code?: number;
	msg?: string;
};

type RainbowDnsActionResponse<T = unknown> = {
	code?: number;
	msg?: string;
	data?: T;
};

type RainbowDnsRecordInput = {
	name: string;
	type: 'A' | 'AAAA' | string;
	value: string;
	line: string;
	ttl: number;
	weight?: number | null;
	mx?: number | null;
	remark?: string;
};

type RainbowDnsRecordFilters = {
	offset?: number;
	limit?: number;
	keyword?: string;
	subdomain?: string;
	value?: string;
	type?: string;
	line?: string;
	status?: string;
};

export class RainbowDnsError extends Error {
	code: number | null;
	constructor(message: string, code: number | null = null) {
		super(message);
		this.name = 'RainbowDnsError';
		this.code = code;
	}
}

function normalizeBaseUrl(baseUrl: string) {
	const normalized = baseUrl.trim().replace(/\/+$/, '');
	if (!/^https?:\/\//i.test(normalized)) {
		throw new RainbowDnsError('彩虹 DNS 面板地址必须以 http:// 或 https:// 开头');
	}
	return normalized;
}

function md5(value: string) {
	return createHash('md5').update(value).digest('hex').toLowerCase();
}

function compactParams(input: Record<string, unknown>) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(input)) {
		if (value === undefined || value === null || value === '') continue;
		params.set(key, String(value));
	}
	return params;
}

function fqdn(domainName: string, subdomain: string) {
	const name = subdomain.trim();
	if (!name || name === '@') return domainName;
	return `${name}.${domainName}`;
}

function normalizeLineForCompare(line: string | number | null | undefined) {
	const value = String(line ?? '').trim().toLowerCase();
	if (!value || value === '0' || value === 'default') return 'default';
	return value;
}

function recordTypesForBinding(binding: DnsRecordBinding) {
	const type = binding.recordType.toUpperCase();
	if (type === 'A+AAAA' || type === 'AAAA+A' || type === 'BOTH') return ['A', 'AAAA'] as const;
	if (type === 'AAAA') return ['AAAA'] as const;
	return ['A'] as const;
}

function actionOk(response: RainbowDnsActionResponse, fallback: string) {
	if (typeof response.code === 'number' && response.code !== 0) {
		throw new RainbowDnsError(response.msg || fallback, response.code);
	}
}

export class RainbowDnsClient {
	private readonly baseUrl: string;
	private readonly uid: number;
	private readonly apiKey: string;

	constructor(config: { baseUrl: string; uid: number; apiKey: string }) {
		this.baseUrl = normalizeBaseUrl(config.baseUrl);
		this.uid = config.uid;
		this.apiKey = config.apiKey;
	}

	private signedParams(params: Record<string, unknown> = {}) {
		const timestamp = Math.floor(Date.now() / 1000);
		return compactParams({
			uid: this.uid,
			timestamp,
			sign: md5(`${this.uid}${timestamp}${this.apiKey}`),
			...params
		});
	}

	private async post<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
				accept: 'application/json'
			},
			body: this.signedParams(params)
		});
		const text = await response.text();
		let json: T & RainbowDnsActionResponse;
		try {
			json = JSON.parse(text);
		} catch {
			throw new RainbowDnsError(`彩虹 DNS 返回非 JSON 响应 (${response.status})`);
		}
		if (!response.ok) {
			throw new RainbowDnsError(json.msg || `彩虹 DNS 请求失败 (${response.status})`);
		}
		if (typeof json.code === 'number' && json.code !== 0) {
			throw new RainbowDnsError(json.msg || '彩虹 DNS API 调用失败', json.code);
		}
		return json;
	}

	async listDomains(options: { offset?: number; limit?: number; kw?: string } = {}) {
		const result = await this.post<RainbowDnsListResponse<RainbowDnsDomain>>('/api/domain', {
			offset: options.offset ?? 0,
			limit: options.limit ?? 100,
			kw: options.kw
		});
		return {
			total: Number(result.total ?? result.rows?.length ?? 0),
			rows: result.rows ?? []
		};
	}

	async getDomain(domainId: number, options: { loginurl?: boolean } = {}) {
		const result = await this.post<RainbowDnsActionResponse<RainbowDnsDomainDetail>>(
			`/api/domain/${domainId}`,
			{
				loginurl: options.loginurl ? 1 : undefined
			}
		);
		actionOk(result, '获取彩虹 DNS 域名信息失败');
		if (!result.data) throw new RainbowDnsError('彩虹 DNS 未返回域名信息');
		return result.data;
	}

	async listRecords(domainId: number, filters: RainbowDnsRecordFilters = {}) {
		const result = await this.post<RainbowDnsListResponse<RainbowDnsRecord>>(
			`/api/record/data/${domainId}`,
			{
				offset: filters.offset ?? 0,
				limit: filters.limit ?? 100,
				keyword: filters.keyword,
				subdomain: filters.subdomain,
				value: filters.value,
				type: filters.type,
				line: filters.line,
				status: filters.status
			}
		);
		return {
			total: Number(result.total ?? result.rows?.length ?? 0),
			rows: result.rows ?? []
		};
	}

	async addRecord(domainId: number, input: RainbowDnsRecordInput) {
		const result = await this.post<RainbowDnsActionResponse>(`/api/record/add/${domainId}`, input);
		actionOk(result, '新增彩虹 DNS 解析记录失败');
		return result;
	}

	async updateRecord(domainId: number, recordId: string, input: RainbowDnsRecordInput) {
		const result = await this.post<RainbowDnsActionResponse>(`/api/record/update/${domainId}`, {
			recordid: recordId,
			...input
		});
		actionOk(result, '修改彩虹 DNS 解析记录失败');
		return result;
	}

	async deleteRecord(domainId: number, recordId: string) {
		const result = await this.post<RainbowDnsActionResponse>(`/api/record/delete/${domainId}`, {
			recordid: recordId
		});
		actionOk(result, '删除彩虹 DNS 解析记录失败');
		return result;
	}

	async setRecordStatus(domainId: number, recordId: string, status: '0' | '1') {
		const result = await this.post<RainbowDnsActionResponse>(`/api/record/status/${domainId}`, {
			recordid: recordId,
			status
		});
		actionOk(result, '修改彩虹 DNS 解析状态失败');
		return result;
	}

	async setRecordRemark(domainId: number, recordId: string, remark: string) {
		const result = await this.post<RainbowDnsActionResponse>(`/api/record/remark/${domainId}`, {
			recordid: recordId,
			remark
		});
		actionOk(result, '修改彩虹 DNS 解析备注失败');
		return result;
	}
}

export function createRainbowDnsClient(config: DnsConfig) {
	return new RainbowDnsClient({
		baseUrl: config.baseUrl,
		uid: config.uid,
		apiKey: decryptSecret(config.apiKeyEncrypted)
	});
}

export function publicDnsConfig(config: DnsConfig) {
	return {
		id: config.id,
		name: config.name,
		base_url: config.baseUrl,
		uid: config.uid,
		enabled: Boolean(config.enabled),
		created_at: config.createdAt
	};
}

export function publicDnsBinding(binding: DnsRecordBinding) {
	return {
		id: binding.id,
		config_id: binding.configId,
		name: binding.name,
		domain_id: binding.domainId,
		domain_name: binding.domainName,
		subdomain: binding.subdomain,
		record_type: binding.recordType,
		line: binding.line,
		ttl: binding.ttl,
		weight: binding.weight,
		mx: binding.mx,
		remark: binding.remark,
		enabled: Boolean(binding.enabled),
		last_a_record_id: binding.lastARecordId,
		last_aaaa_record_id: binding.lastAAAARecordId,
		last_ipv4: binding.lastIpv4,
		last_ipv6: binding.lastIpv6,
		last_synced_at: binding.lastSyncedAt,
		created_at: binding.createdAt,
		fqdn: fqdn(binding.domainName, binding.subdomain)
	};
}

export async function syncDnsBindingToIp(
	client: RainbowDnsClient,
	binding: DnsRecordBinding,
	ips: { ipv4?: string; ipv6?: string; vmName?: string; resourceGroup?: string }
): Promise<DnsSyncResult> {
	const created: string[] = [];
	const updated: string[] = [];
	const skipped: string[] = [];
	let lastARecordId = binding.lastARecordId ?? '';
	let lastAAAARecordId = binding.lastAAAARecordId ?? '';
	let lastIpv4 = binding.lastIpv4 ?? '';
	let lastIpv6 = binding.lastIpv6 ?? '';
	const remark =
		binding.remark ||
		[
			'Azure Panel',
			ips.vmName ? `VM ${ips.vmName}` : '',
			ips.resourceGroup ? `RG ${ips.resourceGroup}` : ''
		]
			.filter(Boolean)
			.join(' ');

	for (const type of recordTypesForBinding(binding)) {
		const value = type === 'AAAA' ? ips.ipv6 : ips.ipv4;
		if (!value) {
			skipped.push(`${type}: no IP`);
			continue;
		}

		const cachedRecordId = type === 'AAAA' ? lastAAAARecordId : lastARecordId;
		const records = await client.listRecords(binding.domainId, {
			subdomain: binding.subdomain,
			type,
			line: binding.line,
			limit: 100
		});
		const existing =
			records.rows.find((record) => String(record.RecordId) === String(cachedRecordId)) ??
			records.rows.find(
				(record) =>
					record.Name === binding.subdomain &&
					record.Type.toUpperCase() === type &&
					normalizeLineForCompare(record.Line) === normalizeLineForCompare(binding.line)
			);
		const input: RainbowDnsRecordInput = {
			name: binding.subdomain,
			type,
			value,
			line: binding.line,
			ttl: binding.ttl,
			weight: binding.weight,
			mx: binding.mx,
			remark
		};

		if (existing?.RecordId) {
			await client.updateRecord(binding.domainId, existing.RecordId, input);
			updated.push(type);
			if (type === 'AAAA') {
				lastAAAARecordId = String(existing.RecordId);
				lastIpv6 = value;
			} else {
				lastARecordId = String(existing.RecordId);
				lastIpv4 = value;
			}
			continue;
		}

		await client.addRecord(binding.domainId, input);
		created.push(type);
		const fresh = await client.listRecords(binding.domainId, {
			subdomain: binding.subdomain,
			type,
			value,
			line: binding.line,
			limit: 100
		});
		const createdRecord = fresh.rows.find(
			(record) =>
				record.Name === binding.subdomain &&
				record.Type.toUpperCase() === type &&
				record.Value === value &&
				normalizeLineForCompare(record.Line) === normalizeLineForCompare(binding.line)
		);
		if (type === 'AAAA') {
			lastAAAARecordId = createdRecord?.RecordId ? String(createdRecord.RecordId) : '';
			lastIpv6 = value;
		} else {
			lastARecordId = createdRecord?.RecordId ? String(createdRecord.RecordId) : '';
			lastIpv4 = value;
		}
	}

	return {
		bindingId: binding.id,
		fqdn: fqdn(binding.domainName, binding.subdomain),
		created,
		updated,
		skipped,
		lastARecordId,
		lastAAAARecordId,
		lastIpv4,
		lastIpv6
	};
}
