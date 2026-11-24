// Markdown essenziale e sicuro: tutto il testo viene prima trasformato in entità HTML, poi formattato.
"use strict";

const Md = (() => {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function inline(s) {
    // Codice e link escono dal testo finché non è formattato, così * e _ negli URL restano intatti.
    const held = [];
    const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
    const link = (url, label) => hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${c}</code>`));
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, t, u) => link(u, inline(t)));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => p + link(u, u));
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
  }

  function render(source) {
    const lines = escape(source || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let list = null; // "ul" | "ol"
    let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join("<br>"))}</p>`); para = []; } };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        flushPara(); closeList();
        const code = [];
        while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
        out.push(`<pre><code>${code.join("\n")}</code></pre>`);
        continue;
      }
      let m;
      if (!line.trim()) { flushPara(); closeList(); continue; }
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        flushPara(); closeList();
        const level = Math.min(m[1].length + 2, 6);
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
        continue;
      }
      if (/^(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); closeList(); out.push("<hr>"); continue; }
      if ((m = line.match(/^&gt;\s?(.*)$/))) { flushPara(); closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/)) || (m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
        flushPara();
        const kind = /^\s*\d/.test(line) ? "ol" : "ul";
        if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
        let body = m[m.length - 1];
        const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
        if (task) body = `<input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inline(task[2])}`;
        else body = inline(body);
        out.push(`<li${task ? ' class="task"' : ""}>${body}</li>`);
        continue;
      }
      closeList();
      para.push(line);
    }
    flushPara(); closeList();
    return out.join("");
  }

  return { render, escape };
})();
