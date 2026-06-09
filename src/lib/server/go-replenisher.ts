import { readEnv } from './runtime-env';

export type GoReplenisherDispatchPayload = {
	policyId: number;
	userId: number;
	deficit: number;
	targetCount: number;
	trackedCount: number;
	accountPoolSize: number;
	triggerAccountName: string;
	subscriptionState: string;
	location: string;
	vmSize: string;
	enableIpv6: boolean;
	enableAcceleratedNetworking: boolean;
	enableDdosProtection: boolean;
	ipPrefix: string;
	ipBrushMaxAttempts: number;
};

export type GoReplenisherDispatchResult = {
	accepted: boolean;
	operationId?: string;
	mode?: string;
	deadlineSeconds?: number;
	message?: string;
	submittedAt?: string;
	observedAccountPool?: number;
	observedCreateDeficit?: number;
};

function envValue(...keys: string[]) {
	for (const key of keys) {
		const value = readEnv(key);
		if (value !== undefined && value !== '') return value;
	}
	return undefined;
}

function isTruthy(value: string | undefined) {
	return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function intEnv(key: string, fallback: number) {
	const value = Number(readEnv(key));
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function isGoReplenisherEnabled() {
	return isTruthy(envValue('GO_REPLENISHER_ENABLED', 'GO_REPLENISHMENT_ENABLED'));
}

export function getGoReplenisherBaseUrl() {
	return envValue('GO_REPLENISHER_URL', 'GO_REPLENISHMENT_URL') ?? 'http://127.0.0.1:43170';
}

export async function dispatchReplenishmentToGoSidecar(
	payload: GoReplenisherDispatchPayload
): Promise<GoReplenisherDispatchResult> {
	if (!isGoReplenisherEnabled()) {
		return { accepted: false, message: 'go replenisher disabled' };
	}

	const timeoutMs = intEnv('GO_REPLENISHER_TIMEOUT_MS', 1500);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const url = new URL('/v1/replenishment/dispatch', getGoReplenisherBaseUrl());
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};
		const token = envValue('GO_REPLENISHER_TOKEN', 'GO_REPLENISHMENT_TOKEN');
		if (token) {
			headers.Authorization = `Bearer ${token}`;
			headers['X-Replenisher-Token'] = token;
		}

		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
			signal: controller.signal
		});
		const text = await response.text();
		const data: GoReplenisherDispatchResult & { message?: string } = text
			? (JSON.parse(text) as GoReplenisherDispatchResult & { message?: string })
			: { accepted: false };
		if (!response.ok) {
			throw new Error(data.message || `Go replenisher returned HTTP ${response.status}`);
		}
		return data;
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw new Error(`Go replenisher dispatch timed out after ${timeoutMs}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}
