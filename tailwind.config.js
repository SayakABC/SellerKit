/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 把 Tailwind 默认 gray 接到主题令牌，使业务模块里直接写
        // text-gray-* / border-gray-* / bg-gray-* 也能跟随浅色/深色主题。
        // 注意：white 刻意不覆盖，否则 text-white（按钮白字）会在深色下变暗。
        gray: {
          50: 'rgb(var(--tw-gray-50) / <alpha-value>)',
          100: 'rgb(var(--tw-gray-100) / <alpha-value>)',
          200: 'rgb(var(--tw-gray-200) / <alpha-value>)',
          300: 'rgb(var(--tw-gray-300) / <alpha-value>)',
          400: 'rgb(var(--tw-gray-400) / <alpha-value>)',
          500: 'rgb(var(--tw-gray-500) / <alpha-value>)',
          600: 'rgb(var(--tw-gray-600) / <alpha-value>)',
          700: 'rgb(var(--tw-gray-700) / <alpha-value>)',
          800: 'rgb(var(--tw-gray-800) / <alpha-value>)',
          900: 'rgb(var(--tw-gray-900) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};
