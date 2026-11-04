#!/usr/bin/env node
/**
 * 版本发布器 —— 一条命令发布一个冻结版本
 *
 * 用法：
 *   node release.js              # 自动取下一个版本号，发布
 *   node release.js --dry        # 只演练，不写文件不上传
 *   node release.js --list       # 只看现有版本
 *
 * 做了什么：
 *   1. 读 versions.json，算出下一个版本号（v1 / v2 / v3…）
 *   2. 把当前最新代码复制到 vN/ 目录（保持 index.html + tools/ + guides/ 的结构）
 *   3. 检查 vN/ 里所有本地链接是否都能落地（死链兜底）
 *   4. 写 versions.json 记录版本信息
 *   5. 只保留最近 MAX_KEEP 个版本，更早的自动删除
 *   6. 上传到 GitHub（Contents API，绕开代理）
 *   7. 打印这个版本的完整网址
 *
 * 为什么相对路径不用改：
 *   vN/ 里的目录结构和根目录完全一样（index.html 在顶层，tools/ guides/ 在下面），
 *   页面里写的 ../guides/x.html、tools/y.html 在 vN/ 里同样成立。
 *   只要复制时保持结构，路径就天然正确 —— 这也是最不容易出错的做法。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = __dirname;
const MAX_KEEP = 5;                    // 只保留最近 5 个版本
const OWNER = 'SQ-eng-source';
const REPO = 'SQ-amazon-toolbox';
const BRANCH = 'main';
const BASE = `https://${OWNER.toLowerCase()}.github.io/${REPO}`;

// 复制进版本目录的内容（只放网页，不放 .git / .bat / 发布工具自己）
const COPY_ITEMS = ['index.html', 'tools', 'guides', 'versions.html'];
// 允许出现在仓库根但**不**复制的
const SKIP = new Set(['.git', '.github', 'node_modules', 'release.js', '发布新版本.bat',
                      'md2html.js', 'versions.json', 'README.md', '.gitignore',
                      '.nojekyll', '启动工具台.bat']);

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ONLY_LIST = args.includes('--list');

function readJSON(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; }
}
function w(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }

const MANIFEST = path.join(ROOT, 'versions.json');

function loadManifest() {
  return readJSON(MANIFEST, { site: BASE, latest: null, versions: [] });
}

/** 复制目录（跳过 SKIP 里的一级条目） */
function copyDir(src, dst, rel = '') {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (!rel && SKIP.has(e.name)) continue;
    if (e.name === '.git') continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, r);
    else fs.copyFileSync(s, d);
  }
}

/** 检查目录里所有本地 href/src 是否能落地 */
function checkDeadLinks(dir) {
  const dead = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.html?$/i.test(e.name)) continue;
      const html = fs.readFileSync(p, 'utf8');
      const re = /(?:href|src)="([^"#]+?)(?:#[^"]*)?"/g;
      let m;
      while ((m = re.exec(html))) {
        const u = m[1].trim();
        if (!u || /^(https?:|\/\/|mailto:|data:|javascript:|about:|blob:)/.test(u)) continue;
        const target = path.resolve(path.dirname(p), u);
        if (!fs.existsSync(target)) dead.push(`${path.relative(dir, p)} → ${u}`);
      }
    }
  };
  walk(dir);
  return dead;
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name)); else n++;
    }
  };
  walk(dir);
  return n;
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- GitHub 上传 ----------
// 找可用的 bash：Git for Windows 有多个安装位置，不能硬编码
function findBash() {
  const cands = [
    'C:/Users/LENOVO/.workbuddy/binaries/PortableGit/versions/1.2.0/bin/bash.exe',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    'C:/Users/LENOVO/AppData/Local/Programs/Git/bin/bash.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  // 退一步：让系统自己找
  return 'bash';
}

function token() {
  const bash = findBash();
  // git / git-credential-manager 不一定在系统 PATH 里，把 bash 同级的 cmd、mingw64/bin 加进去
  const gitRoot = path.dirname(path.dirname(bash));
  const extra = bash === 'bash' ? ''
    : `export PATH="${gitRoot}/cmd:${gitRoot}/mingw64/bin:${gitRoot}/bin:$PATH"; `;
  const r = execSync(`${extra}printf "protocol=https\\nhost=github.com\\n\\n" | git credential-manager get`,
    { shell: bash, encoding: 'utf8' });
  const line = r.split('\n').find(l => l.startsWith('password='));
  if (!line) throw new Error('拿不到 GitHub 令牌（git credential-manager 没返回 password）');
  return line.slice(9).trim();
}

function api(method, p, body, tk) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'api.github.com', path: p, method,
      headers: {
        Authorization: 'Bearer ' + tk,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'sq-release',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, r2 => { let b = ''; r2.on('data', d => b += d); r2.on('end', () => res({ status: r2.statusCode, body: b })); });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

async function upload(localFiles, message, tk) {
  let ok = 0, fail = [];

  // 先取一次远端文件树，避免每个文件都发一次 GET
  const treeRes = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`, null, tk);
  const remote = new Map();
  if (treeRes.status === 200) {
    for (const n of JSON.parse(treeRes.body).tree || []) remote.set(n.path, n.sha);
  }

  for (const [rel, abs] of localFiles) {
    const enc = rel.split('/').map(encodeURIComponent).join('/');
    const sha = remote.get(rel);
    const content = fs.readFileSync(abs).toString('base64');
    const put = await api('PUT', `/repos/${OWNER}/${REPO}/contents/${enc}`, {
      message, content, branch: BRANCH, ...(sha ? { sha } : {})
    }, tk);
    if (put.status === 200 || put.status === 201) { ok++; process.stdout.write('.'); }
    else { fail.push([rel, put.status, put.body.slice(0, 120)]); process.stdout.write('x'); }
  }
  process.stdout.write('\n');
  return { ok, fail };
}

async function del(rel, sha, message, tk) {
  const enc = rel.split('/').map(encodeURIComponent).join('/');
  return api('DELETE', `/repos/${OWNER}/${REPO}/contents/${enc}`, { message, sha, branch: BRANCH }, tk);
}

// ---------- 主流程 ----------
(async () => {
  const mani = loadManifest();

  if (ONLY_LIST) {
    console.log('\n现有版本：');
    if (!mani.versions.length) console.log('  （还没有任何冻结版本）');
    for (const v of mani.versions) {
      console.log(`  ${v.id.padEnd(6)} ${v.time}  ${v.files} 个文件  ${BASE}/${v.id}/`);
    }
    console.log(`\n最新版（持续更新）：${BASE}/\n`);
    return;
  }

  // 1. 算版本号
  const nums = mani.versions.map(v => parseInt(String(v.id).replace(/\D/g, ''), 10)).filter(n => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  const vid = 'v' + next;
  const dst = path.join(ROOT, vid);

  console.log(`\n=== 发布 ${vid} ===`);
  if (fs.existsSync(dst)) { console.error(`✗ 目录 ${vid}/ 已存在，可能上次发布中断了。请手动删掉后重试。`); process.exit(1); }

  // 2. 先写清单页到根目录（index.html 有链接指向它，必须复制前就存在，否则死链检查会误报）
  const entry = { id: vid, time: stamp(), files: 0, url: `${BASE}/${vid}/` };
  mani.versions.push(entry);
  mani.latest = `${BASE}/`;
  w(path.join(ROOT, 'versions.html'), renderVersionsPage(mani));

  // 3. 复制
  fs.mkdirSync(dst, { recursive: true });
  for (const item of COPY_ITEMS) {
    const s = path.join(ROOT, item);
    if (!fs.existsSync(s)) { console.warn(`  ! 跳过不存在的 ${item}`); continue; }
    if (fs.statSync(s).isDirectory()) copyDir(s, path.join(dst, item));
    else fs.copyFileSync(s, path.join(dst, item));
  }
  const n = countFiles(dst);
  console.log(`  复制完成：${n} 个文件 → ${vid}/`);

  // 4. 覆盖版本目录里的清单页：链接必须指向本目录的 index.html，不能带 vN/ 前缀
  //    必须在死链检查之前做，否则检查会看到根目录那份（链接是 v1/index.html）而误判死链
  w(path.join(dst, 'versions.html'), renderVersionsPage(mani, true));

  // 5. 死链检查
  const dead = checkDeadLinks(dst);
  if (dead.length) {
    console.error(`\n✗ ${vid}/ 里有 ${dead.length} 个死链，已中止发布：`);
    dead.slice(0, 15).forEach(d => console.error('    ' + d));
    console.error('\n  已删除本次生成的目录，源码未受影响。');
    fs.rmSync(dst, { recursive: true, force: true });
    mani.versions.pop();                       // 回滚清单，别留下没上传的空壳版本
    w(MANIFEST, JSON.stringify(mani, null, 2) + '\n');
    w(path.join(ROOT, 'versions.html'), renderVersionsPage(mani));
    process.exit(1);
  }
  console.log('  死链检查：通过');

  // 6. 回填文件数并清理超量的旧版本
  entry.files = n;
  const removed = [];
  while (mani.versions.length > MAX_KEEP) {
    const old = mani.versions.shift();
    removed.push(old.id);
    const od = path.join(ROOT, old.id);
    if (fs.existsSync(od)) fs.rmSync(od, { recursive: true, force: true });
  }
  if (removed.length) console.log(`  清理旧版本：${removed.join(', ')}（只保留最近 ${MAX_KEEP} 个）`);

  // 7. 重写根目录清单页（文件数已回填；版本目录里那份在第 4 步已按正确链接写好）
  w(path.join(ROOT, 'versions.html'), renderVersionsPage(mani));

  w(MANIFEST, JSON.stringify(mani, null, 2) + '\n');

  if (DRY) {
    console.log(`\n[演练模式] 未上传。${vid}/ 已生成在本地，可打开 ${vid}/index.html 检查。`);
    return;
  }

  // 7. 上传
  console.log('\n  上传中…');
  const tk = token();
  const localFiles = [];
  const collect = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) collect(path.join(d, e.name), r);
      else localFiles.push([r, path.join(d, e.name)]);
    }
  };
  collect(dst, vid);
  localFiles.push(['versions.json', MANIFEST]);
  localFiles.push(['versions.html', path.join(ROOT, 'versions.html')]);

  const { ok, fail } = await upload(localFiles, `release: ${vid} (${entry.time})`, tk);
  console.log(`  上传成功 ${ok} / ${localFiles.length}`);
  if (fail.length) {
    console.error('  ✗ 失败：');
    fail.forEach(f => console.error('    ', f[0], f[1]));
  }

  // 8. 删除远端过期版本
  if (removed.length) {
    console.log('  同步删除远端旧版本…');
    const tree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`, null, tk);
    if (tree.status === 200) {
      const all = JSON.parse(tree.body).tree || [];
      for (const rid of removed) {
        const targets = all.filter(x => x.path === rid || x.path.startsWith(rid + '/'));
        for (const t of targets) {
          if (t.type !== 'blob') continue;
          await del(t.path, t.sha, `release: 清理过期版本 ${rid}`, tk);
        }
        console.log(`    - ${rid}（${targets.length} 个文件）`);
      }
    }
  }

  console.log(`\n✓ ${vid} 发布完成`);
  console.log(`  这个版本的网址（发给要用这一版的人）：`);
  console.log(`  ${entry.url}`);
  console.log(`\n  最新版（你自己用 / 默认分享）：${mani.latest}`);
  console.log(`  版本清单：${BASE}/versions.html`);
  console.log('\n  GitHub Pages 需要 1–3 分钟构建，稍等一下再打开。\n');
})().catch(e => { console.error('\n✗ 发布失败：', e.message); process.exit(1); });

// ---------- 生成版本清单页 ----------
// inVersionDir=true 时生成「站点内版本」，链接指向自己所在目录，避免 v1/v1/ 这种叠加路径
function renderVersionsPage(mani, inVersionDir) {
  const openHref = (id) => inVersionDir ? 'index.html' : `${id}/index.html`;
  const rows = [...mani.versions].reverse().map(v => `
    <tr>
      <td class="vid">${v.id}</td>
      <td>${v.time}</td>
      <td>${v.files} 个文件</td>
      <td><span class="badge">冻结</span></td>
      <td><button class="copy" data-url="${v.url}">复制链接</button></td>
      <td><a href="${openHref(v.id)}" target="_blank">打开 →</a></td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>版本清单 · SQ-AMAZON-TOOLBOX</title>
<style>
:root{--bg:#f2fbfd;--ink:#12333f;--sub:#6b93a3;--line:#d9f0f6;--deep:#0e7490;--accent:#0891b2;--turq:#22d3ee}
*{box-sizing:border-box;margin:0;padding:0;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
body{background:var(--bg);color:var(--ink);padding:30px 24px}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:22px;color:var(--deep);margin-bottom:8px}
.lead{font-size:13px;color:var(--sub);line-height:1.8;margin-bottom:22px}
.lead b{color:var(--ink)}
table{width:100%;background:#fff;border:1px solid var(--line);border-radius:12px;border-collapse:separate;border-spacing:0;overflow:hidden}
th,td{padding:11px 14px;text-align:left;font-size:13px;border-bottom:1px solid var(--line)}
th{background:#f8fdfe;color:var(--deep);font-size:12px;font-weight:700}
tr:last-child td{border-bottom:none}
.vid{font-weight:700;color:var(--deep);font-family:Consolas,monospace}
.badge{background:#e6fafc;color:var(--deep);border:1px solid #bfe7f2;border-radius:5px;padding:2px 8px;font-size:11px}
.copy{background:linear-gradient(90deg,#22d3ee,#0891b2);color:#fff;border:none;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:600}
.copy:hover{filter:brightness(1.08)}
td a{color:var(--accent);text-decoration:none;font-size:12px}
.tip{margin-top:20px;background:#fdf6e3;border-left:3px solid #e8c98a;border-radius:0 8px 8px 0;padding:13px 16px}
.tip b{display:block;font-size:12.5px;color:#8a6d1f;margin-bottom:7px}
.tip li{font-size:12.5px;color:#7a5f18;line-height:1.9;margin-left:16px}
.none{padding:26px;text-align:center;color:var(--sub);font-size:13px}
</style>
</head>
<body>
<div class="wrap">
  <h1>📌 版本清单</h1>
  <p class="lead">
    每次发布都会生成一个<b>独立网址</b>，冻结在当时的样子，之后你改任何东西它都不会变。<br>
    把某个版本的链接发给特定的人，他们就永远停留在那一版。
  </p>
  ${mani.versions.length ? `<table>
    <thead><tr><th>版本</th><th>发布时间</th><th>大小</th><th>状态</th><th>发给别人</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : '<div class="none">还没有发布过冻结版本。<br>双击「发布新版本.bat」即可生成 v1。</div>'}
  <div class="tip">
    <b>怎么用</b>
    <ul>
      <li><b>最新版</b>（${mani.latest || BASE + '/'}）永远自动更新，你自己用这个，也可以作为默认分享链接。</li>
      <li><b>冻结版</b>（v1、v2…）永不改变，适合发给要固定版本的人，比如培训、交付、给别人做演示。</li>
      <li>只保留最近 <b>5 个</b>版本，更早的会自动删除，那些链接会失效。</li>
      <li>点「复制链接」拿到的是可以直接发出去的完整网址。</li>
    </ul>
  </div>
</div>
<script>
document.querySelectorAll('.copy').forEach(function(b){
  b.addEventListener('click',function(){
    var u=b.getAttribute('data-url'),old=b.textContent;
    var done=function(){b.textContent='已复制 ✓';setTimeout(function(){b.textContent=old},1400)};
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(u).then(done).catch(function(){fallback(u,done)});
    }else{fallback(u,done)}
  });
});
function fallback(u,cb){
  var t=document.createElement('textarea');t.value=u;t.style.position='fixed';t.style.opacity='0';
  document.body.appendChild(t);t.select();
  try{document.execCommand('copy');cb()}catch(e){prompt('手动复制：',u)}
  document.body.removeChild(t);
}
</script>
</body>
</html>`;
}
