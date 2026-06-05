import { insertProxyProfile, listProxyProfilesByUser } from './db/repo';
import type { ProxyProfile } from './db/schema';
import {
	AUTO_CLIENT_IP_PROXY_CANDIDATES,
	AUTO_CLIENT_IP_PROXY_NAME,
	CLIENT_IP_PROXY_HOST,
	normalizeProxyRuntime,
	publicProxyProfile,
	validateProxyConnection,
	type PublicProxyProfile
} from './proxy';

type CandidateStatus = {
	type: string;
	port: number;
	label: string;
	available: boolean;
	error: string;
};

export type ClientIpProxyStatus = {
	client_ip: string;
	available: boolean;
	profile: PublicProxyProfile | null;
	candidates: CandidateStatus[];
	message: string;
};

function autoProfileMatches(profile: ProxyProfile, candidate: { type: string; port: number }) {
	return (
		profile.host === CLIENT_IP_PROXY_HOST &&
		profile.type === candidate.type &&
		profile.port === candidate.port &&
		profile.name === AUTO_CLIENT_IP_PROXY_NAME
	);
}

async function checkCandidate(
	clientIp: string,
	candidate: (typeof AUTO_CLIENT_IP_PROXY_CANDIDATES)[number],
	timeoutMs: number
): Promise<CandidateStatus> {
	try {
		const proxy = normalizeProxyRuntime({
			type: candidate.type,
			host: CLIENT_IP_PROXY_HOST,
			port: candidate.port
		});
		await validateProxyConnection(proxy, { clientIp, timeoutMs });
		return { ...candidate, available: true, error: '' };
	} catch (err) {
		return {
			...candidate,
			available: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

export async function detectClientIpProxy(
	userId: number,
	clientIp: string,
	options: { create?: boolean; timeoutMs?: number } = {}
): Promise<ClientIpProxyStatus> {
	const normalizedClientIp = clientIp.trim();
	if (!normalizedClientIp) {
		return {
			client_ip: '',
			available: false,
			profile: null,
			candidates: [],
			message: '未识别到当前访问网站 IP'
		};
	}

	const timeoutMs = options.timeoutMs ?? 1200;
	const candidates = await Promise.all(
		AUTO_CLIENT_IP_PROXY_CANDIDATES.map((candidate) =>
			checkCandidate(normalizedClientIp, candidate, timeoutMs)
		)
	);
	const available = candidates.find((candidate) => candidate.available);
	if (!available) {
		return {
			client_ip: normalizedClientIp,
			available: false,
			profile: null,
			candidates,
			message: `当前访问 IP ${normalizedClientIp} 未检测到可用代理端口`
		};
	}

	const profiles = await listProxyProfilesByUser(userId);
	let profile =
		profiles.find((item) => autoProfileMatches(item, available)) ??
		profiles.find(
			(item) =>
				item.host === CLIENT_IP_PROXY_HOST &&
				item.type === available.type &&
				item.port === available.port &&
				!item.usernameEncrypted &&
				!item.passwordEncrypted
		);

	if (!profile && options.create) {
		profile = await insertProxyProfile({
			userId,
			name: AUTO_CLIENT_IP_PROXY_NAME,
			type: available.type,
			host: CLIENT_IP_PROXY_HOST,
			port: available.port,
			usernameEncrypted: '',
			passwordEncrypted: ''
		});
	}

	return {
		client_ip: normalizedClientIp,
		available: true,
		profile: profile ? publicProxyProfile(profile) : null,
		candidates,
		message: profile
			? `已识别当前访问 IP ${normalizedClientIp} 的 ${available.label} 代理`
			: `已检测到 ${available.label}，保存账号时会自动创建代理档案`
	};
}

export async function ensureClientIpProxyProfile(userId: number, clientIp: string) {
	const detected = await detectClientIpProxy(userId, clientIp, { create: true, timeoutMs: 1500 });
	if (!detected.profile) {
		throw new Error(
			`${detected.message}。请确认当前访问者 IP 上已运行 HTTP/SOCKS 代理，常见端口：7890、10808、1080、8080。`
		);
	}

	const profiles = await listProxyProfilesByUser(userId);
	const profile = profiles.find((item) => item.id === detected.profile?.id);
	if (!profile) throw new Error('自动代理档案创建失败');
	return profile;
}
