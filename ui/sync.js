// Progress sync between machines (server side: ProgressSync.cs, merge rules: ProgressMerge.cs).
//
//   syncPanel(rerender)  the Profile section: export / import with a preview, the sync folder, Git pull / push
//   startWatcher()       every minute, notice when the server merged another machine's record and adopt it
//
// Nothing here replaces a record: imports and syncs merge (union of lessons, best stars, newest drafts...), and the
// server keeps a backup of what it had before every change in .state/backups.
import { h, api } from './util.js';
import * as game from './game.js';

const when = iso => {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return iso;
  const mins = Math.round((Date.now() - d) / 60000);
  const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  return `${d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} (${rel})`;
};

async function post(path, body, method = 'POST') {
  const res = await fetch('/api/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/** The numbers of a merge preview as short rows: what changes, before and after. */
function diffTable(s) {
  const rows = [
    ['Lessons finished', s.lessonsBefore, s.lessonsAfter],
    ['Day streak', s.streakBefore, s.streakAfter],
    ['Total XP', s.xpBefore, s.xpAfter],
  ];
  const adds = [
    ['Better star scores', s.starsRaised], ['Builds started', s.buildsAdded], ['Build pieces', s.piecesAdded],
    ['Cold rebuilds proven', s.coldAdded], ['Module gates proven', s.gatesAdded], ['Lab challenges', s.labChallengesAdded],
    ['Live-lab tasks', s.labTasksAdded], ['Achievements', s.achievementsAdded], ['Newer drafts', s.draftsChanged], ['Active days', s.daysAdded],
  ].filter(([, n]) => n > 0);
  return h('div.sy-diff',
    h('table.sy-table',
      h('thead', h('tr', h('th', ''), h('th', 'This machine'), h('th', 'After merging'))),
      h('tbody', rows.map(([label, a, b]) => h(`tr${a !== b ? '.changed' : ''}`, h('td', label), h('td', (a ?? 0).toLocaleString()), h('td', (b ?? 0).toLocaleString()))))),
    adds.length > 0 && h('ul.sy-adds', adds.map(([label, n]) => h('li', h('b', `+${n}`), ' ', label))),
    s.profileChanged && h('p.muted.small', 'The welcome answers in the file are newer and will be used.'));
}

/** Export / import, the sync folder and Git. `rerender` redraws the profile page after a merge. */
export function syncPanel(rerender) {
  const status = h('div.sy-status', h('p.muted.small', 'Reading the sync status…'));
  const importOut = h('div.sy-import-out');
  const gitOut = h('pre.sy-log', { hidden: true });
  const folderIn = h('input.sy-input', { type: 'text', placeholder: 'C:\\Users\\you\\OneDrive\\code-dojo  or a cloned private Git repo', spellcheck: false, 'aria-label': 'Sync folder' });
  const machineIn = h('input.sy-input.short', { type: 'text', placeholder: 'This machine', spellcheck: false, 'aria-label': 'Machine name' });
  const gitRow = h('div.sy-row', { hidden: true });
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  let picked = null;

  async function adopt(res) {
    if (res?.state) game.replaceState(res.state, res.rev);
    else await game.reload();
  }

  async function refresh() {
    let s;
    try { s = await api('sync/status'); } catch { status.replaceChildren(h('p.muted.small', 'The server did not answer.')); return; }
    if (document.activeElement !== folderIn) folderIn.value = s.folder || '';
    if (document.activeElement !== machineIn) machineIn.value = s.machine || '';
    gitRow.hidden = !s.isGit;
    const others = Object.entries(s.machines || {}).filter(([m]) => m !== s.machine).sort((a, b) => (a[1] < b[1] ? 1 : -1));
    status.replaceChildren(
      !s.folder ? h('p.muted.small', 'No sync folder yet. Point the dojo at a folder both machines can see; until then, use the progress file below.')
        : !s.folderOk ? h('p.sy-warn.small', `The folder ${s.folder} is not reachable from this machine right now. Nothing is lost: the dojo syncs again when it is back.`)
        : h('dl.sy-facts',
          h('dt', 'Last synced from'), h('dd', s.lastFromMachine ? [h('b', s.lastFromMachine), ` at ${when(s.lastFromAt)}`] : 'no other machine yet'),
          h('dt', 'This machine'), h('dd', h('b', s.machine), `, last wrote ${when(s.lastWriteAt)}`),
          h('dt', 'Last check'), h('dd', when(s.lastSyncAt), ' · every 3 minutes and a few seconds after each change'),
          others.length > 1 && [h('dt', 'Machines seen'), h('dd', others.map(([m, at]) => `${m} (${when(at)})`).join(', '))],
          h('dt', 'File'), h('dd', h('code', s.file)),
          s.conflictCopies > 0 && [h('dt', 'Conflict copies'), h('dd', `${s.conflictCopies} conflict cop${s.conflictCopies === 1 ? 'y' : 'ies'} of the file were merged too; you can delete them.`)]),
      s.error ? h('p.sy-warn.small', s.error) : '',
      h('p.muted.small', `Backups of the record before each merge: ${s.backups} in `, h('code', s.backupDir)));
  }

  async function saveFolder(clear) {
    status.replaceChildren(h('p.muted.small', clear ? 'Turning sync off…' : 'Saving and syncing…'));
    const res = await post('sync/config', { folder: clear ? '' : folderIn.value, machine: machineIn.value }, 'PUT').catch(e => ({ ok: false, error: e.message }));
    if (!res.ok) { status.prepend(h('p.sy-warn.small', res.error)); await refresh(); return; }
    if (clear) folderIn.value = '';
    if (res.summary?.changed) { await adopt(null); rerender?.(); return; }
    await refresh();
  }

  async function syncNow() {
    status.replaceChildren(h('p.muted.small', 'Syncing…'));
    await game.save(true);
    const res = await post('sync/now').catch(e => ({ ok: false, error: e.message }));
    if (!res.ok) status.prepend(h('p.sy-warn.small', res.error));
    if (res.summary?.changed) { await adopt(null); rerender?.(); return; }
    await refresh();
  }

  async function git(action, btn) {
    btn.disabled = true;
    gitOut.hidden = false;
    gitOut.textContent = action === 'pull' ? 'Fetching and merging…' : 'Committing and pushing…';
    await game.save(true);
    const res = await post(`sync/git/${action}`).catch(e => ({ ok: false, log: e.message }));
    btn.disabled = false;
    gitOut.textContent = res.log || (res.ok ? 'Done.' : 'git failed.');
    gitOut.classList.toggle('bad', !res.ok);
    if (action === 'pull' && res.ok) { await adopt(null); }
    await refresh();
  }

  fileIn.addEventListener('change', async () => {
    const file = fileIn.files?.[0];
    fileIn.value = '';
    if (!file) return;
    let bundle;
    try { bundle = JSON.parse(await file.text()); }
    catch { importOut.replaceChildren(h('p.sy-warn', `${file.name} is not valid JSON.`)); return; }
    importOut.replaceChildren(h('p.muted.small', 'Comparing with this machine…'));
    await game.save(true);
    const res = await post('sync/preview', { bundle }).catch(e => ({ ok: false, error: e.message }));
    if (!res.ok) { importOut.replaceChildren(h('p.sy-warn', res.error)); return; }
    picked = bundle;
    const s = res.summary;
    const from = [res.machine && `from ${res.machine}`, res.exportedAt && `exported ${when(res.exportedAt)}`].filter(Boolean).join(', ');
    importOut.replaceChildren(h('div.sy-preview',
      h('div.eyebrow', `Preview · ${file.name}${from ? ` · ${from}` : ''}`),
      h('p.sy-sentence', s.sentence),
      s.changed && diffTable(s),
      h('div.sy-row',
        s.changed && h('button.btn.primary', { type: 'button', onclick: apply }, 'Merge into this machine'),
        h('button.btn.ghost', { type: 'button', onclick: () => { picked = null; importOut.replaceChildren(); } }, s.changed ? 'Cancel' : 'Close')),
      s.changed && h('p.muted.small', 'Merging keeps everything on this machine and adds what the file has: nothing is overwritten. A backup of the current record is saved first.')));
  });

  async function apply() {
    if (!picked) return;
    importOut.replaceChildren(h('p.muted.small', 'Merging…'));
    const res = await post('sync/import', { bundle: picked }).catch(e => ({ ok: false, error: e.message }));
    picked = null;
    if (!res.ok) { importOut.replaceChildren(h('p.sy-warn', res.error)); return; }
    await adopt(res);
    rerender?.();
    // The page is redrawn; say what happened at the top of the new panel.
    setTimeout(() => document.querySelector('.sy-import-out')?.replaceChildren(h('div.sy-done',
      h('b', 'Merged. '), res.summary.sentence, res.backup && h('div.muted.small', 'The record before the merge is saved as ', h('code', res.backup)))), 0);
  }

  const pullBtn = h('button.btn.ghost', { type: 'button' }, 'Pull');
  const pushBtn = h('button.btn.ghost', { type: 'button' }, 'Commit and push');
  pullBtn.addEventListener('click', () => git('pull', pullBtn));
  pushBtn.addEventListener('click', () => git('push', pushBtn));
  gitRow.append(h('span.muted.small', 'This folder is a Git repository:'), pullBtn, pushBtn,
    h('span.muted.small', 'runs your own git with your own credentials'));

  refresh();
  return h('section.panel.sy-panel',
    h('h2', 'Sync between machines'),
    h('p.muted', 'Study at home and at work with one streak and one record. Both ways merge: lessons are joined, the best stars and scores kept, the newest draft wins, and the streak is worked out from the active days of both machines.'),
    h('div.sy-grid',
      h('div.sy-block',
        h('h3', 'Progress file'),
        h('p.muted.small', 'Everything in one versioned JSON file: lessons, stars, XP, streak, cold rebuilds, builds, drafts, lab challenges and live-lab tasks, and your welcome answers.'),
        h('div.sy-row',
          h('a.btn.ghost', { href: '/api/sync/export', download: '' }, 'Download progress file'),
          h('button.btn.ghost', { type: 'button', onclick: () => fileIn.click() }, 'Import a progress file…'), fileIn),
        importOut),
      h('div.sy-block',
        h('h3', 'Sync folder'),
        h('p.muted.small', 'A OneDrive or Dropbox folder, a network share or a cloned private Git repo. The dojo writes code-dojo-progress.json there and merges in the other machine\'s file.'),
        h('div.sy-row', folderIn),
        h('div.sy-row', machineIn,
          h('button.btn.primary', { type: 'button', onclick: () => saveFolder(false) }, 'Save and sync'),
          h('button.btn.ghost', { type: 'button', onclick: syncNow }, 'Sync now'),
          h('button.btn.ghost', { type: 'button', onclick: () => saveFolder(true) }, 'Stop syncing')),
        status, gitRow, gitOut)));
}

let watching = false;

/** Poll the server's revision; when a sync merged in another machine's record, adopt it (unless a save is pending). */
export function startWatcher() {
  if (watching) return;
  watching = true;
  setInterval(async () => {
    if (document.hidden || game.hasPendingSave()) return;
    try {
      const s = await api('sync/status');
      if (s.rev && game.revision() && s.rev !== game.revision() && !game.hasPendingSave()) await game.reload();
    } catch { /* the server is restarting: try again next time */ }
  }, 60_000);
}
