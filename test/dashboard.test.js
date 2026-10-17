import test from 'node:test';
import assert from 'node:assert/strict';
import { needsHandling, summarizeItems, sourceSummaries, platformSummaries, itemPriority } from '../src/dashboard.js';
const item=(id,extra={})=>({id,sourceId:'a',version:'v2',readVersion:'v1',analyzedVersion:'v2',handling:'none',changedAt:'2026-10-01',...extra});
test('handling counts unique content items across pending states and undismissed drafts, done ignores old analysis',()=>{
 const pending=item('p',{handling:'pending'}),later=item('l',{handling:'later'}),done=item('d',{handling:'done',analysis:{intervention:'human',importance:3}}),draft=item('r'),dismissed=item('x');
 const drafts=[{itemId:'p',status:'ready'},{itemId:'r',status:'blocked'},{itemId:'r',status:'ready'},{itemId:'x',status:'dismissed'}];
 const summary=summarizeItems([pending,pending,later,done,draft,dismissed],drafts);
 assert.equal(summary.total,5);assert.equal(summary.unread,5);assert.equal(summary.handling,3);assert.equal(needsHandling(done),false);
 assert.equal(needsHandling({...done,handling:'done'},[{itemId:'d',status:'ready'}]),true);
});
test('priority is evidence based; stale analysis never becomes a new summary or urgency signal',()=>{
 const stale=item('old',{analyzedVersion:'v1',analysis:{importance:3,urgent:true,urgencyReason:'old',summary:'OLD_SUMMARY',intervention:'human'}});
 assert.equal(itemPriority(stale),0);assert.equal(needsHandling(stale),false);assert.deepEqual(summarizeItems([stale]).summaries,[]);
 assert.equal(itemPriority(item('x',{analysis:{importance:1,urgent:true}})),10);
 assert.equal(itemPriority(item('x',{analysis:{importance:1,urgent:true,urgencyReason:'deadline'}})),13);
});
test('source and platform ordering use content changedAt instead of fetch timestamps and priority first',()=>{
 const state={sources:[{id:'a',platform:'github',fetchedAt:'2099'},{id:'b',platform:'bilibili',fetchedAt:'2000'}],items:[item('a1',{analysis:{importance:2},changedAt:'2026-01-01'}),item('b1',{sourceId:'b',analysis:{importance:1,urgent:true,urgencyReason:'soon'},changedAt:'2026-10-01'})],drafts:[]};
 assert.deepEqual(sourceSummaries(state).map(s=>s.id),['a','b']);assert.deepEqual(sourceSummaries(state,'updated').map(s=>s.id),['b','a']);
 assert.deepEqual(platformSummaries(state).map(s=>s.id),['github','bilibili']);assert.equal(platformSummaries(state).length,2);
});

test('fixed intervention and decision status messages are not advertised as content summaries',()=>{
 const staticItems=[item('guard',{analysis:{summary:'context insufficient',processing:'context-incomplete'}}),item('decision',{analysis:{summary:'no reply',processing:'decision-only'}})];
 assert.equal(summarizeItems(staticItems).analyzed,2);assert.deepEqual(summarizeItems(staticItems).summaries,[]);
});
