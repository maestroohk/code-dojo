// Kubernetes builder: put a Gateway, HTTPRoutes, Services, Deployments, ConfigMaps, Secrets and claims on
// the board (and the legacy Ingress, which you still meet in older clusters). Objects find each other by name
// and by labels, so every wire on the board is a reference that resolved (an HTTPRoute's parentRef naming a
// Gateway, its backendRef naming a Service, a Service selector matching pod labels, envFrom naming a
// ConfigMap). Apply it and send requests from outside, roll out a new image step by step, or delete the pods
// to see what data survives. The simulation lives in kubesim.js (DOM-free, tested in Node); the shell in buildlab.js.
import { h } from './util.js';
import { builderLab, controls, fill } from './buildlab.js';
import * as K from './kubesim.js';

const COLORS = { client: '#9a86d6', gateway: '#d08a4a', httproute: '#4fa89c', ingress: '#9a8f84', service: '#4f9bd9', deployment: '#3fb68b', configmap: '#c9a24a', secret: '#d9786a', pvc: '#a8957a' };
const ART = { client: 'cloud', gateway: 'edgeproxy', httproute: 'routetable', ingress: 'ingress', service: 'service', deployment: 'pod', configmap: 'document', secret: 'vault', pvc: 'volume' };
const WIDE = ['deployment', 'ingress', 'gateway', 'httproute'];
const KINDS = Object.fromEntries(Object.entries(K.KINDS).map(([k, v]) => [k, { ...v, color: COLORS[k], width: WIDE.includes(k) ? 230 : 200, art: ART[k] }]));
const cond = (ok, text) => h(`span.ab-code.${ok ? 'ok' : 'bad'}`, text);

export function kubeBuildLab(container, onXp) {
  return builderLab(container, onXp, {
    lab: 'kubebuild',
    sim: K,
    costLabel: 'objects + references',
    board: api => boardOptions(api),
    form: api => formView(api),
    actions: () => [
      { id: 'apply', label: '▶ kubectl apply + send requests', title: 'Create everything, wait for the pods, then send the Internet\'s requests' },
      { id: 'rollout', label: '⟳ Roll out the new image', title: 'Change the Deployment to its "new image" and watch the rolling update step by step' },
      { id: 'delete', label: '✕ Delete the pods', title: 'kubectl delete pod: the Deployment replaces them. Which data survives?' },
    ],
    run: (m, id) => runIt(m, id),
    yaml: { title: 'manifests.yaml', text: K.toYaml, note: 'What kubectl apply -f would read. It follows the board (read-only here: change things on the board or in the inspector).' },
  });
}

function boardOptions(api) {
  const m = () => api.model;
  const blk = id => K.byId(m(), id);
  const { field, text, num, check, select, lines } = controls(api.changed, api.say);
  const resolved = () => K.refs(m()).filter(r => r.to);
  const nameOk = b => v => {
    if (b.kind === 'client') return v ? true : 'A name is needed.';
    if (!K.validName(v)) return 'Kubernetes names: lower-case letters, digits and -, starting and ending with a letter or digit.';
    if (m().blocks.some(x => x !== b && x.kind === b.kind && x.name === v)) return `There is already a ${KINDS[b.kind].label} called ${v}.`;
    return true;
  };
  const labelsOk = v => (K.parseLabels(v) ? true : 'Write labels as key=value pairs separated by commas, like app=web, tier=front.');

  function add(kind, at) {
    if (kind === 'client' && K.ofKind(m(), 'client').length) return 'One Internet is enough.';
    const base = { gateway: 'public', httproute: 'route', ingress: 'legacy', service: 'svc', deployment: 'app', configmap: 'config', secret: 'secret', pvc: 'data' }[kind];
    let i = 1, name = base;
    while (m().blocks.some(b => b.kind === kind && b.name === name)) name = `${base}-${++i}`;
    let id = kind + '-' + name;
    while (blk(id)) id += 'x';
    const b = K.block(kind, id, name, at.x, at.y);
    m().blocks.push(b);
    api.changed();
    return b;
  }

  function body(b) {
    const line = t => h('div.ab-line', t);
    const tag = (t, tone = '') => h(`span.bk-tag${tone ? '.' + tone : ''}`, t);
    if (b.kind === 'client') return [h('div.bk-name', b.name), line(b.via ? `→ ${b.via}` : 'not pointed anywhere'), line(`Host: ${b.host}${Number(b.port) && Number(b.port) !== 80 ? ` · :${b.port}` : ''}`), (b.paths || []).slice(0, 3).map(p => line(`GET ${p} ×${b.count}`))];
    if (b.kind === 'gateway') {
      const st = K.gatewayStatus(m(), b);
      return [h('div.bk-name', b.name), line(`class: ${b.className || '(none)'}`), b.listeners.slice(0, 3).map(l => line(`${l.name} ${l.protocol} :${l.port} ${l.hostname || '*'}`)),
        h('div.bk-tags', st.accepted ? tag(st.address) : tag('no address', 'bad'), tag(st.programmed ? 'Programmed' : st.accepted ? 'not Programmed' : 'Unknown', st.programmed ? '' : 'bad'))];
    }
    if (b.kind === 'httproute') {
      const st = K.routeStatus(m(), b);
      const ok = st.parents.length && st.parents.every(p => p.accepted);
      return [h('div.bk-name', b.name), line(`hosts: ${b.hostnames.join(', ') || '(from the listener)'}`),
        b.rules.length ? b.rules.slice(0, 3).map(r => line(`${r.type === 'Exact' ? '=' : ''}${r.path}${r.header ? ' +hdr' : ''} → ${r.backends.map(x => `${x.service}:${x.port}${r.backends.length > 1 ? ` w${K.weightOf(x)}` : ''}`).join(', ') || '(none)'}`)) : line('no rules'),
        h('div.bk-tags', tag(!st.parents.length ? 'no parentRefs' : ok ? 'Accepted' : 'Accepted: False', ok ? '' : 'bad'), !st.resolved && tag('ResolvedRefs: False', 'bad'))];
    }
    if (b.kind === 'ingress') return [h('div.bk-name', b.name), b.rules.length ? b.rules.map(r => line(`${r.host || '*'}${r.path || '/'} → ${r.service}:${r.port}`)) : line('no rules')];
    if (b.kind === 'service') {
      const pods = K.ofKind(m(), 'deployment').flatMap(d => K.podsOf(m(), d));
      const e = K.endpointsOf(m(), b, pods);
      return [h('div.bk-name', b.name), line(`${b.type} · ${b.port} → ${b.targetPort}${b.type === 'NodePort' ? ` · node :${b.nodePort}` : ''}`), line(`selector: ${b.selector || '(none)'}`),
        h('div.bk-tags', tag(`${e.ready.length} endpoint${e.ready.length === 1 ? '' : 's'}`, e.ready.length ? '' : 'bad'))];
    }
    if (b.kind === 'deployment') {
      const st = K.podState(m(), b);
      const n = Number(b.replicas) || 0;
      return [h('div.bk-name', b.name), h('code.ab-op', b.image), line(`labels: ${b.labels}`),
        h('div.bk-tags', tag(`${st.ready ? n : 0}/${n} ready`, st.ready ? '' : 'bad'), st.phase !== 'Running' && tag(st.phase, 'bad'),
          b.readiness && tag('readiness'), b.liveness && tag('liveness'), b.next && tag(`next: ${b.next}`, 'warn'))];
    }
    if (b.kind === 'pvc') return [h('div.bk-name', b.name), line(`${b.size} · ReadWriteOnce`), h('div.nb-sub', 'Storage that outlives pods')];
    const keys = Object.keys(K.dataOf(b));
    return [h('div.bk-name', b.name), keys.length ? keys.slice(0, 4).map(k => line(b.kind === 'secret' ? `${k}: ••••` : `${k}=${K.dataOf(b)[k]}`)) : line('no keys')];
  }

  function refInspector(r) {
    const f = blk(r.from), t = blk(r.to);
    const remove = h('button.btn.ghost.small', { type: 'button', onclick: () => { K.unref(m(), r); api.changed(); } }, 'Remove');
    const say = {
      via: `The Internet sends its requests to ${t.name}.`,
      rule: `Rule ${r.label} on the legacy Ingress ${f.name} names the Service "${r.ref}". Ingress rules point at Services by name, never at pods.`,
      parent: `${f.name} lists Gateway ${t.name} in its parentRefs${f.parents[r.parent]?.section ? `, listener ${f.parents[r.parent].section}` : ''}. The route asks; the Gateway's controller decides whether it is Accepted (hostnames must fit a listener).`,
      backend: `A rule of ${f.name} (${r.label}) has a backendRef to the Service ${t.name}. backendRefs name a Service and its port, never pods.`,
      cert: `Gateway ${f.name} terminates TLS on listener ${r.label.replace(/ tls$/, '')} with the certificate in Secret ${t.name}.`,
      select: `${f.name} selects every pod labelled ${r.label}. That includes the pods of ${t.name}. There is no link to the Deployment itself: only labels.`,
      env: `${f.name} loads every key of ${t.kind === 'secret' ? 'the Secret' : 'the ConfigMap'} ${t.name} as environment variables (envFrom).`,
      claim: `${f.name} mounts the claim ${t.name} at ${f.mountPath || '(no path)'}.`,
    }[r.kind];
    return h('div.pk-inspect', h('div.pk-inspect-head', h('b', 'Reference'), remove), h('p', say), h('p.muted.small', 'Remove deletes the reference from the YAML. Edit names, selectors and rules on the objects themselves.'));
  }

  const input = (o, key, cls, attrs = {}, cast = v => v.trim()) => h(`input.${cls}`, { value: o[key] ?? '', spellcheck: false, ...attrs, onchange: e => { o[key] = cast(e.target.value); api.changed(); } });
  const pick = (o, key, options, cls = '') => h(`select${cls ? '.' + cls : ''}`, { onchange: e => { o[key] = e.target.value; api.changed(); } }, options.map(v => h('option', { value: v, selected: String(o[key]) === v }, v)));
  const x = (onclick, title = 'Remove') => h('button.btn.ghost.small', { type: 'button', title, onclick: () => { onclick(); api.changed(); } }, '✕');
  const plus = (label, onclick) => h('button.btn.ghost.small', { type: 'button', onclick: () => { onclick(); api.changed(); } }, label);
  const numOf = v => Math.max(0, Math.round(Number(v) || 0));

  function gatewayInspector(b) {
    const st = K.gatewayStatus(m(), b);
    const classes = Object.keys(K.GATEWAY_CLASSES);
    return [
      field('gatewayClassName', text(b, 'className', 'envoy'), `Which controller runs this Gateway. Installed here (kubectl get gatewayclass): ${classes.join(', ')}.`),
      h('div.eyebrow', 'Listeners'),
      b.listeners.map((l, i) => h('div.kb-row',
        input(l, 'name', 'kb-w-name', { title: 'Listener name (a route\'s sectionName can pick it)' }),
        pick(l, 'protocol', ['HTTP', 'HTTPS'], 'kb-w-proto'),
        input(l, 'port', 'kb-w-port', { type: 'number', min: 1, max: 65535, title: 'Port' }, v => numOf(v) || 80),
        input(l, 'hostname', 'kb-w-host', { placeholder: 'any host', title: 'hostname: exact, or *.example.com (suffix match); empty = any' }),
        l.protocol === 'HTTPS' && input(l, 'cert', 'kb-w-svc', { placeholder: 'tls Secret', title: 'tls.certificateRefs: the Secret with tls.crt and tls.key' }),
        x(() => b.listeners.splice(i, 1)))),
      plus('+ Add listener', () => { let n = 'http', k = 1; while (b.listeners.some(l => l.name === n)) n = `http-${++k}`; b.listeners.push({ name: n, protocol: 'HTTP', port: 80, hostname: '', cert: '' }); }),
      h('p.muted.small', 'name · protocol · port · hostname. A request picks the listener on its port with the most specific hostname that fits its Host header. Routes attach where their hostnames fit.'),
      h('div.eyebrow', 'Status'),
      h('ul.yb-plain',
        h('li', cond(st.accepted, `Accepted: ${st.accepted ? 'True' : 'Unknown'}`), ' ', st.accepted ? h('span.muted.small', `controller ${st.controller}`) : h('span.small.nb-why', st.why)),
        h('li', cond(st.programmed, `Programmed: ${st.programmed ? 'True' : st.accepted ? 'False' : 'Unknown'}`), ' ', h('span.muted.small', st.address ? `address ${st.address}` : 'no address')),
        st.listeners.map(x => h('li', h('code', x.l.name), ' ', cond(x.ok, x.ok ? 'Programmed' : x.reason), ' ', h('span.muted.small', `${x.attached} route${x.attached === 1 ? '' : 's'} attached`), x.why && h('div.small.nb-why', x.why)))),
    ];
  }

  function routeInspector(b) {
    const st = K.routeStatus(m(), b);
    const gws = K.ofKind(m(), 'gateway').map(g => g.name);
    return [
      h('div.eyebrow', 'parentRefs'),
      b.parents.map((p, i) => h('div.kb-row',
        input(p, 'name', 'kb-w-svc', { placeholder: 'gateway', title: `The Gateway to attach to${gws.length ? ` (here: ${gws.join(', ')})` : ''}` }),
        input(p, 'section', 'kb-w-name', { placeholder: 'any listener', title: 'sectionName: one listener of that Gateway (empty = every listener that fits)' }),
        x(() => b.parents.splice(i, 1)))),
      plus('+ Add parentRef', () => b.parents.push({ name: gws[0] || '', section: '' })),
      field('hostnames (one per line)', lines(b, 'hostnames', 'shop.example.com', 2), 'Empty: every host the listener accepts. Each must fit a listener\'s hostname, or the route is not Accepted there.'),
      h('div.eyebrow', 'Rules'),
      b.rules.map((r, i) => h('div.kb-rule',
        h('div.kb-row',
          pick(r, 'type', ['PathPrefix', 'Exact'], 'kb-w-proto'),
          input(r, 'path', 'kb-w-path', { title: 'Path value, starting with /' }, v => v.trim() || '/'),
          input(r, 'header', 'kb-w-host', { placeholder: 'header (optional)', title: 'A header match: Name: value' }),
          x(() => b.rules.splice(i, 1), 'Remove the rule')),
        r.backends.map((be, j) => h('div.kb-row.kb-sub',
          h('span.muted', '→'),
          input(be, 'service', 'kb-w-svc', { placeholder: 'service', title: 'backendRef: a Service name' }),
          input(be, 'port', 'kb-w-port', { type: 'number', min: 1, max: 65535, title: 'The Service\'s port' }, v => numOf(v)),
          h('span.muted.small', 'weight'),
          input(be, 'weight', 'kb-w-port', { type: 'number', min: 0, max: 1000000, title: 'Share of the requests: weight ÷ sum of weights. 0 = none.' }, v => numOf(v)),
          x(() => r.backends.splice(j, 1), 'Remove the backendRef'))),
        plus('+ backendRef', () => r.backends.push({ service: '', port: 80, weight: 1 })))),
      plus('+ Add rule', () => b.rules.push({ type: 'PathPrefix', path: '/', header: '', backends: [] })),
      h('p.muted.small', 'The most specific match wins, across every route on the listener: the more exact hostname, then Exact before PathPrefix, the longest prefix, the most header matches, then the older route and rule order. No match: 404.'),
      h('div.eyebrow', 'Status'),
      h('ul.yb-plain',
        !b.parents.length && h('li', cond(false, 'no parentRefs'), ' ', h('span.small.nb-why', 'The route attaches to nothing: drag it onto a Gateway.')),
        st.parents.map(p => h('li', h('code', `parent ${p.ref.name}${p.ref.section ? '/' + p.ref.section : ''}`), ' ', cond(p.accepted, p.accepted ? 'Accepted: True' : p.reason === 'NoSuchGateway' ? 'no status' : `Accepted: False · ${p.reason}`),
          p.accepted ? h('span.muted.small', ` on ${p.listeners.map(l => l.name).join(', ')}`) : h('div.small.nb-why', p.why))),
        h('li', cond(st.resolved, `ResolvedRefs: ${st.resolved ? 'True' : 'False'}`), !st.resolved && h('div.small.nb-why', st.refsBad.map(x => x.why).join(' ')))),
    ];
  }

  function inspector(sel) {
    if (!sel) return h('div.pk-inspect.muted', 'Click an object or a wire to configure it.');
    if (sel.type === 'wire') { const r = K.refs(m()).find(x => x.id === sel.id); return r ? refInspector(r) : null; }
    const b = blk(sel.id);
    if (!b) return null;
    const k = KINDS[b.kind];
    const head = h('div.pk-inspect-head', h('b', `${k.icon} ${k.label}`),
      h('button.btn.ghost.small', { type: 'button', disabled: !!b.fixed, onclick: () => { m().blocks = m().blocks.filter(x => x !== b); api.changed(); } }, 'Delete'));
    const parts = [head, field('Name', text(b, 'name', '', nameOk(b)))];
    if (b.kind === 'client') {
      const entries = m().blocks.filter(x => x.kind === 'gateway' || x.kind === 'ingress' || x.kind === 'service');
      parts.push(
        field('Sends requests to', select(b, 'via', [['', '(nothing)'], ...entries.map(x => [x.name, `${KINDS[x.kind].label}: ${x.name}`])]), 'Through a Gateway (or a legacy Ingress), or straight to a NodePort Service.'),
        h('div.pk-two', field('Host header', text(b, 'host', 'shop.example.com')), field('Port', select(b, 'port', [['80', '80 (http)'], ['443', '443 (https)']]))),
        h('div.pk-two', field('Paths (one per line)', lines(b, 'paths', '/', 2)), field('Requests per path', num(b, 'count', { min: 1, max: 12 }))),
        field('Headers (Name: value, one per line)', lines(b, 'headers', 'x-canary: always', 1), 'Sent with every request. An HTTPRoute rule can match on one.'));
    }
    if (b.kind === 'gateway') parts.push(...gatewayInspector(b));
    if (b.kind === 'httproute') parts.push(...routeInspector(b));
    if (b.kind === 'ingress') {
      parts.push(h('p.muted.small', 'Legacy: the Ingress API is frozen and the ingress-nginx controller was retired in March 2026. You still meet it in older clusters; new setups use a Gateway and HTTPRoutes.'), h('div.eyebrow', 'Rules'),
        b.rules.map((r, i) => h('div.yb-rule',
          h('input.yb-rule-host', { value: r.host || '', placeholder: 'any host', spellcheck: false, title: 'Host (empty = any)', onchange: e => { r.host = e.target.value.trim(); api.changed(); } }),
          h('input.yb-rule-path', { value: r.path || '/', spellcheck: false, title: 'Path prefix', onchange: e => { r.path = e.target.value.trim() || '/'; api.changed(); } }),
          h('span', '→'),
          h('input.yb-rule-svc', { value: r.service, spellcheck: false, title: 'Service name', onchange: e => { r.service = e.target.value.trim(); api.changed(); } }),
          h('input.yb-rule-port', { type: 'number', value: r.port, title: 'Service port', onchange: e => { r.port = Number(e.target.value) || 80; api.changed(); } }),
          h('button.btn.ghost.small', { type: 'button', onclick: () => { b.rules.splice(i, 1); api.changed(); } }, '✕'))),
        h('button.btn.ghost.small', { type: 'button', onclick: () => { b.rules.push({ host: '', path: '/', service: '', port: 80 }); api.changed(); } }, '+ Add rule'),
        h('p.muted.small', 'host · path prefix → service name · service port. The longest matching path wins. A request no rule matches gets 404.'));
    }
    if (b.kind === 'service') {
      parts.push(
        field('Type', select(b, 'type', [['ClusterIP', 'ClusterIP (inside the cluster only)'], ['NodePort', 'NodePort (also a port on every node)']])),
        field('Selector', text(b, 'selector', 'app=web', labelsOk), 'Pods with ALL these labels become endpoints, if they are Ready.'),
        h('div.pk-two', field('port', num(b, 'port', { min: 1, max: 65535 }), 'Where clients call the Service.'), field('targetPort', num(b, 'targetPort', { min: 1, max: 65535 }), 'Where the Service sends traffic on the pod.')),
        b.type === 'NodePort' && field('nodePort', num(b, 'nodePort', { min: 30000, max: 32767 }), '30000 to 32767.'));
      const pods = K.ofKind(m(), 'deployment').flatMap(d => K.podsOf(m(), d));
      const e = K.endpointsOf(m(), b, pods);
      parts.push(h('div.eyebrow', 'Endpoints'), e.ready.length ? h('ul.yb-plain', e.ready.map(p => h('li', h('code', p.name)))) : h('p.small.nb-why', 'No endpoints. Press apply to see why.'));
    }
    if (b.kind === 'deployment') {
      const img = K.IMAGES[b.image];
      parts.push(
        h('div.pk-two', field('Image', select(b, 'image', K.IMAGE_NAMES.map(n => [n, n]))), field('Replicas', num(b, 'replicas', { min: 0, max: 10 }))),
        img && h('p.muted.small', img.what),
        field('Pod labels', text(b, 'labels', 'app=web', labelsOk), 'Every pod gets these. Services select pods by them.'),
        check(b, 'readiness', 'Readiness probe (HTTP GET): only Ready pods get traffic'),
        b.readiness && h('div.pk-two', field('path', text(b, 'readyPath', '/healthz')), field('port', num(b, 'readyPort', { min: 1, max: 65535 }))),
        check(b, 'liveness', 'Liveness probe (HTTP GET): restart the container when it fails'),
        b.liveness && h('div.pk-two', field('path', text(b, 'livePath', '/healthz')), field('port', num(b, 'livePort', { min: 1, max: 65535 }))),
        b.liveness && field('initialDelaySeconds', num(b, 'liveDelay', { min: 0, max: 600 }), 'Probes every 5 s; 3 failures in a row and the container is killed.'),
        field('envFrom (kind:name, one per line)', lines(b, 'envFrom', 'configmap:api-config\nsecret:db-creds', 2), 'Loads every key of that ConfigMap or Secret as environment variables.'),
        h('div.pk-two', field('Claim (PVC name)', text(b, 'claim', '')), field('Mount path', text(b, 'mountPath', img?.data || '/data'))),
        h('div.eyebrow', 'Rolling update'),
        h('div.pk-two', field('maxSurge', num(b, 'maxSurge', { min: 0, max: 10 }), 'Extra pods allowed above replicas.'), field('maxUnavailable', num(b, 'maxUnavailable', { min: 0, max: 10 }), 'Pods allowed below replicas.')),
        field('New image for a rollout', select(b, 'next', [['', '(none)'], ...K.IMAGE_NAMES.filter(n => n !== b.image).map(n => [n, n])]), 'Then press ⟳ Roll out.'));
      const pods = K.podsOf(m(), b);
      parts.push(h('div.eyebrow', 'Pods'), pods.length ? h('ul.yb-plain', pods.map(p => h('li', h('code', p.name), ' ', h(`span.ab-code.${p.ready ? 'ok' : 'bad'}`, `${p.phase} ${p.ready ? '1/1' : '0/1'}`)))) : h('p.muted.small', '0 replicas.'));
    }
    if (b.kind === 'configmap' || b.kind === 'secret') parts.push(field('Data (KEY=value, one per line)', lines(b, 'data', b.kind === 'secret' ? 'DB_PASSWORD=...' : 'API_MODE=production', 3)),
      h('p.muted.small', b.kind === 'secret' ? 'A Secret is stored base64-encoded, which is not encryption. It is kept apart so access can be limited (RBAC) and it is not printed by accident.' : 'Plain configuration. Anyone who can read the namespace can read it: no passwords here.'));
    if (b.kind === 'pvc') parts.push(field('Size', text(b, 'size', '1Gi')), h('p.muted.small', 'A claim asks the cluster for storage. The volume it gets lives on when pods are deleted; a pod mounts it by claim name.'));
    parts.push(K.TARGETS[b.kind].length > 0 && h('p.muted.small', `Drag ▶ onto ${K.TARGETS[b.kind].map(x => KINDS[x].label).join(', ')} to write the reference.`));
    return h('div.pk-inspect', parts);
  }

  return {
    kinds: KINDS,
    wireKinds: { via: { label: '' }, rule: { label: '' }, parent: { label: '', color: '#b8834e' }, backend: { label: '' }, cert: { label: '', color: '#a08a6a' }, select: { label: '', color: '#6f9a5a' }, env: { label: '', color: '#a08a6a' }, claim: { label: '', color: '#8a7a6a' } },
    wires: () => resolved().map(r => ({ id: r.id, kind: r.kind, from: { block: r.from, port: 'out' }, to: { block: r.to }, r })),
    ports: b => (K.TARGETS[b.kind].length ? [{ id: 'out', label: '', on: resolved().some(r => r.from === b.id), title: `Drag onto ${K.TARGETS[b.kind].map(x => KINDS[x].label).join(', ')}` }] : []),
    body,
    canConnect: (from, port, to) => K.canWire(m(), from, to),
    connect: (from, port, to) => {
      const msg = K.connect(m(), from.id, to.id);
      if (!msg) return `A ${KINDS[from.kind].label} cannot refer to a ${KINDS[to.kind].label}.`;
      api.changed();
      api.say(msg);
      return false;
    },
    onDropEmpty: () => { api.say('To remove a reference, click its wire and press Delete.'); return false; },
    palette: ['gateway', 'httproute', 'service', 'deployment', 'configmap', 'secret', 'pvc', 'ingress'].map(kind => ({ kind, add: at => add(kind, at) })),
    howto: 'There are no cables in Kubernetes: a wire appears when a name or a label matches. Drag an HTTPRoute\'s ▶ onto a Gateway (parentRef) and onto a Service (backendRef); drag a Service onto a Deployment to select its pods. Click to configure; Delete removes.',
    inspector,
    onDelete: sel => {
      if (sel.type === 'wire') { const r = K.refs(m()).find(x => x.id === sel.id); if (r) K.unref(m(), r); }
      else {
        const b = blk(sel.id);
        if (!b) return;
        if (b.fixed) { api.say('The Internet stays: it is where the requests come from.'); return; }
        m().blocks = m().blocks.filter(x => x !== b);
      }
      api.changed();
    },
    wireLabel: w => w.r.label || '',
    blockClass: b => (b.fixed ? 'fixed' : ''),
    zones: () => [{ id: 'cluster', label: 'cluster · namespace default', tone: 0, members: m().blocks.filter(b => b.kind !== 'client').map(b => b.id) }],
  };
}

function formView(api) {
  const m = api.model;
  const refs = K.refs(m);
  return h('div.nb-form',
    h('table.nb-ftable',
      h('tr', h('th', 'Object'), h('th', 'Settings'), h('th', 'Refers to')),
      m.blocks.map(b => h('tr', { onclick: () => api.select({ type: 'block', id: b.id }) },
        h('td', h('b', `${KINDS[b.kind].icon} ${b.name}`), h('div.muted.small', KINDS[b.kind].label)),
        h('td.small', formSettings(m, b)),
        h('td.small', refs.filter(r => r.from === b.id).map(r => h('div', r.to ? '✓ ' : h('span.yb-no', '✕ '), `${r.kind} ${r.ref || K.byId(m, r.to)?.name || ''}${r.to ? '' : ' (not found)'}`)),
          refs.some(r => r.from === b.id) ? '' : h('span.muted', '—'))))),
    h('p.muted.small', 'Click a row to edit it in the inspector. A ✕ is a name or selector that matches nothing: the classic typo.'));
}

function formSettings(m, b) {
  if (b.kind === 'client') return `→ ${b.via || '(nothing)'} · Host ${b.host}:${b.port || 80} · ${b.paths.join(', ')}${b.headers?.length ? ` · ${b.headers.join(', ')}` : ''}`;
  if (b.kind === 'gateway') return `class ${b.className} · ${b.listeners.map(l => `${l.name} ${l.protocol}:${l.port} ${l.hostname || '*'}`).join('; ')}`;
  if (b.kind === 'httproute') return `hosts ${b.hostnames.join(', ') || '(listener)'} · ${b.rules.map(r => `${r.type} ${r.path}${r.header ? ` [${r.header}]` : ''} → ${r.backends.map(x => `${x.service}:${x.port}${r.backends.length > 1 ? ` w${K.weightOf(x)}` : ''}`).join(', ') || '(none)'}`).join('; ') || 'no rules'}`;
  if (b.kind === 'ingress') return b.rules.map(r => `${r.host || '*'}${r.path} → ${r.service}:${r.port}`).join('; ') || 'no rules';
  if (b.kind === 'service') return `${b.type} · selector ${b.selector || '(none)'} · ${b.port} → ${b.targetPort}`;
  if (b.kind === 'deployment') return `${b.image} × ${b.replicas} · labels ${b.labels}${b.readiness ? ` · readiness ${b.readyPath}:${b.readyPort}` : ''}${b.liveness ? ` · liveness ${b.livePath}:${b.livePort} after ${b.liveDelay}s` : ''}`;
  if (b.kind === 'pvc') return b.size;
  return Object.keys(K.dataOf(b)).join(', ') || 'no keys';
}

function runIt(m, id) {
  const R = K.apply(m);
  if (R.error) return { ok: false, verdict: R.error, steps: [] };
  const marks = {}, steps = [], wires = {};
  const deps = K.ofKind(m, 'deployment');
  for (const d of deps) {
    const pods = R.pods.filter(p => p.dep === d.id);
    const st = K.podState(m, d);
    marks[d.id] = st.ready ? 'ok' : 'bad';
    steps.push({ who: d.name, tone: st.ready ? 'ok' : 'bad', text: `${pods.length} pod${pods.length === 1 ? '' : 's'} ${st.phase}${st.ready ? ', Ready' : ', not Ready'}: ${st.why}` });
  }
  for (const s of K.ofKind(m, 'service')) {
    const e = R.endpoints[s.id];
    marks[s.id] = e.ready.length ? 'ok' : 'bad';
    steps.push({ who: s.name, tone: e.ready.length ? 'ok' : 'bad', text: e.ready.length ? `endpoints: ${e.ready.map(p => p.name).join(', ')}.` : `no endpoints. ${e.why}` });
  }
  for (const g of K.ofKind(m, 'gateway')) {
    const st = R.gateways[g.id];
    marks[g.id] = st.programmed ? 'ok' : 'bad';
    steps.push({ who: g.name, tone: st.programmed ? 'ok' : 'bad', text: st.accepted
      ? `Gateway accepted by ${st.controller}; address ${st.address}. ${st.listeners.map(x => `Listener ${x.l.name} (${x.l.protocol} :${x.l.port}, ${x.l.hostname || 'any host'}): ${x.ok ? 'Programmed' : `${x.reason}: ${x.why}`}, ${x.attached} route${x.attached === 1 ? '' : 's'}.`).join(' ')}`
      : st.why });
  }
  for (const rt of K.ofKind(m, 'httproute')) {
    const st = R.routes[rt.id];
    const ok = st.parents.length > 0 && st.parents.every(p => p.accepted) && st.resolved;
    marks[rt.id] = ok ? 'ok' : 'bad';
    const ps = st.parents.length ? st.parents.map(p => (p.accepted ? `parent ${p.ref.name}: Accepted on listener ${p.listeners.map(l => l.name).join(', ')}.` : `parent ${p.ref.name}: ${p.why}`)).join(' ') : 'no parentRefs: it attaches to nothing.';
    steps.push({ who: rt.name, tone: ok ? 'ok' : 'bad', text: `HTTPRoute ${ps} ${st.resolved ? 'ResolvedRefs: True.' : `ResolvedRefs: False (${st.refsBad[0].reason}): ${st.refsBad.map(x => x.why).join(' ')}`}` });
  }
  for (const r of K.refs(m)) if (r.to) {
    if (r.kind === 'select') wires[r.id] = R.endpoints[r.from]?.ready.some(p => p.dep === r.to) ? 'ok' : 'bad';
    if (r.kind === 'parent') wires[r.id] = R.routes[r.from]?.parents[r.parent]?.accepted ? 'ok' : 'bad';
    if (r.kind === 'backend') wires[r.id] = R.routes[r.from]?.refsBad.some(x => x.ri === r.ri && x.bi === r.bi) ? 'bad' : 'ok';
    if (r.kind === 'cert') wires[r.id] = R.gateways[r.from]?.listeners.find(x => x.l.cert === r.ref)?.ok ? 'ok' : 'bad';
  }

  if (id === 'rollout') {
    const target = deps.find(d => d.next);
    const ro = K.rollout(m, target?.id);
    if (ro.error) return { ok: false, verdict: ro.error, steps };
    steps.push({ who: ro.d.name, tone: 'info', text: `kubectl set image: ${ro.d.image} → ${ro.d.next}. replicas ${ro.d.replicas}, maxSurge ${ro.d.maxSurge}, maxUnavailable ${ro.d.maxUnavailable}. New pods: ${ro.newState.phase}${ro.newState.ready ? '' : ` (${ro.newState.why})`}` });
    ro.steps.forEach((s, i) => steps.push({ at: `step ${i + 1}`, who: '', tone: s.failed ? 'bad' : 'ok',
      text: `${s.note} Old pods ${s.old}, new Ready ${s.newReady}, new starting ${s.newWaiting}. Serving: ${s.ready} pod${s.ready === 1 ? '' : 's'}. ${s.failed ? `${s.failed} of 4 requests failed.` : '4 of 4 requests OK.'}` }));
    const text = ro.done ? `Rollout complete. ${ro.failed ? `${ro.failed} of ${ro.sent} requests failed on the way.` : 'No request failed.'}`
      : `Rollout stuck: the new pods never became Ready, so the controller stopped (ProgressDeadlineExceeded). ${ro.failed ? `${ro.failed} requests failed.` : 'The old pods kept serving: no request failed. Now kubectl rollout undo.'}`;
    steps.push({ who: ro.d.name, tone: ro.failed ? 'bad' : ro.done ? 'ok' : 'warn', text });
    marks[ro.d.id] = ro.failed ? 'bad' : 'ok';
    return { ok: !ro.failed, verdict: `${text} Fewest ready pods at any step: ${ro.minReady}.`, steps, marks, wires, panel: rolloutPanel(ro) };
  }

  if (id === 'delete') {
    const fate = K.deletePods(m);
    steps.push({ who: 'kubectl', tone: 'info', text: 'kubectl delete pod --all: every pod is gone. Each Deployment\'s ReplicaSet sees too few pods and creates new ones at once, with new names.' });
    if (!fate.length) steps.push({ who: 'kubectl', tone: 'info', text: 'No Deployment here stores data, so nothing is lost: stateless pods are meant to be replaced.' });
    for (const f of fate) { steps.push({ who: f.d.name, tone: f.ok ? 'ok' : 'bad', text: `${f.ok ? 'data still there' : 'data lost'}: ${f.why}` }); marks[f.d.id] = f.ok ? 'ok' : 'bad'; }
    const ok = fate.every(f => f.ok);
    return { ok, verdict: ok ? 'New pods came up, and no data was lost.' : 'New pods came up, but data was lost.', steps, marks, wires, panel: podsPanel(m, R) };
  }

  const groups = new Map();
  for (const r of R.results) { const k = `${r.path}|${r.code}|${r.why}`; if (!groups.has(k)) groups.set(k, { ...r, n: 0 }); groups.get(k).n++; }
  for (const g of groups.values()) steps.push({ who: 'request', tone: g.code === 200 ? 'ok' : 'bad', text: [h('code', `GET ${g.host}${g.path}`), ` ×${g.n} → ${g.code || 'no answer'}: ${g.why}`] });
  const tokens = R.results.map(r => ({ hops: r.chain.slice(1).map((to, i) => ({ from: r.chain[i], to })), label: r.path, endCls: r.code === 200 ? 'ok' : 'bad' }));
  const client = K.ofKind(m, 'client')[0];
  for (const r of K.refs(m)) if (r.to && ['via', 'rule', 'parent', 'backend'].includes(r.kind)) {
    const through = R.results.filter(x => x.chain.includes(r.from) && x.chain.includes(r.to));
    if (through.length) wires[r.id] = through.every(x => x.code === 200) ? 'ok' : 'bad';
  }
  const bad = R.results.filter(r => r.code !== 200).length;
  const verdict = !client?.via ? 'Applied. The Internet is not pointed at anything, so no requests were sent.'
    : `${R.results.length - bad} of ${R.results.length} requests answered 200.`;
  return { ok: !bad && deps.every(d => K.podState(m, d).ready), verdict, steps, tokens, marks, wires, panel: podsPanel(m, R) };
}

function podsPanel(m, R) {
  const el = h('div.yb-card');
  const gws = K.ofKind(m, 'gateway'), rts = K.ofKind(m, 'httproute');
  fill(el,
    gws.length > 0 && h('div.eyebrow', 'kubectl get gateway'),
    gws.length > 0 && h('table.nb-rt', h('tr', h('th', 'NAME'), h('th', 'CLASS'), h('th', 'ADDRESS'), h('th', 'PROGRAMMED')),
      gws.map(g => { const st = R.gateways[g.id]; return h('tr', h('td', g.name), h('td', g.className), h('td', st.address || h('span.yb-no', '')), h('td', h(`span.ab-code.${st.programmed ? 'ok' : 'bad'}`, st.programmed ? 'True' : st.accepted ? 'False' : 'Unknown'))); })),
    rts.length > 0 && h('div.eyebrow', 'HTTPRoutes: status.parents[].conditions'),
    rts.length > 0 && h('table.nb-rt', h('tr', h('th', 'NAME'), h('th', 'HOSTNAMES'), h('th', 'ACCEPTED'), h('th', 'RESOLVEDREFS')),
      rts.map(r => { const st = R.routes[r.id]; const acc = st.parents.length > 0 && st.parents.every(p => p.accepted);
        return h('tr', h('td', r.name), h('td', h('code', r.hostnames.length ? JSON.stringify(r.hostnames) : '')),
          h('td', h(`span.ab-code.${acc ? 'ok' : 'bad'}`, acc ? 'True' : st.parents.find(p => !p.accepted)?.reason || 'no parents')),
          h('td', h(`span.ab-code.${st.resolved ? 'ok' : 'bad'}`, st.resolved ? 'True' : st.refsBad[0].reason))); })),
    h('div.eyebrow', 'kubectl get pods'),
    R.pods.length ? h('table.nb-rt', h('tr', h('th', 'NAME'), h('th', 'READY'), h('th', 'STATUS')),
      R.pods.map(p => h('tr', h('td', h('code', p.name)), h('td', p.ready ? '1/1' : '0/1'), h('td', h(`span.ab-code.${p.ready ? 'ok' : 'bad'}`, p.phase))))) : h('p.muted.small', 'No pods.'),
    K.ofKind(m, 'service').length > 0 && h('div.eyebrow', 'kubectl get endpoints'),
    K.ofKind(m, 'service').length > 0 && h('table.nb-rt', h('tr', h('th', 'NAME'), h('th', 'ENDPOINTS')),
      K.ofKind(m, 'service').map(s => { const e = R.endpoints[s.id]; return h('tr', h('td', s.name), h('td', e.ready.length ? e.ready.map(p => `${p.name}:${s.targetPort}`).join(', ') : h('span.yb-no', '<none>'))); })));
  return el;
}

function rolloutPanel(ro) {
  const R = Number(ro.d.replicas) || 1;
  const el = h('div.yb-card');
  fill(el, h('div.eyebrow', 'Pods during the rollout'),
    h('div.yb-roll', ro.steps.map((s, i) => h('div.yb-roll-row', h('span.muted.small', `${i + 1}`),
      h('span.yb-roll-bar', Array.from({ length: s.old }, () => h('i.old', { title: 'old pod, serving' })),
        Array.from({ length: s.newReady }, () => h(`i.${ro.newState.broken || !ro.newState.ready ? 'broken' : 'new'}`, { title: 'new pod, in the endpoints' })),
        Array.from({ length: s.newWaiting }, () => h('i.wait', { title: 'new pod, not Ready' }))),
      h(`span.small.${s.failed ? 'yb-no' : 'yb-yes'}`, s.failed ? `${s.failed} failed` : 'ok')))),
    h('p.muted.small', `Grey: old pods. Green: new Ready pods. Red: new pods that get traffic and fail. Hollow: new pods waiting to be Ready. Replicas: ${R}.`));
  return el;
}
