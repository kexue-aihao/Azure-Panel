<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';

	let email = $state('');
	let password = $state('');
	let registerEmail = $state('');
	let registerPassword = $state('');
	let message = $state('');
	let loading = $state(false);

	type AuthResponse = {
		token: string;
		email: string;
		role?: string;
		is_admin?: boolean;
		user?: {
			id: number;
			email: string;
			role: string;
			is_admin: boolean;
			disabled: boolean;
		};
	};

	function persistAuth(data: AuthResponse) {
		localStorage.setItem('token', data.token);
		localStorage.setItem('email', data.email);
		localStorage.setItem('role', data.user?.role ?? data.role ?? 'user');
		localStorage.setItem('is_admin', String(data.user?.is_admin ?? data.is_admin ?? false));
		if (data.user) localStorage.setItem('user', JSON.stringify(data.user));
	}

	async function login() {
		loading = true;
		message = '';
		try {
			const data = await api<AuthResponse>('/api/guest/login', {
				method: 'POST',
				body: JSON.stringify({ email, password })
			});
			persistAuth(data);
			await goto('/vms');
		} catch (err) {
			message = err instanceof Error ? err.message : '登录失败';
		} finally {
			loading = false;
		}
	}

	async function register() {
		loading = true;
		message = '';
		try {
			const data = await api<AuthResponse>('/api/guest/register', {
				method: 'POST',
				body: JSON.stringify({ email: registerEmail, password: registerPassword })
			});
			persistAuth(data);
			await goto('/vms');
		} catch (err) {
			message = err instanceof Error ? err.message : '注册失败';
		} finally {
			loading = false;
		}
	}
</script>

<div class="flex min-h-screen items-center justify-center p-4">
	<div class="card w-full max-w-md space-y-5 p-6">
		<div>
			<h1 class="text-2xl font-semibold">Azure Panel</h1>
			<p class="mt-1 text-sm text-muted">SvelteKit 全栈 · 自动开机补机</p>
		</div>

		{#if message}
			<div class="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
				{message}
			</div>
		{/if}

		<form
			class="space-y-3"
			onsubmit={(e) => {
				e.preventDefault();
				void login();
			}}
		>
			<input class="input" bind:value={email} type="email" placeholder="邮箱" required />
			<input class="input" bind:value={password} type="password" placeholder="密码" required />
			<button class="btn-primary w-full" type="submit" disabled={loading}>登录</button>
		</form>

		<form
			class="space-y-3 border-t border-border pt-4"
			onsubmit={(e) => {
				e.preventDefault();
				void register();
			}}
		>
			<p class="text-sm text-muted">没有账号？注册</p>
			<input class="input" bind:value={registerEmail} type="email" placeholder="注册邮箱" required />
			<input
				class="input"
				bind:value={registerPassword}
				type="password"
				placeholder="至少 6 位密码"
				required
			/>
			<button class="btn-secondary w-full" type="submit" disabled={loading}>注册</button>
		</form>
	</div>
</div>
