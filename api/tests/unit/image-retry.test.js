import { describe, expect, it } from 'vitest';
import { fetchImageWithRetry, isTransientImageError } from '../../src/modules/ai/extraction.service.js';

const URL_OK = 'https://pbs.twimg.com/media/abc.jpg';
const okResponse = () => ({ ok: true, status: 200, headers: { get: (h) => (h === 'content-type' ? 'image/jpeg' : null) }, body: (async function* () { yield Buffer.from('img'); })() });
const failing = (status) => ({ ok: false, status, headers: { get: () => null } });
/** A fetch that answers with each step in turn: an Error means "the network threw", a function builds the response. */
const sequence = (...steps) => {
  let i = 0;
  const fn = async () => {
    const s = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (s instanceof Error) throw s;
    return s();
  };
  fn.calls = () => i;
  return fn;
};
const noWait = () => { const waits = []; const sleep = async (ms) => { waits.push(ms); }; sleep.waits = waits; return sleep; };

describe('which picture failures are worth another try', () => {
  it('a picture not published yet, a server hiccup, a rate limit and a network error are; a refusal, a wrong host and a huge file are not', () => {
    for (const m of ['image 404', 'image 429', 'image 500', 'image 503', 'fetch failed', 'The operation was aborted due to timeout']) expect(isTransientImageError(new Error(m))).toBe(true);
    for (const m of ['image 403', 'image 401', 'untrusted image host', 'image too large']) expect(isTransientImageError(new Error(m))).toBe(false);
  });
});

describe('fetching a picture with retries', () => {
  it('a picture that is not there yet on the first try is fetched on the second', async () => {
    const f = sequence(() => failing(404), okResponse);
    const sleep = noWait();
    const part = await fetchImageWithRetry(URL_OK, { fetchFn: f, sleep });
    expect(part.inlineData.mimeType).toBe('image/jpeg');
    expect(f.calls()).toBe(2);
    expect(sleep.waits).toEqual([1500]);
  });
  it('a network blip is retried, and it gives up after three tries with the last error', async () => {
    const f = sequence(new Error('fetch failed'));
    const sleep = noWait();
    await expect(fetchImageWithRetry(URL_OK, { fetchFn: f, sleep })).rejects.toThrow('fetch failed');
    expect(f.calls()).toBe(3);
    expect(sleep.waits).toEqual([1500, 4000]);
  });
  it('a real refusal is not retried, and neither is a wrong host', async () => {
    const f = sequence(() => failing(403));
    await expect(fetchImageWithRetry(URL_OK, { fetchFn: f, sleep: noWait() })).rejects.toThrow('image 403');
    expect(f.calls()).toBe(1);
    const g = sequence(okResponse);
    await expect(fetchImageWithRetry('https://evil.example.com/a.jpg', { fetchFn: g, sleep: noWait() })).rejects.toThrow('untrusted image host');
    expect(g.calls()).toBe(0);
  });
});
