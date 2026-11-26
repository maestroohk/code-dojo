// Checks ui/termmarks.js in plain Node: the markers the shell stand-ins print (netlabs/images/shell/dojo-linerc) are
// found, other OSC sequences are not taken for them, split sequences wait, and files get a sensible editor language.
// Run: node tests/CodeDojo.Tests/termmarks.test.mjs   (LineTermTests.cs runs it as part of dotnet test)
const T = await import(new URL('../../ui/termmarks.js', import.meta.url));

const failures = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) failures.push(what); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

check(eq(T.parseMark('\x1b]dojo;edit;/etc/hosts\x07'), { kind: 'edit', path: '/etc/hosts', root: false }), 'edit marker');
check(eq(T.parseMark('\x1b]dojo;sudoedit;/etc/ssh/sshd_config\x1b\\'), { kind: 'edit', path: '/etc/ssh/sshd_config', root: true }), 'sudoedit marker ended by ST');
check(T.parseMark('\x1b]dojo;edit;/tmp/a;b c.txt\x07').path === '/tmp/a;b c.txt', 'paths may hold ; and spaces');
check(T.parseMark('\x1b]0;root@host: ~\x07') === null, 'a window title is not a marker');
check(T.parseMark('\x1b]dojo;edit;\x07') === null, 'an empty path is not a marker');
check(T.parseMark('\x1b]dojo;run;/bin/sh\x07') === null, 'only edit and sudoedit exist');

const out = T.extractMarks('$ nano /etc/hosts\r\n\x1b]dojo;edit;/etc/hosts\x07dojo: nano opened /etc/hosts\r\n\x1b]0;title\x07$ ');
check(out.marks.length === 1 && out.marks[0].path === '/etc/hosts', 'one marker found in output');
check(out.text === '$ nano /etc/hosts\r\ndojo: nano opened /etc/hosts\r\n$ ', 'markers and other OSC sequences are taken out of the text');

check(T.oscPending('\x1b]dojo;edit;/very/long/path/that/is/split/over/two/websocket/messages/and/more/than/64/chars'), 'a split marker waits');
check(!T.oscPending('\x1b]dojo;edit;/etc/hosts\x07'), 'a whole marker does not wait');
check(!T.oscPending('\x1b[0m'), 'a CSI sequence is not an OSC');
check(!T.oscPending('\x1b]' + 'x'.repeat(5000)), 'a runaway OSC stops waiting');
check(T.oscPending('\x1b]dojo;edit;/etc/hosts\x1b'), 'an ST split after ESC waits');

for (const [path, lang] of [
  ['/work/camel/routes.yaml', 'yaml'], ['/work/kong/kong.yml', 'yaml'], ['/etc/hosts', 'conf'], ['/etc/ssh/sshd_config', 'conf'],
  ['/root/.bashrc', 'bash'], ['/lab/run.sh', 'bash'], ['/app/settings.json', 'json'], ['/srv/app.py', 'python'],
  ['/etc/systemd/system/backup.timer', 'conf'], ['/root/notes.txt', 'plain'], ['/srv/index.html', 'html'], ['/opt/Main.java', 'java'],
]) check(T.editorLang(path) === lang, `editorLang(${path}) = ${T.editorLang(path)}, expected ${lang}`);

if (failures.length) { console.error(failures.map(f => 'FAIL ' + f).join('\n')); process.exit(1); }
console.log(`${checks} checks passed`);
