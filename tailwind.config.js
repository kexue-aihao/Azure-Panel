/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	darkMode: 'class',
	theme: {
		extend: {
			colors: {
				background: 'hsl(222 47% 7%)',
				card: 'hsl(222 47% 10%)',
				border: 'hsl(217 33% 18%)',
				primary: 'hsl(217 91% 60%)',
				muted: 'hsl(215 20% 65%)'
			}
		}
	},
	plugins: []
};
