// The Kubernetes builder's simulator: pure JavaScript, no DOM (runs in the browser and in Node tests).
// A model is { blocks }: the Internet (your users), Gateways and HTTPRoutes (the Gateway API,
// gateway.networking.k8s.io/v1), the legacy Ingress, Services, Deployments, ConfigMaps, Secrets and
// PersistentVolumeClaims. Unlike Compose there are no wires in the model: Kubernetes objects find each
// other by name (an HTTPRoute's parentRef names a Gateway, its backendRef names a Service, a Deployment
// names its ConfigMap) and by labels (a Service selects pods). The board draws a wire wherever a
// reference resolves.
// apply() works out every pod's state, every Service's endpoints, every Gateway's and HTTPRoute's status
// conditions and what each request from outside gets: listener (port, hostname) -> HTTPRoute rule (the
// Gateway API's precedence: hostname, Exact, longest PathPrefix, most header matches, oldest route, rule
// order) -> weighted backendRef -> Service -> a Ready pod. rollout() plays a rolling update step by step;
// deletePods() shows which data survives.

export const KINDS = {
  client: { label: 'Internet', icon: '🌍' },
  gateway: { label: 'Gateway', icon: '⛩' },
  httproute: { label: 'HTTPRoute', icon: '🔀' },
  ingress: { label: 'Ingress (legacy)', icon: '🚪' },
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
  client: { via: '', host: 'shop.example.com', port: 80, headers: [], paths: ['/'], count: 4 },
  gateway: { className: 'envoy', listeners: [{ name: 'http', protocol: 'HTTP', port: 80, hostname: '', cert: '' }] },
  httproute: { parents: [], hostnames: [], rules: [] },
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
    const t = entryOf(m, c.via);
    add(c, t, 'via', t?.kind === 'service' ? `:${t.nodePort}` : t?.kind === 'gateway' ? `:${c.port || 80}` : '', { ref: c.via });
  }
  for (const g of ofKind(m, 'gateway')) g.listeners.forEach((l, i) => { if (l.protocol === 'HTTPS' && l.cert) add(g, named(m, 'secret', l.cert), 'cert', `${l.name} tls`, { rule: `c${i}`, ref: l.cert }); });
  for (const r of ofKind(m, 'httproute')) {
    r.parents.forEach((p, i) => add(r, named(m, 'gateway', p.name), 'parent', p.section ? `parentRef · ${p.section}` : 'parentRef', { rule: `p${i}`, ref: p.name, parent: i }));
    r.rules.forEach((rule, ri) => rule.backends.forEach((be, bi) => add(r, named(m, 'service', be.service), 'backend',
      `${rule.type === 'Exact' ? '=' : ''}${rule.path || '/'}${rule.backends.length > 1 ? ` w${weightOf(be)}` : ''}`, { rule: `b${ri}-${bi}`, ref: be.service, ri, bi })));
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

/** What the Internet's "sends requests to" names: a Gateway, a (legacy) Ingress or a NodePort Service. */
export const entryOf = (m, name) => ['gateway', 'ingress', 'service'].map(k => named(m, k, name)).find(Boolean);
export const weightOf = be => (be.weight === '' || be.weight == null ? 1 : Math.max(0, Number(be.weight) || 0));

export const TARGETS = { client: ['gateway', 'ingress', 'service'], gateway: ['secret'], httproute: ['gateway', 'service'], ingress: ['service'], service: ['deployment'], deployment: ['configmap', 'secret', 'pvc'], configmap: [], secret: [], pvc: [] };
export const canWire = (m, from, to) => !!from && !!to && from.id !== to.id && TARGETS[from.kind].includes(to.kind);

/** Dragging one object onto another writes the reference, as you would in YAML. Returns a message or false. */
export function connect(m, fromId, toId) {
  const f = byId(m, fromId), t = byId(m, toId);
  if (!canWire(m, f, t)) return false;
  if (f.kind === 'client') { f.via = t.name; return `The Internet now sends requests to ${t.name}${t.kind === 'gateway' ? ` (port ${f.port || 80})` : ''}.`; }
  if (f.kind === 'gateway') {
    const l = f.listeners.find(x => x.protocol === 'HTTPS' && !x.cert);
    if (l) { l.cert = t.name; return `Listener ${l.name} now terminates TLS with the certificate in Secret ${t.name}.`; }
    let name = 'https', i = 1;
    while (f.listeners.some(x => x.name === name)) name = `https-${++i}`;
    f.listeners.push({ name, protocol: 'HTTPS', port: 443, hostname: f.listeners[0]?.hostname || '', cert: t.name });
    return `Added listener ${name} (HTTPS, port 443) with tls.certificateRefs → Secret ${t.name}.`;
  }
  if (f.kind === 'httproute' && t.kind === 'gateway') {
    if (f.parents.some(p => p.name === t.name)) return `${f.name} already names ${t.name} in its parentRefs.`;
    f.parents.push({ name: t.name, section: '' });
    return `${f.name} now asks to attach to Gateway ${t.name} (parentRefs). The Gateway's controller decides whether it is Accepted.`;
  }
  if (f.kind === 'httproute') {
    const be = { service: t.name, port: t.port, weight: 1 };
    const empty = f.rules.find(r => !r.backends.length);
    if (empty) { empty.backends.push(be); return `Rule ${empty.type} ${empty.path} now sends to ${t.name}:${t.port}.`; }
    f.rules.push({ type: 'PathPrefix', path: '/', header: '', backends: [be] });
    return `Added the rule "PathPrefix / → ${t.name}:${t.port}". Click the HTTPRoute to edit its path, or to add a second backend with a weight.`;
  }
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
  if (r.kind === 'parent') f.parents.splice(r.parent, 1);
  if (r.kind === 'backend') f.rules[r.ri]?.backends.splice(r.bi, 1);
  if (r.kind === 'cert') { const l = f.listeners[Number(String(r.rule).slice(1))]; if (l) l.cert = ''; }
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

// ---------------------------------------------------------------- Gateway API

/** GatewayClasses installed in this cluster (kubectl get gatewayclass): name -> controllerName. */
export const GATEWAY_CLASSES = { envoy: 'gateway.envoyproxy.io/gatewayclass-controller' };
export const GATEWAY_ADDRESS = '203.0.113.10';
const lower = s => String(s ?? '').trim().toLowerCase();
const list = (xs, none = 'none') => (xs.length ? xs.join(', ') : none);

/** Does a hostname pattern ('' = any, '*.example.com' = suffix match of one or more labels) match a host? */
export function hostMatch(pattern, host) {
  const p = lower(pattern), x = lower(host);
  if (!p) return true;
  if (p.startsWith('*.')) return x.endsWith(p.slice(1)) && x.length > p.length - 1;
  return p === x;
}
/** Do a listener's hostname and a route's hostname have any host in common? */
export function hostsIntersect(a, b) {
  a = lower(a); b = lower(b);
  if (!a || !b) return true;
  const wa = a.startsWith('*.'), wb = b.startsWith('*.');
  if (wa && wb) return a.endsWith(b.slice(1)) || b.endsWith(a.slice(1));
  if (wa) return hostMatch(a, b);
  if (wb) return hostMatch(b, a);
  return a === b;
}
/** HTTPRoute path match. Exact: the whole path. PathPrefix: element by element, a trailing / ignored (/api matches /api, /api/, /api/x, not /apiary). */
export function pathMatch(type, value, path) {
  if (type === 'Exact') return path === value;
  const v = String(value || '/').replace(/\/+$/, '');
  return !v || path === v || path.startsWith(v + '/');
}
/** "x-canary: always" (or x-canary=always) -> ['x-canary', 'always']; null when empty or malformed. */
export function headerOf(s) {
  const m = String(s || '').match(/^\s*([A-Za-z0-9-]+)\s*[:=]\s*(.*?)\s*$/);
  return m ? [m[1].toLowerCase(), m[2]] : null;
}
const ruleText = r => `${r.type === 'Exact' ? 'Exact' : 'PathPrefix'} ${r.path || '/'}${headerOf(r.header) ? ` + header ${headerOf(r.header).join(': ')}` : ''}`;
const hostRank = hn => (!hn ? 0 : hn.startsWith('*.') ? hn.length : 1000 + hn.length);

/** Why a backendRef does not resolve, or null. */
export function backendProblem(m, be) {
  const s = named(m, 'service', be.service);
  if (!s) return { reason: 'BackendNotFound', why: `backendRef "${be.service}" names no Service (Services here: ${list(ofKind(m, 'service').map(x => x.name))}).` };
  if (Number(be.port) !== Number(s.port)) return { reason: 'BackendNotFound', why: `backendRef ${be.service}:${be.port}: Service ${s.name} has no port ${be.port} (it exposes ${s.port}). A backendRef names the Service's port, not the pod's.` };
  return null;
}

/** Status of a Gateway: { accepted, programmed, address, why, listeners: [{ l, ok, reason, why, attached }] }. */
export function gatewayStatus(m, g) {
  const seen = new Set();
  const listeners = g.listeners.map(l => {
    const key = `${l.port}|${lower(l.hostname)}`;
    let ok = true, reason = 'Programmed', why = '';
    if (seen.has(key)) { ok = false; reason = 'HostnameConflict'; why = `another listener of ${g.name} already uses port ${l.port} with hostname ${l.hostname || '(any)'}: Conflicted.`; }
    else if (l.protocol === 'HTTPS') {
      const s = l.cert && named(m, 'secret', l.cert);
      const d = s ? dataOf(s) : {};
      if (!l.cert) { ok = false; reason = 'InvalidCertificateRef'; why = `HTTPS listener ${l.name} has no tls.certificateRefs: it needs a Secret with tls.crt and tls.key.`; }
      else if (!s) { ok = false; reason = 'InvalidCertificateRef'; why = `listener ${l.name} names the certificate Secret "${l.cert}", which does not exist.`; }
      else if (!d['tls.crt'] || !d['tls.key']) { ok = false; reason = 'InvalidCertificateRef'; why = `Secret ${s.name} has no tls.crt and tls.key keys, so listener ${l.name} has no certificate to offer.`; }
    }
    seen.add(key);
    return { l, ok, reason, why, attached: 0 };
  });
  const cls = GATEWAY_CLASSES[g.className];
  if (!cls) return { accepted: false, programmed: false, address: '', listeners,
    why: `gatewayClassName "${g.className}" names no GatewayClass in this cluster (kubectl get gatewayclass lists: ${Object.keys(GATEWAY_CLASSES).join(', ')}). No controller owns ${g.name}: its status stays "Waiting for controller", ADDRESS is empty, PROGRAMMED Unknown, and nothing listens. The request times out.` };
  for (const r of ofKind(m, 'httproute')) for (const p of routeStatus(m, r).parents) if (p.gw === g) for (const l of p.listeners) { const x = listeners.find(y => y.l === l); if (x) x.attached++; }
  return { accepted: true, programmed: listeners.some(x => x.ok), address: GATEWAY_ADDRESS, listeners, controller: cls, why: '' };
}

/** Status of an HTTPRoute: per parentRef Accepted (with the listeners it attached to), and ResolvedRefs. */
export function routeStatus(m, r) {
  const parents = r.parents.map(p => {
    const base = { ref: p, gw: null, accepted: false, listeners: [] };
    const gw = named(m, 'gateway', p.name);
    if (!gw) return { ...base, reason: 'NoSuchGateway', why: `parentRef "${p.name}" names no Gateway (Gateways here: ${list(ofKind(m, 'gateway').map(x => x.name))}). No controller picks the route up, so it has no status for that parent and gets no traffic.` };
    if (!GATEWAY_CLASSES[gw.className]) return { ...base, gw, reason: 'Pending', why: `Gateway ${gw.name} has no controller (gatewayClassName "${gw.className}" is not installed), so nobody accepts the route.` };
    let ls = gw.listeners.filter(l => l.protocol === 'HTTP' || l.protocol === 'HTTPS');
    if (p.section) {
      ls = ls.filter(l => l.name === p.section);
      if (!ls.length) return { ...base, gw, reason: 'NoMatchingParent', why: `Accepted: False (NoMatchingParent): sectionName "${p.section}" names no listener of ${gw.name} (its listeners: ${list(gw.listeners.map(l => l.name))}).` };
    }
    const hit = ls.filter(l => !r.hostnames.length || r.hostnames.some(hn => hostsIntersect(l.hostname, hn)));
    if (!hit.length) return { ...base, gw, reason: 'NoMatchingListenerHostname', why: `Accepted: False (NoMatchingListenerHostname): none of the route's hostnames (${r.hostnames.join(', ')}) fits a listener of ${gw.name} (${ls.map(l => `${l.name} accepts ${l.hostname || 'any host'}`).join('; ')}).` };
    return { ...base, gw, accepted: true, reason: 'Accepted', why: '', listeners: hit };
  });
  const refsBad = [];
  r.rules.forEach((rule, ri) => rule.backends.forEach((be, bi) => { const bad = backendProblem(m, be); if (bad) refsBad.push({ ri, bi, be, ...bad }); }));
  return { parents, resolved: !refsBad.length, refsBad };
}

/** Smooth weighted round robin: deterministic, and 9:1 over ten requests is exactly 9 and 1. */
function pickWeighted(state, live) {
  const total = live.reduce((a, x) => a + x.w, 0);
  live.forEach((x, i) => { state[i] = (state[i] || 0) + x.w; });
  let best = 0;
  live.forEach((x, i) => { if (state[i] > state[best]) best = i; });
  state[best] -= total;
  return live[best];
}

function viaGateway(m, gw, req, pods, rr, chain, out) {
  const gs = gatewayStatus(m, gw);
  if (!gs.accepted) return out(0, gs.why);
  const onPort = gs.listeners.filter(x => Number(x.l.port) === Number(req.port));
  if (!onPort.length) return out(0, `Gateway ${gw.name} (${gs.address}) has no listener on port ${req.port} (listeners: ${list(gw.listeners.map(l => `${l.name} :${l.port}`))}): connection refused.`);
  const fits = onPort.filter(x => hostMatch(x.l.hostname, req.host)).sort((a, b) => hostRank(lower(b.l.hostname)) - hostRank(lower(a.l.hostname)));
  if (!fits.length) return out(404, `no listener of ${gw.name} on port ${req.port} accepts the host "${req.host}" (${onPort.map(x => `${x.l.name}: ${x.l.hostname || 'any'}`).join('; ')}), so the Gateway answers 404.`);
  const L = fits[0];
  if (!L.ok) return out(0, `listener ${L.l.name} is not programmed: ${L.why} The connection is reset before any HTTP is spoken.`);
  const cands = [], notes = [];
  ofKind(m, 'httproute').forEach((r, order) => {
    const st = routeStatus(m, r);
    const mine = st.parents.filter(p => p.ref.name === gw.name);
    if (!mine.some(p => p.listeners.includes(L.l))) {
      const p = mine.find(x => !x.accepted);
      if (p) notes.push(`HTTPRoute ${r.name} is not attached: ${p.why}`);
      else if (mine.length) notes.push(`HTTPRoute ${r.name} is attached to another listener of ${gw.name}, not ${L.l.name}.`);
      return;
    }
    const hosts = r.hostnames.filter(hn => hostsIntersect(L.l.hostname, hn));
    let hx = 0, ha = 0;
    if (hosts.length) {
      const hm = hosts.filter(hn => hostMatch(hn, req.host));
      if (!hm.length) { notes.push(`HTTPRoute ${r.name} is for ${hosts.join(', ')}, not ${req.host}.`); return; }
      for (const hn of hm) { if (!hn.startsWith('*.')) hx = Math.max(hx, hn.length); ha = Math.max(ha, hn.length); }
    }
    r.rules.forEach((rule, ri) => {
      const hdr = headerOf(rule.header);
      const pOk = pathMatch(rule.type, rule.path, req.path), hOk = !hdr || req.headers[hdr[0]] === hdr[1];
      if (pOk && hOk) cands.push({ r, rule, ri, order, hx, ha, exact: rule.type === 'Exact' ? 1 : 0, plen: rule.type === 'Exact' ? 0 : String(rule.path || '/').replace(/\/+$/, '').length, hn: hdr ? 1 : 0 });
      else if (!pOk && rule.type === 'Exact' && req.path.startsWith(String(rule.path).replace(/\/+$/, '') + '/')) notes.push(`${r.name}'s rule Exact ${rule.path} matches only ${rule.path} itself, not ${req.path} (PathPrefix would).`);
      else if (pOk && !hOk) notes.push(`${r.name}'s rule ${ruleText(rule)} needs the header ${hdr.join(': ')}, which this request does not send.`);
    });
  });
  cands.sort((a, b) => b.hx - a.hx || b.ha - a.ha || b.exact - a.exact || b.plen - a.plen || b.hn - a.hn || a.order - b.order || a.r.name.localeCompare(b.r.name) || a.ri - b.ri);
  if (!cands.length) return out(404, `no rule of an HTTPRoute attached to ${gw.name}/${L.l.name} matches ${req.host}${req.path}, so the Gateway answers 404.${notes.length ? ' ' + notes.slice(0, 3).join(' ') : ofKind(m, 'httproute').length ? '' : ' There is no HTTPRoute at all: a Gateway alone routes nothing.'}`);
  const c = cands[0];
  chain.push(c.r.id);
  const at = `HTTPRoute ${c.r.name}, rule ${ruleText(c.rule)}`;
  if (!c.rule.backends.length) return out(500, `${at} matched, but the rule has no backendRefs: there is nowhere to send it, so the Gateway answers 500.`);
  const live = c.rule.backends.map((be, i) => ({ be, i, w: weightOf(be) })).filter(x => x.w > 0);
  if (!live.length) return out(500, `${at} matched, but every backendRef has weight 0: no traffic may go anywhere, so the Gateway answers 500.`);
  const pick = pickWeighted(rr[`${c.r.id}#${c.ri}`] ||= [], live);
  const total = live.reduce((a, x) => a + x.w, 0);
  const share = c.rule.backends.length > 1 ? ` (weight ${pick.w} of ${total}, ${Math.round(100 * pick.w / total)}%)` : '';
  const bad = backendProblem(m, pick.be);
  if (bad) return out(500, `${at} matched and picked backendRef ${pick.be.service}:${pick.be.port}${share}, which does not resolve: ${bad.why} The route reports ResolvedRefs: False, and requests meant for that backend get 500.`);
  return { svc: named(m, 'service', pick.be.service), port: pick.be.port, at: `${at} → ${pick.be.service}:${pick.be.port}${share}: `, hint: notes.filter(n => /Exact/.test(n)).join(' ') };
}

// ---------------------------------------------------------------- requests

function routeIngress(m, ing, req) {
  const cands = ing.rules.map((r, i) => ({ r, i })).filter(({ r }) => !r.host || lower(r.host) === lower(req.host)).filter(({ r }) => pathMatch('PathPrefix', r.path, req.path));
  cands.sort((a, b) => (b.r.path || '/').length - (a.r.path || '/').length || a.i - b.i);
  return cands[0] || null;
}

/** One request from outside. -> { code, why, chain: [blockIds], pod? } */
function request(m, req, pods, rr) {
  const client = ofKind(m, 'client')[0];
  const chain = [client.id];
  let at = '';
  const out = (code, why) => ({ code, why: at + why, chain });
  if (!client.via) return out(0, 'The Internet is not pointed at anything yet: drag its ▶ onto a Gateway (or a NodePort Service).');
  const entry = entryOf(m, client.via);
  if (!entry) return out(0, `There is nothing called "${client.via}" to send requests to.`);
  let svc, port, hint = '';
  if (entry.kind === 'gateway') {
    chain.push(entry.id);
    const hop = viaGateway(m, entry, req, pods, rr, chain, out);
    if (!hop.svc) return hop;
    ({ svc, port, at, hint } = hop);
  } else if (entry.kind === 'ingress') {
    chain.push(entry.id);
    const hit = routeIngress(m, entry, req);
    if (!hit) return out(404, `${entry.name} has no rule for ${req.host}${req.path}, so the ingress controller's default backend answers 404.${entry.rules.some(r => r.host && r.host !== req.host) ? ` (A rule's host must equal the Host header, "${req.host}".)` : ''}`);
    svc = named(m, 'service', hit.r.service);
    if (!svc) return out(503, `Rule ${hit.r.path || '/'} sends traffic to service "${hit.r.service}", which does not exist${ofKind(m, 'service').length ? ` (Services here: ${ofKind(m, 'service').map(s => s.name).join(', ')})` : ''}. The ingress answers 503.`);
    if (Number(hit.r.port) !== Number(svc.port)) return out(503, `Rule ${hit.r.path || '/'} sends to ${svc.name} port ${hit.r.port}, but ${svc.name} exposes port ${svc.port}. The ingress answers 503.`);
    port = svc.port;
  } else {
    svc = entry;
    if (svc.type !== 'NodePort') return out(0, `${svc.name} is a ClusterIP Service: its address exists only inside the cluster, so a request from the Internet never arrives (connection timed out). Use type NodePort, or put a Gateway in front.`);
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
  if (!img.serves(req.path)) return { ...out(404, `the request reached pod ${pod.name}, which runs ${pod.image}. That app has no page at ${req.path}: 404. ${hint || `Is ${svc.name} selecting the right pods, and did the right rule match?`}`), pod };
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
  const headers = Object.fromEntries((client?.headers || []).map(headerOf).filter(Boolean));
  if (client?.via) for (const path of client.paths.length ? client.paths : ['/']) for (let i = 0; i < Math.max(1, Math.min(12, client.count)); i++) {
    results.push({ path, host: client.host, ...request(m, { host: client.host, path, port: Number(client.port) || 80, headers }, pods, rr) });
  }
  const endpoints = Object.fromEntries(ofKind(m, 'service').map(s => {
    const e = endpointsOf(m, s, pods);
    return [s.id, { ...e, why: e.ready.length ? '' : noEndpointsWhy(m, s, e, pods) }];
  }));
  const gateways = Object.fromEntries(ofKind(m, 'gateway').map(g => [g.id, gatewayStatus(m, g)]));
  const routes = Object.fromEntries(ofKind(m, 'httproute').map(r => [r.id, routeStatus(m, r)]));
  return { pods, endpoints, gateways, routes, results };
}

const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function check(m) {
  const seen = new Set();
  for (const b of m.blocks) {
    if (b.kind === 'client') { if (b.headers?.some(x => !headerOf(x))) return `Internet: write each header as Name: value, like x-canary: always.`; continue; }
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
    if (b.kind === 'gateway') {
      if (!b.listeners.length) return `Gateway ${b.name}: spec.listeners needs at least one listener.`;
      const names = new Set();
      for (const l of b.listeners) {
        if (!validName(l.name)) return `Gateway ${b.name}: listener name "${l.name}" is not valid (lower-case letters, digits and -).`;
        if (names.has(l.name)) return `Gateway ${b.name}: two listeners are called ${l.name}. Listener names are unique within a Gateway.`;
        names.add(l.name);
        if (!(Number(l.port) >= 1 && Number(l.port) <= 65535)) return `Gateway ${b.name}: listener ${l.name} needs a port from 1 to 65535.`;
        if (l.hostname && !HOST_RE.test(lower(l.hostname))) return `Gateway ${b.name}: "${l.hostname}" is not a valid listener hostname (a DNS name, optionally starting with *.; no IP addresses, no port).`;
      }
    }
    if (b.kind === 'httproute') {
      for (const hn of b.hostnames) if (!HOST_RE.test(lower(hn))) return `HTTPRoute ${b.name}: "${hn}" is not a valid hostname (a DNS name, optionally starting with *.; no scheme, path or port).`;
      for (const r of b.rules) {
        if (!String(r.path || '').startsWith('/')) return `HTTPRoute ${b.name}: a path match value must start with / (got "${r.path}").`;
        if (r.header && !headerOf(r.header)) return `HTTPRoute ${b.name}: write a header match as Name: value, like x-canary: always.`;
        for (const be of r.backends) if (!(Number(be.port) >= 1 && Number(be.port) <= 65535)) return `HTTPRoute ${b.name}: backendRef ${be.service} needs a port (a backendRef to a Service must name one).`;
      }
    }
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
  for (const b of ofKind(m, 'secret')) docs.push(['apiVersion: v1', 'kind: Secret', 'metadata:', `  name: ${b.name}`, `type: ${'tls.crt' in dataOf(b) ? 'kubernetes.io/tls' : 'Opaque'}`, 'stringData:                 # stored base64-encoded: that is not encryption',
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
  for (const g of ofKind(m, 'gateway')) {
    const L = ['apiVersion: gateway.networking.k8s.io/v1', 'kind: Gateway', 'metadata:', `  name: ${g.name}`, 'spec:', `  gatewayClassName: ${q(g.className)}`];
    if (!g.listeners.length) L.push('  listeners: []');
    else L.push('  listeners:', ...g.listeners.flatMap(l => [`    - name: ${q(l.name)}`, `      protocol: ${l.protocol}`, `      port: ${l.port}`,
      ...(l.hostname ? [`      hostname: ${q(l.hostname)}`] : []),
      ...(l.protocol === 'HTTPS' ? ['      tls:', '        mode: Terminate', '        certificateRefs:', '          - kind: Secret', `            name: ${q(l.cert || '')}`] : []),
      '      allowedRoutes:', '        namespaces:', '          from: Same']));
    docs.push(L);
  }
  for (const r of ofKind(m, 'httproute')) {
    const L = ['apiVersion: gateway.networking.k8s.io/v1', 'kind: HTTPRoute', 'metadata:', `  name: ${r.name}`, 'spec:'];
    L.push(...(r.parents.length ? ['  parentRefs:', ...r.parents.flatMap(p => [`    - name: ${q(p.name)}`, ...(p.section ? [`      sectionName: ${q(p.section)}`] : [])])] : ['  parentRefs: []              # attached to nothing']));
    if (r.hostnames.length) L.push('  hostnames:', ...r.hostnames.map(hn => `    - ${q(hn)}`));
    if (!r.rules.length) L.push('  rules: []');
    else {
      L.push('  rules:');
      for (const rule of r.rules) {
        const hdr = headerOf(rule.header);
        L.push('    - matches:', '        - path:', `            type: ${rule.type === 'Exact' ? 'Exact' : 'PathPrefix'}`, `            value: ${q(rule.path || '/')}`,
          ...(hdr ? ['          headers:', `            - name: ${q(hdr[0])}`, `              value: ${q(hdr[1])}`] : []));
        if (!rule.backends.length) L.push('      backendRefs: []');
        else L.push('      backendRefs:', ...rule.backends.flatMap(be => [`        - name: ${q(be.service)}`, `          port: ${be.port}`, ...(rule.backends.length > 1 || weightOf(be) !== 1 ? [`          weight: ${weightOf(be)}`] : [])]));
      }
    }
    docs.push(L);
  }
  for (const ing of ofKind(m, 'ingress')) {
    const L = ['apiVersion: networking.k8s.io/v1', 'kind: Ingress', 'metadata:', `  name: ${ing.name}`, 'spec:              # legacy: the Ingress API is frozen; new setups use the Gateway API'];
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
/** A board's cost: objects plus references that resolve. A challenge's par is its solution's cost. */
export const refCost = m => m.blocks.length + refs(m).filter(r => r.to).length;
const starsFor = (c, par, slack = 2) => (c <= par ? 3 : c <= par + slack ? 2 : 1);
const net = (s = {}) => block('client', 'net', 'Internet', 20, 220, { fixed: true, via: 'public', ...s });
const listener = (s = {}) => ({ name: 'http', protocol: 'HTTP', port: 80, hostname: '', cert: '', ...s });
const gw = (s = {}) => block('gateway', 'gw', 'public', 250, 220, s);
const route = (rules, s = {}) => block('httproute', 'rt-shop', 'shop', 520, 120, { parents: [{ name: 'public', section: '' }], hostnames: [], rules, ...s });
const rule = (path, service, port = 80, s = {}) => ({ type: 'PathPrefix', path, header: '', backends: [{ service, port, weight: 1 }], ...s });
const front = (rules, s = {}) => [gw(), route(rules, s)];
const web = (s = {}) => block('deployment', 'd-web', 'web', 1100, 120, { replicas: 3, labels: 'app=web', image: 'shop-web:1.0', ...s });
const apiDep = (s = {}) => block('deployment', 'd-api', 'api', 1100, 400, { replicas: 2, labels: 'app=api', image: 'shop-api:1.0', readyPort: 3000, livePort: 3000, envFrom: ['configmap:api-config', 'secret:db-creds'], ...s });
const svc = (id, name, s = {}) => block('service', id, name, 800, 120, s);
const webSvc = (s = {}) => svc('s-web', 'web', { selector: 'app=web', targetPort: 8080, ...s });
const apiSvc = (s = {}) => block('service', 's-api', 'api', 800, 400, { selector: 'app=api', targetPort: 3000, ...s });
const ingress = (rules, s = {}) => block('ingress', 'ing', 'shop', 250, 440, { rules, ...s });
const apiConfig = () => block('configmap', 'cm-api', 'api-config', 1440, 330, { data: ['API_MODE=production'] });
const dbCreds = (name = 'db-creds') => block('secret', 'sec-db', name, 1440, 480, { data: ['DB_PASSWORD=s3cret'] });
const D = (m, name) => named(m, 'deployment', name);
const S = (m, name) => named(m, 'service', name);
const G = (m, name) => named(m, 'gateway', name);

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
const throughGateway = m => {
  const c = ofKind(m, 'client')[0];
  const e = c && entryOf(m, c.via);
  return goal('requests from outside enter through a Gateway', e?.kind === 'gateway', `the Internet sends to ${e ? `${KINDS[e.kind].label} ${e.name}` : c?.via ? `"${c.via}", which does not exist` : 'nothing'}: point it at the Gateway`);
};
/** Some HTTPRoute is Accepted by Gateway gwName. */
const accepted = (R, m, gwName) => {
  const rs = ofKind(m, 'httproute').map(r => ({ r, p: R.routes[r.id].parents.find(p => p.ref.name === gwName) }));
  const ok = rs.some(x => x.p?.accepted);
  const bad = rs.find(x => x.p && !x.p.accepted) || rs[0];
  return goal(`an HTTPRoute is Accepted by Gateway ${gwName}`, ok, !rs.length ? 'there is no HTTPRoute' : bad?.p ? `HTTPRoute ${bad.r.name}: ${bad.p.why}` : `no HTTPRoute names ${gwName} in its parentRefs`);
};
const resolved = (R, m) => {
  const bad = ofKind(m, 'httproute').map(r => ({ r, s: R.routes[r.id] })).find(x => !x.s.resolved);
  return goal('every backendRef resolves (ResolvedRefs: True)', !bad, bad && `HTTPRoute ${bad.r.name}: ResolvedRefs: False (${bad.s.refsBad[0].reason}): ${bad.s.refsBad[0].why}`);
};

export const CHALLENGES = [
  { id: 'sandbox', title: 'Sandbox', xp: 0, par: 0,
    brief: 'A free cluster. A Gateway with an HTTP and an HTTPS listener, an HTTPRoute, Services, Deployments, ConfigMaps, Secrets and claims. Point them at each other by name and label, then apply, roll out and delete pods. The legacy Ingress is in the palette too.',
    setup: () => ({ blocks: [net({ paths: ['/', '/api/orders'] }),
      gw({ listeners: [listener({ hostname: '*.example.com' }), listener({ name: 'https', protocol: 'HTTPS', port: 443, hostname: '*.example.com', cert: 'shop-tls' })] }),
      route([rule('/', 'web'), rule('/api', 'api')], { hostnames: ['shop.example.com'] }),
      webSvc(), apiSvc(), web({ readiness: true }), apiDep({ readiness: true, readyPort: 3000 }), apiConfig(), dbCreds(),
      block('secret', 'sec-tls', 'shop-tls', 250, 460, { data: ['tls.crt=(PEM certificate)', 'tls.key=(PEM private key)'] })] }),
    solve: m => m, check: () => [] },

  { id: 'expose', title: 'Hello, cluster', xp: 20,
    brief: 'Three **web** pods are running, but nobody outside can reach them. The platform team already runs a **Gateway** called `public` (the front door: a listener on port 80). Pods come and go and their IPs change, so you never send traffic to a pod directly. Add a **Service** in front of the pods (drag it onto the Deployment to select them; the app listens on **8080**), then add an **HTTPRoute**: drag it onto the Gateway (that writes its `parentRefs`) and onto the Service (a rule `PathPrefix /` with a `backendRef`).',
    setup: () => ({ blocks: [net(), gw(), web()] }),
    solve: m => { m.blocks.push(webSvc(), route([rule('/', 'web')])); return m; },
    check: (m, R) => [throughGateway(m), allPaths(R, { path: '/' }, 'GET / answers 200')] },

  { id: 'gateway-class', title: 'Reaching in from outside', xp: 25,
    brief: 'Everything looks right, yet every request **times out**. `kubectl get gateway public` shows an empty **ADDRESS** and **PROGRAMMED Unknown**. A Gateway does nothing by itself: the controller named by its **GatewayClass** runs the proxy. This manifest was copied from a quickstart. Compare its `gatewayClassName` with what `kubectl get gatewayclass` lists in this cluster.',
    setup: () => ({ blocks: [net(), gw({ className: 'eg' }), route([rule('/', 'web')]), webSvc(), web()] }),
    solve: m => { G(m, 'public').className = 'envoy'; return m; },
    check: (m, R) => [goal('Gateway public is Programmed and has an address', G(m, 'public') && R.gateways[G(m, 'public').id].programmed, G(m, 'public') ? R.gateways[G(m, 'public').id].why || 'no listener is programmed' : 'keep the Gateway called public'),
      allPaths(R, { path: '/' }, 'GET / answers 200')] },

  { id: 'no-endpoints', title: 'Service has no endpoints', xp: 20,
    brief: 'Every request gets **503**. The pods are healthy, the HTTPRoute is Accepted and the Service exists. A Service does not point at a Deployment: it **selects pods by label**. Compare the Service\'s selector with the labels on the pods, letter by letter. Fix it by typing, not by dragging.',
    setup: () => ({ blocks: [net(), ...front([rule('/', 'web')]), webSvc({ selector: 'app=frontend' }), web()] }),
    solve: m => { S(m, 'web').selector = 'app=web'; return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'GET / answers 200')] },

  { id: 'target-port', title: 'port, targetPort', xp: 25,
    brief: 'Now the Service has endpoints, but every request ends in **502**. A Service has two ports: **port** is where clients (here, the Gateway, through the HTTPRoute\'s backendRef) call it, **targetPort** is where it sends traffic on the pod. Read what the app listens on.',
    setup: () => ({ blocks: [net(), ...front([rule('/', 'web')]), webSvc({ targetPort: 80 }), web()] }),
    solve: m => { S(m, 'web').targetPort = 8080; return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'GET / answers 200'), goal('clients still call the Service on port 80', S(m, 'web')?.port === 80, 'keep port 80: the HTTPRoute\'s backendRef calls web:80')] },

  { id: 'two-apps', title: 'Two apps, one door', xp: 30,
    brief: 'One Gateway, one HTTPRoute, two apps: `/` goes to the website, `/api` to the API. The website works, but `/api/orders` gets **500**. `kubectl describe httproute shop` shows `ResolvedRefs: False, BackendNotFound`. A backendRef names a Service; read the rule and the Services carefully. (The longest matching PathPrefix wins, whatever the order of the rules.)',
    setup: () => ({ blocks: [net({ paths: ['/', '/api/orders'] }), ...front([rule('/', 'web'), rule('/api', 'shop-api')], { hostnames: ['shop.example.com'] }),
      webSvc(), apiSvc(), web(), apiDep({ readiness: true, readyPort: 3000 }), apiConfig(), dbCreds()] }),
    solve: m => { named(m, 'httproute', 'shop').rules[1].backends[0].service = 'api'; return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'GET / reaches the website'), allPaths(R, { path: '/api/orders' }, 'GET /api/orders reaches the API'), resolved(R, m)] },

  { id: 'exact-path', title: 'Half the requests 404', xp: 30,
    brief: 'The home page works, but every **/api/orders** request gets **404**, and the 404 comes from the *website* pods. The HTTPRoute has a rule for `/api`. Read its **match type**: `Exact` matches one path only, `PathPrefix` matches a path and everything under it, element by element. When no `/api` rule matches, `PathPrefix /` catches the request.',
    setup: () => ({ blocks: [net({ paths: ['/', '/api/orders'] }), ...front([rule('/', 'web'), rule('/api', 'api', 80, { type: 'Exact' })], { hostnames: ['shop.example.com'] }),
      webSvc(), apiSvc(), web(), apiDep({ readiness: true, readyPort: 3000 }), apiConfig(), dbCreds()] }),
    solve: m => { named(m, 'httproute', 'shop').rules[1].type = 'PathPrefix'; return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'GET / reaches the website'), allPaths(R, { path: '/api/orders' }, 'GET /api/orders reaches the API')] },

  { id: 'broad-selector', title: 'Some page loads fail', xp: 30,
    brief: 'Both apps carry the label `app=shop`, and the **web** Service selects `app=shop`. So it selects the API pods too, and some page loads land on an API pod, which does not listen on 8080: **502**. Make the selector specific enough to pick only the website pods. (Labels can have several pairs: `app=shop, component=web`.)',
    setup: () => ({ blocks: [net({ count: 6 }), ...front([rule('/', 'web')]),
      webSvc({ selector: 'app=shop' }),
      web({ labels: 'app=shop, component=web' }), apiDep({ labels: 'app=shop, component=api', readiness: true, readyPort: 3000 }), apiConfig(), dbCreds()] }),
    solve: m => { S(m, 'web').selector = 'app=shop, component=web'; return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'every GET / reaches a website pod'), goal('the web Service selects only website pods', S(m, 'web') && R.endpoints[S(m, 'web').id]?.selected.every(p => p.dep === 'd-web'), 'it still selects API pods')] },

  { id: 'hostname', title: 'Accepted: False', xp: 35,
    brief: 'The app team applied their HTTPRoute and every request to `shop.example.com` gets **404**. `kubectl get httproute shop -o yaml` shows `Accepted: False, reason NoMatchingListenerHostname`. The platform team\'s Gateway listener only accepts `*.example.com`, and a route attaches only where one of its **hostnames** fits the listener\'s. Fix the route; the Gateway belongs to the platform team, so leave it as it is.',
    setup: () => ({ blocks: [net(), gw({ listeners: [listener({ hostname: '*.example.com' })] }), route([rule('/', 'web')], { hostnames: ['shop.example.net'] }), webSvc(), web()] }),
    solve: m => { named(m, 'httproute', 'shop').hostnames = ['shop.example.com']; return m; },
    check: (m, R) => [accepted(R, m, 'public'), allPaths(R, { path: '/' }, 'GET shop.example.com/ answers 200'),
      goal('the Gateway still listens on *.example.com, port 80', G(m, 'public')?.listeners.some(l => l.hostname === '*.example.com' && Number(l.port) === 80) && G(m, 'public').listeners.length === 1, 'the Gateway is the platform team\'s: change the HTTPRoute, not the listener'),
      goal('the Internet still asks for shop.example.com', ofKind(m, 'client')[0]?.host === 'shop.example.com', 'keep the Host header at shop.example.com: that is what users type')] },

  { id: 'canary', title: 'A 10% canary', xp: 40,
    brief: 'Version **2.0** of the website runs next to 1.0 as **web-canary**. The plan: send **10%** of the traffic to it and watch. One HTTPRoute rule can list several `backendRefs` with **weights**: each gets weight ÷ total of the requests. Right now half the requests fail with **500** (`ResolvedRefs: False`) and the split is 50/50. Fix the canary backendRef, then set the weights so 1 request in 10 reaches 2.0.',
    setup: () => ({ blocks: [net({ count: 10 }), gw(),
      route([{ type: 'PathPrefix', path: '/', header: '', backends: [{ service: 'web', port: 80, weight: 1 }, { service: 'web-canary', port: 8080, weight: 1 }] }]),
      webSvc({ selector: 'app=web, track=stable' }), block('service', 's-canary', 'web-canary', 800, 380, { selector: 'app=web, track=canary', targetPort: 8080 }),
      web({ labels: 'app=web, track=stable' }), block('deployment', 'd-canary', 'web-canary', 1100, 380, { replicas: 1, labels: 'app=web, track=canary', image: 'shop-web:2.0' })] }),
    solve: m => { const bs = named(m, 'httproute', 'shop').rules[0].backends; bs[0].weight = 90; bs[1].weight = 10; bs[1].port = 80; return m; },
    check: (m, R) => {
      const sent = R.results.length, canary = R.results.filter(r => r.pod?.image === 'shop-web:2.0').length;
      return [allPaths(R, { path: '/' }, 'every GET / answers 200'),
        goal('1 request in 10 reaches version 2.0', sent >= 10 && canary * 10 === sent, `${canary} of ${sent} requests reached shop-web:2.0${sent < 10 ? ' (send at least 10 requests)' : ''}: the weights decide the share, weight ÷ sum of weights`),
        goal('the other 9 in 10 reach version 1.0', R.results.filter(r => r.pod?.image === 'shop-web:1.0' && r.code === 200).length === sent - canary, `${R.results.filter(r => r.pod?.image === 'shop-web:1.0' && r.code === 200).length} of ${sent} requests were served by shop-web:1.0`)];
    } },

  { id: 'from-ingress', title: 'Retire the Ingress', xp: 40,
    brief: 'This cluster still routes through a legacy **Ingress** (the ingress-nginx controller was retired in March 2026, and the Ingress API is frozen). The Gateway `public` is ready. Translate the Ingress into an **HTTPRoute**: same host, same paths (`pathType: Prefix` becomes `PathPrefix`), same Services and ports. Then point the Internet at the Gateway and delete the Ingress.',
    setup: () => ({ blocks: [net({ via: 'shop', paths: ['/', '/api/orders'] }), gw(),
      ingress([{ host: 'shop.example.com', path: '/', service: 'web', port: 80 }, { host: 'shop.example.com', path: '/api', service: 'api', port: 80 }]),
      webSvc(), apiSvc(), web(), apiDep({ readiness: true, readyPort: 3000 }), apiConfig(), dbCreds()] }),
    solve: m => { m.blocks = m.blocks.filter(b => b.kind !== 'ingress'); m.blocks.push(route([rule('/', 'web'), rule('/api', 'api')], { hostnames: ['shop.example.com'] })); ofKind(m, 'client')[0].via = 'public'; return m; },
    check: (m, R) => [throughGateway(m), allPaths(R, { path: '/' }, 'GET / reaches the website'), allPaths(R, { path: '/api/orders' }, 'GET /api/orders reaches the API'),
      goal('the HTTPRoute keeps the Ingress\'s host', ofKind(m, 'httproute').some(r => r.hostnames.includes('shop.example.com')), 'the Ingress only answered for shop.example.com: put it in the route\'s hostnames'),
      goal('the Ingress is gone', !ofKind(m, 'ingress').length, 'delete the Ingress once the Gateway serves the same routes')] },

  { id: 'nodeport', title: 'Straight to a node', xp: 25,
    brief: 'A throwaway test cluster with **no Gateway controller**: for a quick check, the Internet calls the **web** Service directly. Nothing arrives. The default Service type, **ClusterIP**, gets an address that exists only inside the cluster. Choose the type that also opens a port on every node. (Fine for a test; in production a Gateway is the front door.)',
    setup: () => ({ blocks: [net({ via: 'web' }), webSvc(), web()] }),
    solve: m => { S(m, 'web').type = 'NodePort'; return m; },
    check: (m, R) => [allPaths(R, { path: '/' }, 'a request from outside answers 200')] },

  { id: 'readiness', title: 'Running, but not Ready', xp: 30,
    brief: 'Someone added a **readiness probe**, good. Since then the pods show `Running` but `0/1 READY` and the Service has no endpoints. Kubernetes only sends traffic to pods whose readiness probe passes. Look at where the probe knocks.',
    setup: () => ({ blocks: [net(), ...front([rule('/', 'web')]), webSvc(), web({ readiness: true, readyPort: 80 })] }),
    solve: m => { D(m, 'web').readyPort = 8080; return m; },
    check: (m, R) => [podsReady(R, m, 'web'), allPaths(R, { path: '/' }, 'GET / answers 200'), goal('keep the readiness probe', D(m, 'web')?.readiness, 'the probe protects you: fix it, do not remove it')] },

  { id: 'liveness', title: 'Killed while starting', xp: 35,
    brief: 'The API takes about **25 seconds** to start. Its **liveness probe** starts checking at once, fails three times, and the kubelet kills the container: `CrashLoopBackOff`, forever. A liveness probe should catch a hung app, not a slow start. Give it enough time before the first check.',
    setup: () => ({ blocks: [net({ paths: ['/api/orders'] }), ...front([rule('/api', 'api')]), apiSvc(),
      apiDep({ readiness: true, liveness: true, liveDelay: 0 }), apiConfig(), dbCreds()] }),
    solve: m => { D(m, 'api').liveDelay = 10; return m; },
    check: (m, R) => [podsReady(R, m, 'api'), allPaths(R, { path: '/api/orders' }, 'GET /api/orders answers 200'), goal('keep the liveness probe', D(m, 'api')?.liveness, 'it restarts a hung API: fix its timing, do not remove it')] },

  { id: 'config', title: 'Config by name', xp: 30,
    brief: 'The API pods are stuck in **CreateContainerConfigError**. They load their settings with `envFrom` from a ConfigMap and a Secret, by name. Read the pod error, then compare the names.',
    setup: () => ({ blocks: [net({ paths: ['/api/orders'] }), ...front([rule('/api', 'api')]), apiSvc(),
      apiDep({ readiness: true, envFrom: ['configmap:api-config', 'secret:db-credentials'] }), apiConfig(), dbCreds('db-creds')] }),
    solve: m => { D(m, 'api').envFrom = ['configmap:api-config', 'secret:db-creds']; return m; },
    check: (m, R) => [podsReady(R, m, 'api'), allPaths(R, { path: '/api/orders' }, 'GET /api/orders answers 200'),
      goal('the password stays in a Secret, not a ConfigMap', !ofKind(m, 'configmap').some(c => 'DB_PASSWORD' in dataOf(c)), 'a ConfigMap is plain configuration anyone with read access sees: keep passwords in a Secret')] },

  { id: 'rollout', title: 'A safe bad release', xp: 45, costLabel: 'objects + references',
    brief: 'Release **shop-web:2.1** is broken (every request gets 500), and nobody knows yet. Press **Roll out** to see it take the site down. Make the Deployment *safe*: a broken release must never get traffic, and the site must keep **3 ready pods** the whole time. You need a correct **readiness probe** and the right **maxUnavailable**. Keep 2.1 as the new image: the point is to survive it.',
    setup: () => ({ blocks: [net(), ...front([rule('/', 'web')]), webSvc(), web({ next: 'shop-web:2.1' })] }),
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
    setup: () => ({ blocks: [net({ via: '', paths: [] }), block('deployment', 'd-db', 'db', 420, 160, { image: 'postgres:16', replicas: 1, labels: 'app=db', envFrom: ['secret:db-creds'] }),
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
