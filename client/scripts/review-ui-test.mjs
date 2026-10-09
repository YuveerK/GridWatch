// Real browser smoke test with fixture-only APIs. Always closes its server and isolated browser.
// npm run build && node scripts/review-ui-test.mjs
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root,'test-artifacts');
await mkdir(artifacts,{ recursive: true });
const profile = await mkdtemp(path.join(artifacts,'browser-'));
const date = new Date().toISOString();
let operator = true, failQueue = false, expire = false, slow = false;
const caseRow = { id: 'rc_demo',subjectKey: 'post:p:0',postId: 'p',faultIndex: 0,externalId: '123456',title: 'This restoration may belong to another outage',consequence: 'The earlier outage may still appear active.',source: 'CityPowerJhb',serviceType: 'ELECTRICITY',label: 'Alpha Station',createdAt: date,publishedAt: date,tab: 'decision',workflow: 'OPEN',blocked: false,reasons: [{ code: 'RESTORATION_SPLIT_FROM_INCIDENT' }] };
const incident = { id: 'incident-demo',title: 'Alpha Station interruption',serviceType: 'ELECTRICITY',status: 'ACTIVE',kind: 'UNPLANNED',waterState: null,startedAt: date,lastUpdateAt: date,equipment: [{ name: 'Alpha Station' }],localities: [{ name: 'Alpha',restored: false }],timeline: [{ postId: 'anchor',faultIndex: 0,role: 'OPENED',postedAt: date,text: 'Power interrupted at Alpha Station.',source: 'CityPowerJhb',externalId: '123' }] };
const fault = { faultIndex: 0,relevance: 'RESTORATION',status: 'RESTORED',entities: [{ type: 'SUBSTATION',name: 'Alpha Station',parent_name: null }],localities: [{ name: 'Alpha',state: 'RESTORED' }],summary: 'Power supply restored to Alpha.',cause: null,eta_text: null,restoration_percent: null };
const detail = { ...caseRow,sourcePost: { text: 'Power supply restored to Alpha.',source: 'CityPowerJhb',url: 'https://x.com/CityPowerJhb/status/123456',publishedAt: date,media: [{ mediaKey: 'unavailable',type: 'photo',url: '/missing-image.jpg' }],imageText: 'Alpha supply restored.',related: [] },reading: { ...fault,update_summary: fault.summary },readingDraft: { serviceType: 'ELECTRICITY',sdc: null,faults: [fault] },readingOrigin: 'machine',faults: [{ faultIndex: 0,label: 'Alpha Station',relevance: 'RESTORATION',decision: { outcome: 'LINKED',outageId: incident.id } }],decision: { outcome: 'LINKED',outageId: incident.id },incidents: [incident],candidates: [incident],explanations: [{ code: 'RESTORATION_SPLIT_FROM_INCIDENT',explanation: caseRow.consequence }],allowedActions: ['JOIN','SPLIT','READING','REREAD','CONFIRM','DEFER','ENGINEERING','RECHECK'],actions: [],brief: '# Investigation\nCheck the general mechanism with regression evidence.',overrides: [],proposals: [],retries: [] };
const summary = { counts: { decision: 1,waiting: 2,engineering: 0,history: 0 },correctionsEnabled: true,accounts: ['CityPowerJhb','JHBWater','CityTshwane'].map((displayName,i) => ({ id: String(i),displayName,serviceType: i === 1 ? 'WATER' : 'ELECTRICITY',lastCompletedFetch: date,lastCheck: date,latestFetchStatus: 'SUCCEEDED',latestPostsInserted: 0,problems: i === 1 ? ['The latest fetch did not finish.'] : [] })),pipeline: { quality: { finishedAt: date },problems: ['The review stage needs attention.'] } };
const preview = { type: 'JOIN',fingerprint: 'a'.repeat(64),providerCalls: 'None — stored utility evidence only.',changes: [{ faultIndex: 0,label: 'Alpha Station',from: incident.id,to: incident.id,meaning: 'RESTORATION',role: 'RESTORATION' }],siblings: [],before: [{ ...incident,areas: [{ id: 'alpha',name: 'Alpha',restored: false }],entries: [{ ...incident.timeline[0],effect: { status: 'ACTIVE' } }] }],after: [{ ...incident,status: 'RESTORED',areas: [{ id: 'alpha',name: 'Alpha',restored: true }],entries: [{ ...incident.timeline[0],effect: { status: 'ACTIVE' } },{ postId: 'p',faultIndex: 0,role: 'RESTORATION',postedAt: date,text: detail.sourcePost.text,source: 'CityPowerJhb',externalId: '123456',effect: { status: 'RESTORED' } }] }],label: 'Attach restoration and recompute outage',affected: { postIds: ['p'],outageIds: [incident.id] } };
const json = (res,status,body) => { res.writeHead(status,{ 'content-type': 'application/json' });res.end(JSON.stringify(body)); };
const requests = [];
const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    if (url.pathname.startsWith('/v1') || url.pathname.startsWith('/admin')) {
      requests.push({ method: req.method,path: url.pathname,query: url.search });
      if (url.pathname === '/v1/refresh') return json(res,200,{ loaded: true,operator,signInAvailable: true,enabled: false,state: 'idle' });
      if (url.pathname === '/v1/municipalities') return json(res,200,{ data: [{ id: 'jhb',code: 'JHB',name: 'Johannesburg',services: ['ELECTRICITY','WATER'],accounts: ['CityPowerJhb'],waterAccounts: ['JHBWater'] }] });
      if (!operator || expire) return json(res,401,{ error: 'operator_required' });
      if (url.pathname.endsWith('/summary')) return json(res,200,summary);
      if (url.pathname.endsWith('/candidates')) return json(res,200,{ data: [incident],total: 1 });
      if (url.pathname.endsWith('/preview')) return json(res,200,preview);
      if (url.pathname.endsWith('/actions')) return json(res,200,{ id: 'action-demo',type: 'JOIN',state: 'APPLIED',result: { message: 'Restoration attached. Validation passed.',incidents: [{ ...incident,status: 'RESTORED' }],remainingConcerns: [] },validation: { passed: true } });
      if (url.pathname === '/admin/review-cases/rc_demo') return json(res,200,detail);
      if (failQueue) return json(res,500,{ error: 'injected_queue_failure' });
      if (slow) await new Promise((r) => setTimeout(r,1000));
      return json(res,200,{ data: [caseRow],total: 1,counts: summary.counts,offset: 0,limit: 50,hasMore: false });
    }
    if (url.pathname === '/missing-image.jpg') { res.writeHead(404);return res.end(); }
    const requested = path.resolve(root,'dist',url.pathname.slice(1));
    assert(requested.startsWith(path.join(root,'dist')));
    const file = url.pathname.includes('.') ? requested : path.join(root,'dist','index.html');
    const mime = { '.js': 'text/javascript','.css': 'text/css','.woff2': 'font/woff2','.woff': 'font/woff','.html': 'text/html' }[path.extname(file)] ?? 'application/octet-stream';
    res.writeHead(200,{ 'content-type': mime });res.end(await readFile(file));
  } catch { res.writeHead(404);res.end('Not found'); }
});
let browser,ws;
const errors = [];
try {
  server.listen(0,'127.0.0.1');await new Promise((r) => server.once('listening',r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log('Fixture server ready');
  const port = 9450 + Math.floor(Math.random()*100);
  browser = spawn(process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--no-first-run',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--window-size=1440,1000','about:blank'],{ stdio: 'ignore',windowsHide: true });
  console.log(`Isolated browser PID ${browser.pid ?? 'unavailable'}, debugging port ${port}`);
  await writeFile(path.join(profile,'test-process.json'),JSON.stringify({ pid: browser.pid,port }));
  browser.on('error',(e) => errors.push(e.message));
  let page;
  for (let i = 0;i < 50 && !page;i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json`,{ signal: AbortSignal.timeout(500) })).json()).find((p) => p.type === 'page'); } catch {} await new Promise((r) => setTimeout(r,200)); }
  assert(page,'Browser did not start. Set BROWSER to your Chromium executable.');
  ws = new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject) => { const timer = setTimeout(() => reject(new Error('Browser WebSocket did not open')),5000);ws.onopen = () => { clearTimeout(timer);resolve(); };ws.onerror = () => { clearTimeout(timer);reject(new Error('Browser WebSocket failed')); }; });
  let id = 0;const pending = new Map();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data);if (m.id) pending.get(m.id)?.(m);else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); };
  const send = (method,params = {}) => new Promise((resolve,reject) => { const n = ++id;const timeout = setTimeout(() => { pending.delete(n);reject(new Error(`CDP timeout: ${method}`)); },10000);pending.set(n,(m) => { clearTimeout(timeout);pending.delete(n);m.error ? reject(new Error(m.error.message)) : resolve(m.result); });ws.send(JSON.stringify({ id: n,method,params })); });
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate',{ expression,returnByValue: true,awaitPromise: true });if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);return r.result?.value; };
  const until = async (expression) => { for (let i = 0;i < 60;i++) { if (await evaluate(`Boolean(${expression})`)) return;await new Promise((r) => setTimeout(r,100)); }throw new Error(`UI condition timed out: ${expression}`); };
  const click = (label) => evaluate(`(() => { const e = [...document.querySelectorAll('button,a')].find((e) => e.textContent.trim() === ${JSON.stringify(label)});if (!e) throw new Error('Missing control');e.click(); })()`);
  const screenshot = async (name) => { const { data } = await send('Page.captureScreenshot',{ format: 'png',captureBeyondViewport: false });await writeFile(path.join(artifacts,`${name}.png`),Buffer.from(data,'base64')); };
  const noOverflow = async () => assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth + 1'),false,'Horizontal page overflow');
  await send('Runtime.enable');await send('Page.enable');
  await send('Page.navigate',{ url: `${base}/review` });
  await until("document.querySelector('.review-row')");await noOverflow();await screenshot('review-desktop');
  assert(requests.some((r) => r.path === '/admin/review-cases' && r.query.includes('service=ALL')));
  assert.equal(await evaluate("document.querySelector('.review-sources').textContent.includes('JHBWater')"),true);
  console.log('PASS desktop inbox, all-service filters, source health and no overflow');
  await send('Page.navigate',{ url: `${base}/review/rc_demo` });await until("document.querySelector('.review-action-card')");await until("document.body.innerText.includes('Image unavailable here')");await noOverflow();await evaluate("document.querySelector('.review-detail-grid').scrollIntoView({ behavior: 'instant',block: 'start' })");await new Promise((r) => setTimeout(r,100));await screenshot('review-detail-desktop');
  await click('Choose this incident');
  await evaluate("(() => { const fields = document.querySelectorAll('.review-action-card textarea');const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(fields[0],'The utility confirms this restoration.');fields[0].dispatchEvent(new Event('input',{ bubbles: true }));set.call(fields[1],'Power supply restored');fields[1].dispatchEvent(new Event('input',{ bubbles: true })); })()");
  await until("!document.querySelector('.review-action-card button.primary').disabled");await click('Preview this decision');await until("document.body.innerText.includes('Add restoration')");await until("document.querySelector('[aria-label=\"Correction preview\"]')");await evaluate("document.querySelector('.review-preview').scrollIntoView({ behavior: 'instant',block: 'start' })");await new Promise((r) => setTimeout(r,100));await screenshot('review-preview-desktop');
  await click('Attach restoration and recompute outage');await until("document.querySelector('.review-result')");assert.equal(await evaluate("document.querySelector('.review-result').textContent.includes('Validation passed')"),true);
  console.log('PASS source evidence, unavailable image, candidate choice, preview and verified completion');
  await send('Emulation.setDeviceMetricsOverride',{ width: 390,height: 844,deviceScaleFactor: 1,mobile: false });
  await send('Page.navigate',{ url: `${base}/review/rc_demo` });await until("document.querySelector('.review-action-card')");await noOverflow();await screenshot('review-detail-narrow');
  await send('Input.dispatchKeyEvent',{ type: 'keyDown',key: 'Tab',code: 'Tab',windowsVirtualKeyCode: 9 });await send('Input.dispatchKeyEvent',{ type: 'keyUp',key: 'Tab',code: 'Tab',windowsVirtualKeyCode: 9 });
  assert.notEqual(await evaluate('document.activeElement.tagName'),'BODY');
  await evaluate("(() => { const select = document.querySelector('.review-action-card select');select.value = 'READING';select.dispatchEvent(new Event('change',{ bubbles: true })); })()");await until("document.querySelector('.review-fault')");await noOverflow();await evaluate("document.querySelector('.review-fault').scrollIntoView({ behavior: 'instant',block: 'start' })");await send('Input.dispatchKeyEvent',{ type: 'keyDown',key: 'Escape' });await new Promise((r) => setTimeout(r,200));await screenshot('review-editor-narrow');
  console.log('PASS narrow detail/editor layout and keyboard navigation');
  failQueue = true;await send('Page.navigate',{ url: `${base}/review` });await until("document.querySelector('[role=alert]')");assert.equal(await evaluate("document.body.innerText.includes('No issues need your decision')"),false);
  failQueue = false;slow = true;await send('Page.navigate',{ url: `${base}/review` });await until("document.querySelector('.review-row')");slow = false;
  expire = true;await evaluate("window.dispatchEvent(new Event('gridwatch:refreshed'))");await until("document.body.innerText.includes('Sign in to inspect source evidence')");assert.equal(await evaluate("document.querySelector('.review-original') === null"),true);
  await screenshot('review-expired-session-narrow');
  console.log('PASS queue failure, delayed loading and expired-session detail removal');
  expire = false;operator = false;await send('Page.navigate',{ url: `${base}/review` });await until("document.body.innerText.includes('Operator sign-in')");assert.equal(await evaluate("document.querySelector('.review-original') === null"),true);
  assert.deepEqual(errors,[]);console.log(`Screenshots: ${artifacts}`);
  await send('Browser.close').catch(() => {});
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: 99999,method: 'Browser.close' }));
  ws?.close();
  if (browser?.pid && browser.exitCode == null) { await new Promise((r) => setTimeout(r,300));if (browser.exitCode == null) await new Promise((resolve) => execFile('taskkill',['/PID',String(browser.pid),'/T','/F'],{ windowsHide: true,timeout: 5000 },() => resolve())); }
  server.closeAllConnections();await new Promise((r) => server.close(r));
  // This directory was created by mkdtemp under the test-artifacts root; never remove other profiles.
  assert(path.resolve(profile).startsWith(`${path.resolve(artifacts)}${path.sep}`));
  await rm(profile,{ recursive: true,force: true,maxRetries: 4,retryDelay: 300 });
}
