import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewQuery,newFault,readingDiff,queryString,timelineChanges } from '../src/lib/review.js';
test('review defaults span both services independently of public context',() => {
  const q = reviewQuery(new URLSearchParams());assert.equal(q.service,'ALL');assert.equal(q.tab,'decision');assert.equal(q.offset,0);
});
test('review URL preserves filters and pagination',() => {
  const q = reviewQuery(new URLSearchParams('service=WATER&source=JHBWater&tab=engineering&offset=50'));assert.equal(q.source,'JHBWater');assert.equal(q.tab,'engineering');assert.match(queryString(q),/offset=50/);
});
test('new sections do not renumber surviving sections',() => {
  assert.equal(newFault({ serviceType: 'WATER',faults: [{ faultIndex: 0 },{ faultIndex: 8 }] }).faultIndex,9);
});
test('reading differences identify edited and removed sections',() => {
  const before = { faults: [{ faultIndex: 0,status: 'UNKNOWN' },{ faultIndex: 7,status: 'UNKNOWN' }] };const after = { faults: [{ faultIndex: 0,status: 'RESTORED' }] };
  assert.deepEqual(readingDiff(before,after).map((r) => r.index),[0,7]);
});

test('timeline preview distinguishes moved, edited and untouched fault contributions',() => {
  const a = { postId: 'a',faultIndex: 0,role: 'UPDATE',effect: { status: 'ACTIVE' } };
  const b = { postId: 'a',faultIndex: 1,role: 'UPDATE',effect: { status: 'ACTIVE' } };
  const c = { postId: 'c',faultIndex: 0,role: 'RESTORATION',effect: { status: 'RESTORED' } };
  const before = [a,b,c];const after = [{ ...a,effect: { status: 'RESTORED' } },b,{ ...c,postId: 'd' }];
  assert.deepEqual(timelineChanges(before,after).map((r) => [r.id,Boolean(r.before),Boolean(r.after)]),[['a:0',true,true],['c:0',true,false],['d:0',false,true]]);
});
