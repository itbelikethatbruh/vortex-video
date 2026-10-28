// Compiles the Tailwind classes used in public/welcome.html and inlines the CSS between the tw markers.
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..'), page = path.join(root, 'public/welcome.html');
const input = path.join(require('os').tmpdir(), 'vx-tw-in.css');
fs.writeFileSync(input, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
const css = execFileSync('npx', ['tailwindcss', '-c', path.join(__dirname, 'welcome.tailwind.config.js'), '-i', input, '--minify'], { cwd: root }).toString();
const html = fs.readFileSync(page, 'utf8').replace(/(<style id="tw">)[\s\S]*?(<\/style>)/, (m, a, b) => a + css.trim() + b);
fs.writeFileSync(page, html);
console.log('inlined', css.length, 'bytes of Tailwind CSS');
