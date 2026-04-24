/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // Generic `monospace` on iOS falls back to Courier, which looks
        // noticeably rougher than the desktop JetBrains Mono. Adding the
        // system-stack monospace fonts before the generic keyword keeps
        // mobile close to SF Mono / Menlo / Consolas instead.
        mono: [
          'JetBrains Mono', 'Fira Code', 'Cascadia Code',
          'ui-monospace', 'SF Mono', 'SFMono-Regular',
          'Menlo', 'Consolas', 'Liberation Mono', 'monospace',
        ],
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
