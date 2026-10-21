import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {CookieTransport} from '../src/connectors/cookies.js';import {BilibiliConnector} from '../src/connectors/bilibili.js';import {parsePage,parseListing,parseIssue,parsePull} from '../src/connectors/github-web.js';

test('Cookie transport scopes credentials, strips them for signed GitHub diff downloads, refuses other redirects',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dmc-cookie-'));t.after(()=>rm(dir,{recursive:true,force:true}));const cookieFile=join(dir,'cookies.json');
 await writeFile(cookieFile,JSON.stringify({platforms:{github:[{domain:'github.com',name:'user_session',value:'TEST_SECRET',path:'/',expires:0}],bilibili:[]}}),{mode:0o600});
 const requests=[];const transport=new CookieTransport({cookieFile,intervalMs:0,request:async(url,options)=>{requests.push({url,options});return requests.length===1?new Response('',{status:302,headers:{Location:'https://patch-diff.githubusercontent.com/raw/o/r/pull/1.diff?token=SIGNED_TEST'}}):new Response('diff --git a/a b/a');}});
 await assert.rejects(transport.get('github','https://attacker.test/'),/非平台/);assert.equal(requests.length,0);
 await transport.get('github','https://github.com/o/r/pull/1.diff');assert.equal(requests[0].options.headers.Cookie,'user_session=TEST_SECRET');assert.equal(requests[1].options.headers.Cookie,undefined);
 transport.request=async()=>new Response('',{status:302,headers:{Location:'https://attacker.test/steal'}});
 await assert.rejects(transport.get('github','https://github.com/o/r/pull/1.diff'),/跳转/);assert.ok(!JSON.stringify(transport.status('github')).includes('TEST_SECRET'));
});
test('Bilibili collector paginates roots and all replies, deduplicates pinned roots, rejects partial replies',async()=>{
 const root=(id,count=0)=>({rpid_str:id,rcount:count,content:{message:id},member:{uname:'author'}});
 const calls=[];let partial=false;
 const transport={identities:{},json:async(platform,url)=>{const u=new URL(url);calls.push(u);if(u.pathname.endsWith('/nav'))return {isLogin:true,mid:1,uname:'test'};if(u.pathname.endsWith('/view'))return {aid:100,bvid:'BV1111111111',title:'video',desc:'description'};
 if(u.pathname.endsWith('/reply/reply'))return {page:{size:2,count:3},replies:partial?[]:u.searchParams.get('pn')==='1'?[root('11'),root('12')]:[root('13')]};
 return {page:{size:2,count:6},upper:{top:root('1',3)},replies:u.searchParams.get('pn')==='1'?[root('1',3),root('2')]:[root('3')]};}};
 const connector=new BilibiliConnector(transport);const result=await connector.fetch({target:'BV1111111111'});assert.equal(result.items.length,3);assert.equal(result.items[0].payload.comments.length,3);assert.equal(result.complete,true);assert.equal(calls.filter(u=>u.pathname.endsWith('/reply/reply')).length,2);
 partial=true;await assert.rejects(connector.fetch({target:'BV1111111111'}),/不可见回复/);
});
test('GitHub parsers require authenticated structured pages and distinguish missing comments',()=>{
 assert.throws(()=>parsePage('<html>Sign in</html>'),/登录身份/);
 const html='<meta name="user-login" content="test"><script data-target="react-app.embeddedData">'+JSON.stringify({payload:{issuesIndexContentRoute:{results:[{issue:{number:1}}],pageInfo:{totalPages:1,totalCount:1}}}})+'</script>';
 assert.equal(parseListing(parsePage(html),'issue').total,1);
 const issue={databaseId:10,number:1,title:'one',body:'body',totalCommentsCount:2,timelineItems:{edges:[{node:{__typename:'IssueComment',id:'a',databaseId:2,body:'visible'}}]}};
 const item=parseIssue({payload:{issueViewerRoute:{data:{repository:{issue}}}}},'o/r',{number:1});assert.equal(item.payload.contextComplete,false);assert.equal(item.payload.comments.length,1);
});

test('Bilibili rejects a short page when the declared total is not collected',async()=>{
 const t={identities:{},json:async(_,url)=>url.includes('/nav')?{isLogin:true}:url.includes('/view')?{aid:1,bvid:'BV1111111111'}:{page:{size:20,count:100},replies:[{rpid_str:'1',rcount:0,content:{message:'one'}}]}};
 await assert.rejects(new BilibiliConnector(t).fetch({target:'BV1111111111'}),/总数/);
});
test('GitHub PR pages never claim complete review threads without exhaustion evidence',()=>{
 const payload={pullRequestsLayoutRoute:{pullRequest:{number:1,title:'PR'}}};
 const make=body=>parsePage('<meta name="user-login" content="test"><script data-target="react-app.embeddedData">'+JSON.stringify({payload})+'</script>'+body);
 for(const body of ['', '<div id="pullrequest-1"><div class="comment-body">body</div></div><include-fragment src="/review/thread"></include-fragment>'])assert.equal(parsePull(make(body),'o/r',{number:1,commentCount:0}).payload.contextComplete,false);
});

test('Bilibili preserves root and reply images, handles image-only roots and does not download images during collection',async()=>{
 const photo=id=>({img_src:`http://i0.hdslb.com/bfs/new_dyn/${id}.png`,img_width:100,img_height:80,img_size:12});
 const root={rpid_str:'root',rcount:1,content:{message:'',pictures:[photo('root')]}};
 const urls=[],transport={identities:{},json:async(_,url)=>{urls.push(url);if(url.includes('/nav'))return {isLogin:true};if(url.includes('/view'))return {aid:1,bvid:'BV1111111111'};if(url.includes('/reply/reply'))return {page:{size:20,count:1},replies:[{rpid_str:'child',parent_str:'root',content:{message:'配图',pictures:[photo('child')]}}]};return {page:{size:20,count:2},replies:[root]};}};
 const data=await new BilibiliConnector(transport).fetch({target:'BV1111111111'}),item=data.items[0];
 assert.equal(item.title,'图片评论');assert.equal(item.body,'');assert.equal(item.payload.images[0].url,'https://i0.hdslb.com/bfs/new_dyn/root.png');
 assert.equal(item.payload.comments[0].images[0].url,'https://i0.hdslb.com/bfs/new_dyn/child.png');assert.ok(urls.every(url=>new URL(url).hostname==='api.bilibili.com'));
});
