// DEV TOOL: run the real API with a deliberately SLOW, FAKE fetch cycle (no X calls, no Gemini, no spend).
// Use it to look at the refresh progress UI:  node scripts/dev-slow-refresh.mjs  (API on :4124), then run the client with VITE_API_URL=http://localhost:4124
const { createApp } = await import('../src/app.js');
const { cycle } = await import('../src/modules/processing/cycle.js');
const { createCycle } = await import('../src/modules/processing/cycle.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = createCycle({
  cooldownMs: 0,
  counts: async () => ({ outages: 1, outagePosts: 1 }),
  ingest: async () => { await sleep(2500); return { status: 'SUCCEEDED', postsFetched: 3, postsInserted: 3 }; },
  process: async ({ onStart, onPost }) => { onStart(3); for (let i = 1; i <= 3; i++) { await sleep(2500); onPost({}, i, 3); } return { total: 3 }; },
  sweep: async () => { await sleep(1500); },
});
Object.assign(cycle, { start: fake.start, status: fake.status, runNow: fake.runNow, whenIdle: fake.whenIdle });
createApp().listen(4124);
