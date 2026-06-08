<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '$lib/api';
	import { createTranslator, languages, normalizeLanguage, type LanguageCode } from '$lib/i18n';
	import { onMount } from 'svelte';

	let email = $state('');
	let password = $state('');
	let totpCode = $state('');
	let requires2fa = $state(false);
	let registerEmail = $state('');
	let registerPassword = $state('');
	let message = $state('');
	let loading = $state(false);
	let language = $state<LanguageCode>('zh');
	let t = $derived(createTranslator(language));

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
			totp_enabled?: boolean;
		};
		requires_2fa?: boolean;
		message?: string;
	};

	function persistAuth(data: AuthResponse) {
		localStorage.setItem('token', data.token);
		localStorage.setItem('email', data.email);
		localStorage.setItem('role', data.user?.role ?? data.role ?? 'user');
		localStorage.setItem('is_admin', String(data.user?.is_admin ?? data.is_admin ?? false));
		if (data.user) localStorage.setItem('user', JSON.stringify(data.user));
	}

	function setLanguage(value: string) {
		language = normalizeLanguage(value);
		localStorage.setItem('language', language);
	}

	function normalizeTotpInput(value: string) {
		return String(value ?? '')
			.replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
			.replace(/\D/g, '')
			.slice(0, 6);
	}

	async function login() {
		loading = true;
		message = '';
		const cleanTotpCode = normalizeTotpInput(totpCode);
		totpCode = cleanTotpCode;
		if (requires2fa && cleanTotpCode.length !== 6) {
			message = '请输入 6 位二步验证码';
			loading = false;
			return;
		}
		try {
			const data = await api<AuthResponse>('/api/guest/login', {
				method: 'POST',
				body: JSON.stringify({ email, password, totp_code: cleanTotpCode })
			});
			if (data.requires_2fa) {
				requires2fa = true;
				message = data.message || '请输入二步验证码';
				return;
			}
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

	onMount(() => {
		language = normalizeLanguage(localStorage.getItem('language'));
	});
</script>

<div class="flex min-h-screen items-center justify-center p-4">
	<div class="card w-full max-w-md space-y-5 p-6">
		<div class="flex justify-end">
			<label class="sr-only" for="login-language">{t('language.label')}</label>
			<select
				id="login-language"
				class="input max-w-36 text-xs"
				value={language}
				onchange={(event) => setLanguage(event.currentTarget.value)}
			>
				{#each languages as option}
					<option value={option.code}>{option.label}</option>
				{/each}
			</select>
		</div>
		<div>
			<h1 class="text-2xl font-semibold">Azure Panel</h1>
			<p class="mt-1 text-sm text-muted">{t('login.subtitle')}</p>
		</div>

		{#if message}
			<div class="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
				{message}
			</div>
		{/if}

		<form
			class="space-y-3"
			novalidate
			onsubmit={(e) => {
				e.preventDefault();
				void login();
			}}
		>
			<input class="input" bind:value={email} type="email" placeholder={t('login.email')} required />
			<input class="input" bind:value={password} type="password" placeholder={t('login.password')} required />
			{#if requires2fa}
				<input
					class="input"
					bind:value={totpCode}
					inputmode="numeric"
					maxlength="6"
					autocomplete="one-time-code"
					oninput={(event) => {
						totpCode = normalizeTotpInput(event.currentTarget.value);
					}}
					placeholder={t('login.totp')}
					required
				/>
			{/if}
			<button class="btn-primary w-full" type="submit" disabled={loading}>{t('login.login')}</button>
		</form>

		<form
			class="space-y-3 border-t border-border pt-4"
			onsubmit={(e) => {
				e.preventDefault();
				void register();
			}}
		>
			<p class="text-sm text-muted">{t('login.no_account')}</p>
			<input class="input" bind:value={registerEmail} type="email" placeholder={t('login.register_email')} required />
			<input
				class="input"
				bind:value={registerPassword}
				type="password"
				placeholder={t('login.register_password')}
				required
			/>
			<button class="btn-secondary w-full" type="submit" disabled={loading}>{t('login.register')}</button>
		</form>
	</div>
</div>
