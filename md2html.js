const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'guides');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 行内：`code`、**bold**、链接
function inline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

function md2html(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // 表格
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|/.test(lines[i + 1])) {
      const head = line.split('|').slice(1, -1).map(s => s.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map(s => s.trim()));
        i++;
      }
      out.push('<div class="tw"><table><thead><tr>' + head.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push('<blockquote>' + buf.map(b => inline(b)).join('<br>') + '</blockquote>');
      continue;
    }

    // 标题
    let m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      const lv = m[1].length;
      out.push('<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>');
      i++; continue;
    }

    // 分隔线
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        let t = lines[i].replace(/^\s*\d+\.\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) { t += ' ' + lines[i].trim(); i++; }
        items.push('<li>' + inline(t) + '</li>');
      }
      out.push('<ol>' + items.join('') + '</ol>');
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        let t = lines[i].replace(/^\s*[-*]\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) { t += ' ' + lines[i].trim(); i++; }
        items.push('<li>' + inline(t) + '</li>');
      }
      out.push('<ul>' + items.join('') + '</ul>');
      continue;
    }

    // 空行
    if (!line.trim()) { i++; continue; }

    // 普通段落
    out.push('<p>' + inline(line) + '</p>');
    i++;
  }
  return out.join('\n');
}

const CSS = `
:root{--bg:#f2fbfd;--card:#fff;--ink:#12333f;--sub:#6b93a3;--line:#d9f0f6;--deep:#0e7490;--accent:#0891b2;--turq:#22d3ee;--soft:#e0f2fe;--warnbg:#fdf6e3;--warnbd:#e8c98a}
*{box-sizing:border-box;margin:0;padding:0;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
body{background:var(--bg);color:var(--ink);padding:26px 22px 60px}
.wrap{max-width:820px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:14px;padding:32px 38px 42px}
.top{max-width:820px;margin:0 auto 12px;display:flex;align-items:center;gap:10px}
.top a{font-size:12px;color:var(--deep);text-decoration:none;border:1px solid var(--line);background:#fff;border-radius:7px;padding:6px 12px}
.top a:hover{background:var(--soft);border-color:var(--turq)}
h1{font-size:24px;color:var(--deep);line-height:1.35;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid var(--soft)}
h2{font-size:18px;color:var(--deep);margin:30px 0 12px;padding-left:11px;border-left:4px solid var(--turq);line-height:1.4}
h3{font-size:15px;color:var(--ink);margin:22px 0 9px}
h4{font-size:13.5px;color:var(--deep);margin:16px 0 7px}
p{font-size:14px;line-height:1.9;margin-bottom:12px;color:#1d3f4d}
strong{color:var(--deep);font-weight:700}
ul,ol{margin:0 0 14px 22px}
li{font-size:14px;line-height:1.9;margin-bottom:5px;color:#1d3f4d}
code{background:#e6fafc;border:1px solid var(--line);border-radius:4px;padding:1px 6px;font-size:12.5px;color:var(--deep);font-family:Consolas,"Courier New",monospace}
pre{background:#0f2f3a;border-radius:9px;padding:15px 18px;overflow-x:auto;margin:0 0 16px}
pre code{background:none;border:none;color:#d8f3f9;font-size:12.5px;line-height:1.75;padding:0;white-space:pre}
blockquote{background:var(--warnbg);border-left:3px solid var(--warnbd);border-radius:0 8px 8px 0;padding:12px 16px;margin:0 0 16px;font-size:13.5px;line-height:1.85;color:#7a5f18}
blockquote strong{color:#8a6d1f}
hr{border:none;border-top:1px dashed var(--line);margin:26px 0}
.tw{overflow-x:auto;margin:0 0 16px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{background:var(--soft);color:var(--deep);font-weight:700;text-align:left;padding:9px 11px;border:1px solid var(--line);white-space:nowrap}
td{padding:9px 11px;border:1px solid var(--line);line-height:1.7;vertical-align:top}
tbody tr:nth-child(even){background:#fafdfe}
a{color:var(--accent)}
@media (max-width:640px){.wrap{padding:22px 18px 34px}h1{font-size:20px}h2{font-size:16px}p,li{font-size:13.5px}}
`;

const files = fs.readdirSync(dir).filter(f => /^guide-.*\.md$/.test(f));
let n = 0;
for (const f of files) {
  const md = fs.readFileSync(path.join(dir, f), 'utf8');
  const title = (md.match(/^#\s+(.+)$/m) || [, f])[1];
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 使用说明</title>
<style>${CSS}</style>
</head>
<body>
<div class="top"><a href="index.html">← 全部说明</a></div>
<div class="wrap">
${md2html(md)}
</div>
</body>
</html>`;
  const outName = f.replace(/\.md$/, '.html');
  fs.writeFileSync(path.join(dir, outName), html, 'utf8');
  console.log(outName, Buffer.byteLength(html));
  n++;
}
console.log('done', n);
