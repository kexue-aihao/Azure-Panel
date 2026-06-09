import { readEnv } from './runtime-env';

export type GoPanelDispatchPayload = {
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

export type GoPanelDispatchResult = {
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

function intEnv(...keysAndFallback: Array<string | number>) {
	const fallback = Number(keysAndFallback.at(-1));
	const keys = keysAndFallback.slice(0, -1).map(String);
	for (const key of keys) {
		const value = Number(readEnv(key));
		if (Number.isFinite(value) && value > 0) return value;
	}
	return fallback;
}

export function isGoPanelEnabled() {
	return isTruthy(
		envValue('GO_PANEL_ENABLED', 'GO_PANEL_REPLENISHER_ENABLED', 'GO_REPLENISHER_ENABLED', 'GO_REPLENISHMENT_ENABLED')
	);
}

export function getGoPanelBaseUrl() {
	return (
		envValue('GO_PANEL_URL', 'GO_PANEL_REPLENISHER_URL', 'GO_REPLENISHER_URL', 'GO_REPLENISHMENT_URL') ??
		'http://127.0.0.1:3000'
	);
}

export async function dispatchReplenishmentToGoPanel(
	payload: GoPanelDispatchPayload
): Promise<GoPanelDispatchResult> {
	if (!isGoPanelEnabled()) {
		return { accepted: false, message: 'go panel disabled' };
	}

	const timeoutMs = intEnv('GO_PANEL_TIMEOUT_MS', 'GO_REPLENISHER_TIMEOUT_MS', 1500);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const url = new URL('/v1/replenishment/dispatch', getGoPanelBaseUrl());
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};
		const token = envValue('GO_PANEL_TOKEN', 'GO_REPLENISHER_TOKEN', 'GO_REPLENISHMENT_TOKEN');
		if (token) {
			headers.Authorization = `Bearer ${token}`;
			headers['X-Go-Panel-Token'] = token;
			headers['X-Replenisher-Token'] = token;
		}

		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
			signal: controller.signal
		});
		const text = await response.text();
		let data: GoPanelDispatchResult & { message?: string } = { accepted: false };
		if (text) {
			try {
				data = JSON.parse(text) as GoPanelDispatchResult & { message?: string };
			} catch {
				data = { accepted: false, message: text };
			}
		}
		if (!response.ok) {
			throw new Error(data.message || `Go panel returned HTTP ${response.status}`);
		}
		return data;
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw new Error(`Go panel dispatch timed out after ${timeoutMs}ms`);
		}
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}
