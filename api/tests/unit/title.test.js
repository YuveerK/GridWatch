import { describe, expect, it } from 'vitest';
import { titleFor } from '../../src/modules/outages/linker.service.js';

const node = (name, type) => ({ name, type });
const ex = (localities = []) => ({ result: { localities: localities.map((name) => ({ name })) } });

describe('outage titles', () => {
  it('a cable named with a whole sentence does not become the title: the distributor does', () => {
    const facts = { sdcNode: { name: 'Inner City' }, nodes: [node('Central', 'SUBSTATION'), node('Marshall Street East', 'DISTRIBUTOR'), node('cable between Marshall Street East Distributor and the Medium Voltage Chamber', 'CABLE')] };
    expect(titleFor(facts, ex())).toBe('Marshall Street East');
  });
  it('falls back to a cable or other kit when nothing better is named, and never runs long', () => {
    const t = titleFor({ sdcNode: null, nodes: [node('cable between Marshall Street East Distributor and the Medium Voltage Chamber', 'CABLE')] }, ex());
    expect(t.length).toBeLessThanOrEqual(40);
    expect(t.startsWith('cable between')).toBe(true);
  });
  it('a normal substation and suburb title is unchanged', () => {
    expect(titleFor({ sdcNode: null, nodes: [node('Fort', 'SUBSTATION')] }, ex(['Hillbrow']))).toBe('Fort (Hillbrow)');
  });
});
