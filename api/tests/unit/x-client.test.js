import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTimelinePage } from '../../src/modules/ingestion/x.client.js';

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
});
