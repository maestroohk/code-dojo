// "Explain this error": next to a failed run or check, a button that explains the compiler or runtime error in plain
// language from the offline knowledge base (content/errors, matched by server/ErrorKb.cs to the learner's own line
// and names), with an optional AI tutor (server/Tutor.cs) when an Anthropic API key is saved in Settings.
// steps.js calls attachExplain() after drawing any run output, so lessons, katas and the playground all get it.
import { h, md, api, codeBlock } from './util.js';

let tutorStatus = null;   // { configured, model } once asked
const tutor = async (fresh = false) => {
  if (!tutorStatus || fresh) tutorStatus = await api('tutor').catch(() => ({ configured: false }));
  return tutorStatus;
};

const EXCEPTION = /\b[A-Z]\w*(?:Exception|Error)\b/;

/** Is there an error worth explaining in this result? (Wrong output alone is not an error.) */
export function hasError(r) {
  if (!r) return false;
  if ((r.diagnostics || []).some(d => d.severity === 'error' && d.file !== 'tests')) return true;
  if ((r.diagnostics || []).some(d => /^(CS86|TS)\d+/.test(d.id || ''))) return true;   // nullable warnings, tsc on a free run
  if (r.stderr && EXCEPTION.test(r.stderr)) return true;
  return (r.tests || []).some(t => !t.pass && t.detail && !t.detail.startsWith('expected ') && EXCEPTION.test(t.detail));
}

const langOf = (r, opts) => opts.lang || (r.sql ? 'sql' : document.documentElement.dataset.codeLang || 'csharp');

/**
 * Adds the "Explain this error" bar to a run-output panel. `opts`: { code, lang, graded, task } — the learner's code
 * (for their line and names), the language, whether this is a graded step (the tutor then hints, never solves) and
 * the exercise text.
 */
export function attachExplain(panel, r, opts = {}) {
  if (!panel || !hasError(r)) return;
  const code = typeof opts.code === 'function' ? opts.code() : opts.code;
  const language = langOf(r, opts);
  const box = h('div.ex-box', { hidden: true });
  const btn = h('button.btn.ghost.small.ex-btn', { type: 'button', 'aria-expanded': 'false' }, h('span.ex-icon', { 'aria-hidden': 'true' }, '?'), ' Explain this error');
  let loaded = false;
  btn.addEventListener('click', async () => {
    const open = box.hidden;
    box.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (!open || loaded) return;
    loaded = true;
    box.replaceChildren(h('p.muted.small', 'Looking it up…'));
    try {
      const res = await api('explain', { language, code: code || '', diagnostics: r.diagnostics || [], stderr: r.stderr || '', tests: r.tests || [] });
      const status = await tutor();
      render(box, res, { language, code, status, graded: opts.graded !== false, task: opts.task, output: r.stdout });
    } catch {
      loaded = false;
      box.replaceChildren(h('p.diag.error', 'Could not reach the dojo server.'));
    }
  });
  panel.append(h('div.ex-bar', btn, h('span.muted.small', 'Plain-language explanation, the usual causes and a fix'), box));
}

function render(box, res, ctx) {
  const problems = res.problems || [];
  if (!problems.length) {
    box.replaceChildren(h('p.muted.small', 'No compiler or runtime error to explain here: the code ran. Compare the expected and actual output in the checks above.'));
    return;
  }
  box.replaceChildren(...problems.map((p, i) => problemCard(p, i, ctx)));
}

function problemCard(p, i, ctx) {
  const e = p.entry;
  const label = p.code || p.exception || (ctx.language === 'sql' ? 'SQLite' : 'Error');
  const where = p.line > 0 && h('div.ex-where',
    h('span.ex-line-no', `line ${p.line}`), p.lineText != null && h('code.ex-line', p.lineText.trim() || ' '));
  const head = h('div.ex-head',
    h('span.ex-code', label),
    h('b.ex-title', e ? e.title : 'Not in the offline guide yet'));
  const body = e
    ? [
      p.specific && h('div.ex-specific', { html: md(p.specific) }),
      where,
      h('p.ex-message.small.muted', p.message),
      h('div.ex-explain', { html: md(e.explain) }),
      h('div.ex-cols',
        h('div', h('div.ex-sub', 'Usually caused by'), h('ul', e.causes.map(c => h('li', { html: md(c).replace(/^<p>|<\/p>$/g, '') })))),
        h('div', h('div.ex-sub', 'How to fix it'), h('ul', e.fix.map(c => h('li', { html: md(c).replace(/^<p>|<\/p>$/g, '') }))))),
      (e.before || e.after) && h('div.ex-compare',
        h('div', h('div.ex-sub.bad', 'Before'), h('div', { html: codeBlock(e.before || '', ctx.language) })),
        h('div', h('div.ex-sub.good', 'After'), h('div', { html: codeBlock(e.after || '', ctx.language) }))),
    ]
    : [where, h('p.ex-message.small', p.message),
      h('p.small.muted', 'Read the message from the start: it names what the compiler or runtime expected. Check the line it points at and the line just before it, then fix only the first error and run again.')];
  return h('div.ex-card', head, body, tutorBlock(p, ctx, e));
}

function tutorBlock(p, ctx, e) {
  if (!ctx.status?.configured) {
    return h('p.small.muted.ex-tutor-off', 'Want an explanation of this exact code? Add an Anthropic API key in ', h('a', { href: '#/profile' }, 'Profile → Settings'), ' to ask the AI tutor. Without one, everything here works offline.');
  }
  const out = h('div.ex-tutor-out');
  const ask = h('button.btn.ghost.small', { type: 'button' }, 'Ask the tutor about this');
  ask.addEventListener('click', async () => {
    ask.disabled = true;
    out.replaceChildren(h('p.muted.small', 'Asking the tutor…'));
    try {
      const r = await api('tutor/explain', {
        language: ctx.language, code: ctx.code || '', graded: ctx.graded, task: ctx.task || '', kbTitle: e?.title || '', output: ctx.output || '',
        problem: { kind: p.kind, code: p.code, exception: p.exception, message: p.message, line: p.line || 0, lineText: p.lineText || '' },
      });
      out.replaceChildren(r.error
        ? h('p.diag.error', r.error)
        : h('div.ex-tutor-text',
          h('div.ex-sub', `Tutor (${r.model})`, ctx.graded && h('span.muted', ' · hints only, this is a graded step')),
          h('div.prose', { html: md(r.text) })));
    } catch { out.replaceChildren(h('p.diag.error', 'Could not reach the dojo server.')); }
    ask.disabled = false;
  });
  return h('div.ex-tutor', ask, out);
}

// ---------------------------------------------------------------- Settings: the tutor's API key

/** The Settings row for the AI tutor: save or remove an Anthropic API key (kept by the server, never shown again). */
export function tutorSetting() {
  const status = h('div.muted.small', 'Checking…');
  const input = h('input.mono.ex-key', { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'sk-ant-…', 'aria-label': 'Anthropic API key' });
  const save = h('button.btn.ghost.small', { type: 'button' }, 'Save key');
  const remove = h('button.btn.ghost.small', { type: 'button', hidden: true }, 'Remove key');
  const msg = h('span.small');
  const show = s => {
    status.textContent = s.configured
      ? `A key is saved on this machine (state folder, tutor.json). The tutor uses ${s.model}. It is never sent to the browser.`
      : 'No key: "Explain this error" uses the offline guide only.';
    remove.hidden = !s.configured;
  };
  tutor(true).then(show);
  save.addEventListener('click', async () => {
    const key = input.value.trim();
    if (!key) { msg.textContent = 'Paste a key first.'; return; }
    try {
      const res = await fetch('/api/tutor', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: key }) });
      const body = await res.json();
      if (!res.ok) { msg.textContent = body.error || 'Could not save the key.'; return; }
      input.value = '';
      msg.textContent = 'Saved.';
      tutorStatus = body;
      show(body);
    } catch { msg.textContent = 'Could not reach the dojo server.'; }
  });
  remove.addEventListener('click', async () => {
    try { tutorStatus = await api('tutor', {}, 'DELETE'); show(tutorStatus); msg.textContent = 'Removed.'; } catch { msg.textContent = 'Could not reach the dojo server.'; }
  });
  return h('label.setting',
    h('div', h('div', 'AI tutor (optional)'),
      h('div.muted.small', 'With your own Anthropic API key, "Explain this error" can also ask Claude about your exact code. On graded steps it explains and hints, it never writes the solution. Requests go to api.anthropic.com and are billed to your key.'),
      status),
    h('div.ex-key-row', input, save, remove, msg));
}
