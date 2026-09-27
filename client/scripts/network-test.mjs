// Browser regression checks against deterministic fixtures. No production database or persistent app server.
// Run after npm run build: node scripts/network-test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshots = path.join(client, 'test-artifacts');
const fixture = (id, name, type = 'RESERVOIR') => ({ id, name, type, serviceType: 'WATER', service: 'WATER', lat: -26.1, lon: 28.02, derived: false, localities: [], parents: [], children: [], chain: [], aliases: [], recentOutages: [], firstSeenAt: '2026-09-20', lastSeenAt: '2026-09-20', live: false });
const root = fixture('root', 'Central reservoir');
const parentA = fixture('parent-a', 'Northern works', 'TREATMENT_WORKS');
const parentB = fixture('parent-b', 'Western pump', 'PUMP_STATION');
const children = Array.from({ length: 12 }, (_, i) => fixture(`child-${i}`, `Neighbourhood tower ${i + 1}`, 'WATER_TOWER'));
const edge = (parent, child, relationType) => ({ parentId: parent.id, childId: child.id, relationType, parent, child, evidenceCount: 1 });
root.parents = [edge(parentA, { ...root }, 'SUPPLIES'), edge(parentB, { ...root }, 'PUMPS_TO')];
root.children = children.map((c) => edge({ ...root, children: [] }, c, 'SUPPLIES'));
root.localities = [{ localityId: 'area', relationType: 'SERVES', locality: { canonicalName: 'Garden suburb' } }];
const directory = [root, parentA, parentB, ...children, ...Array.from({ length: 20 }, (_, i) => fixture(`extra-${i}`, `Additional asset ${i}`))];
const docs = Array.from({ length: 11 }, (_, i) => ({ id: `doc-${i}`, sourceType: 'OFFICIAL_DOCUMENT', title: `Supply report ${i + 1}`, url: `https://example.org/report-${i}.pdf`, publishedAt: '2026-09-20' }));
const requests = [];
function api(url) {
  const p = url.pathname;
  requests.push(p + url.search);
  if (p === '/v1/municipalities') return { data: [] };
  if (p === '/v1/map/infrastructure') return { data: directory };
  if (p.startsWith('/v1/map/node/')) {
    const n = directory.find((a) => a.id === p.split('/').at(-1)) ?? root;
    return { node: n, origin: [n.lon, n.lat], derived: false, parents: n.parents.map((e) => e.parent), children: n.children.map((e) => e.child), total: 1, unplaced: 0, unmappedConnections: 0, coverageDepth: 4, places: [{ id: 'area', name: 'Garden suburb', lon: 28.05, lat: -26.12, state: 'out', linkedState: 'restored' }], edges: [{ from: [n.lon, n.lat], to: [28.05, -26.12], toId: 'area', relationship: 'ASSOCIATED', kind: 'suburb' }] };
  }
  if (p.endsWith('/evidence')) {
    const offset = Number(url.searchParams.get('offset') || 0);
    const posts = url.searchParams.get('kind') === 'posts';
    const rows = posts ? [{ id: 'post', sourceType: 'SOCIAL_POST', title: 'Water utility', url: 'https://example.org/post', text: 'Supply is recovering.', publishedAt: '2026-09-21' }] : docs;
    return { documents: 11, posts: 1, total: rows.length, hasMore: offset + 10 < rows.length, data: rows.slice(offset, offset + 10) };
  }
  if (p.startsWith('/v1/infrastructure/')) return directory.find((n) => n.id === p.split('/').at(-1)) ?? root;
  if (p === '/v1/infrastructure') {
    const offset = Number(url.searchParams.get('offset') || 0);
    const type = url.searchParams.get('type');
    const q = url.searchParams.get('q')?.toLowerCase();
    const rows = directory.filter((n) => (!type || n.type === type) && (!q || n.name.toLowerCase().includes(q)));
    return { data: rows.slice(offset, offset + 30), total: rows.length, hasMore: offset + 30 < rows.length };
  }
  if (p.includes('/localities/')) return { locality: { id: 'area', name: 'Garden suburb', lat: -26.12, lon: 28.05 }, assets: [{ ...root, relationType: 'SERVES' }] };
  if (p === '/v1/search') return { suburbs: [{ id: 'area', name: 'Garden suburb' }], equipment: [root], outages: [] };
  return { data: [], enabled: false, operator: false, signInAvailable: false };
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/v1/')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(api(url))); }
    const relative = url.pathname.startsWith('/assets/') ? url.pathname.slice(1) : 'index.html';
    const filename = path.resolve(client, 'dist', relative);
    if (!filename.startsWith(path.join(client, 'dist') + path.sep)) { res.writeHead(400); return res.end(); }
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.html': 'text/html' }[path.extname(filename)] ?? 'application/octet-stream';
    res.setHeader('content-type', mime); res.end(await readFile(filename));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(tmpdir(), 'gridwatch-network-'));
const browserPath = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1100', 'about:blank'], { stdio: 'ignore', windowsHide: true });
console.log(`Browser test started (browser PID ${browser.pid}).`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 80; i++) { try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await sleep(100); } }
  assert.ok(port, 'Headless browser started');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json();
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Browser connection timed out')), 8000); ws.onopen = () => { clearTimeout(timer); resolve(); }; ws.onerror = () => { clearTimeout(timer); reject(new Error('Browser connection failed')); }; });
  let seq = 0;
  const pending = new Map();
  const errors = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10000); pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } }); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const p = pending.get(message.id); pending.delete(message.id); return message.error ? p?.reject(new Error(message.error.message)) : p?.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) errors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
    if (message.method === 'Fetch.requestPaused') {
      const url = message.params.request.url;
      const style = { version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#d5dde3' } }] };
      if (url.includes('/styles/')) {
        void send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(JSON.stringify(style)).toString('base64') });
      } else void send('Fetch.continueRequest', { requestId: message.params.requestId });
    }
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  };
  const wait = async (expression, label) => {
    for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await sleep(100); }
    throw new Error(`Timed out: ${label}\n${errors.join('\n')}\n${await evaluate('document.body?.innerText?.slice(0, 1800) ?? ""')}`);
  };
  const click = (selector, text) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) throw new Error('Missing button: ' + ${JSON.stringify(text)}); el.click(); })()`);
  const shot = async (name) => { await mkdir(screenshots, { recursive: true }); const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(path.join(screenshots, name), Buffer.from(r.data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable');
  console.log('Browser connected; checking network explorer.');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*openfreemap.org/styles/*' }] });
  await send('Page.navigate', { url: `${base}/network?service=water&asset=root&view=connections` });
  await wait("document.body.innerText.includes('FEEDS THIS ASSET (2)') && document.body.innerText.includes('Supply report 1')", 'two parents and source documents');
  assert.equal(await evaluate("document.querySelectorAll('.diagram-above .connection-card').length"), 2);
  await click('.network-connections button', 'Show 2 more (12 total)');
  assert.equal(await evaluate("document.querySelectorAll('.diagram-below .connection-card').length"), 12);
  await click('.network-evidence button', 'Next sources');
  await wait("document.body.innerText.includes('Supply report 11')", 'source pagination');
  await click('.network-evidence button', 'Social posts (1)');
  await wait("document.body.innerText.includes('Supply is recovering.')", 'social evidence');
  await click('.connection-card button', 'View connection sources');
  await wait("document.body.innerText.includes('Northern works connection sources')", 'exact edge sources');
  assert.ok(requests.some((r) => r.includes('parentId=parent-a') && r.includes('childId=root') && r.includes('relationType=SUPPLIES')));
  await shot('network-connections-desktop.png');
  await click('.network-tabs button', 'Map');
  await wait("document.querySelector('.maplibregl-canvas')?.width > 200", 'map canvas');
  await wait("performance.getEntriesByType('resource').some((e) => e.name.includes('openfreemap.org/styles'))", 'map style requested');
  await sleep(2200);
  assert.ok((await evaluate('location.search')).includes('asset=root'));
  await shot('network-map-desktop.png');
  await click('.network-tabs button', 'List');
  await wait("document.querySelectorAll('.network-assets button').length === 30", 'directory');
  await click('.network-pagination button', 'Next');
  await wait("document.querySelectorAll('.network-assets button').length === 5", 'second directory page');
  assert.ok((await evaluate('location.search')).includes('asset=root'));
  await evaluate('history.back()');
  await wait("!location.search.includes('offset=30') && document.querySelectorAll('.network-assets button').length === 30", 'Back restores pagination');
  await click('.network-tabs button', 'Hierarchy');
  await click('.diagram-above .network-name', 'Northern works');
  await wait("document.querySelector('.network-selection h2')?.textContent === 'Northern works'", 'expand upstream');
  await evaluate('history.back()');
  await wait("document.querySelector('.network-selection h2')?.textContent === 'Central reservoir'", 'Back restores selected asset');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'no horizontal overflow on mobile');
  const placement = await evaluate(`(() => { const card = document.querySelector('.connection-current'); const nav = document.querySelector('.mobile-nav'); const c = card.getBoundingClientRect(); const n = nav.getBoundingClientRect(); return { top: Math.round(c.top), bottom: Math.round(c.bottom), nav: Math.round(n.top) }; })()`);
  assert.equal(placement.top >= 64 && placement.bottom <= placement.nav + 1, true, `selected asset is not fully above the mobile navigation: ${JSON.stringify(placement)}`);
  await shot('network-connections-mobile.png');
  await click('.diagram-suburbs .network-name', 'Garden suburb');
  await wait("document.body.innerText.includes('Assets linked to Garden suburb')", 'suburb selection');
  await click('.network-tabs button', 'Map');
  await wait("document.querySelector('.maplibregl-canvas')", 'suburb map');
  assert.ok((await evaluate('location.search')).includes('suburb=area'));
  await sleep(600);
  assert.deepEqual(errors, [], 'browser console and runtime errors');
  console.log('PASS: multiple parents, expand neighbours, exact sources, source pagination, shared selection, map rendering, directory pagination, browser Back, suburb selection and mobile layout.');
  console.log(`Screenshots: ${screenshots}`);
  await send('Browser.close');
} finally {
  ws?.close();
  if (browser.exitCode == null) { await Promise.race([new Promise((resolve) => browser.once('exit', resolve)), sleep(2000)]); if (browser.exitCode == null) browser.kill(); }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const resolved = path.resolve(profile);
  if (resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith('gridwatch-network-')) await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
