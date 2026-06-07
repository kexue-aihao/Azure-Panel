export type StartupPhase = 'pending' | 'initializing' | 'ready' | 'failed';

type StartupStatus = {
	phase: StartupPhase;
	started_at: string | null;
	ready_at: string | null;
	failed_at: string | null;
	current_step: string;
	step_updated_at: string | null;
	error: string;
};

const status: StartupStatus = {
	phase: 'pending',
	started_at: null,
	ready_at: null,
	failed_at: null,
	current_step: '',
	step_updated_at: null,
	error: ''
};

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

export function markStartupInitializing(step = 'initializing') {
	if (!status.started_at) status.started_at = new Date().toISOString();
	if (status.phase !== 'ready') status.phase = 'initializing';
	status.current_step = step;
	status.step_updated_at = new Date().toISOString();
	status.error = '';
}

export function markStartupReady() {
	status.phase = 'ready';
	status.ready_at = new Date().toISOString();
	status.failed_at = null;
	status.current_step = 'ready';
	status.step_updated_at = status.ready_at;
	status.error = '';
}

export function markStartupFailed(err: unknown) {
	status.phase = 'failed';
	status.failed_at = new Date().toISOString();
	status.step_updated_at = status.failed_at;
	status.error = errorMessage(err);
}

export function markStartupStep(step: string) {
	if (status.phase !== 'ready') status.phase = 'initializing';
	if (!status.started_at) status.started_at = new Date().toISOString();
	status.current_step = step;
	status.step_updated_at = new Date().toISOString();
}

export function getStartupStatus(): StartupStatus {
	return { ...status };
}
