import { createHash } from 'node:crypto';
import { gunzip, inflateRaw as zlibInflateRaw } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { decryptSecret } from './crypto';
import { getProjectRoot, readEnv } from './runtime-env';
import type { ProxyProfile } from './db/schema';
import { updateProxyProfilePort } from './db/repo';
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
const managedStartPromises = new Map<string, Promise<ProxyRuntimeConfig>>();
const DEFAULT_MANAGED_PROXY_HOST = '127.0.0.1';
const SUPPORTED_VLESS_TRANSPORTS = new Set(['tcp', 'ws', 'grpc']);
const CORE_INSTALL_PROMISES = new Map<ManagedProxyCore, Promise<string>>();

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

function coreEnvKey(core: ManagedProxyCore) {
	return core === 'sing-box' ? 'SING_BOX_BIN' : 'XRAY_BIN';
}

function localCorePath(core: ManagedProxyCore) {
	const exe = process.platform === 'win32' ? '.exe' : '';
	return join(getProjectRoot(), 'bin', `${core}${exe}`);
}

function resolveExistingCoreBinary(core: ManagedProxyCore) {
	const envKey = core === 'sing-box' ? 'SING_BOX_BIN' : 'XRAY_BIN';
	const envPath = readEnv(envKey);
	if (envPath && existsSync(envPath)) return envPath;

	const local = localCorePath(core);
	if (existsSync(local)) return local;

	return '';
}

async function resolveCoreBinary(core: ManagedProxyCore) {
	const existing = resolveExistingCoreBinary(core);
	if (existing) return existing;
	if (process.platform !== 'linux') {
		throw new Error(`未找到 ${core} 核心，请在 .env 设置 ${coreEnvKey(core)}，或把核心放到 ${localCorePath(core)}`);
	}
	return ensureCoreInstalled(core);
}

function processKey(core: ManagedProxyCore, shareLink: string) {
	return `${core}:${createHash('sha256').update(shareLink).digest('hex')}`;
}

function linuxArch() {
	switch (process.arch) {
		case 'x64':
			return 'amd64';
		case 'arm64':
			return 'arm64';
		default:
			return '';
	}
}

function xrayLinuxArch() {
	switch (process.arch) {
		case 'x64':
			return '64';
		case 'arm64':
			return 'arm64-v8a';
		default:
			return '';
	}
}

function coreDownloadUrls(core: ManagedProxyCore) {
	const arch = linuxArch();
	if (!arch) throw new Error(`当前 CPU 架构 ${process.arch} 暂不支持自动下载 ${core} 核心`);
	if (core === 'sing-box') {
		const version = readEnv('SING_BOX_VERSION') ?? '1.12.0';
		return {
			version,
			urls: [
				`https://github.com/SagerNet/sing-box/releases/download/v${version}/sing-box-${version}-linux-${arch}.tar.gz`
			]
		};
	}
	const xrayArch = xrayLinuxArch();
	if (!xrayArch) throw new Error(`当前 CPU 架构 ${process.arch} 暂不支持自动下载 ${core} 核心`);
	const version = readEnv('XRAY_VERSION') ?? '25.4.30';
	return {
		version,
		urls: [
			`https://github.com/XTLS/Xray-core/releases/download/v${version}/Xray-linux-${xrayArch}.zip`,
			`https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${xrayArch}.zip`,
			`https://github.com/XTLS/Xray-core/releases/download/v25.4.30/Xray-linux-${xrayArch}.zip`
		]
	};
}

async function ensureCoreInstalled(core: ManagedProxyCore) {
	const existing = CORE_INSTALL_PROMISES.get(core);
	if (existing) return existing;
	const promise = installCore(core).finally(() => CORE_INSTALL_PROMISES.delete(core));
	CORE_INSTALL_PROMISES.set(core, promise);
	return promise;
}

async function installCore(core: ManagedProxyCore) {
	const target = localCorePath(core);
	mkdirSync(dirname(target), { recursive: true });
	const { version, urls } = coreDownloadUrls(core);
	const tempDir = await mkdtemp(join(tmpdir(), `azure-panel-${core}-`));

	try {
		const errors: string[] = [];
		for (const url of urls) {
			const archivePath = join(tempDir, basename(new URL(url).pathname));
			try {
				const response = await fetch(url);
				if (!response.ok || !response.body) {
					throw new Error(`HTTP ${response.status}`);
				}
				await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));

				if (core === 'sing-box') {
					await extractTarGzFile(archivePath, 'sing-box', target);
				} else {
					await extractZipFile(archivePath, 'xray', target);
				}
				await chmod(target, 0o755);
				return target;
			} catch (err) {
				errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		throw new Error(errors.join('；'));
	} catch (err) {
		throw new Error(
			`自动安装 ${core} 核心失败: ${err instanceof Error ? err.message : String(err)}。请运行 ./update.sh，或手动下载后在 .env 设置 ${coreEnvKey(core)}`
		);
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function extractTarGzFile(archivePath: string, wantedName: string, target: string) {
	const archive = await gunzipBuffer(readFileSync(archivePath));
	let offset = 0;
	while (offset + 512 <= archive.length) {
		const header = archive.subarray(offset, offset + 512);
		offset += 512;
		if (header.every((byte) => byte === 0)) break;

		const fileName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
		const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
		const size = Number.parseInt(sizeOctal || '0', 8);
		const typeFlag = header.subarray(156, 157).toString('utf8');
		const dataStart = offset;
		const dataEnd = dataStart + size;
		if ((!typeFlag || typeFlag === '0') && basename(fileName) === wantedName) {
			await writeFile(target, archive.subarray(dataStart, dataEnd));
			return;
		}
		offset = dataStart + size + ((512 - (size % 512)) % 512);
	}
	throw new Error(`压缩包中未找到 ${wantedName}`);
}

async function extractZipFile(archivePath: string, wantedName: string, target: string) {
	const buffer = readFileSync(archivePath);
	let offset = 0;
	while (offset < buffer.length - 30) {
		if (buffer.readUInt32LE(offset) !== 0x04034b50) {
			offset += 1;
			continue;
		}
		const flags = buffer.readUInt16LE(offset + 6);
		const method = buffer.readUInt16LE(offset + 8);
		const compressedSize = buffer.readUInt32LE(offset + 18);
		const fileNameLength = buffer.readUInt16LE(offset + 26);
		const extraLength = buffer.readUInt16LE(offset + 28);
		const fileName = buffer.subarray(offset + 30, offset + 30 + fileNameLength).toString('utf8');
		const dataStart = offset + 30 + fileNameLength + extraLength;
		const dataEnd = dataStart + compressedSize;
		if ((flags & 0x08) !== 0) throw new Error('暂不支持带 data descriptor 的 zip 包');
		if (basename(fileName) === wantedName) {
			const compressed = buffer.subarray(dataStart, dataEnd);
			let data: Buffer;
			if (method === 0) {
				data = compressed;
			} else if (method === 8) {
				data = await inflateRawBuffer(compressed);
			} else {
				throw new Error(`不支持的 zip 压缩方法: ${method}`);
			}
			await writeFile(target, data);
			return;
		}
		offset = dataEnd;
	}
	throw new Error(`压缩包中未找到 ${wantedName}`);
}

function inflateRawBuffer(buffer: Buffer) {
	return new Promise<Buffer>((resolve, reject) => {
		zlibInflateRaw(buffer, (err: Error | null, result: Buffer) => {
			if (err) reject(err);
			else resolve(result);
		});
	});
}

function gunzipBuffer(buffer: Buffer) {
	return new Promise<Buffer>((resolve, reject) => {
		gunzip(buffer, (err, result) => {
			if (err) reject(err);
			else resolve(result);
		});
	});
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

async function resolveReusableListenPort(preferredPort?: number) {
	if (preferredPort && Number.isInteger(preferredPort) && preferredPort > 0 && preferredPort <= 65535) {
		if (await isLocalPortFree(preferredPort)) return preferredPort;
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
			await verifyHttpProxyConnect(proxy.port, 1200);
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

function verifyHttpProxyConnect(port: number, timeoutMs: number) {
	return new Promise<void>((resolve, reject) => {
		const socket = net.connect({ host: DEFAULT_MANAGED_PROXY_HOST, port });
		let buffer = '';
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error('HTTP 代理 CONNECT 验证超时'));
		}, timeoutMs);
		const cleanup = () => clearTimeout(timer);

		socket.once('connect', () => {
			socket.write(
				'CONNECT management.azure.com:443 HTTP/1.1\r\nHost: management.azure.com:443\r\n\r\n'
			);
		});
		socket.on('data', (chunk) => {
			buffer += String(chunk);
			if (!buffer.includes('\r\n\r\n')) return;
			cleanup();
			socket.end();
			if (/^HTTP\/\d(?:\.\d)? 2\d\d/i.test(buffer)) {
				resolve();
				return;
			}
			reject(new Error(`HTTP 代理 CONNECT 验证失败: ${buffer.split('\r\n')[0] || '无响应状态'}`));
		});
		socket.once('error', (err) => {
			cleanup();
			reject(err);
		});
		socket.once('end', () => {
			cleanup();
			if (!buffer) reject(new Error('HTTP 代理 CONNECT 验证无响应'));
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
	const pending = managedStartPromises.get(key);
	if (pending) return pending;

	const promise = startManagedProxyProcess(shareLink, { ...options, core }, key).finally(() => {
		managedStartPromises.delete(key);
	});
	managedStartPromises.set(key, promise);
	return promise;
}

async function ensureManagedProxyFromShareLink(
	shareLink: string,
	options: { core: ManagedProxyCore; port?: number }
): Promise<ProxyRuntimeConfig> {
	const core = options.core;
	const key = processKey(core, shareLink);
	const pending = managedStartPromises.get(key);
	if (pending) return pending;

	const promise = (async () => {
		const existing = managedProcesses.get(key);
		if (existing && existing.process.exitCode === null && !existing.process.killed) {
			return existing.ready;
		}
		const port = await resolveReusableListenPort(options.port);
		return startManagedProxyProcess(shareLink, { core, port }, key);
	})().finally(() => {
		managedStartPromises.delete(key);
	});

	managedStartPromises.set(key, promise);
	return promise;
}

async function startManagedProxyProcess(
	shareLink: string,
	options: { core: ManagedProxyCore; port?: number },
	key: string
): Promise<ProxyRuntimeConfig> {
	const core = options.core;
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

	const bin = await resolveCoreBinary(core);
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
	child.stdout.on('data', () => {
		// Drain stdout so verbose cores cannot block on a full pipe.
	});
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

export function stopAllManagedProxyProcesses(signal: NodeJS.Signals = 'SIGTERM') {
	for (const managed of managedProcesses.values()) {
		if (managed.process.exitCode === null && !managed.process.killed) {
			managed.process.kill(signal);
		}
	}
	managedProcesses.clear();
	managedStartPromises.clear();
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
	const proxy = await ensureManagedProxyFromShareLink(decryptSecret(encrypted), {
		core,
		port: profile.port
	});
	if (proxy.port !== profile.port) {
		await updateProxyProfilePort(profile.id, proxy.port);
	}
	return proxy;
}

export function normalizeManagedCore(value: string): ManagedProxyCore | null {
	const normalized = value.trim().toLowerCase();
	if (normalized === 'sing-box' || normalized === 'xray') return normalized;
	return null;
}

let shutdownHooksInstalled = false;

function installManagedProxyShutdownHooks() {
	if (shutdownHooksInstalled) return;
	shutdownHooksInstalled = true;

	process.once('exit', () => {
		stopAllManagedProxyProcesses('SIGTERM');
	});

	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.once(signal, () => {
			stopAllManagedProxyProcesses('SIGTERM');
			process.exit(signal === 'SIGINT' ? 130 : 143);
		});
	}
}

installManagedProxyShutdownHooks();
