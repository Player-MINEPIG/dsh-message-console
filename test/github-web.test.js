import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitHubWebConnector,parsePage,parseReleaseListing,parseRelease} from '../src/connectors/github-web.js';
import {CookieTransport} from '../src/connectors/cookies.js';
import {Store} from '../src/store.js';
import {ConsoleService} from '../src/core.js';

const source={target:'o/r',types:['release']};
const releaseHTML=body=>`<meta name="user-login" content="test"><meta name="route-controller" content="releases"><meta name="octolytics-dimension-repository_nwo" content="o/r">${body}`;
const listing=(tags=['v1'],next=null)=>releaseHTML(tags.length?tags.map(tag=>`<section data-release-anchor="release-${tag}"><a href="/o/r/releases/tag/${encodeURIComponent(tag)}">${tag}</a></section>`).join('')+(next?`<div class="pagination"><a rel="next" href="${next}">Next</a></div>`:'<div class="pagination"><span class="next_page disabled" aria-disabled="true">Next</span></div>'):'<div class="blankslate"><h2>There aren’t any releases here</h2></div>');
const detail=(tag='v1',notes='<p>First paragraph.</p><p>Second paragraph.</p>',extra='')=>releaseHTML(`<meta property="og:url" content="/o/r/releases/tag/${encodeURIComponent(tag)}"><div class="Box"><div class="Box-body"><h1>Release ${tag}</h1><span class="Label">Pre-release</span><relative-time datetime="2026-10-18T00:00:00Z"></relative-time><div class="markdown-body" data-test-selector="body-content">${notes}</div>${extra}</div><include-fragment src="https://github.com/o/r/releases/expanded_assets/${encodeURIComponent(tag)}"></include-fragment></div>`);
const parse=html=>parsePage(html,{structured:false});
function transportFor(resolve){
  const calls=[];
  return {calls,identities:{},status:()=>({ready:true,canPublish:false}),get:async(platform,url,options)=>{
    const parsed=new URL(url);assert.equal(platform,'github');assert.equal(parsed.origin,'https://github.com');assert.equal(options.accept,parsed.pathname.endsWith('.diff')?'text/plain':'text/html');calls.push(parsed.pathname+parsed.search);
    return new Response(await resolve(parsed));
  }};
}

test('Cookie Release collector follows validated pages, deduplicates tags and reads details without React payloads',async()=>{
  const transport=transportFor(url=>{
    if(url.pathname==='/o/r/releases')return url.search?listing(['v1','feature/v2']):listing(['v1'],'/o/r/releases?page=2');
    return detail(decodeURIComponent(url.pathname.split('/tag/')[1]));
  });
  const connector=new GitHubWebConnector(transport),batch=await connector.fetch(source);
  assert.equal(batch.complete,true);assert.equal(batch.metadata.releases,2);assert.equal(batch.metadata.limitedContexts,0);
  assert.deepEqual(batch.items.map(item=>item.remoteId),['release:web-v1','release:web-feature/v2']);
  assert.equal(batch.items[0].body,'First paragraph.\nSecond paragraph.');
  assert.equal(batch.items[0].payload.prerelease,true);assert.equal(batch.items[0].payload.publishedAt,'2026-10-18T00:00:00Z');
  assert.equal(transport.identities.github.name,'test');
  assert.deepEqual(await connector.getItem(source,batch.items[1]),batch.items[1]);
  assert.equal(transport.calls.filter(path=>path==='/o/r/releases/tag/v1').length,1);
});

test('Cookie Release mixes with Issue and PR collection in one complete batch',async()=>{
  const structured=payload=>`<meta name="user-login" content="test"><script data-target="react-app.embeddedData">${JSON.stringify({payload})}</script>`;
  const transport=transportFor(url=>{
    if(url.pathname==='/o/r/releases')return listing();
    if(url.pathname.includes('/releases/tag/'))return detail();
    if(url.pathname==='/o/r/issues')return structured({issuesIndexContentRoute:{results:[{issue:{number:1}}],pageInfo:{totalPages:1,totalCount:1}}});
    if(url.pathname==='/o/r/issues/1')return structured({issueViewerRoute:{data:{repository:{issue:{databaseId:10,number:1,title:'Issue one',body:'issue',totalCommentsCount:0}}}}});
    if(url.pathname==='/o/r/pulls')return structured({repoPullsDashboardContentRoute:{results:[{number:2}],totalPages:1,totalCount:1}});
    if(url.pathname==='/o/r/pull/2')return structured({pullRequestsLayoutRoute:{pullRequest:{number:2,title:'PR two'}}});
    if(url.pathname==='/o/r/pull/2.diff')return 'diff --git a/file b/file';
    throw new Error('Unexpected path');
  });
  const result=await new GitHubWebConnector(transport).fetch({...source,types:['release','issue','pr']});
  assert.deepEqual(result.items.map(item=>item.kind),['release','issue','pr']);
  assert.deepEqual(result.metadata,{issues:1,prs:1,releases:1,limitedContexts:1});
});

test('Release parsing accepts an explicit empty state and rejects missing auth, changed structure and wrong details',()=>{
  assert.deepEqual(parseReleaseListing(parse(listing([])),'o/r'),{rows:[],next:null});
  assert.throws(()=>parsePage(listing().replace('<meta name="user-login" content="test">',''),{structured:false}),/登录身份/);
  assert.throws(()=>parseReleaseListing(parse(releaseHTML('<div>Temporarily unavailable</div>')),'o/r'),/不可识别/);
  assert.throws(()=>parseReleaseListing(parse(listing().replace('content="o/r"','content="o/else"')),'o/r'),/仓库不匹配/);
  assert.throws(()=>parseRelease(parse(detail('v2')),'o/r',{tag:'v1'}),/详情结构/);
  assert.throws(()=>parseRelease(parse(detail().replace('datetime="2026-10-18T00:00:00Z"','')),'o/r',{tag:'v1'}),/详情结构/);
  assert.equal(parseRelease(parse(detail('v1','')),'o/r',{tag:'v1'}).body,'');
  assert.equal(parseRelease(parse(detail().replaceAll('Pre-release','Latest')),'o/r',{tag:'v1'}).payload.prerelease,false);
});

test('Release pagination rejects hostile links, broken next controls, loops and page limit overflow',async()=>{
  for(const next of ['https://attacker.test/o/r/releases?page=2','https://api.github.com/o/r/releases?page=2','/o/other/releases?page=2','/o/r/releases?page=1','/o/r/releases?page=2&token=unexpected']){
    assert.throws(()=>parseReleaseListing(parse(listing(['v1'],next)),'o/r'),/分页地址/);
  }
  assert.throws(()=>parseReleaseListing(parse(listing().replace('class="next_page disabled"','class="missing"').replace('aria-disabled="true"','')),'o/r'),/分页结构/);
  assert.throws(()=>parseReleaseListing(parse(listing().replace('/o/r/releases/tag/v1','https://attacker.test/o/r/releases/tag/v1')),'o/r'),/标签链接/);
  const transport=transportFor(()=>listing(['v1'],'/o/r/releases?page=2'));
  await assert.rejects(new GitHubWebConnector(transport,{maxPages:1}).fetch(source),/分页上限/);
  assert.equal(transport.calls.length,1);
});

test('Release list changes during collection abort the batch instead of committing a partial baseline',async()=>{
  let reads=0;
  const transport=transportFor(url=>url.pathname==='/o/r/releases'?listing(++reads===1?['v1']:['v2','v1']):detail());
  await assert.rejects(new GitHubWebConnector(transport).fetch(source),/采集期间发生变化/);
});

test('Release requests use scoped Cookie transport, keep authentication and cooldown errors, and refuse redirects',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dmc-release-cookie-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const cookieFile=join(dir,'cookies.json');await writeFile(cookieFile,JSON.stringify({platforms:{github:[{domain:'github.com',name:'user_session',value:'TEST_SECRET',path:'/',expires:0}]}}),{mode:0o600});
  const calls=[];const transport=new CookieTransport({cookieFile,intervalMs:0,request:async(url,options)=>{
    calls.push(url);assert.equal(new URL(url).origin,'https://github.com');assert.equal(options.headers.Cookie,'user_session=TEST_SECRET');assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,'manual');
    return new Response(new URL(url).pathname.endsWith('/releases')?listing():detail());
  }});
  assert.equal((await new GitHubWebConnector(transport).fetch(source)).items.length,1);assert.equal(calls.length,3);
  transport.request=async()=>new Response('',{status:429});
  await assert.rejects(new GitHubWebConnector(transport).fetch(source),error=>error.retryMs===30*60_000);
  transport.request=async()=>new Response('',{status:302,headers:{location:'https://github.com/login'}});
  await assert.rejects(new GitHubWebConnector(transport).fetch(source),/跳转/);
});

test('Release first baseline is read, stable refresh stays read, later notes change becomes unread, failed page preserves baseline',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dmc-release-baseline-'));const store=await new Store(dir).start();
  let notes='<p>Original notes</p>',broken=false;
  const connector=new GitHubWebConnector(transportFor(url=>broken?releaseHTML('Unrecognized page'):url.pathname==='/o/r/releases'?listing():detail('v1',notes)));
  const service=new ConsoleService({store,connectors:{github:connector},executor:{},workspaces:{resolve:async id=>({id})}});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  const saved=await service.saveSource({...source,workspaceId:'workspace',name:'Release source',platform:'github'});
  assert.equal((await service.refresh(saved.id,{organize:false})).fetched,true);
  let item=service.view().items[0];assert.equal(item.readVersion,item.version);assert.equal(service.view().runs.length,0);
  const baseline=item.version;await service.refresh(saved.id,{organize:false});assert.equal(service.view().items[0].version,baseline);
  notes='<p>Updated notes</p>';await service.refresh(saved.id,{organize:false});item=service.view().items[0];assert.notEqual(item.readVersion,item.version);assert.equal(service.view().items.length,1);
  const version=item.version;broken=true;assert.equal((await service.refresh(saved.id,{organize:false})).fetched,false);assert.equal(service.view().items[0].version,version);
});
