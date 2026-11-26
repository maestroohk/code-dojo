// "Set up data science tools": shown only when the dojo's Python environment (numpy, pandas,
// matplotlib) is missing, e.g. on a second machine. One click creates it; the log streams in.
import { h, api } from './util.js';

export function pyenvBanner({ reason = 'Data science lessons need numpy, pandas, matplotlib and scikit-learn.' } = {}) {
  const box = h('div.pyenv', { hidden: true });
  let timer = null;

  async function refresh() {
    let s;
    try { s = await api('pyenv'); } catch { return; }
    if (s.ready && s.state !== 'running') { box.hidden = true; return; }
    box.hidden = false;
    if (s.state === 'running') return follow();
    const missing = (s.packages || []).filter(p => !p.version).map(p => p.name);
    box.replaceChildren(
      h('div.pyenv-text',
        h('b', 'Set up the data science tools'),
        h('p.muted.small', reason, ' ',
          s.packages?.length ? `Missing here: ${missing.join(', ')}.` : 'They are not installed on this machine yet.',
          ' The dojo installs them into its own Python environment (', h('code', s.dir), '), apart from your system Python. About 100 MB from pypi.org.'),
        !s.systemPython && h('p.small.bad', 'Python 3 was not found on PATH. Install it from python.org first, then come back.')),
      h('button.btn.primary', { type: 'button', disabled: !s.systemPython && !s.packages?.length, onclick: start }, 'Set up now'));
  }

  async function start() {
    try { await api('pyenv/setup', {}); } catch { return; }
    follow();
  }

  function follow() {
    const log = h('pre.pyenv-log');
    const status = h('b', 'Setting up… this takes a few minutes.');
    box.hidden = false;
    box.replaceChildren(h('div.pyenv-text', status, log));
    clearInterval(timer);
    timer = setInterval(async () => {
      if (!box.isConnected) return clearInterval(timer);
      let r;
      try { r = await api('pyenv/log'); } catch { return; }
      log.textContent = r.log.slice(-14).join('\n');
      log.scrollTop = log.scrollHeight;
      if (r.state === 'done') { clearInterval(timer); status.textContent = 'Ready. numpy, pandas, matplotlib, scikit-learn, scipy and statsmodels are installed.'; setTimeout(refresh, 2500); }
      if (r.state === 'failed') { clearInterval(timer); status.textContent = 'Setup failed. The log below says why; you can try again.'; box.append(h('button.btn.ghost', { type: 'button', onclick: start }, 'Try again')); }
    }, 1200);
  }

  refresh();
  return box;
}
