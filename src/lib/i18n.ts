export const languages = [
	{ code: 'zh', label: '中文' },
	{ code: 'en', label: 'English' },
	{ code: 'ja', label: '日本語' },
	{ code: 'ru', label: 'Русский' }
] as const;

export type LanguageCode = (typeof languages)[number]['code'];

const dictionaries = {
	zh: {
		'nav.vms': 'VM 管理',
		'nav.accounts': 'Azure 号池',
		'nav.resources': '资源浏览',
		'nav.proxies': '代理配置',
		'nav.dns': 'DNS 管理',
		'nav.workflows': '自动补机',
		'nav.notifications': '通知设置',
		'nav.logs': '执行日志',
		'nav.security': '账号安全',
		'nav.admin': '管理员后台',
		'nav.logout': '退出登录',
		'language.label': '语言',
		'login.subtitle': 'SvelteKit 全栈 · 自动开机补机',
		'login.email': '邮箱',
		'login.password': '密码',
		'login.totp': 'Google / Microsoft Authenticator 6 位验证码',
		'login.login': '登录',
		'login.no_account': '没有账号？注册',
		'login.register_email': '注册邮箱',
		'login.register_password': '至少 6 位密码',
		'login.register': '注册'
	},
	en: {
		'nav.vms': 'VMs',
		'nav.accounts': 'Azure Pool',
		'nav.resources': 'Resources',
		'nav.proxies': 'Proxies',
		'nav.dns': 'DNS',
		'nav.workflows': 'Replenishment',
		'nav.notifications': 'Notifications',
		'nav.logs': 'Logs',
		'nav.security': 'Security',
		'nav.admin': 'Admin',
		'nav.logout': 'Sign Out',
		'language.label': 'Language',
		'login.subtitle': 'SvelteKit full stack · automated VM replenishment',
		'login.email': 'Email',
		'login.password': 'Password',
		'login.totp': '6-digit code from Google / Microsoft Authenticator',
		'login.login': 'Sign In',
		'login.no_account': 'No account? Register',
		'login.register_email': 'Registration email',
		'login.register_password': 'At least 6 characters',
		'login.register': 'Register'
	},
	ja: {
		'nav.vms': 'VM 管理',
		'nav.accounts': 'Azure アカウントプール',
		'nav.resources': 'リソース',
		'nav.proxies': 'プロキシ',
		'nav.dns': 'DNS 管理',
		'nav.workflows': '自動補充',
		'nav.notifications': '通知設定',
		'nav.logs': '実行ログ',
		'nav.security': 'アカウント安全',
		'nav.admin': '管理者',
		'nav.logout': 'ログアウト',
		'language.label': '言語',
		'login.subtitle': 'SvelteKit フルスタック · 自動 VM 補充',
		'login.email': 'メール',
		'login.password': 'パスワード',
		'login.totp': 'Google / Microsoft Authenticator の6桁コード',
		'login.login': 'ログイン',
		'login.no_account': 'アカウントがありませんか？登録',
		'login.register_email': '登録メール',
		'login.register_password': '6文字以上のパスワード',
		'login.register': '登録'
	},
	ru: {
		'nav.vms': 'VM',
		'nav.accounts': 'Пул Azure',
		'nav.resources': 'Ресурсы',
		'nav.proxies': 'Прокси',
		'nav.dns': 'DNS',
		'nav.workflows': 'Автопополнение',
		'nav.notifications': 'Уведомления',
		'nav.logs': 'Журналы',
		'nav.security': 'Безопасность',
		'nav.admin': 'Админ',
		'nav.logout': 'Выйти',
		'language.label': 'Язык',
		'login.subtitle': 'SvelteKit full stack · автоматическое пополнение VM',
		'login.email': 'Email',
		'login.password': 'Пароль',
		'login.totp': '6-значный код Google / Microsoft Authenticator',
		'login.login': 'Войти',
		'login.no_account': 'Нет аккаунта? Зарегистрируйтесь',
		'login.register_email': 'Email для регистрации',
		'login.register_password': 'Минимум 6 символов',
		'login.register': 'Регистрация'
	}
} satisfies Record<LanguageCode, Record<string, string>>;

export function normalizeLanguage(value: unknown): LanguageCode {
	const code = String(value ?? '').trim().toLowerCase();
	return languages.some((language) => language.code === code) ? (code as LanguageCode) : 'zh';
}

export function createTranslator(language: LanguageCode) {
	const dict: Record<string, string> = dictionaries[language] ?? dictionaries.zh;
	const fallback: Record<string, string> = dictionaries.zh;
	return (key: keyof typeof dictionaries.zh | string) => dict[key] ?? fallback[key] ?? key;
}
