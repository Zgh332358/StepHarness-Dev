// Markdown 渲染（纯函数，不依赖 DOM，便于测试）。
// 安全约定：所有文本先整体转义，之后只插入固定的标签；链接只允许 http/https。
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function inline(src: string): string {
  const codes: string[] = [];
  let s = esc(src).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, '$1<a href="$2" target="_blank">$2</a>')
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+?)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

function blocks(src: string): string {
  const lines = src.split("\n");
  let html = "", para: string[] = [];
  const flush = () => { if (para.length) { html += `<p>${para.map(inline).join("<br>")}</p>`; para = []; } };
  const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m: RegExpMatchArray | null;
    if (!l.trim()) { flush(); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flush(); const n = Math.min(m[1].length, 4); html += `<h${n}>${inline(m[2])}</h${n}>`; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); html += "<hr>"; continue; }
    if (/^\s*>/.test(l)) {
      flush(); const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      i--; html += `<blockquote>${blocks(q.join("\n"))}</blockquote>`; continue;
    }
    if (l.includes("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush(); const head = cells(l); i += 2; const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      continue;
    }
    if (listRe.test(l)) {
      flush();
      const items: { indent: number; ordered: boolean; start: number; text: string }[] = [];
      while (i < lines.length) {
        const cur = lines[i], lm = cur.match(listRe);
        if (lm) items.push({ indent: lm[1].replace(/\t/g, "  ").length, ordered: /\d/.test(lm[2]), start: parseInt(lm[2]) || 1, text: lm[3] });
        else if (cur.trim() && /^\s+/.test(cur) && items.length) items[items.length - 1].text += "\n" + cur.trim();
        else break;
        i++;
      }
      i--;
      const build = (idx: number, indent: number): [string, number] => {
        const ordered = items[idx].ordered;
        const parts: string[] = [];
        const start = items[idx].start;
        while (idx < items.length && items[idx].indent >= indent) {
          if (items[idx].indent > indent && parts.length) { const [h, n] = build(idx, items[idx].indent); parts[parts.length - 1] += h; idx = n; continue; }
          parts.push(items[idx].text.split("\n").map(inline).join("<br>")); idx++;
        }
        const tag = ordered ? "ol" : "ul";
        return [`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${parts.map((p) => `<li>${p}</li>`).join("")}</${tag}>`, idx];
      };
      html += build(0, items[0].indent)[0];
      continue;
    }
    para.push(l);
  }
  flush();
  return html;
}

export function md(src: string): string {
  if (!src) return "";
  let html = "", last = 0;
  const re = /^ {0,3}```([^\n`]*)\n([\s\S]*?)(?:\n {0,3}```[ \t]*(?=\n|$)|$(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    html += blocks(src.slice(last, m.index));
    html += `<pre><div class="head"><span>${esc(m[1].trim() || "code")}</span><button data-copy>复制</button></div><code>${esc(m[2])}</code></pre>`;
    last = re.lastIndex;
    if (m[0].length === 0) re.lastIndex++;
  }
  return html + blocks(src.slice(last));
}
