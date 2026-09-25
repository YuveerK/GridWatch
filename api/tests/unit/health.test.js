import { describe, expect, it } from 'vitest';
import { formatHealth } from '../../src/modules/processing/health.js';

describe('source health', () => {
  it('reports every active account', () => {
    const text = formatHealth({
      accounts: [
        { displayName: 'CityPowerJhb', serviceType: 'ELECTRICITY', active: true, lastPoll: '2026-09-24T16:58:00.000Z', lastNewPost: '2026-09-24T15:25:00.000Z', latestExternalId: '1', backlog: 0, errors: 0, openReviews: 15 },
        { displayName: 'CityTshwane', serviceType: 'ELECTRICITY', active: true, lastPoll: '2026-09-24T16:58:00.000Z', lastNewPost: null, latestExternalId: '2', backlog: 0, errors: 0, openReviews: 6 },
        { displayName: 'JHBWater', serviceType: 'WATER', active: true, lastPoll: '2026-09-24T16:58:00.000Z', lastNewPost: null, latestExternalId: '3', backlog: 0, errors: 0, openReviews: 0 },
      ],
      pipeline: { cycle: 'COMPLETE', leaseHeld: false, unprocessed: 0, stuck: 0 },
      activity: { posts: 4, opened: 1, updated: 2, geminiCalls: 4, inputTokens: 1000, outputTokens: 200, model: 'gemini-3.5-flash-lite' },
    });
    expect(text).toContain('CityPowerJhb / ELECTRICITY');
    expect(text).toContain('CityTshwane / ELECTRICITY');
    expect(text).toContain('JHBWater / WATER');
    expect(text).toContain('latest cycle        COMPLETE');
    expect(text).toContain('Gemini calls        4');
  });
});