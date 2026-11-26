// What the dojo's line-based terminal (netlabs.js) understands beyond plain text and colours: markers that the shell's
// stand-ins print for the page (netlabs/images/shell/dojo-linerc). No DOM here, so Node can test it
// (tests/CodeDojo.Tests/termmarks.test.mjs).
//
//   ESC ] dojo;edit;/abs/path BEL       nano / vim / vi FILE: open FILE in the page's editor
//   ESC ] dojo;sudoedit;/abs/path BEL   sudoedit FILE, sudo nano FILE: the same, saved as root
// (ST, ESC \, may end the sequence instead of BEL.)

/** A whole OSC sequence at the start of `text`, or null. */
export const OSC = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;

/** Is `text` the start of an OSC sequence that has not ended yet (so the terminal should wait for more output)? */
export const oscPending = text => /^\x1b\]/.test(text) && !OSC.test(text) && !/^\x1b\][^\x07\x1b]*\x1b[^\\]/.test(text) && text.length < 4096;

/** The dojo marker in one OSC sequence: { kind: 'edit', path, root } or null (any other OSC, such as a window title). */
export function parseMark(osc) {
  const m = /^\x1b\]dojo;(edit|sudoedit);([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(osc);
  if (!m) return null;
  const path = m[2].trim();
  if (!path || /[\x00-\x1f]/.test(path)) return null;
  return { kind: 'edit', path, root: m[1] === 'sudoedit' };
}

/** Every marker in a piece of output, and the output without them (for tests and for anything that logs output). */
export function extractMarks(text) {
  const marks = [];
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '\x1b' && text[i + 1] === ']') {
      const m = OSC.exec(text.slice(i));
      if (m) { const mk = parseMark(m[0]); if (mk) marks.push(mk); i += m[0].length; continue; }
    }
    out += text[i++];
  }
  return { marks, text: out };
}

/** The editor language for a file in a container: what ui/util.js highlight() knows, from the name. */
export function editorLang(path) {
  const name = String(path || '').split('/').pop().toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (['yml', 'yaml'].includes(ext)) return 'yaml';
  if (ext === 'json') return 'json';
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'javascript';
  if (ext === 'ts') return 'typescript';
  if (ext === 'py') return 'python';
  if (ext === 'cs') return 'csharp';
  if (ext === 'java') return 'java';
  if (ext === 'sql') return 'sql';
  if (ext === 'css') return 'css';
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return 'html';
  if (['sh', 'bash', 'zsh'].includes(ext) || /^\.?(bashrc|profile|bash_profile|zshrc|bash_logout)$/.test(name) || name === 'dockerfile') return 'bash';
  if (['conf', 'cfg', 'ini', 'cnf', 'properties', 'env', 'toml', 'service', 'timer', 'socket', 'rules', 'list'].includes(ext) ||
    /^(hosts|fstab|crontab|resolv\.conf|sshd_config|ssh_config|sudoers|passwd|group|environment|exports|\.env)$/.test(name) ||
    /^\/etc\//.test(String(path))) return 'conf';
  return 'plain';
}
