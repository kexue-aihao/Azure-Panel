export class ApiError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
	const token = localStorage.getItem('token');
	const headers = new Headers(options.headers);
	headers.set('Content-Type', 'application/json');
	if (token) headers.set('Authorization', `Bearer ${token}`);

	const resp = await fetch(path, { ...options, headers });
	const text = await resp.text();
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { message: text };
	}

	if (!resp.ok) {
		const body = data as { message?: string; detail?: string };
		throw new ApiError(body.message ?? body.detail ?? `请求失败 (${resp.status})`, resp.status);
	}
	return data as T;
}
