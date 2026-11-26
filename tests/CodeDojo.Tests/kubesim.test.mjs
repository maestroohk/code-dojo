// Checks the Kubernetes builder's simulator (ui/kubesim.js) in plain Node: every graded challenge's setup
// fails its goals, its solution passes with 3 stars and par is the solution's cost, the manifests render,
// two runs give the same result, and the Gateway API rules (hostnames, path matching, precedence,
// weights, status conditions) behave as the spec says.
// Run: node tests/CodeDojo.Tests/kubesim.test.mjs   (KubeSimTests.cs runs it as part of dotnet test)
const K = await import(new URL('../../ui/kubesim.js', import.meta.url));

const failures = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) failures.push(what); };
const strip = R => JSON.stringify(R, (k, v) => (typeof v === 'function' ? undefined : v));

// ---- every challenge
const graded = K.CHALLENGES.filter(c => c.xp > 0);
check(graded.length >= 14, `at least 14 graded challenges (found ${graded.length})`);
check(new Set(K.CHALLENGES.map(c => c.id)).size === K.CHALLENGES.length, 'challenge ids are unique');
for (const id of ['no-endpoints', 'readiness']) check(K.CHALLENGES.some(c => c.id === id), `challenge ${id} exists (tracks/kubernetes links to it)`);
for (const c of graded) {
  const before = K.judge(c.setup(), c);
  check(!before.ok, `${c.id}: the setup must fail its goals`);
  check(before.goals.every(g => g.ok || g.why), `${c.id}: every failing goal says why`);
  const after = K.judge(c.solve(c.setup()), c);
  check(after.ok, `${c.id}: the solution must pass (${after.goals.filter(g => !g.ok).map(g => `${g.label}: ${g.why}`).join(' | ')})`);
  check(after.stars === 3, `${c.id}: the solution earns 3 stars (got ${after.stars}, cost ${after.cost}, par ${c.par})`);
  check(c.par === K.refCost(c.solve(c.setup())), `${c.id}: par is the cost of the solution (par ${c.par}, cost ${K.refCost(c.solve(c.setup()))})`);
  check(strip(K.apply(c.solve(c.setup()))) === strip(K.apply(c.solve(c.setup()))), `${c.id}: two runs of the solution are identical`);
  const y = K.toYaml(c.solve(c.setup()));
  check(y.length > 50, `${c.id}: the manifests render`);
  if (K.ofKind(c.solve(c.setup()), 'gateway').length) check(/apiVersion: gateway\.networking\.k8s\.io\/v1\nkind: Gateway/.test(y), `${c.id}: the Gateway is gateway.networking.k8s.io/v1`);
  if (K.ofKind(c.solve(c.setup()), 'httproute').length) check(/kind: HTTPRoute\n[\s\S]*parentRefs:\n    - name: /.test(y), `${c.id}: the HTTPRoute has parentRefs`);
}
const usesIngress = graded.filter(c => K.ofKind(c.solve(c.setup()), 'ingress').length);
check(usesIngress.length === 0, `no solution keeps an Ingress (found: ${usesIngress.map(c => c.id).join(', ')})`);
check(graded.filter(c => K.ofKind(c.setup(), 'ingress').length).length === 1, 'exactly one challenge starts from a legacy Ingress');
const sandbox = K.CHALLENGES.find(c => c.xp === 0);
{
  const R = K.apply(sandbox.setup());
  check(!R.error && R.results.length > 0 && R.results.every(r => r.code === 200), `the sandbox serves every request (${R.error || R.results.filter(r => r.code !== 200).map(r => r.why)[0]})`);
  const https = K.apply({ blocks: sandbox.setup().blocks.map(b => (b.kind === 'client' ? { ...b, port: 443 } : b)) });
  check(https.results.every(r => r.code === 200), 'the sandbox serves HTTPS on 443 too');
}

// ---- hostnames and paths (Gateway API rules)
check(K.hostMatch('*.example.com', 'shop.example.com') && K.hostMatch('*.example.com', 'a.b.example.com') && !K.hostMatch('*.example.com', 'example.com'), 'wildcard: a suffix match of one or more labels, never the apex');
check(K.hostMatch('', 'anything.example.org') && K.hostMatch('Shop.Example.com', 'shop.example.com'), 'empty hostname matches any host; hostnames ignore case');
check(K.hostsIntersect('*.example.com', 'shop.example.com') && !K.hostsIntersect('*.example.com', 'shop.example.net') && K.hostsIntersect('*.example.com', '*.shop.example.com') && K.hostsIntersect('', 'x.example.org'), 'listener/route hostname intersection');
check(K.pathMatch('PathPrefix', '/api', '/api') && K.pathMatch('PathPrefix', '/api', '/api/orders') && K.pathMatch('PathPrefix', '/api/', '/api') && !K.pathMatch('PathPrefix', '/api', '/apiary'), 'PathPrefix matches element by element, trailing / ignored');
check(K.pathMatch('Exact', '/api', '/api') && !K.pathMatch('Exact', '/api', '/api/orders') && K.pathMatch('PathPrefix', '/', '/anything'), 'Exact matches one path only; PathPrefix / matches all');

// ---- a small world to probe routing
const world = (routes, s = {}) => ({ blocks: [
  K.block('client', 'net', 'Internet', 0, 0, { via: 'public', count: 1, paths: s.paths || ['/'], host: s.host || 'shop.example.com', headers: s.headers || [] }),
  K.block('gateway', 'gw', 'public', 0, 0, { className: s.className || 'envoy', listeners: s.listeners || [{ name: 'http', protocol: 'HTTP', port: 80, hostname: '', cert: '' }] }),
  ...routes.map((r, i) => K.block('httproute', `rt${i}`, r.name || `r${i}`, 0, 0, { parents: [{ name: 'public', section: '' }], hostnames: [], ...r })),
  ...['web', 'api'].map(n => K.block('service', `s-${n}`, n, 0, 0, { selector: `app=${n}`, targetPort: n === 'web' ? 8080 : 3000 })),
  K.block('deployment', 'd-web', 'web', 0, 0, { labels: 'app=web', image: 'shop-web:1.0' }),
  K.block('deployment', 'd-api', 'api', 0, 0, { labels: 'app=api', image: 'shop-api:1.0', envFrom: ['configmap:c'] }),
  K.block('configmap', 'cm', 'c', 0, 0, { data: ['API_MODE=x', 'DB_PASSWORD=y'] }),
] });
const R = (path, service, s = {}) => ({ type: 'PathPrefix', path, header: '', backends: [{ service, port: 80, weight: 1 }], ...s });
const hit = (m, path) => { const r = K.apply({ ...m, blocks: m.blocks.map(b => (b.kind === 'client' ? { ...b, paths: [path] } : b)) }).results[0]; return { ...r, dep: r.pod?.dep }; };
{
  const m = world([{ rules: [R('/', 'web'), R('/api', 'api'), R('/api', 'web', { type: 'Exact' })] }]);
  check(hit(m, '/api').dep === 'd-web', 'an Exact match beats a PathPrefix of the same path');
  check(hit(m, '/api/orders').dep === 'd-api', 'the longest PathPrefix wins');
  check(hit(m, '/apiary').code === 404 && hit(m, '/apiary').dep === 'd-web', '/apiary falls to PathPrefix / (and the website has no such page)');
}
{
  const m = world([{ name: 'b', rules: [R('/', 'web')] }, { name: 'a', hostnames: ['shop.example.com'], rules: [R('/', 'api')] }]);
  check(hit(m, '/api/x').dep === 'd-api', 'a route with a matching exact hostname beats one with no hostnames');
  const w = world([{ name: 'b', hostnames: ['*.example.com'], rules: [R('/api', 'web')] }, { name: 'a', hostnames: ['shop.example.com'], rules: [R('/', 'api')] }]);
  check(hit(w, '/api/x').dep === 'd-api', 'hostname precedence comes before path length');
  const o = world([{ name: 'z', rules: [R('/api', 'api')] }, { name: 'y', rules: [R('/api', 'web')] }]);
  check(hit(o, '/api/x').dep === 'd-api', 'a tie goes to the older route (creation order)');
  const hd = world([{ rules: [R('/api', 'api'), R('/api', 'web', { header: 'x-canary: always' })] }], { headers: ['x-canary: always'] });
  check(hit(hd, '/api/x').dep === 'd-web', 'more header matches win a tie on path');
  check(hit(world([{ rules: [R('/api', 'api'), R('/api', 'web', { header: 'x-canary: always' })] }]), '/api/x').dep === 'd-api', 'a header match needs the header');
}
{
  const r = hit(world([{ rules: [R('/', 'nope')] }]), '/');
  check(r.code === 500 && /ResolvedRefs: False/.test(r.why), 'a backendRef to a missing Service gets 500 and ResolvedRefs: False');
  const st = K.apply(world([{ rules: [R('/', 'web', { backends: [{ service: 'web', port: 8080, weight: 1 }] })] }])).routes.rt0;
  check(!st.resolved && /no port 8080/.test(st.refsBad[0].why), 'a backendRef to a port the Service lacks does not resolve');
  check(hit(world([{ rules: [R('/', 'web', { backends: [] })] }]), '/').code === 500, 'a rule with no backendRefs answers 500');
  check(hit(world([{ rules: [R('/api', 'api')] }]), '/').code === 404, 'no matching rule answers 404');
  check(hit(world([]), '/').code === 404, 'a Gateway with no routes answers 404');
}
{
  const m = world([{ hostnames: ['shop.example.net'], rules: [R('/', 'web')] }], { listeners: [{ name: 'http', protocol: 'HTTP', port: 80, hostname: '*.example.com', cert: '' }] });
  const A = K.apply(m);
  check(A.routes.rt0.parents[0].reason === 'NoMatchingListenerHostname' && !A.routes.rt0.parents[0].accepted, 'a route whose hostnames fit no listener is Accepted: False (NoMatchingListenerHostname)');
  check(A.results[0].code === 404 && A.gateways.gw.listeners[0].attached === 0, 'an unattached route gets no traffic (404, 0 attached routes)');
  const s = world([{ parents: [{ name: 'public', section: 'https' }], rules: [R('/', 'web')] }]);
  check(K.apply(s).routes.rt0.parents[0].reason === 'NoMatchingParent', 'a sectionName naming no listener is NoMatchingParent');
  const g = world([{ parents: [{ name: 'private', section: '' }], rules: [R('/', 'web')] }]);
  check(!K.apply(g).routes.rt0.parents[0].accepted && K.apply(g).results[0].code === 404, 'a parentRef to a missing Gateway attaches nothing');
  const c = K.apply(world([{ rules: [R('/', 'web')] }], { className: 'nginx' }));
  check(c.results[0].code === 0 && !c.gateways.gw.accepted && !c.gateways.gw.address, 'a Gateway with an unknown GatewayClass has no address and answers nothing');
  const p = K.apply(world([{ rules: [R('/', 'web')] }], { listeners: [{ name: 'http', protocol: 'HTTP', port: 8080, hostname: '', cert: '' }] }));
  check(p.results[0].code === 0 && /no listener on port 80/.test(p.results[0].why), 'no listener on the port: connection refused');
  const t = K.apply(world([{ rules: [R('/', 'web')] }], { listeners: [{ name: 'http', protocol: 'HTTP', port: 80, hostname: 'shop.example.com', cert: '' }, { name: 'any', protocol: 'HTTP', port: 80, hostname: '', cert: '' }] }));
  check(t.results[0].code === 200 && t.gateways.gw.listeners.every(l => l.attached === 1), 'a route with no hostnames attaches to every listener');
}
{
  // weights: 9:1 over ten requests is exactly 9 and 1; weight 0 gets nothing
  const m = world([{ rules: [R('/', 'web', { backends: [{ service: 'web', port: 80, weight: 90 }, { service: 'api', port: 80, weight: 10 }] })] }]);
  m.blocks[0].count = 10; m.blocks[0].paths = ['/api/x'];
  const res = K.apply(m).results;
  check(res.filter(r => r.pod?.dep === 'd-api').length === 1 && res.filter(r => r.pod?.dep === 'd-web').length === 9, 'weights 90/10 split ten requests 9 and 1');
  m.blocks.find(b => b.kind === 'httproute').rules[0].backends[1].weight = 0;
  check(K.apply(m).results.every(r => r.pod?.dep === 'd-web'), 'weight 0 sends no traffic');
  m.blocks.find(b => b.kind === 'httproute').rules[0].backends[0].weight = 0;
  check(K.apply(m).results.every(r => r.code === 500), 'all weights 0 answers 500');
}
{
  // the YAML of a canary route and an HTTPS listener
  const y = K.toYaml(K.CHALLENGES.find(c => c.id === 'canary').solve(K.CHALLENGES.find(c => c.id === 'canary').setup()));
  check(/backendRefs:\n        - name: web\n          port: 80\n          weight: 90\n        - name: web-canary\n          port: 80\n          weight: 10/.test(y), 'the canary YAML lists both backendRefs with weights');
  const s = K.toYaml(sandbox.setup());
  check(/protocol: HTTPS\n      port: 443\n      hostname: "\*\.example\.com"\n      tls:\n        mode: Terminate\n        certificateRefs:\n          - kind: Secret\n            name: shop-tls/.test(s), 'the HTTPS listener YAML names its certificate Secret');
  check(/type: kubernetes\.io\/tls/.test(s), 'a Secret with tls.crt is type kubernetes.io/tls');
}
{
  // wiring on the board writes the references
  const m = { blocks: [K.block('httproute', 'r', 'shop'), K.block('gateway', 'g', 'public'), K.block('service', 's', 'web')] };
  check(!!K.connect(m, 'r', 'g') && m.blocks[0].parents[0].name === 'public', 'dragging an HTTPRoute onto a Gateway writes a parentRef');
  check(!!K.connect(m, 'r', 's') && m.blocks[0].rules[0].backends[0].service === 'web', 'dragging an HTTPRoute onto a Service writes a rule with a backendRef');
  check(K.refs(m).filter(r => r.to).length === 2, 'both references resolve on the board');
}

if (failures.length) {
  console.error(`${failures.length} of ${checks} checks failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`kubesim: all ${checks} checks passed`);
