import { afterEach, describe, expect, it, vi } from 'vitest';
import { XNetworkError, XRateLimitError, fetchTimelinePage } from '../../src/modules/ingestion/x.client.js';

afterEach(() => vi.unstubAllGlobals());

describe('X timeline request', () => {
  it('asks only for new posts and leaves out retweets and replies (we pay per post returned)', async () => {
    let requested = '';
    vi.stubGlobal('fetch', async (url) => {
      requested = String(url);
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [], meta: {} }) };
    });
    await fetchTimelinePage({ userId: '337882328', sinceId: '2101118656755183924' });
    const q = new URL(requested).searchParams;
    expect(q.get('since_id')).toBe('2101118656755183924');
    expect(q.get('exclude')).toBe('retweets,replies');
    expect(requested).toContain('/users/337882328/tweets');
  });

  it('returns posts with their media', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        data: [{ id: '1', text: 'x', attachments: { media_keys: ['m1'] } }],
        includes: { media: [{ media_key: 'm1', type: 'photo', url: 'https://pbs.twimg.com/a.jpg' }] },
        meta: { next_token: null },
      }),
    }));
    const page = await fetchTimelinePage({ userId: '1' });
    expect(page.posts[0].media[0].url).toContain('a.jpg');
  });

  describe('when the internet drops', () => {
    const blip = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const ok = { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [{ id: '9', text: 'hi' }], meta: {} }) };

    it('tries once more after a network blip and carries on as normal', async () => {
      let calls = 0;
      vi.stubGlobal('fetch', async () => (++calls === 1 ? Promise.reject(blip()) : ok));
      const page = await fetchTimelinePage({ userId: '1' }, { retryDelayMs: 0 });
      expect(calls).toBe(2);
      expect(page.posts).toHaveLength(1);
    });

    it('gives a clear message if it still cannot reach X, after exactly one retry', async () => {
      let calls = 0;
      vi.stubGlobal('fetch', async () => (calls++, Promise.reject(blip())));
      const err = await fetchTimelinePage({ userId: '1' }, { retryDelayMs: 0 }).catch((e) => e);
      expect(calls).toBe(2);
      expect(err).toBeInstanceOf(XNetworkError);
      expect(err.message).toBe("Couldn't reach X. Check your internet connection and try again.");
      expect(err.reason).toBe('ECONNRESET');
    });

    it('also retries a timeout', async () => {
      let calls = 0;
      vi.stubGlobal('fetch', async () => (++calls === 1 ? Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })) : ok));
      await fetchTimelinePage({ userId: '1' }, { retryDelayMs: 0 });
      expect(calls).toBe(2);
    });

    it('never retries an answer from X: rate limits, bad keys and server errors are final', async () => {
      let calls = 0;
      vi.stubGlobal('fetch', async () => (calls++, { ok: false, status: 401, headers: new Headers(), text: async () => 'Unauthorized' }));
      await expect(fetchTimelinePage({ userId: '1' }, { retryDelayMs: 0 })).rejects.toThrow('X API 401');
      expect(calls).toBe(1);

      calls = 0;
      vi.stubGlobal('fetch', async () => (calls++, { ok: false, status: 429, headers: new Headers(), text: async () => '' }));
      await expect(fetchTimelinePage({ userId: '1' }, { retryDelayMs: 0 })).rejects.toBeInstanceOf(XRateLimitError);
      expect(calls).toBe(1);
    });
  });
});
