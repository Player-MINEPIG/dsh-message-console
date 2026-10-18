import test from 'node:test';
import assert from 'node:assert/strict';
import { needsHandling, summarizeItems, sourceSummaries, platformSummaries, itemPriority, itemStatus, sourceItems, paginateItems } from '../src/dashboard.js';
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

test('item status uses handling before unread and keeps completed, draft and stale-analysis semantics',()=>{
 const read=item('read',{readVersion:'v2'}),unread=item('unread'),handling=item('handling',{handling:'pending'});
 assert.equal(itemStatus(read),'read');assert.equal(itemStatus(unread),'unread');assert.equal(itemStatus(handling),'handling');
 assert.equal(itemStatus({...read,handling:'later'}),'handling');
 assert.equal(itemStatus({...unread,handling:'done',analysis:{intervention:'human'}}),'unread');
 assert.equal(itemStatus(read,[{itemId:read.id,status:'ready'}]),'handling');
 assert.equal(itemStatus(read,[{itemId:read.id,status:'dismissed'}]),'read');
 assert.equal(itemStatus({...read,analysis:{intervention:'human'},analyzedVersion:'v1'}),'read');
 assert.equal(itemStatus({...read,analysis:{intervention:'human'}}),'handling');
});

test('local pagination shows 10 by default, supports 20 and 50, reports ranges and clamps after data shrinks',()=>{
 const rows=Array.from({length:31},(_,index)=>item(String(index+1)));
 const first=paginateItems(rows);assert.equal(first.items.length,10);assert.deepEqual([first.page,first.pageCount,first.start,first.end,first.total],[1,4,1,10,31]);
 const second=paginateItems(rows,2);assert.deepEqual(second.items.map(row=>row.id),rows.slice(10,20).map(row=>row.id));assert.deepEqual([second.start,second.end],[11,20]);
 const last=paginateItems(rows,4);assert.deepEqual(last.items.map(row=>row.id),['31']);assert.deepEqual([last.start,last.end],[31,31]);
 const twenty=paginateItems(rows,2,20);assert.deepEqual([twenty.items.length,twenty.start,twenty.end,twenty.pageCount],[11,21,31,2]);
 assert.equal(paginateItems(rows,1,50).items.length,31);
 assert.deepEqual([paginateItems(rows.slice(0,3),4).page,paginateItems(rows.slice(0,3),4).items.length],[1,3]);
 assert.equal(paginateItems(rows,0).page,1);
 const empty=paginateItems([],4);assert.deepEqual([empty.items.length,empty.start,empty.end,empty.page,empty.pageCount],[0,0,0,1,1]);
 assert.equal(rows.length,31);
});

test('source filtering searches the entire local source before pagination and retains priority ordering without mutating input',()=>{
 const rows=Array.from({length:31},(_,index)=>item(`a${index}`,{title:`Entry ${index}`,body:index===30?'x'.repeat(500)+' FullTextMarker':'plain',readVersion:index%2?'v1':'v2'}));
 const draftItem=rows[20],state={items:[...rows,item('other',{sourceId:'b',title:'FullTextMarker'})],drafts:[{itemId:draftItem.id,status:'blocked'}]};
 assert.deepEqual(sourceItems(state,'a',{query:'fulltextmarker'}).map(row=>row.id),['a30']);
 assert.deepEqual(paginateItems(sourceItems(state,'a',{query:'Entry 3'})).items.map(row=>row.id),['a3','a30']);
 assert.equal(sourceItems(state,'a',{filter:'unread'}).length,15);
 assert.deepEqual(sourceItems(state,'a',{filter:'handling'}).map(row=>row.id),[draftItem.id]);
 assert.equal(sourceItems(state,'a',{query:'   FULLTEXTMARKER  '}).length,1);
 assert.deepEqual(sourceItems(state,'a',{query:'missing'}),[]);assert.deepEqual(sourceItems(state,'empty'),[]);
 assert.equal(state.items[0].id,'a0');assert.equal(state.items.length,32);
 const prioritized={...state,items:[item('new',{changedAt:'2026-10-18'}),item('important',{changedAt:'2026-10-01',analysis:{importance:2}})]};
 assert.deepEqual(sourceItems(prioritized,'a').map(row=>row.id),['important','new']);
});
