import type { CreateVmProgressEvent } from './azure';
import { insertExecutionLog } from './db/repo';

export type VmOperationProgress = (
	event: CreateVmProgressEvent
) => void | Promise<void>;

export function wantsProgressStream(request: Request) {
	return request.headers.get('accept')?.includes('application/x-ndjson') ?? false;
}

export function operationProgressEvent(
	step: string,
	status: CreateVmProgressEvent['status'],
	message: string,
	detail?: CreateVmProgressEvent['detail']
): CreateVmProgressEvent {
	return {
		step,
		status,
		message,
		detail,
		timestamp: new Date().toISOString()
	};
}

function errorMessage(err: unknown) {
	return err instanceof Error ? err.message : String(err);
}

function streamMessage(controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) {
	controller.enqueue(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
}

export function vmOperationStream<T>(options: {
	run: (progress: VmOperationProgress) => Promise<T>;
	onProgress?: (event: CreateVmProgressEvent) => void | Promise<void>;
	errorStep?: string;
}) {
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const progress = async (event: CreateVmProgressEvent) => {
				streamMessage(controller, { type: 'progress', event });
				await options.onProgress?.(event);
			};

			try {
				const result = await options.run(progress);
				streamMessage(controller, { type: 'result', result });
			} catch (err) {
				const message = errorMessage(err);
				if (options.errorStep) {
					await progress(operationProgressEvent(options.errorStep, 'error', message));
				}
				streamMessage(controller, { type: 'error', message });
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'application/x-ndjson; charset=utf-8',
			'cache-control': 'no-store',
			'x-accel-buffering': 'no'
		}
	});
}

export async function writeVmOperationLog(options: {
	userId: number;
	accountId: number;
	source: string;
	resourceGroup: string;
	vmName: string;
	event: CreateVmProgressEvent;
}) {
	await insertExecutionLog({
		userId: options.userId,
		accountId: options.accountId,
		source: options.source,
		action: options.event.step,
		status: options.event.status,
		message: options.event.message,
		resourceGroup: options.resourceGroup,
		vmName: options.vmName
	}).catch((logErr) => {
		console.warn(`[execution-log] failed to write ${options.source} log:`, logErr);
	});
}
