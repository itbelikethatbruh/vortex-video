// Tailwind 3 config for public/welcome.html. Rebuild the inlined CSS after changing classes:
//   node tools/build-welcome.js   (needs: npm i -D tailwindcss@3.4.16)
module.exports = {
  content: ['./public/welcome.html'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'ui-monospace', 'monospace'] },
      colors: { void: '#07070C', obsidian: '#0D0B16', surface: '#14111F', surface3: '#1D1930', vcyan: '#22D3EE', vviolet: '#8B5CF6', vmagenta: '#EC4899', vmint: '#34D399', vmuted: '#9D99B8' },
    },
  },
};
