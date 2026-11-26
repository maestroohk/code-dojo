// "What's in the dojo": every feature with its honest status, and a roadmap of ideas.
// Update this file whenever a feature lands or changes status; the page reads nothing else.
import { h } from './util.js';

// status: done | partial | building | planned | blocked
const FEATURES = [
  { area: 'Learning', items: [
    { name: 'Topics catalog', status: 'done', link: '#/', note: 'Every topic on one page, grouped by category, with progress and mastery rings.' },
    { name: 'Lesson player', status: 'done', note: 'Quiz, predict, drag-to-order, fill-the-gap, match, sort, code and fix-the-bug steps; hints, stars, Back to review.' },
    { name: 'Learn it first links', status: 'done', link: '#/projects', note: 'Project stages link the lessons they need and bring you back to the exact step.' },
    { name: 'Spaced practice', status: 'done', link: '#/practice', note: 'Wrong answers return after 1, 3, 7 and 14 days.' },
    { name: 'Graded code in C#', status: 'done', note: 'Compiled with Roslyn, run in a separate process, checked by hidden tests.' },
    { name: 'Graded code in Python, JavaScript, TypeScript', status: 'done', note: 'Same three kinds of check as C#. Charts graded by inspecting the figure.' },
    { name: 'Graded SQL', status: 'done', note: 'Real SQLite; results compared any-order, ordered, or by resulting table state.' },
    { name: 'EF Core exercises', status: 'done', note: 'EF Core with SQLite runs for real inside exercises.' },
    { name: 'Your builds', status: 'done', link: '#/builds', note: 'Every topic assembles a real tool from your passing code. Pieces light up as you earn them; open it as a Code space or download a .zip. The Git topic builds gitkit (more topics are being converted).' },
    { name: 'Dream projects to choose from', status: 'done', note: 'A topic can offer 4 to 5 dreams; pick one on the topic page, change it later, keep every piece you earned. Lessons can serve a different exercise per dream.' },
    { name: 'Welcome questions and Your path', status: 'done', link: '#/welcome', note: 'Seven quick questions give you a path through the topics, dream suggestions and a daily goal. Retake from Profile.' },
    { name: 'Visualizers in lessons', status: 'done', note: 'Code in motion (step through programs) and LINQ in motion on learn cards.' },
  ] },
  { area: 'Pacing: prove it, keep it', items: [
    { name: 'Lessons that call your earlier pieces', status: 'done', note: 'A step can "use" pieces you built before: your own latest code is compiled with it, or the reference version (clearly labelled) if you have not built it yet. If your old piece is broken, the review shows it.' },
    { name: 'Cold rebuilds', status: 'done', note: 'From memory: blank editor, no hints, no autocomplete, no solution to reveal, cannot be skipped. An optional gentle timer costs a star when you go over, never the step.' },
    { name: 'Mastery gates', status: 'done', note: 'The next module opens once you prove this one: the boss with enough stars and its cold rebuild. The map shows what is left, with links. Free roam still opens everything but shows the gate as not yet proven.' },
    { name: 'Spaced re-proof', status: 'done', link: '#/practice', note: 'A proven module sends a cold rebuild back to Practice after 3 and 10 days ("Can you still do it?"). Not passing marks the module rusty (amber on the map) until you rebuild it.' },
    { name: 'Rush detector', status: 'done', note: 'Finishing far faster than the minutes a lesson suggests while leaning on hints and answers gets a kind nudge to try the cold rebuild, and no quest progress for that lesson. It never blocks you.' },
    { name: 'Profile file and path order', status: 'done', link: '#/', note: 'Your welcome answers are kept in .state/profile.json too. Reorder Your path on the home page (drag or arrows); the order is saved to your profile.' },
    { name: 'Gates and cold rebuilds in every topic', status: 'building', note: 'The engine is done. C# (builds Sidekick, a real CLI tool) and Fundamentals (builds Delve) are converted; PKI, Networking, Linux and Git are next (see docs/CURRICULUM.md and docs/HANDOFF.md).' },
  ] },
  { area: 'Labs', items: [
    { name: 'Certificate chain lab', status: 'done', link: '#/labs/pki', note: 'Lego-style board, real X509Chain validation, fix-it challenges.' },
    { name: 'Code in motion', status: 'done', link: '#/labs/code', note: 'Step forwards and backwards through any program.' },
    { name: 'LINQ in motion', status: 'done', link: '#/labs/linq', note: 'Watch items flow through each operator.' },
    { name: 'Subnetting trainer', status: 'done', link: '#/labs/subnet', note: 'Endless drills with a bit-by-bit breakdown.' },
    { name: 'Vim & nano trainer', status: 'done', link: '#/labs/vim', note: '36 Vim and 9 nano challenges scored against par.' },
    { name: 'Live network labs', status: 'done', link: '#/labs/net', note: '10 container networks with in-page terminals. Needs Docker.' },
    { name: 'Linux missions', status: 'done', link: '#/labs/linux', note: '12 story missions on a real shell. Needs Docker.' },
    { name: 'Visual block builder for other topics', status: 'building', note: 'A reusable board, a Network builder (subnets, routing, NAT) and an Architecture builder (gateway, routes, failures).' },
    { name: 'Live Camel + gateway lab', status: 'planned', note: 'A real integration route and API gateway in containers, to break and fix.' },
  ] },
  { area: 'Tools', items: [
    { name: 'Playground in 7 languages', status: 'done', link: '#/playground', note: 'C#, Python, JavaScript, TypeScript, Java, HTML/CSS/JS with Tailwind; Python charts shown.' },
    { name: 'Editor assistance', status: 'done', note: 'Completion (switchable), auto-closing tags, brackets and quotes, Ctrl+/ comments.' },
    { name: 'HTML, JSX and CSS IntelliSense', status: 'done', note: 'Tags with descriptions, the attributes each tag takes (className, htmlFor, onClick in JSX), attribute values (type=, target=, rel=), Tailwind classes, your own components, CSS properties and values, and Emmet-style div.card or ul>li*3 + Tab.' },
    { name: 'Code theme "Dojo Dusk"', status: 'done', note: 'One colour per kind of thing: coral tags, teal components, periwinkle attributes, sage values, slate punctuation; brackets coloured by depth in every language; colour swatches under CSS hex values.' },
    { name: 'Pop-out editor', status: 'done', note: 'The corner button or Ctrl+Shift+F opens any editor large, with the task and results beside it and its own text size (A−/A+). Ctrl+B folds the side panel; new results bring it back. Esc returns.' },
    { name: 'Room for the code in Code spaces', status: 'done', link: '#/spaces', note: 'Full screen button; the Problems/Output panel stays folded until a run, build, test or error needs it (Ctrl+J toggles it).' },
    { name: 'C# go to definition, references, hover', status: 'done', note: 'From the real compiler, across files and NuGet packages.' },
    { name: 'Python and TypeScript intelligence', status: 'building', note: 'Definition, references, hover and smarter completion for Python and JS/TS.' },
    { name: 'Workbench', status: 'done', link: '#/workbench', note: 'Run your web apps live, call them, see each request travel through your code; several apps at once.' },
    { name: 'Code spaces (.NET)', status: 'done', link: '#/spaces', note: 'Real projects with NuGet, build, run, test.' },
    { name: 'Code spaces for Python and Node', status: 'done', link: '#/spaces', note: 'pip packages and pytest; npm packages, Express and Next.js. Registry lookups try IPv6 and IPv4 in parallel, so a network with a dead IPv6 route no longer looks offline.' },
    { name: 'Time-travel debugger', status: 'done', note: 'Breakpoints, stepping in all directions, variables, watch and call stack. Console programs ask for input while they are recorded; web apps are recorded per request.' },
    { name: 'Debugging web APIs', status: 'done', note: 'Debug a web project: it runs on a private port, every request is recorded on its own (list with status, time, breakpoint hits, exceptions), and any request opens in the debugger. Code spaces only, C# only.' },
    { name: 'Database studio', status: 'partial', link: '#/db', note: 'SQLite fully working. PostgreSQL tested; SQL Server and MySQL not yet run for real.' },
    { name: 'Data science tools setup', status: 'done', link: '#/track/datascience', note: 'One click installs numpy, pandas and matplotlib into the dojo’s own environment.' },
    { name: 'Real Next.js projects', status: 'done', link: '#/spaces', note: 'New space → Next.js + Tailwind: npm install, next dev with hot reload (loopback only), Stop ends every process, next build with TypeScript errors in Problems, next start.' },
  ] },
  { area: 'Game', items: [
    { name: 'XP, levels, streak, daily goal', status: 'done' },
    { name: 'Daily quests and chest', status: 'done', link: '#/' },
    { name: 'Streak freezes and milestones', status: 'done' },
    { name: 'Weekly league against yourself', status: 'done', link: '#/profile' },
    { name: 'Topic mastery and titles', status: 'done', link: '#/profile' },
    { name: 'Daily challenge (double XP)', status: 'done', link: '#/challenge' },
    { name: 'Accent themes, achievements, boot screen with facts', status: 'done' },
  ] },
];

// Ideas: lessons and features worth building next. Tell Claude which ones to do.
const IDEAS = [
  { kind: 'Topic', name: 'System design', why: 'Scaling, caching, queues, sharding, CAP and consistency, with an interactive "design an X" board that simulates load.' },
  { kind: 'Topic', name: 'Testing in depth (xUnit, mocks, TDD katas)', why: 'Write tests first against real katas; the grader checks your tests catch planted bugs.' },
  { kind: 'Topic', name: 'Observability with OpenTelemetry', why: 'Logs, metrics and traces wired into your Workbench apps, so you can see a trace you produced.' },
  { kind: 'Topic', name: 'Messaging: RabbitMQ and Kafka', why: 'Live Docker labs: publish, consume, retry, dead letters, partitions and consumer groups.' },
  { kind: 'Topic', name: 'Cloud fundamentals (Azure)', why: 'App Service, Functions, Storage, Key Vault, identity and costs, with Bicep/Terraform templates to read and fix.' },
  { kind: 'Topic', name: 'Infrastructure as code: Terraform', why: 'Plan/apply mental model, state, modules, drift; graded by parsing plans.' },
  { kind: 'Topic', name: 'Web security hands-on (OWASP Top 10)', why: 'Attack and then fix a deliberately vulnerable app you run locally: SQL injection, XSS, CSRF, IDOR.' },
  { kind: 'Topic', name: 'Clean architecture and DDD', why: 'Aggregates, value objects, bounded contexts, refactoring a big ball of mud stage by stage.' },
  { kind: 'Topic', name: 'Concurrency and async in depth', why: 'Threads, locks, channels, deadlocks you can watch in a visualizer, and fixing races.' },
  { kind: 'Topic', name: 'PowerShell scripting', why: 'You live on Windows: objects in the pipeline, remoting, automation of daily chores.' },
  { kind: 'Topic', name: 'Regular expressions', why: 'A regex lab that highlights matches and groups as you type, with golf challenges.' },
  { kind: 'Topic', name: 'gRPC and GraphQL', why: 'Contracts, streaming and schema design, run in the Workbench.' },
  { kind: 'Topic', name: 'Calling AI models from C#', why: 'Build a small assistant with the Claude API: prompts, tools, streaming, costs and safety.' },
  { kind: 'Topic', name: 'Interview prep: problem sets', why: 'Timed DSA problems by pattern, with hints and the Code in motion view of the optimal solution.' },
  { kind: 'Feature', name: 'Progress sync between machines', why: 'Export/import, or sync progress through a private Git repo or file, so home and work share one streak.' },
  { kind: 'Feature', name: 'Search everything (Ctrl+K)', why: 'Jump to any lesson, concept, command or lab; a built-in glossary.' },
  { kind: 'Feature', name: 'Notes and highlights per lesson', why: 'Your own notes next to each step, searchable, exportable.' },
  { kind: 'Feature', name: 'Learning paths', why: 'Backend developer, DevOps engineer, data analyst: ordered routes across topics with a progress map.' },
  { kind: 'Feature', name: 'Flashcards from lessons', why: 'Auto-made cards for commands, flags and concepts, reviewed with spaced repetition.' },
  { kind: 'Feature', name: 'Explain my error', why: 'Turn compiler and runtime errors into plain-language explanations with the likely fix (an AI tutor if you add an API key).' },
  { kind: 'Feature', name: 'Code katas with a timer', why: 'Short daily katas with personal-best times and a history chart.' },
  { kind: 'Feature', name: 'Completion certificates', why: 'A page per finished topic summarising what you built and mastered.' },
];

const LABEL = { done: 'Done', partial: 'Partly done', building: 'Being built', planned: 'Planned', blocked: 'Blocked here' };

export function featuresView(page) {
  const all = FEATURES.flatMap(a => a.items);
  const count = s => all.filter(i => i.status === s).length;
  page('features',
    h('section.hero', h('div',
      h('div.eyebrow', "What's in the dojo"),
      h('h1', 'Everything built, being built, and next'),
      h('p.muted', 'An honest inventory. "Partly done" says what is missing; "Blocked here" means this network prevents it.'))),
    h('div.ft-summary', ['done', 'partial', 'building', 'planned', 'blocked'].map(s =>
      h(`div.ft-count.s-${s}`, h('b', count(s)), h('span', LABEL[s])))),
    FEATURES.map(a => h('section.ft-area',
      h('h2.section-title', a.area),
      h('div.ft-list', a.items.map(i => h('div.ft-item',
        h(`span.ft-status.s-${i.status}`, LABEL[i.status]),
        h('div.ft-body', i.link ? h('a.ft-name', { href: i.link }, i.name) : h('b.ft-name', i.name), i.note && h('div.muted.small', i.note))))))),
    h('section.ft-area',
      h('h2.section-title', 'Ideas: lessons and features to add next'),
      h('p.muted', 'Tell Claude which of these to build, or suggest your own.'),
      h('div.ft-ideas', IDEAS.map(i => h('div.ft-idea', h('span.ft-kind', i.kind), h('b', i.name), h('div.muted.small', i.why))))));
}
