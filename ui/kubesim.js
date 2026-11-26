// The Kubernetes builder's simulator: pure JavaScript, no DOM (runs in the browser and in Node tests).
// A model is { blocks }: the Internet (your users), an Ingress, Services, Deployments, ConfigMaps,
// Secrets and PersistentVolumeClaims. Unlike Compose there are no wires in the model: Kubernetes objects
// find each other by name (an Ingress rule names a Service, a Deployment names its ConfigMap) and by
// labels (a Service selects pods). The board draws a wire wherever a reference resolves.
// apply() works out every pod's state, every Service's endpoints and what each request from outside
// gets; rollout() plays a rolling update step by step; deletePods() shows which data survives.

export const KINDS = {
  client: { label: 'Internet', icon: '🌍' },
  ingress: { label: 'Ingress', icon: '🚪' },
  service: { label: 'Service', icon: '⚖' },
  deployment: { label: 'Deployment', icon: '📦' },
  configmap: { label: 'ConfigMap', icon: '📝' },
  secret: { label: 'Secret', icon: '🔑' },
  pvc: { label: 'PersistentVolumeClaim', icon: '💾' },
};

/** port: what the program listens on. health: the path that answers 200 when it is fine. startS: seconds to boot. */
export const IMAGES = {
  'shop-web:1.0': { port: 8080, health: '/healthz', startS: 3, app: 'web', serves: p => !p.startsWith('/api'), what: 'the shop website, listens on 8080, health at /healthz' },
  'shop-web:2.0': { port: 8080, health: '/healthz', startS: 3, app: 'web', serves: p => !p.startsWith('/api'), what: 'the new website version (works)' },
  'shop-web:2.1': { port: 8080, health: '/healthz', startS: 3, app: 'web', broken: true, serves: () => true, what: 'a release with a bad config: every request, /healthz included, gets 500' },
  'shop-api:1.0': { port: 3000, health: '/healthz', startS: 25, app: 'api', needsEnv: ['DB_PASSWORD', 'API_MODE'], serves: p => p.startsWith('/api'), what: 'the shop API, listens on 3000, needs DB_PASSWORD and API_MODE, takes about 25 s to start' },
  'postgres:16': { port: 5432, health: null, startS: 5, app: 'db', needsEnv: ['POSTGRES_PASSWORD'], data: '/var/lib/postgresql/data', serves: () => false, what: 'a database, listens on 5432 (not HTTP), keeps data in /var/lib/postgresql/data' },
};
export const IMAGE_NAMES = Object.keys(IMAGES);
const PERIOD = 5, FAILS = 3;   // probe period and failureThreshold

export const DEFAULTS = {
  client: { via: '', host: 'shop.example.com', paths: ['/'], count: 4 },
  ingress: { rules: [] },
  service: { type: 'ClusterIP', selector: '', port: 80, targetPort: 80, nodePort: 30080 },
  deployment: { image: 'shop-web:1.0', replicas: 2, labels: 'app=web', readiness: false, readyPath: '/healthz', readyPort: 8080,
    liveness: false, livePath: '/healthz', livePort: 8080, liveDelay: 0, envFrom: [], claim: '', mountPath: '', maxSurge: 1, maxUnavailable: 1, next: '' },
  configmap: { data: [] }, secret: { data: [] }, pvc: { size: '1Gi' },
};
const clone = o => JSON.parse(JSON.stringify(o));
export const block = (kind, id, name, x = 0, y = 0, settings = {}) => ({ id, kind, name, x, y, ...clone(DEFAULTS[kind]), ...settings });
export const byId = (m, id) => m.blocks.find(b => b.id === id);
export const named = (m, kind, name) => m.blocks.find(b => b.kind === kind && b.name === name);
export const ofKind = (m, kind) => m.blocks.filter(b => b.kind === kind);
export const validName = n => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(n);

/** "app=web, tier=front" -> [['app','web'],['tier','front']]; null if malformed. */
export function parseLabels(s) {
  const out = [];
  for (const part of String(s || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const m = part.match(/^([A-Za-z0-9./_-]+)\s*[=:]\s*([A-Za-z0-9._-]*)$/);
    if (!m) return null;
    out.push([m[1], m[2]]);
  }
  return out;
}
const labelText = pairs => pairs.map(([k, v]) => `${k}=${v}`).join(', ');
export const matches = (selector, labels) => selector.length > 0 && selector.every(([k, v]) => labels.some(([k2, v2]) => k === k2 && v === v2));
export function dataOf(b) {
  const o = {};
  for (const line of b.data || []) { const i = line.indexOf('='); if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return o;
}

/** Every reference between objects, resolved or not: the board draws the resolved ones as wires. */
export function refs(m) {
  const out = [];
  const add = (from, to, kind, label, extra = {}) => out.push({ id: `R-${kind}-${from.id}-${extra.rule ?? (to ? to.id : extra.ref)}`, from: from.id, to: to?.id || null, kind, label, ...extra });
  for (const c of ofKind(m, 'client')) if (c.via) {
    const t = m.blocks.find(b => (b.kind === 'ingress' || b.kind === 'service') && b.name === c.via);
    add(c, t, 'via', t?.kind === 'service' ? `:${t.nodePort}` : '', { ref: c.via });
  }
  for (const ing of ofKind(m, 'ingress')) ing.rules.forEach((r, i) => add(ing, named(m, 'service', r.service), 'rule', `${r.host ? r.host : '*'}${r.path || '/'}`, { rule: i, ref: r.service }));
  for (const s of ofKind(m, 'service')) {
    const sel = parseLabels(s.selector);
    for (const d of ofKind(m, 'deployment')) if (sel && matches(sel, parseLabels(d.labels) || [])) add(s, d, 'select', labelText(sel));
  }
  for (const d of ofKind(m, 'deployment')) {
    for (const ref of d.envFrom) {
      const [kind, name] = ref.split(':');
      add(d, named(m, kind, name), 'env', 'envFrom', { ref: name, refKind: kind });
    }
    if (d.claim) add(d, named(m, 'pvc', d.claim), 'claim', d.mountPath || '(no path)', { ref: d.claim });
  }
  return out;
}

export const TARGETS = { client: ['ingress', 'service'], ingress: ['service'], service: ['deployment'], deployment: ['configmap', 'secret', 'pvc'], configmap: [], secret: [], pvc: [] };
export const canWire = (m, from, to) => !!from && !!to && from.id !== to.id && TARGETS[from.kind].includes(to.kind);

/** Dragging one object onto another writes the reference, as you would in YAML. Returns a message or false. */
export function connect(m, fromId, toId) {
  const f = byId(m, fromId), t = byId(m, toId);
  if (!canWire(m, f, t)) return false;
  if (f.kind === 'client') { f.via = t.name; return `The Internet now sends requests to ${t.name}.`; }
  if (f.kind === 'ingress') { f.rules.push({ host: '', path: '/', service: t.name, port: t.port }); return `Added the rule "any host, path / → ${t.name}:${t.port}". Click the Ingress to edit it.`; }
  if (f.kind === 'service') { f.selector = t.labels; return `${f.name} now selects ${t.labels}: the labels on ${t.name}'s pods.`; }
  if (t.kind === 'pvc') { f.claim = t.name; f.mountPath ||= IMAGES[f.image]?.data || '/data'; return `${f.name} mounts the claim ${t.name} at ${f.mountPath}.`; }
  const ref = `${t.kind}:${t.name}`;
  if (!f.envFrom.includes(ref)) f.envFrom.push(ref);
  return `${f.name} now loads every key of ${t.name} as environment variables (envFrom).`;
}

/** Removes the reference behind a board wire. */
export function unref(m, r) {
  const f = byId(m, r.from);
  if (!f) return;
  if (r.kind === 'via') f.via = '';
  if (r.kind === 'rule') f.rules.splice(r.rule, 1);
  if (r.kind === 'select') f.selector = '';
  if (r.kind === 'env') f.envFrom = f.envFrom.filter(x => x !== `${r.refKind}:${r.ref}`);
  if (r.kind === 'claim') { f.claim = ''; }
}

// ---------------------------------------------------------------- pods

const SUFFIX = ['x7k2p', 'm4q9z', 'b8n3v', 't2w6c', 'h5r1j', 'k9d4s', 'p3f8g', 'w6c2n', 'z1q7r', 'd4v9m'];
const hashOf = (s) => { let x = 7; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x.toString(36).slice(-5).padStart(5, 'a'); };

/** The state of one pod running `image` for Deployment d: { phase, ready, why, crashes }. */
export function podState(m, d, image = d.image) {
  const img = IMAGES[image];
  if (!img) return { phase: 'ImagePullBackOff', ready: false, why: `ErrImagePull: the image "${image}" does not exist, so the kubelet cannot pull it.` };
  const env = {};
  for (const ref of d.envFrom) {
    const [kind, name] = ref.split(':');
    const src = named(m, kind, name);
    if (!src) return { phase: 'CreateContainerConfigError', ready: false, why: `${kind} "${name}" not found. The pod refers to it in envFrom, so the container cannot be created. Names must match exactly.` };
    Object.assign(env, dataOf(src));
  }
  if (d.claim && !named(m, 'pvc', d.claim)) return { phase: 'Pending', ready: false, why: `persistentvolumeclaim "${d.claim}" not found: the pod waits for its storage and is never scheduled.` };
  const missing = (img.needsEnv || []).filter(k => !env[k]);
  if (missing.length) return { phase: 'CrashLoopBackOff', ready: false, crashes: 5, why: `the app exits at start: "${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set". Put ${missing.length > 1 ? 'them' : 'it'} in a ConfigMap or Secret and load it with envFrom.` };
  const probe = (path, port, what) => {
    if (!img.health) return `${what} probe failed: ${image} is not an HTTP server, so an HTTP GET gets no answer`;
    if (Number(port) !== img.port) return `${what} probe failed: dial tcp :${port}: connection refused. The app listens on ${img.port}.`;
    if (path !== img.health) return `${what} probe failed: HTTP 404 on ${path}. The app's health endpoint is ${img.health}.`;
    if (img.broken) return `${what} probe failed: HTTP 500 on ${path}. This release is broken.`;
    return null;
  };
  if (d.liveness) {
    const bad = probe(d.livePath, d.livePort, 'Liveness');
    if (bad) return { phase: 'CrashLoopBackOff', ready: false, crashes: 5, why: `${bad} After ${FAILS} failures the kubelet kills the container and starts it again, forever.` };
    const deadline = (Number(d.liveDelay) || 0) + PERIOD * FAILS;
    if (img.startS > deadline) return { phase: 'CrashLoopBackOff', ready: false, crashes: 5, why: `Liveness probe failed: connection refused. The app needs about ${img.startS} s to start, but the probe begins at ${d.liveDelay || 0} s and gives up after ${FAILS} failures ${PERIOD} s apart (at ${deadline} s). The kubelet kills it before it ever finishes starting. Wait longer: initialDelaySeconds of at least ${img.startS - PERIOD * FAILS}.` };
  }
  if (d.readiness) {
    const bad = probe(d.readyPath, d.readyPort, 'Readiness');
    if (bad) return { phase: 'Running', ready: false, why: `${bad} The pod runs, but it is not Ready, so no Service sends it traffic.` };
  }
  return { phase: 'Running', ready: true, broken: !!img.broken, why: d.readiness ? 'Running and Ready: the readiness probe passes.' : 'Running. With no readiness probe, Kubernetes counts it Ready as soon as the container starts.' };
}

export function podsOf(m, d, image = d.image, from = 0) {
  const n = Math.max(0, Math.min(10, Number(d.replicas) || 0));
  const st = podState(m, d, image);
  const h = hashOf(d.name + image);
  return Array.from({ length: n }, (_, i) => ({ name: `${d.name}-${h}-${SUFFIX[(i + from) % SUFFIX.length]}`, dep: d.id, image, labels: parseLabels(d.labels) || [], ...st }));
}

/** Pods a Service selects, and the ready ones among them (its endpoints). */
export function endpointsOf(m, s, pods) {
  const sel = parseLabels(s.selector);
  const selected = sel ? pods.filter(p => matches(sel, p.labels)) : [];
  return { sel, selected, ready: selected.filter(p => p.ready) };
}

function noEndpointsWhy(m, s, e, pods) {
  if (!e.sel) return `the selector "${s.selector}" is not valid: write key=value pairs, like app=web.`;
  if (!e.sel.length) return `${s.name} has no selector, so it selects no pods.`;
  if (!e.selected.length) {
    const seen = [...new Set(pods.map(p => labelText(p.labels)))];
    return `${s.name} selects ${labelText(e.sel)}, and no pod has those labels${seen.length ? ` (the pods have: ${seen.join(' | ')})` : ''}. "Service has no endpoints": check the spelling, letter by letter.`;
  }
  return `${s.name} selects ${e.selected.length} pod${e.selected.length === 1 ? '' : 's'}, but none is Ready: ${e.selected[0].why}`;
}

// ---------------------------------------------------------------- requests

function routeIngress(m, ing, req) {
  const cands = ing.rules.map((r, i) => ({ r, i })).filter(({ r }) => !r.host || r.host === req.host).filter(({ r }) => req.path.startsWith(r.path || '/'));
  cands.sort((a, b) => (b.r.path || '/').length - (a.r.path || '/').length || a.i - b.i);
  return cands[0] || null;
}

/** One request from outside. -> { code, why, chain: [blockIds], pod? } */
function request(m, req, pods, rr) {
  const client = ofKind(m, 'client')[0];
  const chain = [client.id];
  const out = (code, why) => ({ code, why, chain });
  if (!client.via) return out(0, 'The Internet is not pointed at anything yet: drag its ▶ onto an Ingress or a Service.');
  const entry = m.blocks.find(b => (b.kind === 'ingress' || b.kind === 'service') && b.name === client.via);
  if (!entry) return out(0, `There is nothing called "${client.via}" to send requests to.`);
  let svc, port;
  if (entry.kind === 'ingress') {
    chain.push(entry.id);
    const hit = routeIngress(m, entry, req);
    if (!hit) return out(404, `${entry.name} has no rule for ${req.host}${req.path}, so the ingress controller's default backend answers 404.${entry.rules.some(r => r.host && r.host !== req.host) ? ` (A rule's host must equal the Host header, "${req.host}".)` : ''}`);
    svc = named(m, 'service', hit.r.service);
    if (!svc) return out(503, `Rule ${hit.r.path || '/'} sends traffic to service "${hit.r.service}", which does not exist${ofKind(m, 'service').length ? ` (Services here: ${ofKind(m, 'service').map(s => s.name).join(', ')})` : ''}. The ingress answers 503.`);
    if (Number(hit.r.port) !== Number(svc.port)) return out(503, `Rule ${hit.r.path || '/'} sends to ${svc.name} port ${hit.r.port}, but ${svc.name} exposes port ${svc.port}. The ingress answers 503.`);
    port = svc.port;
  } else {
    svc = entry;
    if (svc.type !== 'NodePort') return out(0, `${svc.name} is a ClusterIP Service: its address exists only inside the cluster, so a request from the Internet never arrives (connection timed out). Use type NodePort, or put an Ingress in front.`);
    port = svc.nodePort;
  }
  chain.push(svc.id);
  const e = endpointsOf(m, svc, pods);
  if (!e.ready.length) return out(503, `${svc.name} has no endpoints: ${noEndpointsWhy(m, svc, e, pods)}`);
  const n = rr[svc.id] = (rr[svc.id] ?? -1) + 1;
  const pod = e.ready[n % e.ready.length];
  chain.push(pod.dep);
  const img = IMAGES[pod.image];
  if (Number(svc.targetPort) !== img.port) return { ...out(502, `${svc.name} forwarded port ${port} to pod ${pod.name} on targetPort ${svc.targetPort}, but the app listens on ${img.port}: connection refused, 502.`), pod };
  if (pod.broken) return { ...out(500, `pod ${pod.name} (${pod.image}) answered 500: this release is broken, and nothing stopped traffic from reaching it.`), pod };
  if (pod.booting) return { ...out(502, `pod ${pod.name} is in the endpoints, but its app is still starting: connection refused. Without a readiness probe, "container started" counts as Ready.`), pod };
  if (!img.serves(req.path)) return { ...out(404, `the request reached pod ${pod.name}, which runs ${pod.image}. That app has no page at ${req.path}: 404. Is ${svc.name} selecting the right pods?`), pod };
  return { ...out(200, `${pod.name} (${pod.image}) answered 200.`), pod };
}

/** Steady state after kubectl apply, plus a round of requests from outside. */
export function apply(m) {
  const errors = check(m);
  if (errors) return { error: errors };
  const pods = ofKind(m, 'deployment').flatMap(d => podsOf(m, d));
  const client = ofKind(m, 'client')[0];
  const rr = {};
  const results = [];
  if (client?.via) for (const path of client.paths.length ? client.paths : ['/']) for (let i = 0; i < Math.max(1, Math.min(12, client.count)); i++) {
    results.push({ path, host: client.host, ...request(m, { host: client.host, path }, pods, rr) });
  }
  const endpoints = Object.fromEntries(ofKind(m, 'service').map(s => {
    const e = endpointsOf(m, s, pods);
    return [s.id, { ...e, why: e.ready.length ? '' : noEndpointsWhy(m, s, e, pods) }];
  }));
  return { pods, endpoints, results };
}

function check(m) {
  const seen = new Set();
  for (const b of m.blocks) {
    if (b.kind === 'client') continue;
    if (!validName(b.name)) return `"${b.name}" is not a valid name: lower-case letters, digits and -, starting and ending with a letter or digit.`;
    const k = b.kind + ':' + b.name;
    if (seen.has(k)) return `Two ${KINDS[b.kind].label}s are called "${b.name}". Names are unique per kind.`;
    seen.add(k);
    if (b.kind === 'deployment') {
      const l = parseLabels(b.labels);
      if (!l || !l.length) return `${b.name}: a Deployment needs pod labels like app=web (its own selector uses them).`;
      if (Number(b.maxSurge) === 0 && Number(b.maxUnavailable) === 0) return `${b.name}: maxSurge and maxUnavailable cannot both be 0, or a rollout could never make progress.`;
    }
    if (b.kind === 'service' && b.type === 'NodePort' && (b.nodePort < 30000 || b.nodePort > 32767)) return `${b.name}: a nodePort must be between 30000 and 32767.`;
  }
  return null;
}

// ---------------------------------------------------------------- rolling update

/**
 * Rolls Deployment d from its image to d.next, one controller step at a time, sending 4 requests per step.
 * -> { error } or { steps: [{ old, newReady, newWaiting, ready, failed, note }], failed, minReady, done, stalled }
 */
export function rollout(m, dId) {
  const d = byId(m, dId) || ofKind(m, 'deployment').find(x => x.next);
  if (!d) return { error: 'Pick a Deployment and set "New image for a rollout" in its inspector.' };
  if (!d.next || d.next === d.image) return { error: `${d.name}: set "New image for a rollout" to a different image first.` };
  const err = check(m);
  if (err) return { error: err };
  const R = Math.max(1, Number(d.replicas) || 1), surge = Math.max(0, Number(d.maxSurge) || 0), unav = Math.max(0, Number(d.maxUnavailable) || 0);
  const others = ofKind(m, 'deployment').filter(x => x !== d).flatMap(x => podsOf(m, x));
  const oldTpl = podsOf(m, { ...d, replicas: 10 })[0], newTpl = podsOf(m, { ...d, replicas: 10, image: d.next }, d.next)[0];
  const newState = podState(m, d, d.next);
  const img = IMAGES[d.next];
  const old = podsOf(m, d).filter(p => p.ready);
  let oldCount = R, made = 0;
  const fresh = [];   // { pod, age }
  const steps = [];
  let failed = 0, minReady = Infinity, stall = 0, sent = 0;
  const svcs = ofKind(m, 'service').filter(s => { const sel = parseLabels(s.selector); return sel && matches(sel, parseLabels(d.labels) || []); });
  for (let tick = 0; tick < 30; tick++) {
    // New pods: a step after creation the container runs. With a readiness probe it joins the endpoints once the
    // probe passes (one more step); without one it joins at once, even while the app is still booting.
    for (const f of fresh) f.age++;
    const newReady = fresh.filter(f => newState.ready && (d.readiness ? f.age >= 2 : f.age >= 1));
    const available = Math.min(oldCount, old.length) + newReady.length;
    let note = '';
    // Scale down old pods while enough stay available.
    const canKill = Math.max(0, available - (R - unav));
    const kill = Math.min(canKill, oldCount);
    if (kill) { oldCount -= kill; note += `removed ${kill} old pod${kill > 1 ? 's' : ''}. `; }
    // Scale up new pods within the surge.
    const room = Math.max(0, R + surge - (oldCount + fresh.length));
    const create = Math.min(room, R - fresh.length);
    for (let i = 0; i < create; i++) fresh.push({ pod: { ...newTpl, name: newTpl.name.replace(/-[^-]+$/, '-' + SUFFIX[(made++ + 5) % SUFFIX.length]) }, age: 0 });
    if (create) note += `created ${create} new pod${create > 1 ? 's' : ''} (${d.next}). `;
    // Traffic in this step.
    const live = [...old.slice(0, oldCount), ...fresh.filter(f => newState.phase === 'Running' && (d.readiness ? newState.ready && f.age >= 2 : f.age >= 1))
      .map(f => ({ ...f.pod, ready: true, booting: !d.readiness && f.age === 1 && img.startS > 0, broken: newState.broken || (!newState.ready && !d.readiness) }))];
    const readyNow = live.length;
    minReady = Math.min(minReady, readyNow);
    let bad = 0;
    if (svcs.length) {
      const pods = [...others, ...live];
      const rr = {};
      for (let i = 0; i < 4; i++) {
        sent++;
        const e = endpointsOf(m, svcs[0], pods);
        if (!e.ready.length) { bad++; continue; }
        const n = rr.x = (rr.x ?? -1) + 1;
        const p = e.ready[n % e.ready.length];
        if (p.broken || p.booting || Number(svcs[0].targetPort) !== IMAGES[p.image].port) bad++;
      }
    }
    failed += bad;
    const doneNow = oldCount === 0 && newReady.length >= R;
    steps.push({ old: oldCount, newReady: newReady.length, newWaiting: fresh.length - newReady.length, ready: readyNow, failed: bad, note: note.trim() || (doneNow ? 'all new pods Ready.' : d.readiness ? 'waiting for the new pods to pass their readiness probe.' : 'waiting for the new pods to start.') });
    if (doneNow) return { d, steps, failed, sent, minReady, done: true, stalled: false, newState };
    stall = kill || create ? 0 : stall + 1;
    if (stall >= 3) return { d, steps, failed, sent, minReady, done: false, stalled: true, newState };
  }
  return { d, steps, failed, sent, minReady, done: false, stalled: true, newState };
}

/** kubectl delete pod for every pod: which data comes back? */
export function deletePods(m) {
  const out = [];
  for (const d of ofKind(m, 'deployment')) {
    const img = IMAGES[d.image];
    if (!img?.data) continue;
    const st = podState(m, d);
    if (!st.ready) { out.push({ d, ok: false, why: `${d.name} never ran (${st.phase}), so it stored nothing.` }); continue; }
    const pvc = d.claim && named(m, 'pvc', d.claim);
    if (!pvc) { out.push({ d, ok: false, why: `${d.name} wrote its data into the container's own filesystem. Deleting the pod deleted it. The Deployment made a new, empty pod.` }); continue; }
    if (d.mountPath !== img.data) { out.push({ d, ok: false, why: `${d.name} mounts ${pvc.name} at ${d.mountPath || '(nothing)'}, but ${d.image} writes to ${img.data}. The claim stayed empty and the data died with the pod.` }); continue; }
    out.push({ d, ok: true, why: `${d.name} keeps ${img.data} on the claim ${pvc.name}. The claim outlives pods: the new pod mounts the same volume and finds the data.` });
  }
  return out;
}

// ---------------------------------------------------------------- YAML

const q = v => (/^[A-Za-z0-9_./-]+$/.test(String(v)) && !/^(true|false|yes|no|null|\d+)$/i.test(String(v)) ? String(v) : JSON.stringify(String(v)));
const kv = (pairs, ind) => pairs.map(([k, v]) => `${ind}${k}: ${q(v)}`);

export function toYaml(m) {
  const docs = [];
  for (const b of ofKind(m, 'configmap')) docs.push(['apiVersion: v1', 'kind: ConfigMap', 'metadata:', `  name: ${b.name}`, ...(b.data.length ? ['data:', ...kv(Object.entries(dataOf(b)), '  ')] : ['data: {}'])]);
  for (const b of ofKind(m, 'secret')) docs.push(['apiVersion: v1', 'kind: Secret', 'metadata:', `  name: ${b.name}`, 'type: Opaque', 'stringData:                 # stored base64-encoded: that is not encryption',
    ...(b.data.length ? kv(Object.entries(dataOf(b)), '  ') : [])].map(l => (b.data.length || !l.startsWith('stringData') ? l : 'stringData: {}')));
  for (const b of ofKind(m, 'pvc')) docs.push(['apiVersion: v1', 'kind: PersistentVolumeClaim', 'metadata:', `  name: ${b.name}`, 'spec:', '  accessModes: [ReadWriteOnce]', '  resources:', '    requests:', `      storage: ${b.size || '1Gi'}`]);
  for (const d of ofKind(m, 'deployment')) {
    const labels = parseLabels(d.labels) || [];
    const img = IMAGES[d.image];
    const probe = (name, path, port, extra = []) => [`          ${name}:`, '            httpGet:', `              path: ${q(path)}`, `              port: ${port}`, ...extra, `            periodSeconds: ${PERIOD}`, `            failureThreshold: ${FAILS}`];
    const L = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', `  name: ${d.name}`, 'spec:', `  replicas: ${d.replicas}`,
      '  strategy:', '    type: RollingUpdate', '    rollingUpdate:', `      maxSurge: ${d.maxSurge}`, `      maxUnavailable: ${d.maxUnavailable}`,
      '  selector:', '    matchLabels:', ...kv(labels, '      '),
      '  template:', '    metadata:', '      labels:', ...kv(labels, '        '),
      '    spec:', '      containers:', `        - name: ${d.name}`, `          image: ${q(d.image)}`];
    if (img) L.push('          ports:', `            - containerPort: ${img.port}`);
    if (d.envFrom.length) L.push('          envFrom:', ...d.envFrom.flatMap(r => { const [k, n] = r.split(':'); return [`            - ${k === 'secret' ? 'secretRef' : 'configMapRef'}:`, `                name: ${n}`]; }));
    if (d.readiness) L.push(...probe('readinessProbe', d.readyPath, d.readyPort));
    if (d.liveness) L.push(...probe('livenessProbe', d.livePath, d.livePort, [`            initialDelaySeconds: ${d.liveDelay || 0}`]));
    if (d.claim) L.push('          volumeMounts:', '            - name: data', `              mountPath: ${q(d.mountPath || '/data')}`, '      volumes:', '        - name: data', '          persistentVolumeClaim:', `            claimName: ${d.claim}`);
    docs.push(L);
  }
  for (const s of ofKind(m, 'service')) {
    const sel = parseLabels(s.selector) || [];
    docs.push(['apiVersion: v1', 'kind: Service', 'metadata:', `  name: ${s.name}`, 'spec:', `  type: ${s.type}`, ...(sel.length ? ['  selector:', ...kv(sel, '    ')] : ['  selector: {}']),
      '  ports:', `    - port: ${s.port}`, `      targetPort: ${s.targetPort}`, ...(s.type === 'NodePort' ? [`      nodePort: ${s.nodePort}`] : [])]);
  }
  for (const ing of ofKind(m, 'ingress')) {
    const L = ['apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', `  name: ${ing.name}`, 'spec:'];
    if (!ing.rules.length) L.push('  rules: []');
    else {
      L.push('  rules:');
      const hosts = [...new Set(ing.rules.map(r => r.host || ''))];
      for (const host of hosts) {
        L.push(host ? `    - host: ${host}` : '    - http:', ...(host ? ['      http:'] : []), '        paths:');
        for (const r of ing.rules.filter(x => (x.host || '') === host)) L.push(`          - path: ${q(r.path || '/')}`, '            pathType: Prefix', '            backend:', '              service:', `                name: ${q(r.service)}`, '                port:', `                  number: ${r.port}`);
      }
    }
    docs.push(L);
  }
  return docs.map(d => d.join('\n')).join('\n---\n') + '\n';
}

// ---------------------------------------------------------------- challenges

const goal = (label, ok, why) => ({ label, ok: !!ok, why: ok ? '' : why });
const refCost = m => m.blocks.length + refs(m).filter(r => r.to).length;
const starsFor = (c, par, slack = 2) => (c <= par ? 3 : c <= par + slack ? 2 : 1);
const net = (s = {}) => block('client', 'net', 'Internet', 20, 200, { fixed: true, ...s });
const web = (s = {}) => block('deployment', 'd-web', 'web', 760, 120, { replicas: 3, labels: 'app=web', image: 'shop-web:1.0', ...s });
const apiDep = (s = {}) => block('deployment', 'd-api', 'api', 760, 400, { replicas: 2, labels: 'app=api', image: 'shop-api:1.0', readyPort: 3000, livePort: 3000, envFrom: ['configmap:api-config', 'secret:db-creds'], ...s });
const svc = (id, name, s = {}) => block('service', id, name, 420, 120, s);
const ingress = (rules, s = {}) => block('ingress', 'ing', 'shop', 220, 120, { rules, ...s });
const apiConfig = () => block('configmap', 'cm-api', 'api-config', 1100, 330, { data: ['API_MODE=production'] });
const dbCreds = (name = 'db-creds') => block('secret', 'sec-db', name, 1100, 480, { data: ['DB_PASSWORD=s3cret'] });
const D = (m, name) => named(m, 'deployment', name);
const S = (m, name) => named(m, 'service', name);

function allPaths(R, want, label) {
  const bad = R.results.filter(r => r.path === want.path && r.code !== 200);
  const sent = R.results.filter(r => r.path === want.path);
  return goal(label, sent.length && !bad.length, sent.length ? `${bad.length} of ${sent.length} requests for ${want.path} failed (${bad[0]?.code || 'no answer'}): ${bad[0]?.why}` : `the Internet sends no request for ${want.path}`);
}
const podsReady = (R, m, name) => {
  const d = D(m, name);
  const p = d && R.pods.filter(x => x.dep === d.id);
  const bad = p?.find(x => !x.ready);
  return goal(`all ${name} pods are Running and Ready`, p?.length && !bad, !d ? `there is no Deployment called ${name}` : !p.length ? `${name} has 0 replicas` : bad ? `${bad.phase}: ${bad.why}` : '');
};

export const CHALLENGES = [
  { id: 'sandbox', title: 'Sandbox', xp: 0, par: 0,
    brief: 'A free cluster. Add Deployments, Services, an Ingress, ConfigMaps, Secrets and claims, point them at each other by name and label, then apply, roll out and delete pods.',
    setup: () => ({ blocks: [net({ via: 'shop', paths: ['/', '/api/orders'] }), ingress([{ host: '', path: '/', service: 'web', port: 80 }, { host: '', path: '/api', service: 'api', port: 80 }]),
      svc('s-web', 'web', { selector: 'app=web', targetPort: 8080 }), block('service', 's-api', 'api', 420, 400, { selector: 'app=api', targetPort: 3000 }),
      web({ readiness: true }), apiDep({ readiness: true, readyPort: 3000 }), apiConfig(), dbCreds()] }),
    solve: m => m, check: () => [] },

  { id: 'expose', title: 'Hello, cluster', xp: 20,
    brief: 'Three **web** pods are running, but nobody outside can reach them. Pods come and go, and their IPs change, so you never send traffic to a pod directly. Add a **Service** in front of them (drag it onto the Deployment to select its pods), then add an **Ingress** rule for `/` that points at the Service. The app inside listens on **8080**.',
    setup: () => ({ blocks: [net({ via: 'shop' }), ingress([]), web()] }),
    solve: m => { m.blocks.push(svc('s-web', 'web', { selector: 'app=web', targetPort: 8080 })); byId(m, 'ing').rules.push({ host: '', path: '/', service: 'web', port: 80 }); return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'GET / answers 200')] },

  { id: 'no-endpoints', title: 'Service has no endpoints', xp: 20,
    brief: 'Every request gets **503**. The pods are healthy and the Service exists. A Service does not point at a Deployment: it **selects pods by label**. Compare the Service\'s selector with the labels on the pods, letter by letter. Fix it by typing, not by dragging.',
    setup: () => ({ blocks: [net({ via: 'shop' }), ingress([{ host: '', path: '/', service: 'web', port: 80 }]), svc('s-web', 'web', { selector: 'app=frontend', targetPort: 8080 }), web()] }),
    solve: m => { S(m, 'web').selector = 'app=web'; return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'GET / answers 200')] },

  { id: 'target-port', title: 'port, targetPort', xp: 25,
    brief: 'Now the Service has endpoints, but every request ends in **502**. A Service has two ports: **port** is where clients call it, **targetPort** is where it sends traffic on the pod. Read what the app listens on.',
    setup: () => ({ blocks: [net({ via: 'shop' }), ingress([{ host: '', path: '/', service: 'web', port: 80 }]), svc('s-web', 'web', { selector: 'app=web', targetPort: 80 }), web()] }),
    solve: m => { S(m, 'web').targetPort = 8080; return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'GET / answers 200'), goal('clients still call the Service on port 80', S(m, 'web')?.port === 80, 'keep port 80: the Ingress rule calls web:80')] },

  { id: 'nodeport', title: 'Reaching in from outside', xp: 25,
    brief: 'There is no Ingress controller in this test cluster, so the Internet calls the **web** Service directly. Nothing arrives. The default Service type, **ClusterIP**, gets an address that exists only inside the cluster. Choose the type that also opens a port on every node.',
    setup: () => ({ blocks: [net({ via: 'web' }), svc('s-web', 'web', { selector: 'app=web', targetPort: 8080 }), web()] }),
    solve: m => { S(m, 'web').type = 'NodePort'; return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'a request from outside answers 200')] },

  { id: 'ingress', title: 'Two apps, one door', xp: 30,
    brief: 'One Ingress, two apps: `/` goes to the website, `/api` to the API. The website works, but `/api/orders` gets **503**. The Ingress rule names a Service; read the rule and the Services carefully. (The longest matching path wins, whatever the order of the rules.)',
    setup: () => ({ blocks: [net({ via: 'shop', paths: ['/', '/api/orders'] }),
      ingress([{ host: 'shop.example.com', path: '/', service: 'web', port: 80 }, { host: 'shop.example.com', path: '/api', service: 'shop-api', port: 80 }]),
      svc('s-web', 'web', { selector: 'app=web', targetPort: 8080 }), block('service', 's-api', 'api', 420, 400, { selector: 'app=api', targetPort: 3000 }),
      web(), apiDep({ readiness: true, readyPort: 3000 }), apiConfig(), dbCreds()] }),
    solve: m => { byId(m, 'ing').rules[1].service = 'api'; return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'GET / reaches the website'), allPaths(R, { path: '/api/orders' }, 'GET /api/orders reaches the API')] },

  { id: 'broad-selector', title: 'Half the requests 404', xp: 30,
    brief: 'Both apps carry the label `app=shop`, and the **web** Service selects `app=shop`. So it selects the API pods too, and some page loads land on an API pod, which does not listen on 8080: **502**. Make the selector specific enough to pick only the website pods. (Labels can have several pairs: `app=shop, component=web`.)',
    setup: () => ({ blocks: [net({ via: 'shop', count: 6 }), ingress([{ host: '', path: '/', service: 'web', port: 80 }]),
      svc('s-web', 'web', { selector: 'app=shop', targetPort: 8080 }),
      web({ labels: 'app=shop, component=web' }), apiDep({ labels: 'app=shop, component=api', readiness: true, readyPort: 3000 }), apiConfig(), dbCreds()] }),
    solve: m => { S(m, 'web').selector = 'app=shop, component=web'; return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'every GET / reaches a website pod'), goal('the web Service selects only website pods', S(m, 'web') && R.endpoints[S(m, 'web').id]?.selected.every(p => p.dep === 'd-web'), 'it still selects API pods')] },

  { id: 'readiness', title: 'Running, but not Ready', xp: 30,
    brief: 'Someone added a **readiness probe**, good. Since then the pods show `Running` but `0/1 READY` and the Service has no endpoints. Kubernetes only sends traffic to pods whose readiness probe passes. Look at where the probe knocks.',
    setup: () => ({ blocks: [net({ via: 'shop' }), ingress([{ host: '', path: '/', service: 'web', port: 80 }]), svc('s-web', 'web', { selector: 'app=web', targetPort: 8080 }), web({ readiness: true, readyPort: 80 })] }),
    solve: m => { D(m, 'web').readyPort = 8080; return m; },
    check: (m, R) => [podsReady(R, m, 'web'), allPaths(R, { path: '/' }, 'GET / answers 200'), goal('keep the readiness probe', D(m, 'web')?.readiness, 'the probe protects you: fix it, do not remove it')] },

  { id: 'liveness', title: 'Killed while starting', xp: 35,
    brief: 'The API takes about **25 seconds** to start. Its **liveness probe** starts checking at once, fails three times, and the kubelet kills the container: `CrashLoopBackOff`, forever. A liveness probe should catch a hung app, not a slow start. Give it enough time before the first check.',
    setup: () => ({ blocks: [net({ via: 'shop', paths: ['/api/orders'] }), ingress([{ host: '', path: '/api', service: 'api', port: 80 }]), block('service', 's-api', 'api', 420, 400, { selector: 'app=api', targetPort: 3000 }),
      apiDep({ readiness: true, liveness: true, liveDelay: 0 }), apiConfig(), dbCreds()] }),
    solve: m => { D(m, 'api').liveDelay = 10; return m; },
    check: (m, R) => [podsReady(R, m, 'api'), allPaths(R, { path: '/api/orders' }, 'GET /api/orders answers 200'), goal('keep the liveness probe', D(m, 'api')?.liveness, 'it restarts a hung API: fix its timing, do not remove it')] },

  { id: 'config', title: 'Config by name', xp: 30,
    brief: 'The API pods are stuck in **CreateContainerConfigError**. They load their settings with `envFrom` from a ConfigMap and a Secret, by name. Read the pod error, then compare the names.',
    setup: () => ({ blocks: [net({ via: 'shop', paths: ['/api/orders'] }), ingress([{ host: '', path: '/api', service: 'api', port: 80 }]), block('service', 's-api', 'api', 420, 400, { selector: 'app=api', targetPort: 3000 }),
      apiDep({ readiness: true, envFrom: ['configmap:api-config', 'secret:db-credentials'] }), apiConfig(), dbCreds('db-creds')] }),
    solve: m => { D(m, 'api').envFrom = ['configmap:api-config', 'secret:db-creds']; return m; },
    check: (m, R) => [podsReady(R, m, 'api'), allPaths(R, { path: '/api/orders' }, 'GET /api/orders answers 200'),
      goal('the password stays in a Secret, not a ConfigMap', !ofKind(m, 'configmap').some(c => 'DB_PASSWORD' in dataOf(c)), 'a ConfigMap is plain configuration anyone with read access sees: keep passwords in a Secret')] },

  { id: 'rollout', title: 'A safe bad release', xp: 45, costLabel: 'objects + references',
    brief: 'Release **shop-web:2.1** is broken (every request gets 500), and nobody knows yet. Press **Roll out** to see it take the site down. Make the Deployment *safe*: a broken release must never get traffic, and the site must keep **3 ready pods** the whole time. You need a correct **readiness probe** and the right **maxUnavailable**. Keep 2.1 as the new image: the point is to survive it.',
    setup: () => ({ blocks: [net({ via: 'shop' }), ingress([{ host: '', path: '/', service: 'web', port: 80 }]), svc('s-web', 'web', { selector: 'app=web', targetPort: 8080 }), web({ next: 'shop-web:2.1' })] }),
    solve: m => { Object.assign(D(m, 'web'), { readiness: true, readyPort: 8080, readyPath: '/healthz', maxUnavailable: 0 }); return m; },
    check: (m, R) => {
      const d = D(m, 'web');
      if (!d || d.next !== 'shop-web:2.1') return [goal('the rollout tries shop-web:2.1', false, 'keep "New image for a rollout" at shop-web:2.1')];
      const ro = rollout(m, d.id);
      if (ro.error) return [goal('the rollout runs', false, ro.error)];
      return [allPaths(R, { path: '/' }, 'before the rollout, GET / answers 200'),
        goal('no request fails during the rollout', ro.failed === 0, `${ro.failed} of ${ro.sent} requests failed during the rollout: ${!d.readiness ? 'with no readiness probe, every new pod counts as Ready the moment it starts, broken or not' : 'see the rollout steps'}`),
        goal('3 ready pods at every step', ro.minReady >= 3, `at one point only ${ro.minReady} pod${ro.minReady === 1 ? ' was' : 's were'} ready: maxUnavailable ${d.maxUnavailable} lets the controller remove old pods before new ones are Ready`)];
    } },

  { id: 'pvc', title: 'Data that outlives the pod', xp: 40,
    brief: 'The **db** Deployment runs Postgres. Press **Delete the pods**: the Deployment replaces the pod at once, and every row is gone. A pod\'s filesystem dies with it. Add a **PersistentVolumeClaim**, drag db onto it, and mount it where Postgres keeps its data: **/var/lib/postgresql/data**.',
    setup: () => ({ blocks: [net({ via: '' , paths: [] }), block('deployment', 'd-db', 'db', 420, 160, { image: 'postgres:16', replicas: 1, labels: 'app=db', envFrom: ['secret:db-creds'] }),
      block('secret', 'sec-db', 'db-creds', 780, 120, { data: ['POSTGRES_PASSWORD=s3cret'] })] }),
    solve: m => { m.blocks.push(block('pvc', 'pvc-db', 'db-data', 780, 320)); Object.assign(D(m, 'db'), { claim: 'db-data', mountPath: '/var/lib/postgresql/data' }); return m; },
    check: (m, R) => { const f = deletePods(m).find(x => x.d.name === 'db'); return [podsReady(R, m, 'db'), goal('the data survives deleting the pod', f?.ok, f?.why || 'keep the db Deployment')]; } },
];
for (const c of CHALLENGES) c.par ??= refCost(c.solve(c.setup()));

export function judge(m, ch) {
  const R = apply(m);
  const goals = R.error ? [goal('kubectl apply accepts it', false, R.error)] : ch.check(m, R).filter(Boolean);
  const ok = goals.length > 0 && goals.every(g => g.ok);
  const cost = refCost(m);
  return { ok, goals, cost, stars: ok ? starsFor(cost, ch.par) : 0 };
}
