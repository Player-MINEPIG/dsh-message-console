import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubConnector } from '../src/connectors/github.js';

test('GitHub follows Link pagination and keeps PR namespace separate from issue',async()=>{
  const seen=[];
  const request=async url=>{
    seen.push(url);const path=new URL(url).pathname;
    if(path.endsWith('/issues'))return new Response(JSON.stringify([{id:10,number:1,title:'issue',body:'text',html_url:'https://github.com/o/r/issues/1',state:'open',user:{login:'a'},labels:[]}]),{headers:{link:'<https://api.github.com/repos/o/r/issues?page=2>; rel="next"'}});
    if(path.endsWith('/comments'))return new Response('[]');
    throw new Error(url);
  };
  const connector=new GitHubConnector({request:async url=>url.includes('page=2')?new Response('[]'):request(url)});
  const result=await connector.fetch({target:'o/r',types:['issue']});assert.equal(result.complete,true);assert.equal(result.items[0].remoteId,'issue:10');assert.equal(result.items[0].payload.number,1);
});
test('GitHub rate limiting exposes retry delay and refuses hostile Link origin',async()=>{
  const connector=new GitHubConnector({request:async()=>new Response('{}',{status:429,headers:{'retry-after':'120'}})});
  await assert.rejects(connector.call('/repos/o/r/issues'),error=>error.retryMs===120000);
  await assert.rejects(connector.call('https://evil.example/path'),/跨站/);
});
test('GitHub publication binds review to head SHA and only emits COMMENT',async()=>{
  let sent;
  const connector=new GitHubConnector({account:'test',request:async(url,options)=>{sent={url,...options};return new Response(JSON.stringify({id:42,html_url:'https://github.com/o/r/pull/1'}),{status:201});}});
  const result=await connector.publish({target:'o/r'},{kind:'pr',payload:{number:1,head:'sha'},url:'https://github.com/o/r/pull/1'},{body:'Finding'},{actionId:'action'});
  assert.equal(result.remoteId,'42');const body=JSON.parse(sent.body);assert.equal(body.event,'COMMENT');assert.equal(body.commit_id,'sha');assert.match(body.body,/dsh-message-console:action/);
});
