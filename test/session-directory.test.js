import test from 'node:test';
import assert from 'node:assert/strict';
import { watchSessionDirectory } from '../src/session-directory.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function directory(refresh) {
 let snapshot={phase:'ready',ids:[],byId:{}},calls=0;const listeners=new Set();
 const update=ids=>{snapshot={phase:'ready',ids,byId:Object.fromEntries(ids.map(id=>[id,{id}]))};for(const listener of listeners)listener();};
 const sessions={list:{getSnapshot:()=>snapshot,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}},refresh:async()=>{calls++;await refresh({update,calls});}};
 return {sessions,update,get calls(){return calls;},get ids(){return snapshot.ids;},get listeners(){return listeners.size;}};
}
test('restores existing cold identities and recovers a late removed frame without creating sessions',async()=>{
 const id='dmc-original',host=directory(async({update,calls})=>{if(calls===1)update([]);else update([id]);});
 const stop=watchSessionDirectory(host.sessions,[id]);await settle();assert.equal(host.calls,2);assert.deepEqual(host.ids,[id]);
 host.update([]);await settle();assert.equal(host.calls,3);assert.deepEqual(host.ids,[id]);stop();assert.equal(host.listeners,0);
 host.update([]);await settle();assert.equal(host.calls,3);
});
test('missing or unavailable cold rows do not cause repeated refreshes on unchanged snapshots',async()=>{
 const host=directory(async()=>{});const stop=watchSessionDirectory(host.sessions,['missing']);await settle();assert.equal(host.calls,2);
 for(let i=0;i<5;i++)host.update([]);await settle();assert.equal(host.calls,2);stop();
 let errors=0;const failing=directory(async()=>{throw new Error('host unavailable');});const unwatch=watchSessionDirectory(failing.sessions,['cold'],()=>{errors++;});await settle();assert.equal(errors,1);assert.equal(failing.calls,1);unwatch();
});

test('plugin lifetime sync restores work completed after the view leaves, without refreshing unchanged inventories',async()=>{
 const { syncSessionDirectory }=await import('../src/session-directory.js');const host=directory(async({update})=>update(['original-id']));let finished=[];
 const sync=syncSessionDirectory(host.sessions,async()=>({sessionIds:finished}),{pollMs:0});await sync.pull();assert.equal(host.calls,0);
 finished=['original-id'];await sync.pull();await settle();assert.equal(host.calls,1);assert.deepEqual(host.ids,['original-id']);
 for(let i=0;i<3;i++)await sync.pull();await settle();assert.equal(host.calls,1);
 sync.dispose();host.update([]);await sync.pull();await settle();assert.equal(host.calls,1);
});

test('inventory failure keeps the prior watcher and disposal ignores a late inventory response',async()=>{
 const { syncSessionDirectory }=await import('../src/session-directory.js');const host=directory(async({update})=>update(['saved']));let mode='ready',release,errors=0;
 const deferred=new Promise(resolve=>{release=resolve;});
 const sync=syncSessionDirectory(host.sessions,async()=>{if(mode==='error')throw new Error('temporary directory error');if(mode==='late')return deferred;return {sessionIds:['saved']};},{pollMs:0,onError:()=>{errors++;}});
 await sync.pull();await settle();assert.deepEqual(host.ids,['saved']);
 mode='error';await sync.pull();assert.equal(errors,1);host.update([]);await settle();assert.deepEqual(host.ids,['saved']);assert.equal(host.calls,2);
 mode='late';const pending=sync.pull();await Promise.resolve();sync.dispose();release({sessionIds:['late-id']});await pending;await settle();assert.equal(host.listeners,0);assert.equal(host.calls,2);
});
