import test from 'node:test';
import assert from 'node:assert/strict';
import { contains, quoted } from '../bin/lab-expectations.mjs';
// The judge must quote the reply. With a two-fact Expect line it often joins two exact pieces with an ellipsis,
// and the strict "the quote is in the reply" rule then failed a correct answer.
const reply='A declined request holds nothing: the host said no, so the nights are free again. The guest is refunded in full, because a pending reservation is always refunded in full.';
test('a quote copied from the reply is accepted',()=>{
 assert.ok(quoted(reply,'the nights are free again'));assert.ok(quoted(reply,'The guest is  refunded in full,'));
});
test('a quote made of exact pieces joined with an ellipsis is accepted when every piece is in the reply, in order',()=>{
 const stitched='A declined request holds nothing … The guest is refunded in full';
 assert.equal(contains(reply,stitched),false,'the strict rule refuses it: this was the false failure');
 assert.ok(quoted(reply,stitched));assert.ok(quoted(reply,'the nights are free again... refunded in full'));assert.ok(quoted(reply,'…the host said no'));
});
test('pieces of a list quoted on separate lines are accepted when each is in the reply, in order',()=>{
 const list='A hold keeps two things for the guest (glossary, **Hold**):\n1. **The nights**: while the hold is active, no one else can reserve them.\n2. **The price**: an active hold locks the quoted price.';
 const picked='A hold keeps two things for the guest (glossary, **Hold**):\n\n1. **The nights**\n\n2. **The price**';
 assert.equal(contains(list,picked),false);assert.ok(quoted(list,picked));
 assert.equal(quoted(list,'1. **The nights**\n\n2. **The deposit**'),false);
});
test('a piece that is not in the reply, pieces out of order, and an empty quote are still refused',()=>{
 assert.equal(quoted(reply,'the nights are free again … the guest is charged a fee'),false);
 assert.equal(quoted(reply,'The guest is refunded in full … the nights are free again'),false);
 assert.equal(quoted(reply,''),false);assert.equal(quoted(reply,'…'),false);assert.equal(quoted(reply,'holds expire after 24 hours'),false);
});
