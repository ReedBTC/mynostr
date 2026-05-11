/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  // Force-include classes that aren't referenced in any source file.
  //
  // CF Pages refuses to serve a Tailwind CSS file whose minified output
  // contains the substring `.w-32{width:8rem}.w-4{width:1rem}` (the
  // sequence that appears when the .w-36 utility is omitted). The exact
  // CF rule is opaque; the empirical fix is to keep .w-36 in the build
  // even when no source uses it. Removing this line will re-trigger the
  // bug — see commit history around 6f55125 / 7c4ef20 for the diagnosis.
  safelist: ['w-36'],
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
