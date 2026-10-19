import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubConnector } from '../src/connectors/github.js';

test('GitHub follows Link pagination and keeps PR namespace separate from issue',async()=>{
  const seen=[];
  const request=async url=>{
    seen.push(url);const path=new URL(url).pathname;
    if(path.endsWith('/issues'))return new Response(JSON.stringify([{id:10,number:1,title:'issue',body:'text',updated_at:'2026-01-02T00:00:00Z',html_url:'https://github.com/o/r/issues/1',state:'open',user:{login:'a'},labels:[]}]),{headers:{link:'<https://api.github.com/repos/o/r/issues?page=2>; rel="next"'}});
    if(path.endsWith('/comments'))return new Response('[]');
    throw new Error(url);
  };
  const connector=new GitHubConnector({request:async url=>url.includes('page=2')?new Response('[]'):request(url)});
  const result=await connector.fetch({target:'o/r',types:['issue']});assert.equal(result.complete,true);assert.equal(result.items[0].remoteId,'issue:10');assert.equal(result.items[0].payload.number,1);assert.equal(result.items[0].updatedAt,'2026-01-02T00:00:00Z');
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

test('GitHub API collects closed issues and merged PRs across pages with normalized state',async()=>{
  const calls=[],pr={updated_at:'2026-10-19T02:00:00Z',state:'closed',merged:true,merged_at:'2026-10-19T00:00:00Z',head:{sha:'head'},base:{sha:'base'},changed_files:0};
  const connector=new GitHubConnector({request:async url=>{
    const parsed=new URL(url);calls.push(parsed);
    if(parsed.pathname.endsWith('/issues'))return jsonResponse(parsed.searchParams.has('page')?[{id:20,number:2,title:'merged PR',state:'closed',pull_request:{}}]:[{id:10,number:1,title:'closed issue',state:'closed'}],parsed.searchParams.has('page')?{}:{link:'<https://api.github.com/repos/o/r/issues?state=all&page=2>; rel="next"'});
    if(parsed.pathname.endsWith('/pulls/2'))return jsonResponse(pr);
    return jsonResponse([]);
  }});
  const result=await connector.fetch({target:'o/r',types:['issue','pr']});assert.equal(result.items.length,2);
  assert.equal(result.items[0].payload.state,'closed');assert.equal(result.items[1].payload.state,'merged');assert.equal(result.items[1].payload.merged,true);assert.equal(result.items[1].payload.mergedAt,pr.merged_at);
  assert.equal(result.items[1].updatedAt,pr.updated_at);assert.equal(result.items[1].remoteId,'pr:20');assert.ok(calls.filter(url=>url.pathname.endsWith('/issues')).every(url=>url.searchParams.get('state')==='all'));
});
function jsonResponse(data,headers={}){return new Response(JSON.stringify(data),{headers});}
test('incomplete PR files retain state for collection and explicitly prohibit automated review',async()=>{
  const connector=new GitHubConnector({request:async url=>new URL(url).pathname.endsWith('/pulls/2')?jsonResponse({state:'closed',merged:false,head:{sha:'h'},base:{sha:'b'},changed_files:4}):jsonResponse([])});
  const result=await connector.readDiscussion({target:'o/r'},2,'pr',{issue:{id:20,number:2,title:'large PR',state:'closed'}});
  assert.equal(result.payload.state,'closed');assert.equal(result.payload.contextComplete,false);assert.match(result.payload.contextLimit,/不执行自动审查/);
});
test('GitHub release detail uses tag endpoint and rejects incomplete pagination',async()=>{
  const connector=new GitHubConnector({request:async url=>{assert.equal(new URL(url).pathname,'/repos/o/r/releases/tags/v%2F1');return jsonResponse({id:10,name:'release',tag_name:'v/1',body:'notes',updated_at:'2026-10-18T00:00:00Z'});}});
  const release=await connector.getItem({target:'o/r'},{kind:'release',payload:{tag:'v/1'}});assert.equal(release.remoteId,'release:10');assert.equal(release.updatedAt,'2026-10-18T00:00:00Z');
  const broken=new GitHubConnector({maxPages:1,request:async()=>jsonResponse([],{link:'<https://api.github.com/repos/o/r/issues?page=2>; rel="next"'})});await assert.rejects(broken.fetch({target:'o/r',types:['issue']}),/分页/);
});
