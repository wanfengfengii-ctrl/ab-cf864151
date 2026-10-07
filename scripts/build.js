'use strict';

/**
 * 生产构建：生成 dist/
 * - 拷贝服务端代码（server.js / state.js）
 * - 将 CSS 与 JS 内联进单个自包含 index.html
 * - 生成带内容哈希的构建清单 build-info.json
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

function main() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(distDir, 'public'), { recursive: true });

  const files = {};

  for (const name of ['server.js', 'state.js']) {
    const content = fs.readFileSync(path.join(srcDir, name));
    fs.writeFileSync(path.join(distDir, name), content);
    files[name] = hash(content);
  }

  const html = fs.readFileSync(path.join(srcDir, 'public', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(srcDir, 'public', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(srcDir, 'public', 'app.js'), 'utf8');

  if (js.includes('</script>')) {
    throw new Error('app.js 不得包含 </script>，否则无法内联');
  }

  let out = html
    .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}\n</style>`)
    .replace('<script src="app.js"></script>', () => `<script>\n${js}\n</script>`);

  if (out.includes('href="styles.css"') || out.includes('src="app.js"')) {
    throw new Error('资源内联失败：index.html 仍引用外部文件');
  }

  fs.writeFileSync(path.join(distDir, 'public', 'index.html'), out);
  files['public/index.html'] = hash(out);

  const manifest = {
    name: 'dose-dashboard',
    builtAt: new Date().toISOString(),
    node: process.version,
    files,
  };
  fs.writeFileSync(path.join(distDir, 'build-info.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`生产构建完成 → dist/（${Object.keys(files).length} 个文件，哈希 ${hash(JSON.stringify(files))}）`);
}

main();
