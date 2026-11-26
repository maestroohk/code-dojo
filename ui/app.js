// Views and the lesson player.
// Routes: #/ (topics)  #/track/t  #/lesson/t/m/l  #/labs  #/labs/pki  #/projects  #/workbench  #/db  #/practice  #/playground  #/profile
import { h, md, inline, api, shuffle, ask, loader } from './util.js';
import * as game from './game.js';
import { renderStep, renderRunOutput, DRAG_TYPES, TYPE_LABEL } from './steps.js';
import { createEditor, autocompleteOn, setAutocomplete } from './editor.js';
import { blueprint } from './blueprint.js';
import { pkiLab } from './lab-pki.js';
import { linqViz } from './linqviz.js';
import { codeTrace } from './codetrace.js';
import { subnetTrainer } from './lab-subnet.js';
import { netBuildLab } from './lab-netbuild.js';
import { archBuildLab } from './lab-archbuild.js';
import { composeBuildLab } from './lab-composebuild.js';
import { kubeBuildLab } from './lab-kubebuild.js';
import { pipeBuildLab } from './lab-pipebuild.js';
import { msgBuildLab } from './lab-msgbuild.js';
import { vimLab } from './lab-vim.js';
import { regexLab } from './lab-regex.js';
import { workbench } from './workbench.js';
import { netLabs } from './netlabs.js';
import { codeSpaces } from './codespaces.js';
import { pyenvBanner } from './pyenv.js';
import { featuresView } from './features.js';
import { playgroundDebugger } from './debugger.js';
import { dbStudio } from './dbstudio.js';
import * as builds from './builds.js';
import { welcomeView, pathPanel, shouldWelcome } from './welcome.js';
import * as gamify from './gamify.js';
import * as pacing from './pacing.js';

const app = document.getElementById('app');
let tracks = [];
let leave = null;              // cleanup for the current view

// ---------------------------------------------------------------- shell

function toast(node, kind = '') {
  const host = document.getElementById('toasts');
  const el = h(`div.toast.${kind || 'info'}`, node);
  host.append(el);
  setTimeout(() => el.classList.add('out'), 3600);
  setTimeout(() => el.remove(), 4100);
}

function announce(fresh) {
  for (const a of fresh) toast([h('span.toast-icon', a.icon), h('div', h('strong', 'Achievement unlocked'), h('div', a.title))], 'gold');
}

function confetti() {
  const canvas = h('canvas.confetti');
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  const W = canvas.width = innerWidth, H = canvas.height = innerHeight;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d9773f';
  const colors = [accent, '#22c98a', '#ffb020', '#ff5d73', '#36b3ff'];
  const bits = Array.from({ length: 110 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 200, y: H * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 3,
    s: 4 + Math.random() * 6, r: Math.random() * 6, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  let frame = 0;
  (function tick() {
    ctx.clearRect(0, 0, W, H);
    for (const b of bits) {
      b.vy += 0.32; b.x += b.vx; b.y += b.vy; b.r += 0.2; b.vx *= 0.99;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * 0.6); ctx.restore();
    }
    if (++frame < 150) requestAnimationFrame(tick); else canvas.remove();
  })();
}

function header(active) {
  const lv = game.levelInfo();
  const goal = game.state.settings.dailyGoal;
  const today = game.todayXp();
  const days = game.streak();
  const link = (hash, label, id) => h(`a.nav-link${active === id ? '.active' : ''}`, { href: hash }, label);
  const due = game.dueReviews().length;
  return h('header.top',
    h('a.brand', { href: '#/' }, h('span.brand-mark', '{ }'), h('span', 'code-dojo')),
    h('nav.nav',
      link('#/', 'Topics', 'home'),
      link('#/labs', 'Labs', 'labs'),
      h(`a.nav-link${active === 'practice' ? '.active' : ''}`, { href: '#/practice' }, 'Practice', due > 0 && h('span.badge', due)),
      link('#/projects', 'Projects', 'projects'),
      link('#/builds', 'Builds', 'builds'),
      moreMenu(active, [['#/workbench', 'Workbench', 'workbench'], ['#/spaces', 'Code spaces', 'spaces'], ['#/db', 'Databases', 'db'],
        ['#/playground', 'Playground', 'playground'], ['#/features', "What's in the dojo", 'features'], ['#/profile', 'Profile', 'profile']])),
    h('div.stats',
      h(`div.stat.streak${days > 0 && game.state.days[game.dayKey()] ? '.lit' : ''}`, { title: `${days}-day streak${gamify.freezes() ? ` · ${gamify.freezes()} streak freeze${gamify.freezes() === 1 ? '' : 's'}` : ''}` },
        h('span', '🔥'), h('b', days), gamify.freezes() > 0 && h('span.stat-freeze', '❄'.repeat(gamify.freezes()))),
      h('div.stat.goal', { title: `Daily goal: ${today} of ${goal} XP` },
        h('div.ring', { style: { '--p': Math.min(1, today / goal) } }), h('b', `${today}`), h('span.muted', `/ ${goal} XP`)),
      h('a.stat.level', { href: '#/profile', title: `${lv.rank}: ${lv.into} of ${lv.need} XP to the next level` },
        h('span.level-num', lv.level),
        h('div.level-meta', h('span.level-rank', gamify.headerTitle(lv.rank)), h('div.bar', h('div.bar-fill', { style: { width: `${(lv.into / lv.need) * 100}%` } }))))));
}

/**
 * "More ▾": the less-used destinations, so the header stays calm. A menu button (Enter, Space or ↓ opens it,
 * ↑ ↓ Home End move, Escape closes and returns focus). The menu is fixed-positioned because the nav scrolls.
 */
function moreMenu(active, items) {
  const current = items.find(([, , id]) => id === active);
  const btn = h(`button.nav-link.nav-more${current ? '.active' : ''}`, { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'nav-more-menu' },
    current ? current[1] : 'More', h('span.nav-caret', { 'aria-hidden': 'true' }, '▾'));
  const menu = h('div.nav-menu', { id: 'nav-more-menu', role: 'menu', hidden: true, 'aria-label': 'More destinations' },
    items.map(([hash, label, id]) => h(`a.nav-menu-item${id === active ? '.active' : ''}`, { href: hash, role: 'menuitem', tabindex: '-1', 'aria-current': id === active ? 'page' : null }, label)));
  const links = () => [...menu.querySelectorAll('a')];
  const onDoc = e => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(); };
  function open(focusAt = 0) {
    const r = btn.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - 240)))}px`;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onDoc);
    const list = links();
    list[(focusAt + list.length) % list.length]?.focus();
  }
  function close(refocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDoc);
    if (refocus) btn.focus();
  }
  btn.addEventListener('click', () => (menu.hidden ? open() : close()));
  btn.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (menu.hidden) open(0); else close(true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open(-1); }
    else if (e.key === 'Escape') close(true);
  });
  menu.addEventListener('keydown', e => {
    const list = links();
    const at = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'Tab') close();
  });
  menu.addEventListener('click', () => close());
  return h('div.nav-more-wrap', btn, menu);
}

function page(active, ...content) {
  app.replaceChildren(header(active), h('main.page', content));
  window.scrollTo(0, 0);
  gamify.afterPage();
}

// ---------------------------------------------------------------- home / map

function stars(n, max = 3) {
  return h('span.stars', Array.from({ length: max }, (_, i) => h(`span.star${i < n ? '.on' : ''}`, '★')));
}

const LABS = [
  { id: 'pki', icon: '🔐', title: 'Certificate chain lab', category: 'Security',
    text: 'Build roots, intermediates and server certificates like blocks, wire up who signs whom, and watch real chain validation succeed or fail. Eight fix-it challenges.' },
  { id: 'subnet', icon: '⧖', title: 'Subnetting trainer', category: 'Networking',
    text: 'Endless subnetting questions (network, broadcast, host ranges, masks, splitting blocks) with a bit-by-bit breakdown after every answer, until it is automatic.' },
  { id: 'netbuild', icon: '🔌', title: 'Network builder', category: 'Networking',
    text: 'Place PCs, switches, routers and the Internet on a topology diagram, cable them, set addresses, gateways, static routes and NAT, then ping and watch the packet hop by hop with every decision explained. Twelve challenges.' },
  { id: 'archbuild', icon: '🏗', title: 'Architecture builder', category: 'Architecture',
    text: 'Wire a client through an API gateway and integration routes to services, queues, caches and databases. Send bursts, inject failures and read the dashboard: 401, 429, 502, 504 and the 204 trap. Ten challenges.' },
  { id: 'composebuild', icon: '🐳', title: 'Compose builder', category: 'Docker',
    text: 'Draw containers, networks, volumes and bind mounts and run docker compose up: start order, healthchecks, port clashes, who reaches whom by name, and which data survives. Live compose.yaml you can edit. Eleven challenges.' },
  { id: 'kubebuild', icon: '☸', title: 'Kubernetes builder', category: 'Kubernetes',
    text: 'Ingress, Services, Deployments, probes, ConfigMaps, Secrets and claims. Send requests from outside, roll out a broken release, delete pods: no endpoints, 502, CrashLoopBackOff, explained. Eleven challenges.' },
  { id: 'pipebuild', icon: '⛓', title: 'Pipeline builder', category: 'CI/CD',
    text: 'Jobs, needs, artifacts, caches, a matrix, environments with approvals and secrets. Run it for a push, a pull request or a fork and watch the timeline. Generates the GitHub Actions YAML. Ten challenges.' },
  { id: 'msgbuild', icon: '📨', title: 'Messaging builder', category: 'Messaging',
    text: 'RabbitMQ and Kafka on one board: exchanges, bindings, acks, dead-letter queues and restarts; partitions, keys, replicas, consumer groups, offsets and lag. Every message animated, every decision explained. Eleven challenges each.' },
  { id: 'vim', icon: '⌨', title: 'Vim & nano trainer', category: 'Linux',
    text: 'A real Vim emulator with 36 keystroke-golf challenges, from "how do I quit?" to text objects, dot-repeat and :%s. Plus nano basics, a cheat sheet and free practice.' },
  { id: 'regex', icon: '.*', title: 'Regex lab', category: 'Tools',
    text: 'Live matching with every group in colour, each token explained in plain English, a step debugger that shows backtracking (and catastrophic backtracking), substitutions, and the same pattern as C#, JavaScript, Python, rg, grep, sed and PowerShell. Seventeen real-task challenges.' },
  { id: 'code', icon: '▶', title: 'Code in motion', category: 'Foundations',
    text: 'Step through any program line by line, forwards and backwards: watch loops count, variables change, arrays get sorted and recursive calls stack up.' },
  { id: 'linq', icon: '⇶', title: 'LINQ in motion', category: 'C#',
    text: 'Type a query and watch every item travel through Where, Select, OrderBy and GroupBy in the order it really happens. See deferred execution and buffering with your own eyes.' },
  { id: 'net', icon: '🌐', title: 'Live network labs', category: 'Networking & security',
    text: 'Thirteen hands-on labs on real containers: addressing, routing, packet capture, DNS, NAT, scanning, firewalls, TLS, logs and SSH, plus an Apache Camel and Kong gateway stack and real RabbitMQ and Kafka brokers. Terminals right in the page. Needs Docker Desktop.' },
  { id: 'linux', icon: '🐧', title: 'Linux missions', category: 'Linux',
    text: 'Twelve story-driven missions as the new sysadmin of a biscuit company: files, pipes, permissions, processes, full disks, text surgery, scripts, cron, users, packages, and a boss-fight incident night. Needs Docker Desktop.' },
];

const CODE_PRESETS = [
  { title: 'A counting loop', group: 'Loops', point: 'Watch i and sum. The condition is tested once more than the body runs: the last test fails and the loop ends.',
    code: ['var sum = 0;', 'for (var i = 1; i <= 4; i++)', '{', '    sum += i;', '}', 'Console.WriteLine($"sum = {sum}");'] },
  { title: 'Nested loops', group: 'Loops', point: 'The inner loop runs completely for every single turn of the outer loop.',
    code: ['for (var row = 1; row <= 3; row++)', '{', '    var line = "";', '    for (var col = 1; col <= row; col++)', '        line += "*";', '    Console.WriteLine(line);', '}'] },
  { title: 'While: until it is done', group: 'Loops', point: 'A while loop does not know in advance how many times it will run. Here: halving until we reach 1.',
    code: ['var n = 40;', 'var steps = 0;', 'while (n > 1)', '{', '    n = n % 2 == 0 ? n / 2 : 3 * n + 1;', '    steps++;', '}', 'Console.WriteLine(steps);'] },
  { title: 'Swapping two values', group: 'State', point: 'Without a temporary variable, the first assignment would destroy a value you still need.',
    code: ['var a = 3;', 'var b = 7;', 'var temp = a;', 'a = b;', 'b = temp;', 'Console.WriteLine($"{a} {b}");'] },
  { title: 'Bubble sort', group: 'Algorithms', point: 'Each pass bubbles the largest remaining value to the end. Watch the boxes swap.',
    code: ['int[] a = { 5, 2, 4, 1, 3 };', 'for (var pass = 0; pass < a.Length - 1; pass++)', '{', '    for (var j = 0; j < a.Length - 1 - pass; j++)', '    {', '        if (a[j] > a[j + 1])', '            (a[j], a[j + 1]) = (a[j + 1], a[j]);', '    }', '}', 'Console.WriteLine(string.Join(", ", a));'] },
  { title: 'Binary search', group: 'Algorithms', point: 'Every step halves the range lo..hi: 10 items need at most 4 looks, a million need 20.',
    code: ['int[] a = { 2, 5, 8, 12, 16, 23, 38, 41, 56, 72 };', 'var target = 41;', 'var lo = 0;', 'var hi = a.Length - 1;', 'var found = -1;', 'while (lo <= hi)', '{', '    var mid = (lo + hi) / 2;', '    if (a[mid] == target) { found = mid; break; }', '    if (a[mid] < target) lo = mid + 1;', '    else hi = mid - 1;', '}', 'Console.WriteLine($"found at {found}");'] },
  { title: 'Recursion: factorial', group: 'Functions', point: 'Each call waits for the one it made. Watch the call stack grow to the base case, then unwind.',
    code: ['Console.WriteLine(Factorial(4));', '', 'int Factorial(int n)', '{', '    if (n <= 1) return 1;', '    var rest = Factorial(n - 1);', '    return n * rest;', '}'] },
  { title: 'Two pointers', group: 'Algorithms', point: 'Reverse in place: one pointer from each end, meeting in the middle.',
    code: ['char[] word = "dojo!".ToCharArray();', 'var left = 0;', 'var right = word.Length - 1;', 'while (left < right)', '{', '    (word[left], word[right]) = (word[right], word[left]);', '    left++;', '    right--;', '}', 'Console.WriteLine(new string(word));'] },
  { title: 'A list growing', group: 'Collections', point: 'Lists grow as you add. Watch the boxes appear, and Remove close the gap.',
    code: ['var basket = new List<string>();', 'basket.Add("apple");', 'basket.Add("bread");', 'basket.Add("milk");', 'basket.Remove("bread");', 'basket.Insert(0, "eggs");', 'Console.WriteLine(basket.Count);'] },
];

function codeLab(lab) {
  const slot = h('div');
  const point = h('p.lv-point');
  const pick = (p, btn) => {
    slot.replaceChildren(codeTrace(p, { editable: true }));
    point.textContent = p.point;
    btn?.closest('.ct-presets').querySelectorAll('.pk-ch').forEach(b => b.classList.toggle('active', b === btn));
  };
  const groups = [...new Set(CODE_PRESETS.map(p => p.group))];
  page('labs',
    h('a.back-link', { href: '#/labs' }, '← All labs'),
    h('div.track-head', h('div', h('h2.track-title', `${lab.icon} ${lab.title}`),
      h('p.muted', 'Pick an example or write your own. The code really runs; then you can replay every step, forwards and backwards.'))),
    h('div.ct-presets', groups.map(g => h('div.ct-group', h('span.muted.small', g),
      CODE_PRESETS.filter(p => p.group === g).map(p => h(`button.pk-ch${p === CODE_PRESETS[0] ? '.active' : ''}`, { type: 'button', onclick: e => pick(p, e.currentTarget) }, p.title))))),
    point, slot);
  pick(CODE_PRESETS[0]);
}

// Each preset makes one point. Pick one, press play, then change the query and run it again.
const LINQ_PRESETS = [
  { title: 'One item at a time', point: 'Where and Select stream: 5 goes all the way through before 3 is even read.',
    source: 'new[] { 5, 3, 8, 1, 9 }', query: '.Where(n => n > 2).Select(n => n * 10)' },
  { title: 'OrderBy has to wait', point: 'OrderBy cannot give out the smallest item until it has seen every item, so it reads the whole source first.',
    source: 'new[] { 5, 3, 8, 1, 9 }', query: '.Where(n => n > 2).OrderBy(n => n).Select(n => n * 10)' },
  { title: 'Take stops early', point: 'Take(2) stops pulling after two items: 1 and 9 are never read at all.',
    source: 'new[] { 5, 3, 8, 1, 9 }', query: '.Select(n => n * 10).Take(2)' },
  { title: 'Order of operators matters', point: 'Filtering first means Select does less work. Swap them and count the chips.',
    source: 'Enumerable.Range(1, 10)', query: '.Select(n => n * n).Where(n => n % 2 == 0)' },
  { title: 'GroupBy buffers too', point: 'GroupBy reads everything, then hands out one group per key.',
    source: 'new[] { "apple", "avocado", "banana", "blueberry", "cherry" }', query: '.GroupBy(w => w[0]).Select(g => $"{g.Key}: {g.Count()}")' },
  { title: 'Terminal operators run it', point: 'Sum is not lazy: it pulls everything and returns one number.',
    source: 'new[] { 4, 7, 10, 13 }', query: '.Where(n => n % 2 == 0).Sum()' },
  { title: 'Records and objects', point: 'Works with your own types. Watch Select pick a property out of each order.',
    source: 'new[] { new Order("ann", 30m), new Order("bob", 120m), new Order("cy", 75m) }', query: '.Where(o => o.Total > 50).OrderByDescending(o => o.Total).Select(o => o.Customer)',
    setup: 'record Order(string Customer, decimal Total);' },
];

const trackHash = id => `#/track/${id}`;

// A detour: from a project stage into the lesson that teaches what it needs, and back to the exact step.
//   { back: '#/lesson/...stage', title: 'Stage 7: ...', step: 3, lesson: 'csharp/06-.../03-...' }
const getDetour = () => { try { return JSON.parse(sessionStorage.getItem('detour') || 'null'); } catch { return null; } };
const setDetour = d => (d ? sessionStorage.setItem('detour', JSON.stringify(d)) : sessionStorage.removeItem('detour'));
function lessonByKey(key) {
  const [t, m, l] = key.split('/');
  const track = tracks.find(x => x.id === t), module = track?.modules.find(x => x.id === m), lesson = module?.lessons.find(x => x.id === l);
  return lesson && { track, module, lesson };
}
const currentTrack = () => tracks.find(t => t.id === sessionStorage.getItem('track')) || tracks[0];

/** The learning center: every topic and lab on one page. */
function home() {
  if (!tracks.length) return page('home', h('div.empty', h('h2', 'No topics found'), h('p', 'Add a folder under tracks/ and refresh.')));
  const sorted = [...tracks].sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.title.localeCompare(b.title));
  const recent = currentTrack();
  const resume = game.nextLesson(recent);
  page('home',
    h('section.hero',
      h('div',
        h('div.eyebrow', 'Learning center'),
        h('h1', 'What do you want to get better at?'),
        h('p.muted', 'Topics are courses with exercises. Labs are sandboxes where you build and break things. Projects are real apps you grow stage by stage and can run in the Workbench.')),
      resume && h('div.hero-resume',
        h('a.btn.primary.big', { href: `#/lesson/${resume.key}`, onclick: () => sessionStorage.setItem('track', recent.id) }, 'Continue'),
        h('span.muted.small', `${recent.title} · ${resume.lesson.title}`))),
    pathPanel(tracks, { nextLesson: game.nextLesson, trackProgress: game.trackProgress }),
    gamify.todayPanel({ refresh: () => { if (!location.hash || location.hash === '#/') home(); } }),
    // Topics grouped by category, in the order their first topic appears.
    [...new Set(sorted.map(t => t.category || 'Topics'))].map(cat => [
      h('h2.section-title', cat),
      h('div.catalog', sorted.filter(t => (t.category || 'Topics') === cat).map(t => {
      const prog = game.trackProgress(t);
      const next = game.nextLesson(t);
      const projects = game.projectModules(t).length;
      return h('a.topic-card', { href: trackHash(t.id) },
        h('div.topic-icon', t.icon || t.title.slice(0, 2)),
        h('div.topic-body',
          h('div.eyebrow', t.category || 'Topic'),
          h('h3', t.title),
          h('p.muted.small', t.tagline || ''),
          h('div.topic-meta',
            h('span', `${game.lessonModules(t).length} modules`),
            projects > 0 && h('span', `${projects} projects`),
            h('span', `${prog.done}/${prog.total} lessons`)),
          gamify.topicChip(t),
          h('div.bar', h('div.bar-fill', { style: { width: `${(prog.done / Math.max(1, prog.total)) * 100}%` } })),
          next && h('div.small.topic-next', `Next: ${next.lesson.title}`)));
      }))]),
    h('h2.section-title', 'Labs'),
    h('div.catalog', LABS.map(l => h('a.topic-card.lab', { href: `#/labs/${l.id}` },
      h('div.topic-icon', l.icon),
      h('div.topic-body', h('div.eyebrow', `Lab · ${l.category}`), h('h3', l.title), h('p.muted.small', l.text))))),
    h('p.catalog-foot', h('a.btn.ghost', { href: '#/features' }, "What's in the dojo: features, status and what's next")),
    h('p.muted.small.catalog-foot', 'New topics are folders under tracks/; see tracks/AUTHORING.md.'));
}

function trackView(id) {
  const track = tracks.find(t => t.id === id);
  if (!track) return notFound();
  sessionStorage.setItem('track', track.id);
  if (game.syncGates(track).length) game.save();
  const prog = game.trackProgress(track);
  const next = game.nextLesson(track);
  const first = prog.done === 0;

  const hero = next
    ? h('section.hero',
      h('div',
        h('div.eyebrow', first ? 'Start here' : 'Continue'),
        h('h1', next.lesson.title),
        h('p.muted', `${next.module.title} · ${next.lesson.kind === 'boss' ? 'Boss challenge' : `about ${next.lesson.minutes || 10} min`}`),
        h('p', next.lesson.summary || '')),
      h('a.btn.primary.big', { href: `#/lesson/${next.key}` }, first ? 'Start learning' : 'Continue'))
    : h('section.hero', h('div', h('div.eyebrow', 'Track complete'), h('h1', `You finished ${track.title} 🏆`),
      h('p.muted', 'Replay lessons for three stars, or keep sharp in Practice.')), h('a.btn.primary.big', { href: '#/practice' }, 'Practice'));

  const modules = game.lessonModules(track).map((m, mi, all) => [
    moduleSection(track, m, String(mi + 1).padStart(2, '0'), next?.key),
    m.gate && gateCard(track, m, all[mi + 1], mi + 2)]);
  const projects = game.projectModules(track);

  page('home',
    h('a.back-link', { href: '#/' }, '← All topics'),
    track.id === 'datascience' && pyenvBanner(),
    hero,
    h('div.track-head',
      h('div', h('h2.track-title', `${track.title} track`), h('p.muted', track.tagline || '')),
      h('div.track-nums',
        h('div', h('b', `${prog.done}/${prog.total}`), h('span.muted', 'lessons')),
        h('div', h('b', `${prog.stars}/${prog.maxStars}`), h('span.muted', 'stars')),
        h('div', h('b', game.state.xp.toLocaleString()), h('span.muted', 'total XP')))),
    builds.trackPanel(track, { refresh: () => trackView(track.id) }),
    gamify.trackMastery(track),
    modules,
    projects.length > 0 && h('a.project-teaser', { href: '#/projects' },
      h('div', h('div.eyebrow', 'Projects'), h('h2', 'Build something real'),
        h('p.muted', `${projects.map(p => p.title).join(', ')}. Multi-stage builds where your code carries forward and is tested like production code.`)),
      h('span.btn.ghost', 'Open projects')));
}

function linqLab(lab) {
  const slot = h('div');
  const point = h('p.lv-point');
  const pick = (p, btn) => {
    slot.replaceChildren(linqViz(p, { editable: true }));
    point.textContent = p.point;
    btn?.parentElement.querySelectorAll('.pk-ch').forEach(b => b.classList.toggle('active', b === btn));
  };
  const chips = h('div.pk-challenges', LINQ_PRESETS.map((p, i) => h(`button.pk-ch${i === 0 ? '.active' : ''}`, { type: 'button', onclick: e => pick(p, e.currentTarget) }, p.title)));
  page('labs',
    h('a.back-link', { href: '#/labs' }, '← All labs'),
    h('div.track-head', h('div', h('h2.track-title', `${lab.icon} ${lab.title}`),
      h('p.muted', 'Every query here really runs. Each column is one stage; each chip is an item leaving that stage, in the exact order it happened.'))),
    chips, point, slot);
  pick(LINQ_PRESETS[0]);
}

function labsView(id, sub) {
  if (!id) {
    return page('labs',
      h('section.hero', h('div', h('div.eyebrow', 'Labs'), h('h1', 'Build it, break it, see why'),
        h('p.muted', 'Sandboxes with real machinery underneath. Nothing here is graded, except the challenges.'))),
      h('div.catalog', LABS.map(l => h('a.topic-card.lab', { href: `#/labs/${l.id}` },
        h('div.topic-icon', l.icon),
        h('div.topic-body', h('div.eyebrow', l.category), h('h3', l.title), h('p.muted.small', l.text))))));
  }
  const lab = LABS.find(l => l.id === id);
  if (!lab) return notFound();
  if (id === 'linq') return linqLab(lab);
  if (id === 'code') return codeLab(lab);
  if (id === 'regex') {
    const host = h('div');
    page('labs', h('a.back-link', { href: '#/labs' }, '← All labs'),
      h('div.track-head', h('div', h('h2.track-title', `${lab.icon} ${lab.title}`), h('p.muted', 'Type a pattern and watch it match. .NET is the reference flavour (real System.Text.RegularExpressions on the server, with a match timeout); JavaScript runs in your browser.'))),
      host);
    leave = regexLab(host, (xp, title) => toast(h('div', h('b', `+${xp} XP`), ` · solved "${title}"`), 'gold'));
    return;
  }
  if (id === 'vim') {
    const host = h('div');
    page('labs', h('a.back-link', { href: '#/labs' }, '← All labs'),
      h('div.track-head', h('div', h('h2.track-title', `${lab.icon} ${lab.title}`),
        h('p.muted', 'Click the editor and type real Vim keys. Every challenge has a par: match the goal in as few keystrokes as you can.'))),
      host);
    return vimLab(host, (xp, title) => toast(h('div', h('b', `+${xp} XP`), ` · solved "${title}"`), 'gold'));
  }
  if (id === 'netbuild' || id === 'archbuild') {
    const host = h('div');
    page('labs', h('a.back-link', { href: '#/labs' }, '← All labs'),
      h('div.track-head', h('div', h('h2.track-title', `${lab.icon} ${lab.title}`),
        h('p.muted', id === 'netbuild'
          ? 'Build a network topology and ping across it. Every hop is explained: same subnet or gateway, which route wins, ARP, NAT and TTL, and exactly why a ping fails.'
          : 'Build a request path through real components and send traffic through it. Every response code is explained, and the dashboard shows what is (and is not) being counted.'))),
      host);
    const solved = (xp, title) => toast(h('div', h('b', `+${xp} XP`), ` · solved "${title}"`), 'gold');
    leave = id === 'netbuild' ? netBuildLab(host, solved) : archBuildLab(host, solved);
    return;
  }
  if (id === 'msgbuild') { const host = h('div'); page('labs', h('a.back-link', { href: '#/labs' }, '← All labs'), h('div.track-head', h('div', h('h2.track-title', `${lab.icon} ${lab.title}`), h('p.muted', 'Build a messaging setup as a diagram, send messages through it, and read why each one landed, waited, retried or got lost.'))), host); leave = msgBuildLab(host, (xp, title) => toast(h('div', h('b', `+${xp} XP`), ` · solved "${title}"`), 'gold'), sub); return; }
  if (id === 'composebuild' || id === 'kubebuild' || id === 'pipebuild') {
    const host = h('div');
    page('labs', h('a.back-link', { href: '#/labs' }, '← All labs'),
      h('div.track-head', h('div', h('h2.track-title', `${lab.icon} ${lab.title}`), h('p.muted', 'Build it as a diagram, run it, and read why each part works or fails. The YAML on the right follows every change.'))),
      host);
    const solved = (xp, title) => toast(h('div', h('b', `+${xp} XP`), ` · solved "${title}"`), 'gold');
    leave = { composebuild: composeBuildLab, kubebuild: kubeBuildLab, pipebuild: pipeBuildLab }[id](host, solved);
    return;
  }
  if (id === 'subnet') {
    const host = h('div');
    page('labs', h('a.back-link', { href: '#/labs' }, '← All labs'),
      h('div.track-head', h('div', h('h2.track-title', `${lab.icon} ${lab.title}`),
        h('p.muted', 'Type the answer and press Enter. After each one you see the address and mask bit by bit: blue bits name the network, the rest name the host.'))),
      host);
    return subnetTrainer(host);
  }
  const host = h('div.lab-host');
  page('labs',
    h('a.back-link', { href: '#/labs' }, '← All labs'),
    h('div.track-head', h('div', h('h2.track-title', `${lab.icon} ${lab.title}`), h('p.muted', 'Real certificates, real X509Chain validation. The lab\'s "today" is fixed so results never depend on your clock.'))),
    host);
  leave = pkiLab(host, (xp, title) => toast(h('div', h('b', `+${xp} XP`), ` · solved "${title}"`), 'gold'));
}

/**
 * The mastery gate after a module (pacing.js): what proving it takes, with links, and what it unlocks. Proven gates
 * shrink to one line; a rusty one (a re-proof failed) asks for the cold rebuild again.
 */
function gateCard(track, m, nextM, nextNum) {
  const st = pacing.gateStatus(track, m, game.state, { tracks });
  const rusty = pacing.isRusty(game.state, track, m);
  const free = game.state.settings.freeRoam;
  const what = nextM ? `Module ${nextNum}: ${nextM.title}` : 'the rest of the topic';
  const needRow = n => h(`li.gate-need${n.done ? '.done' : ''}`,
    h('span.gate-mark', { 'aria-hidden': 'true' }, n.done ? '✓' : '○'),
    h('a', { href: n.href }, n.kind === 'cold' ? (/^cold/i.test(n.title) ? n.title : `Cold rebuild: ${n.title}`) : `${n.boss ? 'Boss: ' : ''}${n.title}`),
    h('span.muted.small', n.kind === 'cold' ? (n.done ? 'passed from memory' : 'pass it from memory')
      : `${n.want} star${n.want === 1 ? '' : 's'} needed${n.done ? '' : n.have ? `, you have ${n.have}` : ''}`));
  if (st.proven && !rusty) {
    return h('div.gate-card.proven', { role: 'note' }, h('span.gate-icon', { 'aria-hidden': 'true' }, '✓'),
      h('div.grow', h('b', `${m.title}: proven`), h('span.muted.small', nextM ? ` · ${what} is open` : '')));
  }
  if (st.proven && rusty) {
    const cold = st.needs.find(n => n.kind === 'cold') || st.needs[0];
    return h('div.gate-card.rusty', { role: 'note' }, h('span.gate-icon', { 'aria-hidden': 'true' }, '!'),
      h('div.grow', h('b', `${m.title} is getting rusty`),
        h('p.muted.small', 'A "Can you still do it?" check did not pass. Rebuild it from memory to make it solid again. Nothing is locked.'),
        cold && h('a.btn.ghost.small', { href: cold.href }, `Re-prove: ${cold.title}`)));
  }
  return h('div.gate-card', { role: 'note' },
    h('span.gate-icon', { 'aria-hidden': 'true' }, '🔒'),
    h('div.grow',
      h('b', `Prove it to unlock ${what}`),
      h('p.muted.small', free
        ? 'Free roam is on, so the next module is open anyway, but this one is not yet proven.'
        : 'Pass these and the next module opens. It is how the skills here stick, not a test you can fail.'),
      h('ul.gate-needs', st.needs.map(needRow))));
}

/** One module (or project) card with its lessons (or stages). */
function moduleSection(track, m, label, nextKey) {
  const project = game.isProject(m);
  const done = m.lessons.filter(l => game.isDone(game.lessonKey(track, m, l))).length;
  const blocker = !project && game.gateBlocker(track, m);
  const rusty = !project && m.gate && pacing.isRusty(game.state, track, m);
  return h(`section.module${project ? '.project' : ''}${rusty ? '.rusty' : ''}${blocker && !game.state.settings.freeRoam ? '.gated' : ''}`,
    h('div.module-head',
      h('div.module-num', label),
      h('div.module-text', h('h2', m.title), h('p.muted', m.summary || ''),
        project && h('div.project-meta',
          m.level && h('span.muted.small', m.level),
          h('div.skill-row', (m.skills || []).map(s => h('span.skill', s))))),
      h('div.module-prog', h('span', `${done} / ${m.lessons.length}`), h('div.bar', h('div.bar-fill', { style: { width: `${(done / Math.max(1, m.lessons.length)) * 100}%` } })))),
    h('div.lessons', m.lessons.map((l, li) => {
      const key = game.lessonKey(track, m, l);
      const rec = game.state.lessons[key];
      const open = game.isUnlocked(track, m, li);
      const boss = l.kind === 'boss';
      const cls = `${rec ? '.done' : ''}${open ? '' : '.locked'}${boss ? '.boss' : ''}${nextKey === key ? '.next' : ''}`;
      const inner = [
        h('div.lesson-node', rec ? '✓' : open ? (boss ? '👑' : li + 1) : '🔒'),
        h('div.lesson-text', h('div.lesson-title', l.title), h('div.lesson-sub', boss ? 'Boss challenge' : `${l.exercises} ${project ? 'steps' : 'exercises'}`)),
        rec ? stars(rec.stars) : h('span.stars.ghost', '★★★'),
      ];
      return open
        ? h(`a.lesson${cls}`, { href: `#/lesson/${key}`, title: l.summary || '' }, inner)
        : h(`div.lesson${cls}`, { title: blocker ? `Prove "${blocker.title}" first: see its gate above` : `Finish the previous ${project ? 'stage' : 'lesson'} to unlock this one` }, inner);
    })));
}

// ---------------------------------------------------------------- projects

function projectsView() {
  const all = tracks.flatMap(t => game.projectModules(t).map(m => ({ track: t, m })));
  page('projects',
    h('section.hero',
      h('div',
        h('div.eyebrow', 'Projects'),
        h('h1', 'Build something real'),
        h('p.muted', 'A project is one program you grow over several stages. Each stage teaches what it needs, then asks you to extend your own code from the stage before. Web projects run as a real server on this machine and are tested over real HTTP.'))),
    all.length
      ? all.map(({ track, m }, i) => {
        // Point at the first unfinished stage of each project.
        const nextStage = m.lessons.find(l => !game.isDone(game.lessonKey(track, m, l)));
        const section = moduleSection(track, m, `P${i + 1}`, nextStage && game.lessonKey(track, m, nextStage));
        if (m.blueprint) {
          const stages = m.lessons.map(l => ({ title: l.title, done: game.isDone(game.lessonKey(track, m, l)) }));
          section.append(blueprint(m.blueprint, stages, nextStage ? m.lessons.indexOf(nextStage) + 1 : 0));
        }
        if (m.blueprint?.layers?.includes('Endpoints')) {
          const code = game.state.projects[`${track.id}/${m.id}`];
          section.append(h('div.project-actions',
            h('a.btn.ghost', { href: '#/workbench', onclick: () => sessionStorage.setItem('workbench-open', JSON.stringify({ name: m.title, code: code || '' })) },
              '▶ Run my code in the Workbench'),
            h('span.muted.small', code ? 'Opens your latest passing stage as a live app.' : 'Pass a stage first; until then it opens a starter app.')));
        }
        return section;
      })
      : h('div.empty', h('p.muted', 'No projects yet.')));
}

// ---------------------------------------------------------------- lesson player

/**
 * Plays a list of steps. Used for lessons and for practice sessions.
 *   items: [{ step, lessonKey, idx, track, module, lesson }]
 */
function play({ title, items, mode, meta, onFinish, startAt = 0, prereqs = [], detour = null }) {
  const total = items.length;
  let pos = Math.min(startAt, Math.max(0, items.length - 1)), combo = 0, bestCombo = 0, earned = 0, mistakes = 0, firstTry = 0, answered = 0;
  let current = null, phase = 'answer', attempts = 0, hints = 0, revealed = false;
  // For the rush detector (pacing.js): how long the session took and how much it leaned on hints and reveals.
  const startedAt = Date.now();
  let hintsUsed = 0, reveals = 0;
  let furthest = pos; // steps before this one are finished; going Back to them is a read-only review
  const replay = mode === 'lesson' && game.isDone(meta.key);
  const project = !!meta?.project;
  const boss = meta?.lesson?.kind === 'boss' || project;   // project code pays like boss code
  const challenge = mode === 'challenge';                  // the daily challenge: double XP
  game.emit('session', { mode });

  const progress = h('div.play-bar', h('div.play-fill'));
  const comboEl = h('div.combo');
  const xpEl = h('div.play-xp', '0 XP');
  const stage = h('div.stage');
  const feedback = h('div.feedback', { hidden: true });
  const hintBox = h('div.hints');
  const hintBtn = h('button.btn.ghost', { type: 'button', onclick: showHint }, '💡 Hint');
  const skipBtn = h('button.btn.ghost', { type: 'button', onclick: reveal, hidden: true }, 'Show answer');
  const mainBtn = h('button.btn.primary.big', { type: 'button', onclick: submit }, 'Check');
  const backBtn = h('button.btn.ghost.big', { type: 'button', onclick: back, title: 'Previous step' }, '← Back');
  const typeTag = h('span.tag');

  app.replaceChildren(
    h('div.player',
      h('header.play-top',
        h('button.icon-btn', { type: 'button', title: 'Leave', 'aria-label': 'Leave', onclick: quit }, '✕'),
        progress, comboEl, xpEl),
      detour && h('div.detour-bar',
        h('span', 'Studying for ', h('b', detour.title)),
        h('a.btn.primary.small', { href: detour.back }, '← Back to the project')),
      h('main.play-main', h('div.play-meta', typeTag, h('span.muted.small', title)),
        prereqs.length > 0 && h('div.prereqs',
          h('span.muted.small', 'Learn it first:'),
          prereqs.map(k => {
            const found = lessonByKey(k);
            if (!found) return null;
            const done = game.isDone(k);
            return h(`button.prereq${done ? '.done' : ''}`, {
              type: 'button', title: done ? 'You finished this lesson. Open it again to refresh it.' : 'Opens the lesson; a button there brings you back to this exact step.',
              onclick: () => { setDetour({ back: location.hash, title: title.split(' · ').pop(), step: pos, lesson: k }); location.hash = `#/lesson/${k}`; },
            }, done ? '✓ ' : '📖 ', found.lesson.title);
          })),
        stage, hintBox),
      h('footer.play-foot', feedback, h('div.foot-row', h('div.foot-left', hintBtn, skipBtn), h('div.foot-right', backBtn, mainBtn)))));
  window.scrollTo(0, 0);

  const onKey = e => {
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); back(); return; }
    if (e.key !== 'Enter' || e.target.matches('textarea, button, a, input')) return;
    e.preventDefault();
    submit();
  };
  document.addEventListener('keydown', onKey);
  leave = () => { document.removeEventListener('keydown', onKey); current?.view.destroy?.(); };

  async function quit() {
    if (answered > 0 && pos < total &&
        !(await ask('Leave this session? The XP you earned so far is kept, but it will not count as finished.', { ok: 'Leave', cancel: 'Keep going' }))) return;
    // Practice lives at #/practice and lessons at #/lesson/..., so always go via the router.
    const target = detour ? detour.back : meta?.quick || challenge ? '#/' : mode === 'practice' ? '#/practice' : project ? '#/projects' : trackHash(sessionStorage.getItem('track') || tracks[0]?.id);
    if (location.hash === target) route(); else location.hash = target;
  }

  function refresh() {
    if (!current) return;
    const step = current.item.step;
    if (phase === 'answer') {
      mainBtn.textContent = step.type === 'learn' ? 'Continue' : step.type === 'code' ? 'Run checks' : 'Check';
      mainBtn.disabled = !current.view.ready();
    }
    const left = (step.hints?.length || 0) - hints;
    // A cold rebuild has no hints and no solution to show. In Practice it can be given up honestly (it turns rusty).
    hintBtn.hidden = phase !== 'answer' || !step.hints?.length || !!step.cold;
    hintBtn.disabled = left <= 0;
    hintBtn.textContent = left > 0 ? `💡 Hint (${left})` : '💡 No more hints';
    skipBtn.hidden = !(phase === 'answer' && attempts >= 2 && step.type !== 'learn') || (step.cold && mode !== 'practice');
    skipBtn.textContent = step.cold ? 'I cannot remember it yet' : step.type === 'code' ? 'Show solution' : 'Show answer';
    backBtn.hidden = pos === 0;
  }

  function show() {
    current?.view.destroy?.();
    const item = items[pos];
    phase = 'answer'; attempts = 0; hints = 0; revealed = false;
    feedback.hidden = true; feedback.className = 'feedback';
    hintBox.replaceChildren();
    const view = renderStep(item.step, {
      onChange: refresh, submit, bonus, mode,
      // SQL: the tables this step works on. A step without its own setup (a learn card's "Try it") borrows the
      // nearest setup in the same lesson, looking forward first, so samples run against the lesson's data.
      dataSetup: dataSetupFor(items, pos),
      // Learn cards before this one in the same lesson: a "continues" sample runs after their samples (like notebook cells).
      earlierCards: items.slice(0, pos).filter(i => i.lessonKey === item.lessonKey && i.step.type === 'learn').map(i => i.step),
      track: item.track, module: item.module, lesson: item.lesson, idx: item.idx,
      // "uses": the learner's own earlier pieces travel with the check (builds.js, Pacing.cs).
      uses: step => builds.usesPayload(tracks, item.track, step),
      draftKey: `${item.lessonKey}#${item.idx}`,
      // Projects: open with the learner's latest passing program, and remember each new one.
      carried: project ? game.state.projects[meta.moduleKey] : undefined,
      onPassed: (codeNow, info) => {
        if (project) game.state.projects[meta.moduleKey] = codeNow;
        // A cold step passed from memory: gates and re-proofs can see it; a "coldOf" re-proof marks the original piece proven.
        if (info?.cold) {
          pacing.recordCold(game.state, item.lessonKey, item.idx, { at: game.dayKey(), ms: info.ms, inTime: info.inTime });
          const src = /^(.+)#(\d+)$/.exec(item.step.coldOf || '');
          if (src) builds.markCold(src[1], Number(src[2]) - 1);
        }
        const added = builds.record(tracks, item, codeNow);   // "Your builds": the newest version of this piece
        if (added) toast(builds.pieceToast(added), 'info');
        game.save();
      },
    });
    current = { item, view };
    typeTag.textContent = TYPE_LABEL[item.step.type] || item.step.type;
    typeTag.className = `tag type-${item.step.type}`;
    stage.replaceChildren(view.el);
    stage.classList.remove('enter'); void stage.offsetWidth; stage.classList.add('enter');
    progress.firstChild.style.width = `${(furthest / total) * 100}%`;
    if (pos < furthest) review();
    refresh();
    window.scrollTo(0, 0);
    if (item.step.type !== 'code') view.focus?.();
  }

  /** A step already finished in this session: show it settled, with nothing left to score. */
  function review() {
    const { item, view } = current;
    phase = 'done';
    if (item.step.type !== 'learn') {
      // Code keeps the learner's own (saved) program; other steps show the right answer.
      if (item.step.type !== 'code') { view.retry?.(); view.reveal?.(); }
      view.lock?.(true);
      setFeedback('info', 'Reviewing an earlier step', 'You already answered this one, so nothing here is scored again. Press Continue to move on.');
    }
    mainBtn.textContent = 'Continue';
    mainBtn.disabled = false;
  }

  function back() {
    if (pos === 0) return;
    pos--;
    show();
  }

  /** Extra XP outside the answer flow, e.g. for typing out a code sample. */
  function bonus(xp, kind) {
    if (replay || mode === 'practice') xp = 1;
    earned += xp;
    if (kind === 'typed') game.state.stats.typed = (game.state.stats.typed || 0) + 1;
    const { leveledUp, level } = game.addXp(xp);
    if (leveledUp) { game.sound('level'); toast([h('span.toast-icon', '⬆️'), h('div', h('strong', `Level ${level.level}`), h('div', level.rank))], 'gold'); }
    xpEl.textContent = `${earned} XP`;
    xpEl.classList.remove('bump'); void xpEl.offsetWidth; xpEl.classList.add('bump');
    game.save();
    announce(game.checkAchievements(tracks));
    return xp;
  }

  function showHint() {
    const step = current.item.step;
    if (hints >= (step.hints?.length || 0) || step.cold) return;
    hintsUsed++;
    hintBox.append(h('div.hint', h('span.hint-n', `Hint ${hints + 1}`), h('div', { html: md(step.hints[hints]) })));
    hints++;
    game.state.stats.hints++;
    refresh();
    hintBox.lastChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function setFeedback(kind, titleText, bodyHtml) {
    feedback.hidden = false;
    feedback.className = `feedback ${kind}`;
    feedback.replaceChildren(h('div.fb-title', titleText), bodyHtml ? h('div.fb-body', { html: bodyHtml }) : '');
  }

  function award(correctNow) {
    const { item } = current;
    const step = item.step;
    answered++;
    let xp = 0;
    if (correctNow && !revealed) {
      if (attempts === 1 && hints === 0) { combo++; firstTry++; } else combo = 0;
      bestCombo = Math.max(bestCombo, combo);
      xp = mode === 'practice' ? 6 : game.stepXp(step, { attempts, hints, revealed, combo, replay, boss });
      if (challenge) xp *= 2;
      // Typing an answer is harder than dragging it, so it pays a little more.
      if (current.typed) { xp += replay || mode === 'practice' ? 1 : 4; game.state.stats.typed = (game.state.stats.typed || 0) + 1; }
      game.state.stats.correct++;
      if (step.type === 'code') { game.state.stats.codePassed++; if (step.mode === 'fix') game.state.stats.fixes++; }
      if (DRAG_TYPES.has(step.type)) game.state.stats.drags++;
      game.state.stats.bestCombo = Math.max(game.state.stats.bestCombo, bestCombo);
    }
    game.emit('answer', { correct: correctNow && !revealed, firstTry: attempts === 1 && hints === 0, combo, mode, type: step.type, typed: !!current.typed, track: item.track });
    // A cold step in Practice is a re-proof: passing within three runs counts (it is written from memory).
    if (mode === 'practice') game.reviewed(item.lessonKey, item.idx, correctNow && !revealed && (step.cold ? attempts <= 3 : attempts === 1));
    else if (step.type !== 'code' && (attempts > 1 || revealed)) game.missed(item.lessonKey, item.idx);

    if (xp) {
      earned += xp;
      const { leveledUp, level } = game.addXp(xp);
      if (leveledUp) { game.sound('level'); toast([h('span.toast-icon', '⬆️'), h('div', h('strong', `Level ${level.level}`), h('div', level.rank))], 'gold'); }
    }
    xpEl.textContent = `${earned} XP`;
    xpEl.classList.remove('bump'); void xpEl.offsetWidth; xpEl.classList.add('bump');
    comboEl.textContent = combo >= 3 ? `🔥 ${combo} in a row` : '';
    game.save();
    announce(game.checkAchievements(tracks));
    return xp;
  }

  async function submit() {
    if (!current || mainBtn.disabled) return;
    const { item, view } = current;
    const step = item.step;

    if (phase === 'done') return advance();
    if (step.type === 'learn') return advance();

    mainBtn.disabled = true;
    const result = await view.check();
    if (current.view !== view) return;                       // the learner left while checks were running
    if (!result.noPenalty) attempts++;
    current.typed = !!result.typed;

    if (result.correct) {
      phase = 'done';
      if (result.overTime) mistakes++;                       // a cold step over its timeLimit: one star less, never a fail
      view.lock(true);
      const xp = award(true);
      game.sound('right');
      const praise = attempts === 1 ? shuffle(['Correct!', 'Nice.', 'Exactly right.', 'Spot on.', 'You got it.'])[0] : 'Got there!';
      setFeedback('good', `${praise}  +${xp} XP`, step.explain ? md(step.explain) : '');
      mainBtn.textContent = pos === total - 1 ? 'Finish' : 'Continue';
      mainBtn.disabled = false;
      mainBtn.focus({ preventScroll: true });
    } else {
      if (!result.noPenalty) {
        if (attempts === 1 || (step.type === 'code' && attempts === 4)) mistakes++;
        combo = 0; comboEl.textContent = '';
        game.state.stats.wrong++;
        game.sound('wrong');
      }
      setFeedback('bad', step.type === 'code' ? 'Not passing yet' : 'Not quite', result.detail ? inline(result.detail) : 'Have another look and try again.');
      view.lock(false);
      refresh();
      mainBtn.disabled = false;
      mainBtn.textContent = step.type === 'code' ? 'Run checks' : 'Check again';
    }
    refresh();
  }

  function reveal() {
    const { view, item } = current;
    if (item.step.cold) return giveUp();
    revealed = true;
    reveals++;
    phase = 'done';
    view.retry?.();
    view.reveal();
    view.lock(true);
    award(false);
    setFeedback('info', 'Here is the answer', item.step.explain ? md(item.step.explain) : 'Study it, then carry on. It will come back in Practice.');
    mainBtn.textContent = pos === total - 1 ? 'Finish' : 'Continue';
    mainBtn.disabled = false;
    refresh();
  }

  /** Practice only: a re-proof the learner cannot do from memory. No answer is shown; the module turns rusty. */
  function giveUp() {
    const { view } = current;
    revealed = true;
    phase = 'done';
    view.lock(true);
    award(false);
    setFeedback('info', 'Marked as rusty', 'That is useful to know. It comes back tomorrow; rebuilding it in its lesson makes it solid again.');
    mainBtn.textContent = pos === total - 1 ? 'Finish' : 'Continue';
    mainBtn.disabled = false;
    refresh();
  }

  function advance() {
    pos++;
    furthest = Math.max(furthest, pos);
    if (pos < total) return show();
    progress.firstChild.style.width = '100%';
    current.view.destroy?.();
    current = null;
    onFinish({ earned, mistakes, firstTry, bestCombo, exercises: items.filter(i => i.step.type !== 'learn').length, replay, boss,
      ms: Date.now() - startedAt, hints: hintsUsed, reveals });
  }

  show();
}

/** The SQL setup for step `pos`: its own, else the nearest in the same lesson (forward first). */
function dataSetupFor(items, pos) {
  const own = items[pos]?.step.setup;
  if (own) return own;
  const key = items[pos]?.lessonKey;
  for (let d = 1; d < items.length; d++) {
    for (const i of [pos + d, pos - d]) {
      const it = items[i];
      if (it && it.lessonKey === key && it.step.setup) return it.step.setup;
    }
  }
  return undefined;
}

async function lessonView(trackId, moduleId, lessonId) {
  const track = tracks.find(t => t.id === trackId);
  document.documentElement.dataset.codeLang = track?.language || 'csharp';
  const module = track?.modules.find(m => m.id === moduleId);
  const index = module?.lessons.findIndex(l => l.id === lessonId) ?? -1;
  if (index < 0) return notFound();
  const meta = module.lessons[index];
  const key = game.lessonKey(track, module, meta);
  const detour = getDetour();
  const onDetour = detour?.lesson === key;                       // studying a concept for a project stage
  const returning = detour && detour.back === location.hash;     // coming back to the stage
  if (!onDetour && !game.isUnlocked(track, module, index)) { location.hash = '#/'; return; }
  let lesson;
  const slow = setTimeout(() => app.replaceChildren(loader(meta.title)), 150);
  const dream = builds.dreamParam(track);
  try { lesson = await api(`lesson/${key}${dream ? `?dream=${encodeURIComponent(dream)}` : ''}`); } catch { clearTimeout(slow); return notFound(); }
  clearTimeout(slow);

  const items = lesson.steps.map((step, idx) => ({ step, lessonKey: key, idx, track: trackId, module: moduleId, lesson: lessonId }));
  const startAt = returning ? detour.step : 0;
  if (returning) setDetour(null);
  const start = () => play({
    title: `${module.title} · ${lesson.title}`, items, mode: 'lesson',
    startAt, prereqs: lesson.prereqs || [], detour: onDetour ? detour : null,
    meta: { key, lesson: meta, project: game.isProject(module), moduleKey: `${trackId}/${moduleId}` },
    onFinish(r) {
      const starCount = game.starsFor(r.mistakes);
      const bonus = Math.round((r.boss ? 50 : 20) * (r.replay ? 0.3 : 1)) + (starCount === 3 && !r.replay ? 15 : 0);
      const before = game.state.lessons[key];
      game.state.lessons[key] = {
        stars: Math.max(before?.stars || 0, starCount),
        bestXp: Math.max(before?.bestXp || 0, r.earned + bonus),
        runs: (before?.runs || 0) + 1,
        completedAt: before?.completedAt || game.dayKey(),
      };
      if (r.mistakes === 0 && r.exercises > 0) game.state.stats.perfect++;
      if (r.boss && !before) game.state.stats.bosses++;
      // The rush detector: much faster than the lesson's minutes while leaning on hints and reveals. Never blocks.
      const rushed = !r.replay && pacing.isRushed({ ms: r.ms, minutes: meta.minutes, hints: r.hints, reveals: r.reveals, exercises: r.exercises });
      const coldNext = rushed ? pacing.coldStepsOf(track, module).find(c => c.key !== key) : null;
      if (coldNext) pacing.queueReproof(game.state, coldNext, `${trackId}/${moduleId}`, game.dayKey(game.addDays(1)));
      const proven = game.syncGates(track);
      game.emit('lesson', { key, track: trackId, stars: starCount, boss: meta.kind === 'boss', replay: r.replay, mistakes: r.mistakes, exercises: r.exercises, rushed,
        firstTime: !before, project: game.isProject(module), firstInTrack: !before && game.flatLessons(track).filter(x => game.isDone(x.key)).length === 1 });
      const { leveledUp, level } = game.addXp(bonus);
      game.save(true);
      const fresh = game.checkAchievements(tracks);
      game.save(true);
      const isProject = game.isProject(module);
      const lastStage = isProject && index === module.lessons.length - 1;
      summary({
        r, starCount, bonus, fresh, leveledUp, level, track, key, lessonTitle: lesson.title, detour: onDetour ? detour : null,
        rushed, coldNext, proven,
        heading: lastStage ? 'Project shipped!' : isProject ? 'Stage complete!' : meta.kind === 'boss' ? 'Boss defeated!' : 'Lesson complete!',
        siblings: isProject ? module.lessons.map(l => ({ key: game.lessonKey(track, module, l), lesson: l })) : null,
      });
    },
  });
  if (!onDetour && !returning && builds.needsReveal(track, key)) builds.revealScreen(app, track, start); else start();
}

function summary({ r, starCount, bonus, fresh, leveledUp, level, track, key, heading, lessonTitle, practice, siblings, detour, again, rushed, coldNext, proven }) {
  leave?.(); leave = null;
  game.sound('done');
  confetti();
  const all = siblings || (track ? game.flatLessons(track) : []);
  const home = siblings ? '#/projects' : trackHash(track?.id || '');
  const at = all.findIndex(x => x.key === key);
  const next = at >= 0 ? all[at + 1] : null;
  const accuracy = r.exercises ? Math.round((r.firstTry / r.exercises) * 100) : 100;

  app.replaceChildren(h('div.summary',
    h('div.summary-card',
      h('div.summary-icon', practice ? '🔁' : r.boss ? '👑' : '🎉'),
      h('h1', heading),
      lessonTitle && h('p.muted', lessonTitle),
      !practice && h('div.big-stars', stars(starCount)),
      h('div.summary-stats',
        h('div', h('b', { dataset: { tick: r.earned + bonus, prefix: '+' } }, `+${r.earned + bonus}`), h('span.muted', 'XP earned')),
        h('div', h('b', `${accuracy}%`), h('span.muted', 'first try')),
        h('div', h('b', r.bestCombo), h('span.muted', 'best combo'))),
      bonus > 0 && h('p.muted.small', `Includes a ${bonus} XP completion bonus${r.replay ? ' (replays earn less)' : ''}.`),
      leveledUp && h('div.level-up', `⬆️ Level ${level.level}: ${level.rank}`),
      proven?.length > 0 && h('div.gate-card.proven.summary-gate', h('span.gate-icon', { 'aria-hidden': 'true' }, '✓'),
        h('div.grow', h('b', `${proven.map(m => m.title).join(', ')}: proven`),
          h('div.muted.small', 'The next module is open. In 3 and 10 days a cold rebuild from it comes back in Practice: can you still do it?'))),
      rushed && h('div.rush-nudge', { role: 'note' },
        h('b', 'You moved fast'),
        h('p.small', `That took ${pacing.clock(r.ms)} with ${r.hints + r.reveals} hint${r.hints + r.reveals === 1 ? '' : 's'} and answers shown. Speed is fine; skills stick when you rebuild them from memory. `,
          coldNext ? 'Try the cold rebuild before moving on? It is also in tomorrow\'s Practice.' : 'Try this lesson again without hints before moving on?',
          ' (No quest progress for this one.)'),
        h('div.rush-actions',
          coldNext && h('a.btn.ghost.small', { href: `#/lesson/${coldNext.key}` }, 'Try the cold rebuild'),
          h('a.btn.ghost.small', { href: `#/lesson/${key}`, onclick: () => setTimeout(route) }, 'Replay without hints'))),
      !practice && track && builds.summaryPanel(track, key),
      fresh.length > 0 && h('div.summary-badges', fresh.map(a => h('div.badge-row', h('span.badge-icon', a.icon), h('div', h('strong', a.title), h('div.muted.small', a.text))))),
      h('div.summary-actions',
        detour && h('a.btn.primary.big', { href: detour.back }, `Back to ${detour.title}`),
        detour ? null :
        h('a.btn.ghost', { href: home }, siblings ? 'Back to projects' : 'Back to the map'),
        detour ? null :
        practice ? h('a.btn.primary.big', { href: again || '#/practice', onclick: () => setTimeout(route) }, again === '#/' ? 'Done' : 'Practice again')
          : next ? h('a.btn.primary.big', { href: `#/lesson/${next.key}` }, siblings ? 'Next stage' : next.lesson.kind === 'boss' ? 'Face the boss' : 'Next lesson')
            : h('a.btn.primary.big', { href: home }, 'Done')),
      !detour && gamify.oneMore({ track, key, practice }))));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- quick session and daily challenge (rules in gamify.js)

/** Five due reviews or quick questions; with nothing to review yet, the next lesson instead. */
async function quickView() {
  const slow = setTimeout(() => app.replaceChildren(loader('a quick session')), 150);
  const items = await gamify.quickItems(5);
  clearTimeout(slow);
  if (location.hash !== '#/quick') return;
  if (!items.length) { location.replace(gamify.resumeTarget()?.href || '#/'); return; }
  play({
    title: 'Quick session', items, mode: 'practice', meta: { quick: true },
    onFinish(r) {
      game.state.stats.practice++;
      game.save(true);
      const fresh = game.checkAchievements(tracks);
      game.save(true);
      summary({ r, starCount: 0, bonus: 0, fresh, heading: 'Quick session done', practice: true, again: '#/' });
    },
  });
}

/** The daily challenge: one hard exercise, double XP, its own streak. */
async function challengeView() {
  if (gamify.challengeDone()) { location.replace('#/'); return; }
  const slow = setTimeout(() => app.replaceChildren(loader('the daily challenge')), 150);
  const ch = await gamify.loadChallenge();
  clearTimeout(slow);
  if (location.hash !== '#/challenge') return;
  if (!ch) return page('home', h('div.empty', h('h2', 'No challenge today'), h('p.muted', 'Open a topic first.'), h('a.btn.primary', { href: '#/' }, 'Back')));
  document.documentElement.dataset.codeLang = tracks.find(t => t.id === ch.item.track)?.language || 'csharp';
  play({
    title: `Daily challenge · ${ch.trackTitle} · ${ch.lessonTitle}`, items: [ch.item], mode: 'challenge', meta: {},
    onFinish(r) {
      const solved = r.earned > 0;
      const bonus = solved ? 20 : 0;
      if (bonus) game.addXp(bonus);
      gamify.finishChallenge(solved, r.earned + bonus);
      const fresh = game.checkAchievements(tracks);
      game.save(true);
      summary({ r, starCount: 0, bonus, fresh, heading: solved ? 'Challenge won!' : 'Challenge over', practice: true, again: '#/',
        lessonTitle: solved ? 'Double XP, and your challenge streak grows.' : 'The answer was shown, so no XP today. A fresh challenge tomorrow.' });
    },
  });
}

// ---------------------------------------------------------------- practice

async function practiceView() {
  const due = game.dueReviews();
  const doneKeys = Object.keys(game.state.lessons);
  const start = async () => {
    const SIZE = 8;
    const picks = shuffle(due).slice(0, SIZE).map(r => ({ key: r.key, idx: r.idx }));
    const cache = new Map();
    const lessonOf = async key => {
      const t = tracks.find(x => x.id === key.split('/')[0]);
      const dream = t ? builds.dreamParam(t) : '';
      if (!cache.has(key)) cache.set(key, await api(`lesson/${key}${dream ? `?dream=${encodeURIComponent(dream)}` : ''}`).catch(() => null));
      return cache.get(key);
    };
    // Top up with random quick questions from finished lessons.
    for (const key of shuffle(doneKeys)) {
      if (picks.length >= SIZE) break;
      const lesson = await lessonOf(key);
      if (!lesson) continue;
      const candidates = shuffle(lesson.steps.map((s, idx) => ({ s, idx })).filter(x => !['learn', 'code'].includes(x.s.type)));
      for (const c of candidates.slice(0, 2)) {
        if (picks.length < SIZE && !picks.some(p => p.key === key && p.idx === c.idx)) picks.push({ key, idx: c.idx });
      }
    }
    const items = [];
    for (const p of shuffle(picks)) {
      const lesson = await lessonOf(p.key);
      const step = lesson?.steps[p.idx];
      if (!step || step.type === 'learn') { game.state.review = game.state.review.filter(r => !(r.key === p.key && r.idx === p.idx)); continue; }
      const [track, module, id] = p.key.split('/');
      items.push({ step, lessonKey: p.key, idx: p.idx, track, module, lesson: id });
    }
    if (!items.length) return;
    play({
      title: 'Practice', items, mode: 'practice', meta: {},
      onFinish(r) {
        game.state.stats.practice++;
        game.save(true);
        const fresh = game.checkAchievements(tracks);
        game.save(true);
        summary({ r, starCount: 0, bonus: 0, fresh, heading: 'Practice complete', practice: true });
      },
    });
  };

  page('practice',
    h('section.hero',
      h('div',
        h('div.eyebrow', 'Practice'),
        h('h1', due.length ? `${due.length} question${due.length === 1 ? '' : 's'} to review` : 'Keep it fresh'),
        h('p.muted', 'Questions you got wrong come back here after 1, 3, 7 and 14 days. Answer one right each time and it is mastered. Modules you proved send a cold rebuild back after 3 and 10 days: can you still do it? Sessions are topped up with quick questions from lessons you have finished.')),
      doneKeys.length || due.length
        ? h('button.btn.primary.big', { type: 'button', onclick: start }, 'Start a session')
        : h('a.btn.primary.big', { href: '#/' }, 'Finish a lesson first')),
    h('div.cards',
      h('div.card', h('b.card-num', game.state.review.length), h('span.muted', 'questions in review')),
      h('div.card', h('b.card-num', due.length), h('span.muted', 'due today')),
      h('div.card', h('b.card-num', game.state.stats.reviewed), h('span.muted', 'mastered')),
      h('div.card', h('b.card-num', game.state.stats.practice), h('span.muted', 'sessions done'))));
}

// ---------------------------------------------------------------- playground

const WEB_SAMPLE = `<!-- HTML, CSS and JavaScript, previewed live. Tick "Tailwind" to style with utility classes. -->
<main class="min-h-screen grid place-items-center bg-stone-100">
  <div class="w-80 rounded-xl bg-white p-6 shadow">
    <h1 class="text-xl font-semibold text-stone-800">Counter</h1>
    <p class="mt-1 text-sm text-stone-500">Click the button. The script below updates the page.</p>
    <button id="btn" class="mt-4 rounded-lg bg-orange-600 px-4 py-2 font-medium text-white hover:bg-orange-700">
      Clicked <span id="n">0</span> times
    </button>
  </div>
</main>

<script>
  let n = 0;
  document.getElementById('btn').addEventListener('click', () => {
    n++;
    document.getElementById('n').textContent = n;
    console.log('clicked', n);
  });
</script>`;

const CSHARP_SAMPLE = [
  '// A scratchpad. Anything you write here runs as a real C# program.',
  'var languages = new List<string> { "C#", "F#", "Visual Basic" };',
  '',
  'foreach (var name in languages.OrderBy(n => n.Length))',
  '{',
  '    Console.WriteLine($"{name} has {name.Length} characters");',
  '}',
].join('\n');

let languages = null;

async function playground() {
  languages ||= await api('languages').catch(() => [{ id: 'csharp', name: 'C#' }]);
  const all = [...languages, { id: 'web', name: 'HTML / CSS / JS', web: true }];
  const s = game.state;
  s.settings.playLang ||= 'csharp';
  const lang = all.find(l => l.id === s.settings.playLang) || all[0];
  document.documentElement.dataset.codeLang = lang.web ? 'html' : lang.id;
  const acToggle = () => h('label.small.pg-ac', { title: 'Suggestions as you type, auto-closing brackets, quotes and tags. Ctrl+Space suggests on demand; Ctrl+/ comments lines.' },
    h('input', { type: 'checkbox', checked: autocompleteOn(), onchange: e => setAutocomplete(e.target.checked) }), ' Autocomplete');
  const KEY = lang.id === 'csharp' ? 'playground' : `playground:${lang.id}`;   // C# keeps its old draft
  const sample = lang.id === 'csharp' ? CSHARP_SAMPLE : lang.web ? WEB_SAMPLE : lang.sample || '';

  const panel = h('div.output', { hidden: true });
  const status = h('span.muted.small');
  const stdin = h('textarea.answer.mono', { rows: 3, spellcheck: false, placeholder: 'Lines your program reads from standard input' });
  let busy = false;

  const tabs = h('div.pg-langs', all.map(l => h(`button.tab.small${l.id === lang.id ? '.active' : ''}`, {
    type: 'button', onclick: () => { s.settings.playLang = l.id; game.save(); playground(); },
  }, l.name)), h('span.muted.small.pg-more', { title: 'Install Go, Rust, Ruby or PHP and restart the dojo: they appear here automatically.' }, '+ more when installed'));

  // ---- the web tab: a live preview in a sandboxed frame, no server involved
  if (lang.web) {
    const frame = h('iframe.pg-frame', { sandbox: 'allow-scripts allow-modals', title: 'Preview' });
    const logs = h('pre.pg-console');
    s.settings.tailwind ??= true;
    const tw = h('input', { type: 'checkbox', checked: s.settings.tailwind, onchange: e => { s.settings.tailwind = e.target.checked; game.save(); render(); } });
    let t;
    const render = () => {
      logs.textContent = '';
      const bridge = `<script>(()=>{const send=(k,a)=>parent.postMessage({dojo:'console',k,a:a.map(x=>{try{return typeof x==='object'?JSON.stringify(x):String(x)}catch{return String(x)}}).join(' ')},'*');
        for(const k of ['log','info','warn','error']){const o=console[k];console[k]=(...a)=>{send(k,a);o.apply(console,a)}}
        addEventListener('error',e=>send('error',[e.message+' (line '+e.lineno+')']));})();<\/script>`;
      const tailwind = s.settings.tailwind ? '<script src="https://cdn.tailwindcss.com"><\/script>' : '';
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">${bridge}${tailwind}</head><body>${editor.value}</body></html>`;
    };
    const onMsg = e => {
      if (e.source !== frame.contentWindow || e.data?.dojo !== 'console') return;
      if (/cdn.tailwindcss.com should not be used in production/.test(e.data.a)) return;   // the CDN's own nag
      logs.append(h(`div.pg-log.${e.data.k}`, e.data.a));
      logs.scrollTop = logs.scrollHeight;
    };
    window.addEventListener('message', onMsg);
    leave = () => window.removeEventListener('message', onMsg);
    const preview = h('div.pg-preview', frame, h('div.ct-head', 'Console'), logs);
    const editor = createEditor({
      value: s.drafts[KEY] ?? sample, minLines: 18,
      onChange: v => { s.drafts[KEY] = v; game.save(); clearTimeout(t); t = setTimeout(render, 400); },
      onRun: render,
      // The large view keeps the live preview beside the code (moving the frame reloads it, so render again).
      popout: { title: 'index.html', runLabel: 'Refresh preview', side: () => { setTimeout(render, 0); return [preview]; } },
    });
    page('playground',
      h('div.track-head', h('div', h('h2.track-title', 'Playground'), h('p.muted', 'Try an idea in any language you have installed. Nothing here is graded.'))),
      tabs,
      h('div.pg-web',
        h('div', editor.el,
          h('div.code-tools',
            h('label.small', tw, ' Tailwind CSS'),
            acToggle(),
            h('span.muted.small', s.settings.tailwind ? 'loaded from the Tailwind CDN, so it needs internet' : ''),
            h('span.spacer'),
            h('button.btn.ghost.small', { type: 'button', onclick: async () => { if (await ask('Reset to the example?', { ok: 'Reset' })) { editor.value = sample; delete s.drafts[KEY]; game.save(); render(); } } }, 'Reset'))),
        preview));
    render();
    return;
  }

  // ---- languages that run on this machine
  const run = async () => {
    if (busy) return;
    busy = true; runBtn.disabled = true; status.textContent = lang.id === 'java' ? 'Compiling and running (Java takes a moment)…' : 'Running…';
    try {
      const r = await api('run', { track: 'csharp', language: lang.id, code: editor.value, stdin: stdin.value });
      if (lang.id === 'csharp') editor.mark(r.diagnostics);
      renderRunOutput(panel, r);
    } catch {
      panel.hidden = false;
      panel.replaceChildren(h('div.diag.error', 'Could not reach the dojo server. Is it still running?'));
    }
    busy = false; runBtn.disabled = false; status.textContent = '';
  };
  const stdinBox = h('details.stdin', h('summary', 'Program input'), stdin);
  const editor = createEditor({
    value: s.drafts[KEY] ?? sample,
    onChange: v => { s.drafts[KEY] = v; game.save(); },
    onRun: run, minLines: 14,
    onGutterClick: lang.id === 'csharp' ? line => pgDebug?.toggle(line) : undefined,
    // The large view keeps the program input, the debugger and the output beside the code.
    popout: { title: `Playground · ${lang.name || lang.id}`, side: () => [stdinBox, pgDebug?.panel, panel] },
  });
  const runBtn = h('button.btn.primary', { type: 'button', onclick: run }, '▶ Run');
  // C#: the time-travel debugger (ui/debugger.js): breakpoints in the gutter, F5 debug, Ctrl+F5 run.
  const pgDebug = lang.id === 'csharp' ? playgroundDebugger(editor, { stdin: () => stdin.value, run }) : null;
  if (pgDebug) leave = pgDebug.dispose;

  page('playground',
    h('div.track-head', h('div', h('h2.track-title', 'Playground'), h('p.muted', 'Try an idea in any language you have installed. Break something on purpose, see what happens. Nothing here is graded.'))),
    tabs,
    lang.id === 'python' && pyenvBanner({ reason: 'Charts, data and models in Python need numpy, pandas, matplotlib and scikit-learn.' }),
    h('div.playground',
      editor.el,
      h('div.code-tools', runBtn, pgDebug?.button,
        h('button.btn.ghost', { type: 'button', onclick: async () => { if (await ask('Reset to the example?', { ok: 'Reset' })) { editor.value = sample; delete s.drafts[KEY]; game.save(); } } }, 'Reset'),
        status, h('span.spacer'), acToggle(), h('span.muted.small', 'Ctrl+Space suggest · Ctrl+/ comment · Ctrl+Enter run')),
      stdinBox,
      pgDebug?.panel,
      panel));
}

// ---------------------------------------------------------------- profile

function profile() {
  const s = game.state;
  const lv = game.levelInfo();
  const answered = s.stats.correct + s.stats.wrong;

  // Last 12 weeks of activity, oldest first, aligned so each column is a week.
  const cells = [];
  const end = new Date();
  const startDay = game.addDays(-(7 * 12 - 1) - end.getDay() + 6, end);
  for (let d = new Date(startDay); d <= end; d = game.addDays(1, d)) {
    const xp = s.days[game.dayKey(d)] || 0;
    const heat = xp === 0 ? 0 : xp < s.settings.dailyGoal / 2 ? 1 : xp < s.settings.dailyGoal ? 2 : 3;
    cells.push(h(`span.heat.h${heat}`, { title: `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${xp} XP` }));
  }

  const setting = (label, help, control) => h('label.setting', h('div', h('div', label), h('div.muted.small', help)), control);
  const toggle = (key) => h('input', {
    type: 'checkbox', checked: s.settings[key],
    onchange: e => { s.settings[key] = e.target.checked; game.save(true); },
  });

  page('profile',
    h('section.hero.profile-hero',
      h('div.level-big', lv.level),
      h('div.grow',
        h('div.eyebrow', `Level ${lv.level}`),
        h('h1', lv.rank),
        h('div.bar.thick', h('div.bar-fill', { style: { width: `${(lv.into / lv.need) * 100}%` } })),
        h('p.muted.small', `${lv.into} / ${lv.need} XP to level ${lv.level + 1}`))),
    h('div.cards',
      h('div.card', h('b.card-num', s.xp.toLocaleString()), h('span.muted', 'total XP')),
      h('div.card', h('b.card-num', `${game.streak()} 🔥`), h('span.muted', 'day streak')),
      h('div.card', h('b.card-num', Object.keys(s.lessons).length), h('span.muted', 'lessons finished')),
      h('div.card', h('b.card-num', s.stats.codePassed), h('span.muted', 'code exercises passed')),
      h('div.card', h('b.card-num', answered ? `${Math.round((s.stats.correct / answered) * 100)}%` : '–'), h('span.muted', 'answers correct')),
      h('div.card', h('b.card-num', s.stats.bestCombo), h('span.muted', 'best combo'))),
    gamify.profilePanels(profile),
    h('section.panel', h('h2', 'Activity'), h('div.heatmap', cells), h('p.muted.small', 'Brighter squares are days you reached more of your daily goal.')),
    h('section.panel',
      h('h2', `Achievements  ${Object.keys(s.achievements).length} / ${game.ACHIEVEMENTS.length}`),
      h('div.badges', game.ACHIEVEMENTS.map(a => h(`div.badge-card${s.achievements[a.id] ? '.earned' : ''}`,
        h('div.badge-icon', a.icon), h('div', h('strong', a.title), h('div.muted.small', a.text)))))),
    h('section.panel',
      h('h2', 'Your path'),
      h('p.muted', s.profile ? 'Your path, dream suggestions and daily goal come from the welcome questions.' : 'Answer a few questions to get a path through the topics, dream projects that fit you and a daily goal.'),
      h('a.btn.ghost', { href: '#/welcome' }, s.profile ? 'Retake the questions' : 'Tailor the dojo to you')),
    h('section.panel',
      h('h2', 'Settings'),
      setting('Text size', 'Make everything bigger: text, code, buttons and terminals.', h('select', {
        onchange: e => { s.settings.textSize = e.target.value; applyTextSize(); game.save(true); },
      }, [['normal', 'Normal'], ['large', 'Large'], ['xlarge', 'Extra large']]
        .map(([v, label]) => h('option', { value: v, selected: (s.settings.textSize || 'normal') === v }, label)))),
      setting('Daily goal', 'XP to aim for each day.', h('select', {
        onchange: e => { s.settings.dailyGoal = Number(e.target.value); game.save(true); profile(); },
      }, [[30, 'Casual · 30 XP'], [60, 'Regular · 60 XP'], [120, 'Serious · 120 XP'], [200, 'Intense · 200 XP']]
        .map(([v, label]) => h('option', { value: v, selected: s.settings.dailyGoal === v }, label)))),
      setting('Type instead of drag', 'Fill-the-gap and ordering puzzles open in typing mode: you write the code yourself for a little extra XP. You can still switch on each puzzle.', toggle('typing')),
      setting('Free roam', 'Unlock every lesson. By default the first lesson of each module is open and the rest unlock in order.', toggle('freeRoam')),
      setting('Sound effects', 'Short tones for right and wrong answers.', toggle('sound')),
      setting('Reset progress', 'Erase XP, stars, streak and drafts on this machine.', h('button.btn.danger', {
        type: 'button',
        onclick: async () => { if (await ask('Erase all progress? This cannot be undone.', { ok: 'Erase everything', danger: true })) { await game.reset(); profile(); } },
      }, 'Reset'))));
}

function notFound() {
  page('', h('div.empty', h('h2', 'Nothing here'), h('a.btn.primary', { href: '#/' }, 'Back to the map')));
}

// ---------------------------------------------------------------- router

function route() {
  leave?.(); leave = null;
  document.documentElement.dataset.codeLang = 'csharp';
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (parts[0]) {
    case undefined: if (shouldWelcome()) { location.replace('#/welcome'); return; } return home();
    case 'track': return trackView(parts[1]);
    case 'labs': if (parts[1] === 'net' || parts[1] === 'linux') { leave = netLabs(page, parts[2], parts[1]); return; } return labsView(parts[1], parts[2]);
    case 'workbench': leave = workbench(page); return;
    case 'spaces': leave = codeSpaces(page, parts[1]); return;
    case 'features': return featuresView(page);
    case 'db': leave = dbStudio(page); return;
    case 'lesson': return lessonView(parts[1], parts[2], parts[3]);
    case 'practice': return practiceView();
    case 'quick': return quickView();
    case 'challenge': return challengeView();
    case 'projects': return projectsView();
    case 'builds': return builds.buildsView(page, tracks);
    case 'welcome': return welcomeView(page, tracks);
    case 'playground': return playground();
    case 'profile': return profile();
    default: return notFound();
  }
}

function applyTextSize() {
  document.documentElement.dataset.size = game.state.settings.textSize || 'normal';
  const term = localStorage.getItem('termSize');
  if (term) document.documentElement.style.setProperty('--term-size', term + 'px');
}

/** Your numbers, kept for the boot screen so it can greet you before the server answers. */
function saveHud() {
  try {
    const lv = game.levelInfo();
    localStorage.setItem('dojo-hud', JSON.stringify({ xp: game.state.xp, streak: game.streak(), level: lv.level, rank: lv.rank }));
    localStorage.setItem('dojo-text-size', game.state.settings.textSize || 'normal');
  } catch { }
}

async function boot() {
  const stage = (pct, text) => window.dojoBoot?.(pct, text);
  const started = Date.now();
  try {
    stage(35, 'Loading your topics…');
    const topics = api('tracks').then(t => { stage(70, 'Loading your progress…'); return t; });
    [tracks] = await Promise.all([topics, game.load()]);
    gamify.init(tracks);
    applyTextSize();
    saveHud();
    stage(100, 'Ready.');
  } catch (e) {
    app.replaceChildren(h('div.empty', h('h2', 'Cannot reach the dojo server'), h('p.muted', 'Start it with dojo.cmd and refresh this page.')));
    return;
  }
  // Let the bar reach the end, and give the fact a moment to be read on a fast machine.
  await new Promise(r => setTimeout(r, Math.max(250, 900 - (Date.now() - started))));
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', saveHud);
  route();
}

boot();
