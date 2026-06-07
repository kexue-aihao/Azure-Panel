export type StartupPhase = 'pending' | 'initializing' | 'ready' | 'failed';

type StartupStatus = {
	phase: StartupPhase;
	started_at: string | null;
	ready_at: string | null;
	failed_at: string | null;
	error: string;
};

const status: StartupStatus = {
	phase: 'pending',
	started_at: null,
	ready_at: null,
	failed_at: null,
	error: ''
};

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

export function markStartupInitializing() {
	if (!status.started_at) status.started_at = new Date().toISOString();
	if (status.phase !== 'ready') status.phase = 'initializing';
	status.error = '';
}

export function markStartupReady() {
	status.phase = 'ready';
	status.ready_at = new Date().toISOString();
	status.failed_at = null;
	status.error = '';
}

export function markStartupFailed(err: unknown) {
	status.phase = 'failed';
	status.failed_at = new Date().toISOString();
	status.error = errorMessage(err);
}

export function getStartupStatus(): StartupStatus {
	return { ...status };
}
