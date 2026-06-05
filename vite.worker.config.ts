import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/** 将 worker-entry 打包为可在 Supervisor 中直接运行的 Node 脚本 */
export default defineConfig({
	build: {
		outDir: 'build',
		emptyOutDir: false,
		lib: {
			entry: resolve(__dirname, 'src/worker-entry.ts'),
			formats: ['es'],
			fileName: () => 'worker.js'
		},
		rollupOptions: {
			output: {
				entryFileNames: 'worker.js'
			},
			external: [
				'better-sqlite3',
				'mysql2',
				'mysql2/promise',
				'@azure/arm-compute',
				'@azure/arm-network',
				'@azure/arm-resources',
				'@azure/identity',
				'bcryptjs',
				'drizzle-orm',
				'drizzle-orm/better-sqlite3',
				'drizzle-orm/mysql2',
				'jose',
				'node:fs',
				'node:path'
			]
		},
		target: 'node20',
		ssr: true
	}
});
