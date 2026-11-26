// The page's file editor for the line-based terminals (live labs and terminal steps): `nano file`, `vim file`,
// `sudoedit file` in the terminal print a marker (ui/termmarks.js) and the file opens here; the terminal's
// "Open file…" button opens any path. The server reads and writes the file inside the container
// (server/ContainerFiles.cs): Save keeps the file's owner and permissions, and does not overwrite a file that
// changed in the container since it was opened without asking first.
import { h, ask } from './util.js';
import { createEditor } from './editor.js';
import { editorLang } from './termmarks.js';

let open = null;   // the editor on screen: { path, root, modal } (one at a time)

/**
 * Open `path` in the editor.
 *   call(op, body)  the server: op 'read' | 'write', body { path, root, text, eol, hash } -> JSON reply
 *   host            where the file lives, for the title ("ops", "your machine")
 *   root            read and save as root (sudoedit)
 *   onDone({ saved, path })  after Save or Cancel
 */
export async function openFileEditor({ call, host, path, root = false, onDone }) {
  if (open) {
    if (open.path === path) { open.focus(); return; }
    if (!await open.close()) return;
  }
  const status = h('span.fe-status.muted.small', { role: 'status', 'aria-live': 'polite' }, 'Opening…');
  const asRoot = h('input', { type: 'checkbox', checked: root, title: 'Read and save the file as root (like sudoedit)' });
  const saveBtn = h('button.btn.primary.small', { type: 'button', disabled: true, title: 'Write the file into the container (Ctrl+S)' }, 'Save');
  const cancelBtn = h('button.btn.ghost.small', { type: 'button', title: 'Close without saving (Esc)' }, 'Cancel');
  const title = h('b.ed-modal-title', path);
  const badges = h('span.fe-badges');
  const main = h('div.ed-modal-main.fe-main', h('div.fe-msg.muted', 'Reading the file from the container…'));
  const modal = h('div.ed-modal.fe-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': `Edit ${path}` },
    h('div.ed-modal-head',
      title, h('span.muted.small', `on ${host}`), badges,
      h('span.spacer'), status,
      h('label.fe-root.small', asRoot, ' as root'),
      cancelBtn, saveBtn),
    h('div.ed-modal-body', main),
    h('div.fe-foot.muted.small', 'Ctrl+S saves · Esc cancels · the file is written inside the container, keeping its owner and permissions'));
  document.body.append(modal);
  document.body.classList.add('ed-modal-open');

  let ed = null, file = null, clean = '', busy = false, closed = false;
  const dirty = () => !!ed && ed.value !== clean;
  const setStatus = (text, kind = 'muted') => { status.className = `fe-status small ${kind}`; status.textContent = text; };

  function finish(saved) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    modal.remove();
    if (!document.querySelector('.ed-modal')) document.body.classList.remove('ed-modal-open');
    open = null;
    onDone?.({ saved, path: file?.path || path });
  }
  async function close() {
    if (closed) return true;
    if (dirty() && !await ask(`Discard your changes to ${file?.path || path}?`, { ok: 'Discard', danger: true })) return false;
    finish(false);
    return true;
  }
  async function load() {
    saveBtn.disabled = true;
    setStatus('Opening…');
    let r;
    try { r = await call('read', { path, root: asRoot.checked }); }
    catch (e) { r = { ok: false, msg: `Could not reach the dojo server (${e.message}).` }; }
    if (closed) return;
    if (!r.ok) {
      setStatus('');
      const denied = /Permission denied/i.test(r.msg || '') && !asRoot.checked;
      main.replaceChildren(h('div.fe-msg', h('p.bad', r.msg || 'The file could not be opened.'),
        h('div.fe-actions',
          denied && h('button.btn.primary.small', { type: 'button', onclick: () => { asRoot.checked = true; load(); } }, 'Open as root'),
          h('button.btn.ghost.small', { type: 'button', onclick: () => finish(false) }, 'Close'))));
      return;
    }
    file = { path: r.path || path, eol: r.eol || 'lf', hash: r.hash, isNew: r.state === 'new' };
    title.textContent = file.path;
    badges.replaceChildren(...[
      file.isNew && h('span.fe-badge.new', 'new file'),
      file.eol === 'crlf' && h('span.fe-badge', { title: 'The file uses Windows line endings; Save keeps them' }, 'CRLF'),
      h('span.fe-badge', editorLang(file.path))].filter(Boolean));
    clean = r.text || '';
    ed = createEditor({ value: clean, language: editorLang(file.path), assist: false, popout: false, minLines: 12, path: file.path,
      onChange: () => { saveBtn.disabled = busy; setStatus(dirty() ? 'Not saved' : '', dirty() ? 'warn' : 'muted'); } });
    main.replaceChildren(ed.el);
    saveBtn.disabled = false;
    setStatus(file.isNew ? r.msg : '');
    ed.focus();
  }
  async function save(force = false) {
    if (!ed || busy) return;
    busy = true; saveBtn.disabled = true;
    setStatus('Saving…');
    let r;
    try { r = await call('write', { path: file.path, root: asRoot.checked, text: ed.value, eol: file.eol, hash: force ? null : file.hash }); }
    catch (e) { r = { ok: false, msg: `Could not reach the dojo server (${e.message}).` }; }
    busy = false; saveBtn.disabled = false;
    if (closed) return;
    if (r.ok) { clean = ed.value; file.hash = r.hash; finish(true); return; }
    if (r.state === 'changed') {
      setStatus('Changed in the container', 'warn');
      if (await ask(`${file.path} changed in the container since you opened it. Overwrite it with your version?`, { ok: 'Overwrite', danger: true })) return save(true);
      return;
    }
    setStatus(r.msg || 'Not saved', 'bad');
    if (/Permission denied/i.test(r.msg || '') && !asRoot.checked) asRoot.focus();
  }
  function onKey(e) {
    if (document.querySelector('.modal-back')) return;   // a question is open on top
    if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  saveBtn.addEventListener('click', () => save());
  cancelBtn.addEventListener('click', () => close());
  asRoot.addEventListener('change', () => { if (!ed) load(); });
  document.addEventListener('keydown', onKey, true);
  // Leaving the page (editor.js removes every .ed-modal on hashchange): forget this one too.
  window.addEventListener('hashchange', () => { if (!closed) { closed = true; document.removeEventListener('keydown', onKey, true); open = null; } }, { once: true });
  open = { path, close, focus: () => ed?.focus() };
  await load();
}

/** "Open file…": ask for a path (absolute, ~/..., or relative to the terminal's start folder), then open it. */
export function askAndOpen({ call, host, last = '', onDone }) {
  const input = h('input.fe-path', { type: 'text', value: last, spellcheck: false, autocomplete: 'off', placeholder: '/etc/hosts  or  ~/notes.txt', 'aria-label': 'File path' });
  const asRoot = h('input', { type: 'checkbox' });
  const done = go => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    const path = input.value.trim();
    if (go && path) openFileEditor({ call, host, path, root: asRoot.checked, onDone });
  };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
  };
  const overlay = h('div.modal-back', { onclick: e => { if (e.target === overlay) done(false); } },
    h('div.modal.fe-ask', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Open a file' },
      h('h3', `Open a file on ${host}`),
      h('p.muted.small', 'It opens in an editor on the page. A file that does not exist yet is created when you save.'),
      input,
      h('label.fe-root.small', asRoot, ' as root (for files only root may change)'),
      h('div.modal-actions',
        h('button.btn.ghost', { type: 'button', onclick: () => done(false) }, 'Cancel'),
        h('button.btn.primary', { type: 'button', onclick: () => done(true) }, 'Open'))));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  input.focus();
  input.select();
}
