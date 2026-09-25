import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatReviewInspection, suggestedCommands } from '../../src/modules/review/inspect.js';

const detail = {
  id: 'rev1',
  priority: 3,
  reasons: [{ code: 'NEW_NEAR_ACTIVE', detail: 'still live: "Honeydew"' }],
  serviceType: 'ELECTRICITY',
  sourceAccount: 'CityPowerJhb',
  postId: 'post-1',
  externalId: '123',
  publishedAt: '2026-09-23T20:26:00.000Z',
  text: 'Ruimsig Switching Station',
  imageText: null,
  reading: { relevance: 'OUTAGE', status: 'INVESTIGATING', cause: null, restoration_percent: null },
  faultIndex: 0,
  kind: 'UNPLANNED',
  equipment: ['Ruimsig'],
  localities: ['Honeydew'],
  window: null,
  decision: { outcome: 'NEW', reason: 'best candidate below threshold' },
  candidates: [{ id: 'out-1', title: 'Honeydew', status: 'ACTIVE', kind: 'UNPLANNED', score: 0.62, reasons: ['locality overlap 100%'], equipment: ['Ruimsig'], localities: ['Honeydew'], age: '2h after it opened', openedBy: '999' }],
};

describe('review inspection', () => {
  it('shows the candidate score and the reasons it was scored', () => {
    const text = formatReviewInspection(detail);
    expect(text).toContain('score 0.62');
    expect(text).toContain('locality overlap 100%');
    expect(text).toContain('rev1');
  });

  it('prints repair commands and does not run them', () => {
    const text = suggestedCommands(detail);
    expect(text).toContain('node scripts/correct-link.js 123 --join 999');
    expect(text).toContain('no action');
    expect(text).not.toContain('--apply');
    const source = readFileSync(new URL('../../src/modules/review/inspect.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/prisma\.\w+\.(update|delete|create)/);
  });
});
