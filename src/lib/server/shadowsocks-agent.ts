import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { Agent, type AgentConnectOpts } from 'agent-base';
import type http from 'node:http';
import type { ProxyRuntimeConfig } from './proxy';

type ShadowsocksMethod =
	| 'aes-128-gcm'
	| 'aes-192-gcm'
	| 'aes-256-gcm'
	| 'chacha20-ietf-poly1305';

type CipherSpec = {
	algorithm: crypto.CipherGCMTypes | crypto.CipherChaCha20Poly1305Types;
	keyLength: number;
	saltLength: number;
};

const CHUNK_SIZE = 0x3fff;
const TAG_SIZE = 16;
const INFO = Buffer.from('ss-subkey');

const CIPHERS: Record<ShadowsocksMethod, CipherSpec> = {
	'aes-128-gcm': { algorithm: 'aes-128-gcm', keyLength: 16, saltLength: 16 },
	'aes-192-gcm': { algorithm: 'aes-192-gcm', keyLength: 24, saltLength: 24 },
	'aes-256-gcm': { algorithm: 'aes-256-gcm', keyLength: 32, saltLength: 32 },
	'chacha20-ietf-poly1305': {
		algorithm: 'chacha20-poly1305',
		keyLength: 32,
		saltLength: 32
	}
};

function asMethod(method?: string): ShadowsocksMethod {
	const normalized = method?.toLowerCase() as ShadowsocksMethod | undefined;
	if (normalized && CIPHERS[normalized]) return normalized;
	throw new Error(`暂不支持的 Shadowsocks 方法: ${method || '-'}`);
}

function evpBytesToKey(password: string, keyLength: number) {
	let previous = Buffer.alloc(0);
	const output: Buffer[] = [];
	while (Buffer.concat(output).length < keyLength) {
		const md5 = crypto.createHash('md5');
		md5.update(previous);
		md5.update(password);
		previous = md5.digest();
		output.push(previous);
	}
	return Buffer.concat(output).subarray(0, keyLength);
}

function hkdfSha1(key: Buffer, salt: Buffer, length: number) {
	return Buffer.from(crypto.hkdfSync('sha1', key, salt, INFO, length));
}

function incrementNonce(nonce: Buffer) {
	for (let index = 0; index < nonce.length; index++) {
		nonce[index] = (nonce[index] + 1) & 0xff;
		if (nonce[index] !== 0) break;
	}
}

function createCipher(spec: CipherSpec, key: Buffer, nonce: Buffer) {
	if (spec.algorithm === 'chacha20-poly1305') {
		return crypto.createCipheriv(spec.algorithm, key, nonce, { authTagLength: TAG_SIZE });
	}
	return crypto.createCipheriv(spec.algorithm, key, nonce, { authTagLength: TAG_SIZE });
}

function createDecipher(spec: CipherSpec, key: Buffer, nonce: Buffer) {
	if (spec.algorithm === 'chacha20-poly1305') {
		return crypto.createDecipheriv(spec.algorithm, key, nonce, { authTagLength: TAG_SIZE });
	}
	return crypto.createDecipheriv(spec.algorithm, key, nonce, { authTagLength: TAG_SIZE });
}

function encryptAead(spec: CipherSpec, key: Buffer, nonce: Buffer, payload: Buffer) {
	const cipher = createCipher(spec, key, nonce);
	const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
	const tag = cipher.getAuthTag();
	incrementNonce(nonce);
	return Buffer.concat([encrypted, tag]);
}

function decryptAead(spec: CipherSpec, key: Buffer, nonce: Buffer, payload: Buffer) {
	const encrypted = payload.subarray(0, -TAG_SIZE);
	const tag = payload.subarray(-TAG_SIZE);
	const decipher = createDecipher(spec, key, nonce);
	decipher.setAuthTag(tag);
	const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
	incrementNonce(nonce);
	return decrypted;
}

function encodeAddress(host: string, port: number) {
	const portBuffer = Buffer.alloc(2);
	portBuffer.writeUInt16BE(port);

	if (net.isIPv4(host)) {
		return Buffer.concat([
			Buffer.from([0x01]),
			Buffer.from(host.split('.').map((part) => Number(part))),
			portBuffer
		]);
	}

	const hostBuffer = Buffer.from(host);
	if (hostBuffer.length > 255) throw new Error('目标主机名过长');
	return Buffer.concat([Buffer.from([0x03, hostBuffer.length]), hostBuffer, portBuffer]);
}

function omitConnectionKeys(options: AgentConnectOpts) {
	const { host, path, port, ...rest } = options as AgentConnectOpts & {
		host?: string;
		path?: string;
		port?: number | string;
	};
	return rest;
}

class ShadowsocksSocket extends Duplex {
	private readonly socket: net.Socket;
	private readonly spec: CipherSpec;
	private readonly masterKey: Buffer;
	private readonly targetHeader: Buffer;
	private readonly encKey: Buffer;
	private readonly encNonce = Buffer.alloc(12);
	private decKey: Buffer | null = null;
	private decNonce = Buffer.alloc(12);
	private pendingPayloadLength: number | null = null;
	private inbound = Buffer.alloc(0);
	private sentInitial = false;

	constructor(options: {
		socket: net.Socket;
		method: ShadowsocksMethod;
		password: string;
		targetHost: string;
		targetPort: number;
	}) {
		super();
		this.socket = options.socket;
		this.spec = CIPHERS[options.method];
		this.masterKey = evpBytesToKey(options.password, this.spec.keyLength);
		const salt = crypto.randomBytes(this.spec.saltLength);
		this.encKey = hkdfSha1(this.masterKey, salt, this.spec.keyLength);
		this.targetHeader = encodeAddress(options.targetHost, options.targetPort);
		this.socket.write(salt);

		this.socket.on('data', (chunk) => this.handleInbound(Buffer.from(chunk)));
		this.socket.once('end', () => this.push(null));
		this.socket.once('close', () => this.push(null));
		this.socket.once('error', (err) => this.destroy(err));
	}

	_read() {
		// Data is pushed by the wrapped socket's data event.
	}

	_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
		try {
			const payload = this.sentInitial ? chunk : Buffer.concat([this.targetHeader, chunk]);
			this.sentInitial = true;
			this.socket.write(this.encodeChunks(payload), callback);
		} catch (err) {
			callback(err as Error);
		}
	}

	_final(callback: (error?: Error | null) => void) {
		this.socket.end(callback);
	}

	_destroy(error: Error | null, callback: (error?: Error | null) => void) {
		this.socket.destroy();
		callback(error);
	}

	private encodeChunks(payload: Buffer) {
		const chunks: Buffer[] = [];
		let offset = 0;
		while (offset < payload.length) {
			const part = payload.subarray(offset, offset + CHUNK_SIZE);
			offset += part.length;
			const length = Buffer.alloc(2);
			length.writeUInt16BE(part.length);
			chunks.push(encryptAead(this.spec, this.encKey, this.encNonce, length));
			chunks.push(encryptAead(this.spec, this.encKey, this.encNonce, part));
		}
		return Buffer.concat(chunks);
	}

	private handleInbound(chunk: Buffer) {
		try {
			this.inbound = Buffer.concat([this.inbound, chunk]);
			if (!this.decKey) {
				if (this.inbound.length < this.spec.saltLength) return;
				const salt = this.inbound.subarray(0, this.spec.saltLength);
				this.inbound = this.inbound.subarray(this.spec.saltLength);
				this.decKey = hkdfSha1(this.masterKey, salt, this.spec.keyLength);
			}

			while (this.decKey) {
				if (this.pendingPayloadLength === null) {
					if (this.inbound.length < 2 + TAG_SIZE) return;
					const encryptedLength = this.inbound.subarray(0, 2 + TAG_SIZE);
					this.inbound = this.inbound.subarray(2 + TAG_SIZE);
					const lengthBuffer = decryptAead(this.spec, this.decKey, this.decNonce, encryptedLength);
					this.pendingPayloadLength = lengthBuffer.readUInt16BE();
				}

				const encryptedPayloadLength = this.pendingPayloadLength + TAG_SIZE;
				if (this.inbound.length < encryptedPayloadLength) return;
				const encryptedPayload = this.inbound.subarray(0, encryptedPayloadLength);
				this.inbound = this.inbound.subarray(encryptedPayloadLength);
				this.push(decryptAead(this.spec, this.decKey, this.decNonce, encryptedPayload));
				this.pendingPayloadLength = null;
			}
		} catch (err) {
			this.destroy(err as Error);
		}
	}
}

export class ShadowsocksProxyAgent extends Agent {
	private readonly proxy: ProxyRuntimeConfig;

	constructor(proxy: ProxyRuntimeConfig, options?: http.AgentOptions) {
		super(options);
		this.proxy = proxy;
	}

	async connect(_req: http.ClientRequest, options: AgentConnectOpts) {
		if (!options.host) throw new Error('缺少目标主机');
		const targetPort = Number(options.port);
		const method = asMethod(this.proxy.method);
		const password = this.proxy.password ?? '';
		if (!password) throw new Error('缺少 Shadowsocks 密码');

		const rawSocket = net.connect({ host: this.proxy.host, port: this.proxy.port });
		await new Promise<void>((resolve, reject) => {
			rawSocket.once('connect', resolve);
			rawSocket.once('error', reject);
		});

		const socket = new ShadowsocksSocket({
			socket: rawSocket,
			method,
			password,
			targetHost: options.host,
			targetPort
		});

		if (options.secureEndpoint) {
			return tls.connect({
				...omitConnectionKeys(options),
				socket,
				servername: options.servername ?? options.host
			});
		}

		return socket;
	}
}
