<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	type TwoFactorStatus = { enabled: boolean };
	type TwoFactorSetup = {
		secret: string;
		otpauth_uri: string;
		qr_data_url: string;
	};

	let enabled = $state(false);
	let setup = $state<TwoFactorSetup | null>(null);
	let code = $state('');
	let password = $state('');
	let disableCode = $state('');
	let loading = $state(false);
	let toast = $state('');

	async function load() {
		const status = await api<TwoFactorStatus>('/api/user/security/2fa/status');
		enabled = status.enabled;
	}

	async function startSetup() {
		loading = true;
		toast = '';
		try {
			setup = await api<TwoFactorSetup>('/api/user/security/2fa/setup', { method: 'POST' });
			code = '';
			toast = '请使用 Google Authenticator 或 Microsoft Authenticator 扫码，然后输入 6 位验证码完成绑定';
		} catch (err) {
			toast = err instanceof Error ? err.message : '生成二步验证密钥失败';
		} finally {
			loading = false;
		}
	}

	async function enable2fa() {
		if (!setup) return;
		loading = true;
		toast = '';
		try {
			await api('/api/user/security/2fa/enable', {
				method: 'POST',
				body: JSON.stringify({ secret: setup.secret, code })
			});
			setup = null;
			code = '';
			toast = '二步验证已开启';
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '开启二步验证失败';
		} finally {
			loading = false;
		}
	}

	async function disable2fa() {
		loading = true;
		toast = '';
		try {
			await api('/api/user/security/2fa/disable', {
				method: 'POST',
				body: JSON.stringify({ password, code: disableCode })
			});
			password = '';
			disableCode = '';
			toast = '二步验证已关闭';
			await load();
		} catch (err) {
			toast = err instanceof Error ? err.message : '关闭二步验证失败';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<h1 class="mb-4 text-2xl font-semibold">账号安全</h1>

{#if toast}
	<div class="mb-4 rounded-lg border border-border bg-card px-3 py-2 text-sm">{toast}</div>
{/if}

<div class="grid gap-6 xl:grid-cols-2">
	<section class="card space-y-4 p-5">
		<div>
			<h2 class="text-lg font-medium">二步验证码</h2>
			<p class="mt-1 text-sm text-muted">
				可选开启。开启后登录 Azure Panel 时需要输入 Google Authenticator 或 Microsoft Authenticator 的 6 位动态验证码。
			</p>
		</div>
		<div class={`badge ${enabled ? 'bg-green-900/50 text-green-300' : 'bg-amber-900/50 text-amber-200'}`}>
			当前状态：{enabled ? '已开启' : '未开启'}
		</div>

		{#if !enabled}
			<button class="btn-primary" type="button" disabled={loading} onclick={() => void startSetup()}>
				{loading ? '生成中...' : '生成绑定二维码'}
			</button>
			{#if setup}
				<div class="space-y-3 rounded-lg border border-border bg-background/70 p-4">
					<img class="rounded-lg bg-white p-2" src={setup.qr_data_url} alt="二步验证二维码" width="220" height="220" />
					<div>
						<div class="text-xs text-muted">无法扫码时可手动输入密钥</div>
						<div class="mt-1 break-all rounded bg-black/20 px-3 py-2 font-mono text-sm">{setup.secret}</div>
					</div>
					<input
						class="input"
						bind:value={code}
						inputmode="numeric"
						pattern="[0-9]{6}"
						placeholder="输入 6 位验证码完成开启"
					/>
					<button class="btn-primary" type="button" disabled={loading || code.length < 6} onclick={() => void enable2fa()}>
						确认开启
					</button>
				</div>
			{/if}
		{:else}
			<div class="space-y-3 rounded-lg border border-border bg-background/70 p-4">
				<p class="text-sm text-muted">关闭二步验证需要当前登录密码和 6 位动态验证码。</p>
				<input class="input" type="password" bind:value={password} placeholder="当前登录密码" />
				<input
					class="input"
					bind:value={disableCode}
					inputmode="numeric"
					pattern="[0-9]{6}"
					placeholder="当前 6 位验证码"
				/>
				<button class="btn-danger" type="button" disabled={loading} onclick={() => void disable2fa()}>
					关闭二步验证
				</button>
			</div>
		{/if}
	</section>
</div>
