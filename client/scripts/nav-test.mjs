// Drives a real (headless) Edge/Chrome through client-side navigation and reports console errors + blank pages.
//   node scripts/nav-test.mjs http://localhost:5177
import { spawn } from 'node:child_process';

const base = process.argv[2] ?? 'http://localhost:5173';
const EDGE = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9340 + Math.floor(Math.random() * 50);
const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 40; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    if (targets.some((t) => t.type === 'page')) break;
  } catch { /* browser still starting */ }
  await sleep(250);
}
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) return pending.get(msg.id)(msg.result);
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description?.split('\n')[0] ?? msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').split('\n')[0]}`);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

await send('Runtime.enable');
await send('Page.enable');

const results = [];
async function step(label, action) {
  const before = errors.length;
  await action();
  await sleep(1800);
  const text = await evaluate('document.getElementById("root")?.innerText?.trim().length ?? 0');
  results.push({ label, blank: !(text > 40), chars: text, newErrors: errors.slice(before) });
}

await send('Page.navigate', { url: base });
await sleep(3500);
results.push({ label: 'load /', blank: !((await evaluate('document.getElementById("root")?.innerText?.trim().length ?? 0')) > 40), chars: await evaluate('document.getElementById("root").innerText.length'), newErrors: [...errors] });

const click = (href) => evaluate(`(() => { const a = document.querySelector('.nav a[href="${href}"]'); if (!a) return 'missing'; a.click(); return 'clicked'; })()`);
for (const href of ['/outages', '/planned', '/activity', '/network', '/about', '/']) await step(`click nav ${href}`, () => click(href));
// into a detail page and back through the browser history
await step('open first outage card', () => evaluate(`(() => { document.querySelector('a[href^="/outages/"]')?.click(); })()`));
await step('history back', () => evaluate('history.back()'));
await step('open a suburb from a card', () => evaluate(`(() => { document.querySelector('a[href^="/suburb/"]')?.click(); })()`));
await step('suburb -> save as my area', () => evaluate(`(() => { document.querySelector('button.btn.primary')?.click(); })()`));
await step('go to network', () => click('/network'));
await step('open a service centre', () => evaluate(`(() => { document.querySelector('a.sdc-card')?.click(); })()`));
await step('open equipment from it', () => evaluate(`(() => { document.querySelector('a[href^="/network/"].chip')?.click(); })()`));
await step('outages: filter tab "Planned"', async () => { await click('/outages'); await sleep(1200); await evaluate(`(() => { [...document.querySelectorAll('.seg button')].find((b) => b.textContent.startsWith('Planned'))?.click(); })()`); });
await step('planned page row', async () => { await click('/planned'); await sleep(1200); await evaluate(`(() => { document.querySelector('.rows a.t')?.click(); })()`); });
await step('overview after saving an area', () => click('/'));
await step('search overlay opens ("/" key)', () => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))`));

ws.close();
proc.kill();

let bad = 0;
for (const r of results) {
  const ok = !r.blank && r.newErrors.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(34)} ${r.blank ? 'BLANK PAGE ' : `${r.chars} chars`}${r.newErrors.length ? `  errors: ${r.newErrors.slice(0, 2).join(' | ')}` : ''}`);
}
console.log(bad ? `\n${bad} step(s) failed` : '\nAll navigation steps passed with no console errors.');
process.exit(bad ? 1 : 0);
