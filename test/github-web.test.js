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
  assert.deepEqual(result.metadata,{issues:1,prs:1,releases:1,limitedContexts:1,releaseAccess:'cookie',releaseFallbackReason:null});
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
  let item=service.items(saved.id,{}).items[0];assert.equal(item.readVersion,item.version);assert.equal(service.runs(service.items(saved.id,{}).items[0].id,{}).total,0);
  const baseline=item.version;await service.refresh(saved.id,{organize:false});assert.equal(service.items(saved.id,{}).items[0].version,baseline);
  notes='<p>Updated notes</p>';await service.refresh(saved.id,{organize:false});item=service.items(saved.id,{}).items[0];assert.notEqual(item.readVersion,item.version);assert.equal(service.items(saved.id,{}).items.length,1);
  const version=item.version;broken=true;assert.equal((await service.refresh(saved.id,{organize:false})).fetched,false);assert.equal(service.items(saved.id,{}).items[0].version,version);
});

const publicHTML=html=>html.replace('<meta name="user-login" content="test">','');
async function cookieConnector(t,request,{cookies=true}={}){
  const dir=await mkdtemp(join(tmpdir(),'dmc-release-fallback-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const cookieFile=join(dir,'cookies.json');
  await writeFile(cookieFile,JSON.stringify({platforms:{github:cookies?[{domain:'github.com',name:'user_session',value:'TEST_SECRET',path:'/',expires:0}]:[]}}),{mode:0o600});
  const transport=new CookieTransport({cookieFile,intervalMs:0,request});
  transport.identities.github={name:'old-login'};
  return new GitHubWebConnector(transport);
}

test('Release falls back on 401, same-origin login redirect, missing login meta or expired Cookie, and anonymous requests carry no credentials',async t=>{
  for(const mode of ['401','login-redirect','no-login','missing-cookie'])await t.test(mode,async t=>{
    const calls=[];const connector=await cookieConnector(t,async(url,options)=>{
      const cookie=Object.hasOwn(options.headers,'Cookie');calls.push({url,cookie});
      assert.equal(options.headers.Authorization,undefined);assert.equal(options.redirect,'manual');
      if(cookie){
        if(mode==='401')return new Response('',{status:401});
        if(mode==='login-redirect')return new Response('',{status:302,headers:{Location:'https://github.com/login?return_to=%2Fo%2Fr%2Freleases'}});
        return new Response(publicHTML(listing()));
      }
      assert.equal(options.headers.Cookie,undefined);assert.equal(new URL(url).origin,'https://github.com');
      return new Response(publicHTML(new URL(url).pathname==='/o/r/releases'?listing():detail()));
    },{cookies:mode!=='missing-cookie'});
    const batch=await connector.fetch(source);
    assert.equal(batch.metadata.releaseAccess,'public');assert.ok(batch.metadata.releaseFallbackReason);assert.equal(batch.items.length,1);
    assert.equal(connector.status().identity,null);assert.match(connector.status().reason,/Cookie需更新/);
    assert.equal(calls.filter(call=>!call.cookie).length,3);assert.equal(calls.filter(call=>call.cookie).length,mode==='missing-cookie'?0:1);
    assert.deepEqual(await connector.getItem(source,batch.items[0]),batch.items[0]);
  });
});

test('Release authentication loss after details discards Cookie rows and restarts the entire public listing and detail batch',async t=>{
  const seen=[];const connector=await cookieConnector(t,async(url,options)=>{
    const path=new URL(url).pathname,authenticated=Object.hasOwn(options.headers,'Cookie');seen.push({path,authenticated});
    if(path==='/o/r/releases')return new Response(authenticated?listing(['v1','v2']):publicHTML(listing(['v1','v3'])));
    if(authenticated&&path.endsWith('/v2'))return new Response('',{status:401});
    const tag=path.split('/tag/')[1];return new Response(authenticated?detail(tag,'<p>Cookie notes</p>'):publicHTML(detail(tag,'<p>Public notes</p>')));
  });
  const batch=await connector.fetch(source);
  assert.deepEqual(batch.items.map(item=>item.payload.tag),['v1','v3']);assert.ok(batch.items.every(item=>item.body==='Public notes'));
  assert.deepEqual(seen.filter(call=>!call.authenticated).map(call=>call.path),['/o/r/releases','/o/r/releases/tag/v1','/o/r/releases/tag/v3','/o/r/releases']);
  assert.equal(batch.metadata.releaseAccess,'public');assert.equal(connector.status().identity,null);
});

test('Release does not use anonymous fallback for rate limits, network failures, malformed authenticated pages or other redirects',async t=>{
  const failures=[()=>new Response('',{status:429}),()=>new Response('',{status:403}),()=>new Response('',{status:404}),()=>new Response('',{status:302,headers:{Location:'https://attacker.test/login'}}),()=>new Response('',{status:302,headers:{Location:'https://github.com/o/r/tags'}}),()=>new Response(releaseHTML('Changed structure')),()=>{throw new Error('network timeout');}];
  for(const fail of failures){let calls=0;const connector=await cookieConnector(t,async(url,options)=>{calls++;assert.ok(options.headers.Cookie);return fail();});await assert.rejects(connector.fetch(source));assert.equal(calls,1);}
});

test('Public Release fallback rejects private or login responses, arbitrary redirects and incomplete pagination',async t=>{
  for(const failure of [()=>new Response('',{status:404}),()=>new Response('',{status:401}),()=>new Response('<title>Sign in</title><form action="/session"></form>'),()=>new Response('',{status:302,headers:{Location:'https://attacker.test/steal'}}),()=>new Response(publicHTML(listing(['v1'],'https://attacker.test/o/r/releases?page=2')))]){
    let calls=0;const connector=await cookieConnector(t,async(url,options)=>{calls++;return options.headers.Cookie?new Response('',{status:401}):failure();});
    await assert.rejects(connector.fetch(source));assert.equal(calls,2);assert.equal(connector.status().identity,null);
  }
});

test('Anonymous transport is limited to GitHub Release HTML paths and cannot be used for Issue, API or another platform',async()=>{
  let calls=0;const transport=new CookieTransport({intervalMs:0,request:async()=>{calls++;return new Response('');}});
  for(const [platform,url] of [['github','https://github.com/o/r/issues'],['github','https://api.github.com/repos/o/r/releases'],['bilibili','https://api.bilibili.com/o/r/releases'],['github','https://github.com/o/r/releases/latest']])await assert.rejects(transport.get(platform,url,{anonymous:true}));
  assert.equal(calls,0);
});

test('Mixed source keeps Issue/PR authenticated and failed Issue does not commit an otherwise successful public Release baseline',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dmc-release-mixed-'));const store=await new Store(dir).start();const calls=[];
  const connector=await cookieConnector(t,async(url,options)=>{
    const parsed=new URL(url);calls.push({path:parsed.pathname,cookie:Boolean(options.headers.Cookie)});
    if(options.headers.Cookie)return new Response('',{status:401});
    assert.ok(parsed.pathname.startsWith('/o/r/releases'));return new Response(publicHTML(parsed.pathname==='/o/r/releases'?listing():detail()));
  });
  const service=new ConsoleService({store,connectors:{github:connector},executor:{},workspaces:{resolve:async id=>({id})}});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  const saved=await service.saveSource({...source,types:['release','issue'],workspaceId:'workspace',name:'Mixed source',platform:'github'});
  assert.equal((await service.refresh(saved.id,{organize:false})).fetched,false);assert.equal(service.source(saved.id).initialized,false);assert.equal(service.items(saved.id,{}).items.length,0);
  assert.equal(calls.at(-1).path,'/o/r/issues');assert.equal(calls.at(-1).cookie,true);assert.equal(service.source(saved.id).metadata,undefined);
});

test('Public fallback preserves first-read baseline and access metadata, and a later authenticated refresh restores verified identity',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dmc-release-public-baseline-'));const store=await new Store(dir).start();let authenticated=false;
  const connector=await cookieConnector(t,async(url,options)=>{
    if(options.headers.Cookie&&!authenticated)return new Response('',{status:401});
    const html=new URL(url).pathname==='/o/r/releases'?listing():detail();return new Response(options.headers.Cookie?html:publicHTML(html));
  });
  const service=new ConsoleService({store,connectors:{github:connector},executor:{},workspaces:{resolve:async id=>({id})}});
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  const saved=await service.saveSource({...source,workspaceId:'workspace',name:'Public source',platform:'github'});
  assert.equal((await service.refresh(saved.id,{organize:false})).fetched,true);
  let savedSource=service.source(saved.id),item=service.items(saved.id,{}).items[0];assert.equal(savedSource.metadata.releaseAccess,'public');assert.equal(savedSource.fetchError,null);assert.equal(savedSource.connection.identity,null);assert.equal(item.version,item.readVersion);assert.equal(service.runs(item.id,{}).total,0);
  const version=item.version;authenticated=true;await service.refresh(saved.id,{organize:false});savedSource=service.source(saved.id);
  assert.equal(savedSource.metadata.releaseAccess,'cookie');assert.equal(savedSource.metadata.releaseFallbackReason,null);assert.equal(savedSource.connection.identity.name,'test');assert.equal(service.items(saved.id,{}).items[0].version,version);
});
