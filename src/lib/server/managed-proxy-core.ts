import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { decryptSecret } from './crypto';
import { getProjectRoot, readEnv } from './runtime-env';
import type { ProxyProfile } from './db/schema';
import type { ProxyRuntimeConfig } from './proxy';

export type ManagedProxyCore = 'sing-box' | 'xray';

type ManagedProcess = {
	key: string;
	core: ManagedProxyCore;
	port: number;
	process: ChildProcess;
	configPath: string;
	ready: Promise<ProxyRuntimeConfig>;
};

type VlessShare = {
	protocol: 'vless';
	id: string;
	host: string;
	port: number;
	remark: string;
	params: URLSearchParams;
};

const managedProcesses = new Map<string, ManagedProcess>();
const DEFAULT_MANAGED_PROXY_HOST = '127.0.0.1';
const SUPPORTED_VLESS_TRANSPORTS = new Set(['tcp', 'ws', 'grpc']);

function safeDecode(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function managedDir() {
	const dir = readEnv('MANAGED_PROXY_DIR') ?? join(getProjectRoot(), 'data', 'managed-proxies');
	mkdirSync(dir, { recursive: true });
	return dir;
}

function resolveCoreBinary(core: ManagedProxyCore) {
	const envKey = core === 'sing-box' ? 'SING_BOX_BIN' : 'XRAY_BIN';
	const envPath = readEnv(envKey);
	if (envPath && existsSync(envPath)) return envPath;

	const exe = process.platform === 'win32' ? '.exe' : '';
	const local = join(getProjectRoot(), 'bin', `${core}${exe}`);
	if (existsSync(local)) return local;

	return core;
}

function processKey(core: ManagedProxyCore, shareLink: string) {
	return `${core}:${createHash('sha256').update(shareLink).digest('hex')}`;
}

async function allocateLocalPort() {
	return new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, DEFAULT_MANAGED_PROXY_HOST, () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => {
				if (port) resolve(port);
				else reject(new Error('无法分配本地代理端口'));
			});
		});
	});
}

async function isLocalPortFree(port: number) {
	return new Promise<boolean>((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.listen(port, DEFAULT_MANAGED_PROXY_HOST, () => {
			server.close(() => resolve(true));
		});
	});
}

async function resolveListenPort(preferredPort?: number) {
	if (preferredPort && Number.isInteger(preferredPort) && preferredPort > 0 && preferredPort <= 65535) {
		if (await isLocalPortFree(preferredPort)) return preferredPort;
		throw new Error(`托管代理本地端口 ${preferredPort} 已被占用`);
	}
	return allocateLocalPort();
}

function parseVlessShareLink(shareLink: string): VlessShare {
	const parsed = new URL(shareLink);
	if (parsed.protocol !== 'vless:') throw new Error('当前托管核心仅支持 VLESS 分享链接');
	if (!parsed.username) throw new Error('VLESS 分享链接缺少 UUID');
	if (!parsed.hostname) throw new Error('VLESS 分享链接缺少服务器地址');
	const port = Number(parsed.port || 443);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error('VLESS 分享链接端口无效');
	}
	return {
		protocol: 'vless',
		id: safeDecode(parsed.username),
		host: parsed.hostname,
		port,
		remark: parsed.hash ? safeDecode(parsed.hash.slice(1)) : '',
		params: parsed.searchParams
	};
}

function buildSingBoxConfig(shareLink: string, listenPort: number) {
	const node = parseVlessShareLink(shareLink);
	const security = node.params.get('security') ?? '';
	const flow = node.params.get('flow') ?? '';
	const transport = node.params.get('type') ?? 'tcp';
	if (!SUPPORTED_VLESS_TRANSPORTS.has(transport)) {
		throw new Error(`当前内置 sing-box 托管暂不支持 VLESS ${transport} 传输，请改用本地客户端转换为 HTTP/SOCKS 端口`);
	}
	const outbound: Record<string, unknown> = {
		type: 'vless',
		tag: 'proxy',
		server: node.host,
		server_port: node.port,
		uuid: node.id,
		flow: flow || undefined,
		packet_encoding: node.params.get('packetEncoding') ?? undefined
	};

	if (security === 'reality' || security === 'tls') {
		outbound.tls = {
			enabled: true,
			server_name: node.params.get('sni') || node.params.get('peer') || node.host,
			utls: {
				enabled: Boolean(node.params.get('fp')),
				fingerprint: node.params.get('fp') || undefined
			},
			reality:
				security === 'reality'
					? {
							enabled: true,
							public_key: node.params.get('pbk') || '',
							short_id: node.params.get('sid') || ''
						}
					: undefined
		};
	}

	if (transport !== 'tcp') {
		outbound.transport = buildSingBoxTransport(node.params, transport);
	}

	return {
		log: {
			level: 'warn',
			timestamp: true
		},
		inbounds: [
			{
				type: 'mixed',
				tag: 'mixed-in',
				listen: DEFAULT_MANAGED_PROXY_HOST,
				listen_port: listenPort,
				users: []
			}
		],
		outbounds: [
			outbound,
			{
				type: 'direct',
				tag: 'direct'
			}
		],
		route: {
			final: 'proxy'
		}
	};
}

function buildSingBoxTransport(params: URLSearchParams, transport: string) {
	if (transport === 'ws') {
		return {
			type: 'ws',
			path: params.get('path') || '/',
			headers: params.get('host') ? { Host: params.get('host') } : undefined
		};
	}
	if (transport === 'grpc') {
		return {
			type: 'grpc',
			service_name: params.get('serviceName') || ''
		};
	}
	return {
		type: transport
	};
}

function buildXrayConfig(shareLink: string, listenPort: number) {
	const node = parseVlessShareLink(shareLink);
	const security = node.params.get('security') ?? '';
	const network = node.params.get('type') ?? 'tcp';
	if (!SUPPORTED_VLESS_TRANSPORTS.has(network)) {
		throw new Error(`当前内置 Xray 托管暂不支持 VLESS ${network} 传输，请改用本地客户端转换为 HTTP/SOCKS 端口`);
	}
	const outbound: Record<string, unknown> = {
		tag: 'proxy',
		protocol: 'vless',
		settings: {
			vnext: [
				{
					address: node.host,
					port: node.port,
					users: [
						{
							id: node.id,
							encryption: node.params.get('encryption') || 'none',
							flow: node.params.get('flow') || undefined
						}
					]
				}
			]
		},
		streamSettings: {
			network,
			security,
			realitySettings:
				security === 'reality'
					? {
							serverName: node.params.get('sni') || node.host,
							fingerprint: node.params.get('fp') || 'chrome',
							publicKey: node.params.get('pbk') || '',
							shortId: node.params.get('sid') || ''
						}
					: undefined,
			tlsSettings:
				security === 'tls'
					? {
							serverName: node.params.get('sni') || node.host
						}
					: undefined,
			wsSettings:
				network === 'ws'
					? {
							path: node.params.get('path') || '/',
							headers: node.params.get('host') ? { Host: node.params.get('host') } : undefined
						}
					: undefined,
			grpcSettings:
				network === 'grpc'
					? {
							serviceName: node.params.get('serviceName') || ''
						}
					: undefined
		}
	};

	return {
		log: {
			loglevel: 'warning'
		},
		inbounds: [
			{
				tag: 'http-in',
				listen: DEFAULT_MANAGED_PROXY_HOST,
				port: listenPort,
				protocol: 'http',
				settings: {}
			}
		],
		outbounds: [
			outbound,
			{
				tag: 'direct',
				protocol: 'freedom'
			}
		],
		routing: {
			domainStrategy: 'AsIs',
			rules: []
		}
	};
}

function buildConfig(core: ManagedProxyCore, shareLink: string, listenPort: number) {
	return core === 'sing-box'
		? buildSingBoxConfig(shareLink, listenPort)
		: buildXrayConfig(shareLink, listenPort);
}

function coreArgs(core: ManagedProxyCore, configPath: string) {
	return core === 'sing-box' ? ['run', '-c', configPath] : ['run', '-config', configPath];
}

async function waitForManagedProxy(proxy: ProxyRuntimeConfig, getStartError: () => Error | null) {
	const deadline = Date.now() + 8000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const startError = getStartError();
		if (startError) throw startError;
		try {
			await connectLocalPort(proxy.port, 500);
			return proxy;
		} catch (err) {
			lastError = err;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(`托管代理核心启动后端口未就绪: ${String(lastError)}`);
}

function connectLocalPort(port: number, timeoutMs: number) {
	return new Promise<void>((resolve, reject) => {
		const socket = net.connect({ host: DEFAULT_MANAGED_PROXY_HOST, port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error('连接本机代理端口超时'));
		}, timeoutMs);
		socket.once('connect', () => {
			clearTimeout(timer);
			socket.end();
			resolve();
		});
		socket.once('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

export function canManageShareLink(shareLink: string) {
	try {
		const protocol = new URL(shareLink.trim()).protocol.replace(':', '').toLowerCase();
		return protocol === 'vless';
	} catch {
		return false;
	}
}

export async function startManagedProxyFromShareLink(
	shareLink: string,
	options: { core?: ManagedProxyCore; port?: number } = {}
): Promise<ProxyRuntimeConfig> {
	const core = options.core ?? 'sing-box';
	const key = processKey(core, shareLink);
	const existing = managedProcesses.get(key);
	if (existing && existing.process.exitCode === null && !existing.process.killed) {
		return existing.ready;
	}
	if (existing) managedProcesses.delete(key);

	const port = await resolveListenPort(options.port);
	const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
	const configPath = join(managedDir(), `${core}-${hash}.json`);
	const config = buildConfig(core, shareLink, port);
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

	const bin = resolveCoreBinary(core);
	const child = spawn(bin, coreArgs(core, configPath), {
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	});
	const proxy: ProxyRuntimeConfig = {
		type: 'http',
		host: DEFAULT_MANAGED_PROXY_HOST,
		port
	};
	let stderr = '';
	let startError: Error | null = null;
	child.stderr.on('data', (chunk) => {
		stderr += String(chunk).slice(0, 1200);
	});
	child.once('error', (err) => {
		startError = err;
	});
	child.on('exit', () => {
		const current = managedProcesses.get(key);
		if (current?.process === child) managedProcesses.delete(key);
	});

	const ready = waitForManagedProxy(proxy, () => startError).catch((err) => {
		if (child.exitCode === null && !child.killed) child.kill();
		const hint = stderr.trim() ? `，核心输出：${stderr.trim()}` : '';
		const binHint =
			err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT'
				? `。未找到 ${core} 核心，请运行 install.sh/update.sh 自动安装，或在 .env 设置 ${core === 'sing-box' ? 'SING_BOX_BIN' : 'XRAY_BIN'}`
				: '';
		throw new Error(`${err instanceof Error ? err.message : String(err)}${binHint}${hint}`);
	});
	managedProcesses.set(key, { key, core, port, process: child, configPath, ready });
	return ready;
}

export async function stopManagedProxyFromShareLink(shareLink: string, core: ManagedProxyCore) {
	const key = processKey(core, shareLink);
	const managed = managedProcesses.get(key);
	if (!managed) return;
	managedProcesses.delete(key);
	if (managed.process.exitCode === null && !managed.process.killed) {
		managed.process.kill();
	}
}

export async function stopManagedProxyForProfile(profile: ProxyProfile) {
	const core = normalizeManagedCore(profile.managedCore ?? '');
	const encrypted = profile.shareLinkEncrypted ?? '';
	if (!core || !encrypted) return;
	await stopManagedProxyFromShareLink(decryptSecret(encrypted), core);
}

export async function ensureManagedProxyForProfile(profile: ProxyProfile): Promise<ProxyRuntimeConfig | null> {
	const core = normalizeManagedCore(profile.managedCore ?? '');
	const encrypted = profile.shareLinkEncrypted ?? '';
	if (!core || !encrypted) return null;
	return startManagedProxyFromShareLink(decryptSecret(encrypted), { core, port: profile.port });
}

export function normalizeManagedCore(value: string): ManagedProxyCore | null {
	const normalized = value.trim().toLowerCase();
	if (normalized === 'sing-box' || normalized === 'xray') return normalized;
	return null;
}
