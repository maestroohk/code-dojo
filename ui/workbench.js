// The Workbench: run your own web apps live, call them like Postman would (JSON, forms, multipart
// uploads), and watch each request travel through YOUR code: the map is drawn from your Program.cs
// (middleware in order, then endpoints), and every request lights up the path it actually took.
// Several apps can run at once and call each other; the traffic view draws that conversation.
import { h, api, ask } from './util.js';
import * as game from './game.js';
import { createEditor } from './editor.js';

const STARTER_API = `// A small notes API. Start it, then send it requests from the panel on the right.
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<NoteStore>();
var app = builder.Build();

// Middleware: runs for every request, before and after the endpoint.
app.Use(async (context, next) =>
{
    Console.WriteLine($"→ {context.Request.Method} {context.Request.Path}");
    await next();
    Console.WriteLine($"← {context.Response.StatusCode}");
});

app.MapGet("/notes", (NoteStore store) => store.All());

app.MapGet("/notes/{id}", (int id, NoteStore store) =>
    store.Find(id) is { } note ? Results.Ok(note) : Results.NotFound());

app.MapPost("/notes", (NewNote input, NoteStore store) =>
{
    if (string.IsNullOrWhiteSpace(input.Text)) return Results.BadRequest(new { error = "text is required" });
    var note = store.Add(input.Text);
    return Results.Created($"/notes/{note.Id}", note);
});

// Multipart: a file plus a form field.
app.MapPost("/notes/import", async (HttpRequest request, NoteStore store) =>
{
    var form = await request.ReadFormAsync();
    var file = form.Files["file"];
    if (file is null) return Results.BadRequest(new { error = "send a file in the 'file' field" });
    using var reader = new StreamReader(file.OpenReadStream());
    var added = 0;
    while (await reader.ReadLineAsync() is { } line)
        if (line.Trim().Length > 0) { store.Add(line.Trim()); added++; }
    return Results.Ok(new { file = file.FileName, tag = form["tag"].ToString(), added });
}).DisableAntiforgery();

app.Run();

record Note(int Id, string Text);
record NewNote(string Text);

class NoteStore
{
    readonly List<Note> _notes = [];
    public IReadOnlyList<Note> All() => _notes;
    public Note? Find(int id) => _notes.FirstOrDefault(n => n.Id == id);
    public Note Add(string text) { var n = new Note(_notes.Count + 1, text); _notes.Add(n); return n; }
}
`;

const SAMPLE_INVENTORY = `// App 1 of 2: inventory. Start this one FIRST.
var app = WebApplication.CreateBuilder(args).Build();

var stock = new Dictionary<string, int> { ["apple"] = 5, ["pear"] = 0 };

app.MapGet("/stock/{item}", (string item) =>
    stock.TryGetValue(item, out var count)
        ? Results.Ok(new { item, count })
        : Results.NotFound());

app.Run();
`;

const SAMPLE_SHOP = `// App 2 of 2: the shop. It calls the inventory app over HTTP.
// The Workbench tells every app where the others are: Configuration["Services:<name>"].
var builder = WebApplication.CreateBuilder(args);
var inventoryUrl = builder.Configuration["Services:inventory"]
    ?? throw new InvalidOperationException("Start the 'inventory' app first.");
builder.Services.AddHttpClient();
var app = builder.Build();

app.MapPost("/orders", async (Order order, IHttpClientFactory factory) =>
{
    var http = factory.CreateClient();
    var reply = await http.GetAsync($"{inventoryUrl}/stock/{order.Item}");
    if (reply.StatusCode == HttpStatusCode.NotFound) return Results.NotFound(new { error = $"no such item: {order.Item}" });
    var stock = await reply.Content.ReadFromJsonAsync<Stock>();
    return stock!.Count >= order.Quantity
        ? Results.Ok(new { accepted = true, order.Item, order.Quantity })
        : Results.Conflict(new { accepted = false, reason = $"only {stock.Count} left" });
});

app.Run();

record Order(string Item, int Quantity);
record Stock(string Item, int Count);
`;

const PRESETS = {
  notes: { label: 'Notes API (JSON + multipart)', apps: [{ name: 'notes', code: STARTER_API }],
    requests: [
      { name: 'List notes', method: 'GET', path: '/notes', kind: 'none' },
      { name: 'Create a note', method: 'POST', path: '/notes', kind: 'json', text: '{\n  "text": "Buy milk"\n}' },
      { name: 'Invalid note (400)', method: 'POST', path: '/notes', kind: 'json', text: '{\n  "text": ""\n}' },
      { name: 'Get note 1', method: 'GET', path: '/notes/1', kind: 'none' },
      { name: 'Import a file (multipart)', method: 'POST', path: '/notes/import', kind: 'multipart', fields: [{ name: 'tag', value: 'imported' }, { name: 'file', file: true }] },
    ] },
  shop: { label: 'Two apps: shop → inventory', apps: [{ name: 'inventory', code: SAMPLE_INVENTORY }, { name: 'shop', code: SAMPLE_SHOP }],
    requests: [
      { name: 'Order 2 apples', app: 'shop', method: 'POST', path: '/orders', kind: 'json', text: '{ "item": "apple", "quantity": 2 }' },
      { name: 'Order a pear (409)', app: 'shop', method: 'POST', path: '/orders', kind: 'json', text: '{ "item": "pear", "quantity": 1 }' },
      { name: 'Ask inventory directly', app: 'inventory', method: 'GET', path: '/stock/apple', kind: 'none' },
    ] },
};

/** replaceChildren that, like h(), skips null and false (so `cond && node` works). */
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

const blankRequest = () => ({ method: 'GET', path: '/', headers: [['', '']], kind: 'none', text: '', fields: [{ name: '', value: '' }] });

export function workbench(page) {
  const wb = game.state.workbench ||= { apps: PRESETS.notes.apps.map(a => ({ ...a })), selected: 'notes', saved: PRESETS.notes.requests, req: blankRequest() };
  const opened = sessionStorage.getItem('workbench-open');
  if (opened) {
    sessionStorage.removeItem('workbench-open');
    const { name, code } = JSON.parse(opened);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
    const existing = wb.apps.find(a => a.name === slug);
    if (existing) existing.code = code || existing.code; else wb.apps.push({ name: slug, code: code || STARTER_API });
    wb.selected = slug;
  }

  let running = [];          // apps as the server reports them
  let traces = [];           // every request any app handled or made
  let logs = [];
  let since = 0;
  let outline = [];
  let last = null;           // last response
  let files = {};            // multipart field index -> { name, type, base64 } (not persisted)
  let stopped = false;
  const save = () => game.save();
  const sel = () => wb.apps.find(a => a.name === wb.selected) || wb.apps[0];
  const live = name => running.find(r => r.name === name && r.status !== 'stopped');

  // ------------------------------------------------------------ polling

  async function poll() {
    if (stopped) return;
    try {
      const r = await api(`apps/events?since=${since}`);
      running = r.apps;
      if (r.logs.length || r.traces.length) {
        logs = [...logs, ...r.logs].slice(-400);
        traces = [...traces, ...r.traces].slice(-200);
        since = Math.max(since, ...r.logs.map(l => l.n), ...r.traces.map(t => t.n));
        paintTraffic(); paintLogs();
      }
      paintApps();
    } catch { /* server restarting */ }
    setTimeout(poll, 900);
  }

  // ------------------------------------------------------------ apps + code

  const status = h('span.muted.small');
  const appList = h('div.wb-apps');
  let editor;

  function paintApps() {
    appList.replaceChildren(...wb.apps.map(a => {
      const r = running.find(x => x.name === a.name);
      const st = r?.status || 'not running';
      return h(`button.wb-app${a.name === wb.selected ? '.active' : ''}`, { type: 'button', onclick: () => { wb.selected = a.name; status.textContent = ''; save(); renderAll(); } },
        h(`span.dot.${st.replace(' ', '-')}`), h('b', a.name), h('span.muted.small', r && st !== 'stopped' ? `:${r.port}` : st));
    }), h('button.wb-app.add', { type: 'button', onclick: addApp }, '+ app'));
    const r = live(sel()?.name);
    startBtn.textContent = r ? '↻ Restart' : '▶ Start';
    stopBtn.disabled = !r;
  }

  async function addApp() {
    let n = 2;
    while (wb.apps.some(a => a.name === `app${n}`)) n++;
    wb.apps.push({ name: `app${n}`, code: STARTER_API });
    wb.selected = `app${n}`;
    save(); renderAll();
  }

  async function start() {
    const a = sel();
    status.textContent = 'Compiling and starting…';
    startBtn.disabled = true;
    try {
      const r = await api('apps/start', { name: a.name, code: a.code });
      editor.mark(r.diagnostics || []);
      status.textContent = r.error ? '' : `Running at ${r.app.url}`;
      if (r.error) {
        const errs = (r.diagnostics || []).filter(d => d.severity === 'error');
        showProblem(r.error, errs.map(d => `Line ${d.line}: ${d.message}`));
      } else hideProblem();
    } catch { status.textContent = 'Could not reach the dojo server.'; }
    startBtn.disabled = false;
    running = (await api('apps').catch(() => running));
    paintApps(); refreshOutline();
  }

  async function stop() {
    await api(`apps/${sel().name}/stop`, {});
    running = await api('apps').catch(() => running);
    paintApps();
  }

  const problem = h('div.wb-problem', { hidden: true });
  const showProblem = (title, lines) => { problem.hidden = false; problem.replaceChildren(h('b', title), ...lines.map(l => h('div.small.mono', l))); };
  const hideProblem = () => { problem.hidden = true; };

  const startBtn = h('button.btn.primary', { type: 'button', onclick: start }, '▶ Start');
  const stopBtn = h('button.btn.ghost', { type: 'button', onclick: stop }, '■ Stop');

  let outlineTimer;
  async function refreshOutline() {
    try { outline = await api('outline', { code: sel().code }); } catch { outline = []; }
    paintMap();
  }

  // ------------------------------------------------------------ the code map

  const mapEl = h('div.wb-map');
  function paintMap(hit) {
    const mids = outline.filter(i => i.kind === 'middleware');
    const eps = outline.filter(i => i.kind === 'endpoint');
    const svcs = outline.filter(i => i.kind === 'service');
    const matched = hit?.route != null ? eps.find(e => routeEq(e, hit)) : null;
    const reached = hit ? (matched || !hit.matched ? mids.length : mids.length) : -1;
    const ok = hit && hit.status < 400, warn = hit && hit.status >= 400 && hit.status < 500;
    const cls = hit ? (ok ? 'ok' : warn ? 'warn' : 'bad') : '';
    const jump = l => editor?.goto?.(l);

    put(mapEl, 
      h('div.wb-map-col',
        h('div.wb-map-title', 'Request'),
        h(`div.wb-node.client${hit ? '.lit' : ''}`, h('b', hit ? `${hit.method} ${hit.path}${hit.query || ''}` : 'your request'), hit?.contentType && h('div.small.muted', hit.contentType))),
      h('div.wb-arrow', '→'),
      h('div.wb-map-col',
        h('div.wb-map-title', 'Middleware (in order)'),
        mids.length ? mids.map((m, i) => h(`div.wb-node.mid${hit && i < reached ? '.lit' : ''}`, { onclick: () => jump(m.line), title: `line ${m.line}` },
          h('b', `app.${m.name}`), h('div.small.muted', m.detail || `line ${m.line}`)))
          : h('div.wb-node.empty.small.muted', 'none: requests go straight to routing')),
      h('div.wb-arrow', '→'),
      h('div.wb-map-col.grow',
        h('div.wb-map-title', 'Endpoints'),
        eps.length ? eps.map(e => {
          const isHit = matched === e;
          return h(`div.wb-node.ep${isHit ? '.lit.' + cls : ''}`, { onclick: () => { jump(e.line); useEndpoint(e); }, title: 'Click to prepare a request for this endpoint' },
            h('span.wb-verb', e.method), h('b.mono', e.route),
            e.detail && h('div.small.muted.mono', e.detail),
            isHit && hit.routeValues && Object.keys(hit.routeValues).length > 0 && h('div.small.wb-rv', Object.entries(hit.routeValues).map(([k, v]) => `${k} = ${v}`).join(' · ')));
        }) : h('div.wb-node.empty.small.muted', 'No endpoints found yet. Add app.MapGet(...)'),
        hit && !matched && h(`div.wb-node.miss.${cls}`, h('b', hit.matched ? 'Handled by a route the map could not read' : `No endpoint matched`), h('div.small.muted',
          hit.matched ? '' : hit.status === 404 ? 'Routing found nothing for this method and path, so the app answered 404.' : `A middleware answered ${hit.status} before routing reached an endpoint (it short-circuited).`))),
      h('div.wb-arrow', '→'),
      h('div.wb-map-col',
        h('div.wb-map-title', 'Response'),
        h(`div.wb-node.resp${hit ? '.lit.' + cls : ''}`, h('b', hit ? `${hit.status}` : '…'), hit && h('div.small.muted', `${hit.ms} ms in your app`), hit?.error && h('div.small.bad', hit.error))),
      svcs.length > 0 && h('div.wb-services', h('span.muted.small', 'Services in the DI container: '), svcs.map(s => h('span.wb-svc', { title: s.detail || '', onclick: () => jump(s.line) }, s.name))));
  }

  const routeEq = (e, hit) => e.method === hit.method && norm(e.route) === norm(hit.route) || (e.method === 'ANY' && norm(e.route) === norm(hit.route));
  const norm = r => '/' + String(r || '').replace(/^\/+|\/+$/g, '').toLowerCase().replace(/\{([^}:?=]+)[^}]*\}/g, '{$1}');

  function useEndpoint(e) {
    wb.req.method = e.method === 'ANY' || e.method === '…' ? 'GET' : e.method;
    wb.req.path = e.route.replace(/\{([^}:]+)[^}]*\}/g, (_, n) => (n === 'id' ? '1' : n));
    if (['POST', 'PUT', 'PATCH'].includes(wb.req.method) && wb.req.kind === 'none') { wb.req.kind = 'json'; wb.req.text ||= '{\n  \n}'; }
    save(); paintRequest();
  }

  // ------------------------------------------------------------ request builder

  const reqEl = h('div.wb-req');
  function paintRequest() {
    const r = wb.req;
    const bodyTabs = ['none', 'json', 'text', 'form', 'multipart'];
    const field = (f, i) => h('div.wb-row',
      h('input', { placeholder: 'name', value: f.name, oninput: e => { f.name = e.target.value; save(); } }),
      r.kind === 'multipart' && f.file
        ? h('label.wb-file', h('input', { type: 'file', onchange: e => pickFile(i, e.target.files[0]) }), files[i] ? `📎 ${files[i].name}` : 'Choose file…')
        : h('input', { placeholder: 'value', value: f.value || '', oninput: e => { f.value = e.target.value; save(); } }),
      r.kind === 'multipart' && h('button.icon-btn', { type: 'button', title: f.file ? 'Make it a text field' : 'Make it a file', onclick: () => { f.file = !f.file; save(); paintRequest(); } }, f.file ? '𝐓' : '📎'),
      h('button.icon-btn', { type: 'button', title: 'Remove', onclick: () => { r.fields.splice(i, 1); save(); paintRequest(); } }, '×'));

    put(reqEl, 
      h('div.wb-line',
        h('select.wb-method', { onchange: e => { r.method = e.target.value; save(); } },
          ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => h('option', { selected: r.method === m }, m))),
        h('span.wb-base.mono.small', live(sel()?.name)?.url || 'http://(not running)'),
        h('input.wb-path.mono', { value: r.path, oninput: e => { r.path = e.target.value; save(); }, onkeydown: e => e.key === 'Enter' && send() }),
        h('button.btn.primary', { type: 'button', onclick: send }, 'Send')),
      h('details.wb-headers', { open: r.headers.some(x => x[0]) },
        h('summary', `Headers${r.headers.filter(x => x[0]).length ? ` (${r.headers.filter(x => x[0]).length})` : ''}`),
        r.headers.map((pair, i) => h('div.wb-row',
          h('input', { placeholder: 'X-Api-Key', value: pair[0], oninput: e => { pair[0] = e.target.value; save(); } }),
          h('input', { placeholder: 'value', value: pair[1], oninput: e => { pair[1] = e.target.value; save(); } }),
          h('button.icon-btn', { type: 'button', onclick: () => { r.headers.splice(i, 1); if (!r.headers.length) r.headers.push(['', '']); save(); paintRequest(); } }, '×'))),
        h('button.btn.ghost.small', { type: 'button', onclick: () => { r.headers.push(['', '']); save(); paintRequest(); } }, '+ header')),
      h('div.wb-bodytabs', h('span.muted.small', 'Body '), bodyTabs.map(k => h(`button.tab.small${r.kind === k ? '.active' : ''}`, { type: 'button', onclick: () => { r.kind = k; save(); paintRequest(); } }, k))),
      (r.kind === 'json' || r.kind === 'text') && h('textarea.answer.mono.wb-body', { rows: 6, spellcheck: false, value: r.text, oninput: e => { r.text = e.target.value; save(); } }),
      (r.kind === 'form' || r.kind === 'multipart') && h('div',
        r.fields.map(field),
        h('button.btn.ghost.small', { type: 'button', onclick: () => { r.fields.push({ name: '', value: '' }); save(); paintRequest(); } }, '+ field'),
        r.kind === 'multipart' && h('p.muted.small', 'Each part is sent as multipart/form-data, exactly like an HTML form with a file input.')),
      h('div.wb-saved', h('span.muted.small', 'Saved: '),
        (wb.saved || []).map((s, i) => h('span.wb-chip', h('button', { type: 'button', onclick: () => loadSaved(s) }, s.name),
          h('button.x', { type: 'button', title: 'Forget', onclick: () => { wb.saved.splice(i, 1); save(); paintRequest(); } }, '×'))),
        h('button.btn.ghost.small', { type: 'button', onclick: async () => {
          const name = `${r.method} ${r.path}`;
          wb.saved = [...(wb.saved || []), { name, app: wb.selected, method: r.method, path: r.path, kind: r.kind, text: r.text, headers: r.headers, fields: r.fields }];
          save(); paintRequest();
        } }, '+ save this')));
  }

  function loadSaved(s) {
    if (s.app && wb.apps.some(a => a.name === s.app)) wb.selected = s.app;
    wb.req = { ...blankRequest(), ...JSON.parse(JSON.stringify(s)) };
    if (!wb.req.headers?.length) wb.req.headers = [['', '']];
    if (!wb.req.fields?.length) wb.req.fields = [{ name: '', value: '' }];
    files = {};
    save(); renderAll();
  }

  function pickFile(i, file) {
    if (!file) return;
    if (file.size > 1_000_000) { showProblem('That file is over 1 MB.', ['Pick a smaller one: the Workbench is for trying things, not bulk uploads.']); return; }
    const reader = new FileReader();
    reader.onload = () => { files[i] = { name: file.name, type: file.type || 'application/octet-stream', base64: String(reader.result).split(',')[1] }; paintRequest(); };
    reader.readAsDataURL(file);
  }

  async function send() {
    const a = sel();
    if (!live(a.name)) { showProblem(`"${a.name}" is not running.`, ['Press Start first.']); return; }
    hideProblem();
    const r = wb.req;
    let fields = null;
    if (r.kind === 'form' || r.kind === 'multipart') {
      fields = r.fields.filter(f => f.name).map((f, i) => f.file && files[r.fields.indexOf(f)]
        ? { name: f.name, fileName: files[r.fields.indexOf(f)].name, contentType: files[r.fields.indexOf(f)].type, base64: files[r.fields.indexOf(f)].base64 }
        : f.file ? { name: f.name, fileName: 'sample.txt', contentType: 'text/plain', base64: btoa('first line\nsecond line\n') } : { name: f.name, value: f.value || '' });
    }
    put(respEl, h('div.muted', 'Sending…'));
    try {
      last = await api(`apps/${a.name}/send`, {
        method: r.method, path: r.path, headers: r.headers.filter(x => x[0]),
        body: r.kind === 'none' ? null : { kind: r.kind, text: r.text, fields },
      });
      last.request = { method: r.method, path: r.path, kind: r.kind, text: r.text };
    } catch { last = { error: 'Could not reach the dojo server.' }; }
    paintResponse();
    if (last.server) animate(last.server);
  }

  function animate(hit) {
    paintMap(hit);
    mapEl.classList.remove('pulse'); void mapEl.offsetWidth; mapEl.classList.add('pulse');
  }

  // ------------------------------------------------------------ response

  const respEl = h('div.wb-resp');
  let respTab = 'body';
  function paintResponse() {
    if (!last) return put(respEl, h('div.muted.small', 'Send a request to see the response here.'));
    if (last.error) return put(respEl, h('div.wb-problem', h('b', last.error)));
    const ok = last.status < 400;
    let body = last.body;
    try { if (/json/.test(last.headers.find(x => x[0].toLowerCase() === 'content-type')?.[1] || '')) body = JSON.stringify(JSON.parse(body), null, 2); } catch { }
    const csharp = csharpSnippet(last.request, live(sel().name)?.url);
    const tabs = { body: h('pre.code.plain.wb-out', body || '(empty body)'),
      headers: h('table.wb-table', last.headers.map(([k, v]) => h('tr', h('td.mono', k), h('td.mono', v)))),
      curl: h('pre.code.plain.wb-out', last.curl),
      'C# test': h('pre.code.plain.wb-out', csharp) };
    put(respEl, 
      h('div.wb-line',
        h(`span.wb-status.${ok ? 'ok' : last.status < 500 ? 'warn' : 'bad'}`, `${last.status} ${last.reason || ''}`),
        h('span.muted.small', `${last.ms} ms · ${last.size.toLocaleString()} bytes`),
        h('span.spacer'),
        Object.keys(tabs).map(t => h(`button.tab.small${respTab === t ? '.active' : ''}`, { type: 'button', onclick: () => { respTab = t; paintResponse(); } }, t))),
      tabs[respTab]);
  }

  function csharpSnippet(req, base) {
    if (!req) return '';
    const call = req.kind === 'json'
      ? `var response = await http.${{ POST: 'PostAsync', PUT: 'PutAsync', PATCH: 'PatchAsync' }[req.method] || 'SendAsync'}("${req.path}",\n    new StringContent("""\n${req.text}\n""", Encoding.UTF8, "application/json"));`
      : req.method === 'GET' ? `var response = await http.GetAsync("${req.path}");`
        : req.method === 'DELETE' ? `var response = await http.DeleteAsync("${req.path}");`
          : `var response = await http.SendAsync(new HttpRequestMessage(HttpMethod.${req.method[0] + req.method.slice(1).toLowerCase()}, "${req.path}"));`;
    return [
      '// The same call as an automated test would make it (this is what the dojo\'s checks do).',
      `using var http = new HttpClient { BaseAddress = new Uri("${base || 'http://localhost:5000'}") };`,
      call,
      `Console.WriteLine((int)response.StatusCode);   // expect ${last.status}`,
      'Console.WriteLine(await response.Content.ReadAsStringAsync());',
    ].join('\n');
  }

  // ------------------------------------------------------------ traffic between apps

  const trafficEl = h('div.wb-traffic');
  function paintTraffic() {
    const urlToApp = url => running.find(r => url?.startsWith(r.url))?.name;
    // One arrow per call: requests from you (they carry our trace header) and calls an app made.
    // The receiving app's own record of an app-to-app call would only duplicate the arrow.
    // Records are written when a request ENDS, so order by when it started: a call that caused
    // another must be drawn first.
    const recent = traces
      .filter(t => t.kind === 'out' || t.trace)
      .map(t => ({ ...t, start: t.at - (t.ms || 0) }))
      .sort((a, b) => a.start - b.start)
      .slice(-14);
    const lanes = ['you', ...wb.apps.map(a => a.name)];
    const W = 150, rowH = 30, top = 34;
    const width = lanes.length * W;
    const rows = recent.length;
    const x = name => (lanes.indexOf(name) + 0.5) * W;
    const svg = [`<svg viewBox="0 0 ${width} ${top + rows * rowH + 10}" width="${width}" height="${top + rows * rowH + 10}" class="wb-seq">`,
      '<defs><marker id="wb-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="currentColor"/></marker></defs>'];
    lanes.forEach(l => {
      svg.push(`<text x="${x(l)}" y="18" class="lane">${l}</text><line x1="${x(l)}" y1="24" x2="${x(l)}" y2="${top + rows * rowH}" class="lifeline"/>`);
    });
    recent.forEach((t, i) => {
      const y = top + i * rowH + 14;
      let from, to, label;
      if (t.kind === 'out') { from = t.app; to = urlToApp(t.url) || 'external'; label = `${t.method} ${(t.url || '').replace(/^https?:\/\/[^/]+/, '')} → ${t.status}`; }
      else { to = t.app; from = 'you'; label = `${t.method} ${t.path} → ${t.status}`; }
      if (!lanes.includes(from) || !lanes.includes(to)) return;
      const cls = t.status >= 500 || t.status === 0 ? 'bad' : t.status >= 400 ? 'warn' : 'ok';
      svg.push(`<line x1="${x(from)}" y1="${y}" x2="${x(to)}" y2="${y}" class="msg ${cls}" marker-end="url(#wb-ar)"/>`,
        `<text x="${(x(from) + x(to)) / 2}" y="${y - 5}" class="msg-label">${esc(label)}</text>`);
    });
    svg.push('</svg>');
    trafficEl.innerHTML = recent.length ? svg.join('') : '<p class="muted small">Requests between you and your apps, and between the apps themselves, appear here as they happen.</p>';
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const logsEl = h('pre.wb-logs');
  function paintLogs() {
    const mine = logs.filter(l => l.app === sel()?.name).slice(-80);
    logsEl.textContent = mine.length ? mine.map(l => (l.stream === 'err' ? '! ' : '') + l.text).join('\n') : '(nothing printed yet; Console.WriteLine and logging show up here)';
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  // ------------------------------------------------------------ layout

  function renderAll() {
    const a = sel();
    editor = createEditor({
      value: a.code, minLines: 18,
      onChange: v => { a.code = v; save(); clearTimeout(outlineTimer); outlineTimer = setTimeout(refreshOutline, 500); },
      onRun: start,
    });
    page('workbench',
      h('div.track-head',
        h('div', h('h2.track-title', 'Workbench'), h('p.muted', 'Run your apps for real, call them, and watch each request move through your own code.')),
        h('div.wb-presets', h('span.muted.small', 'Load: '), Object.entries(PRESETS).map(([id, p]) => h('button.btn.ghost.small', { type: 'button', onclick: async () => {
          if (!await ask(`Replace the Workbench apps with "${p.label}"? Your current app code will be overwritten.`, { ok: 'Load it' })) return;
          wb.apps = p.apps.map(x => ({ ...x })); wb.selected = p.apps.at(-1).name; wb.saved = p.requests; wb.req = blankRequest();
          save(); renderAll();
        } }, p.label)))),
      h('div.wb-grid',
        h('section.wb-panel.wb-code',
          h('div.wb-line', appList),
          h('div.wb-line',
            h('input.wb-name', { value: a.name, title: 'App name (other apps find it as Services:<name>)', onchange: e => {
              const name = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') || a.name;
              if (wb.apps.some(x => x !== a && x.name === name)) return;
              a.name = name; wb.selected = name; save(); renderAll();
            } }),
            startBtn, stopBtn,
            h('button.btn.ghost', { type: 'button', title: 'Remove this app', onclick: async () => {
              if (wb.apps.length < 2 || !await ask(`Remove "${a.name}" and its code?`, { ok: 'Remove', danger: true })) return;
              if (live(a.name)) await api(`apps/${a.name}/stop`, {});
              wb.apps = wb.apps.filter(x => x !== a); wb.selected = wb.apps[0].name; save(); renderAll();
            } }, '🗑'),
            status),
          problem,
          editor.el,
          h('details.wb-logbox', { open: true }, h('summary', 'Console output'), logsEl)),
        h('section.wb-panel.wb-call',
          h('h3', 'Send a request'),
          reqEl,
          h('h3', 'Response'),
          respEl)),
      h('section.wb-panel',
        h('div.wb-line', h('h3', 'How your code handled the last request'), h('span.muted.small', 'Drawn from your Program.cs. Click a box to jump to its line; click an endpoint to prepare a request for it.')),
        mapEl),
      h('section.wb-panel',
        h('div.wb-line', h('h3', 'Traffic'), h('span.muted.small', 'Who called whom, newest at the bottom. Apps calling each other show up here too.')),
        trafficEl));
    paintApps(); paintRequest(); paintResponse(); paintTraffic(); paintLogs(); refreshOutline();
  }

  renderAll();
  poll();
  return () => { stopped = true; };
}
