import test from 'node:test';
import assert from 'node:assert/strict';
import { currentAnalysis, needsHandling, itemPriority, itemStatus } from '../src/dashboard.js';
const item=(id,extra={})=>({id,version:'v2',readVersion:'v1',analyzedVersion:'v2',handling:'none',...extra});
test('pending supervision and undismissed drafts require handling, including completed personal status',()=>{
  for(const status of ['pending-supervision','ready','blocked','stale','sending','unknown']) {
    assert.equal(needsHandling(item('a'),[{itemId:'a',status}]),true,status);
    assert.equal(needsHandling(item('a',{handling:'done'}),[{itemId:'a',status}]),true,status);
  }
  for(const status of ['sent','dismissed','superseded']) assert.equal(needsHandling(item('a'),[{itemId:'a',status}]),false,status);
  assert.equal(needsHandling(item('a'),[{itemId:'b',status:'pending-supervision'}]),false);
});
test('priority and handling ignore analysis from another input version',()=>{
  const stale=item('old',{analyzedVersion:'v1',analysis:{importance:3,urgent:true,urgencyReason:'old',intervention:'human'}});
  assert.equal(currentAnalysis(stale),null);assert.equal(itemPriority(stale),0);assert.equal(needsHandling(stale),false);
  assert.equal(itemPriority(item('x',{analysis:{importance:1,urgent:true}})),10);
  assert.equal(itemPriority(item('x',{analysis:{importance:1,urgent:true,urgencyReason:'deadline'}})),13);
});
test('handling precedes unread, with completed personal status suppressing old intervention',()=>{
  const read=item('read',{readVersion:'v2'}),unread=item('unread');
  assert.equal(itemStatus(read),'read');assert.equal(itemStatus(unread),'unread');
  for(const handling of ['pending','later'])assert.equal(itemStatus({...read,handling}),'handling');
  assert.equal(itemStatus({...unread,handling:'done',analysis:{intervention:'human'}}),'unread');
  assert.equal(itemStatus(read,[{itemId:read.id,status:'pending-supervision'}]),'handling');
  assert.equal(itemStatus({...read,analysis:{intervention:'human'},analyzedVersion:'v1'}),'read');
});


test('acknowledged attention suppresses pending state and retained drafts until a new event',()=>{
  const done=item('done',{readVersion:'v2',handling:'done',attentionAcknowledged:true,analysis:{intervention:'human'}}),drafts=[{itemId:'done',status:'ready'}];
  assert.equal(needsHandling(done,drafts),false);assert.equal(itemStatus(done,drafts),'read');
  assert.equal(needsHandling({...done,handling:'pending',attentionAcknowledged:false},drafts),true);
});
