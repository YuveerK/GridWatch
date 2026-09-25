import { describe, expect, it } from 'vitest';
import { extensionsGroupKey } from '../../src/lib/gis-import.js';
import { baseNormalize } from '../../src/lib/normalize.js';

describe('suburb extension groups', () => {
  it('treats "Willowbrook Extensions" as the official parent Willowbrook', () => {
    expect(extensionsGroupKey('Willowbrook')).toBe(baseNormalize('Willowbrook Extensions'));
    expect(extensionsGroupKey('Willowbrook')).toBe(baseNormalize('Willowbrook Extension'));
  });
});
