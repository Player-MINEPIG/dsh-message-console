import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubGhConnector } from '../src/connectors/github-gh.js';

const secret = 'TEST_PRIVATE_GH_TOKEN';
const json = data => new Response(JSON.stringify(data));
const source = {target:'o/r',types:['issue','pr','release']};
function fixture(overrides = {}) {
  const calls = [], processes = [];
  const connector = new GitHubGhConnector({
    run: async (...args) => { processes.push(args); return {stdout:`${secret}\n`}; },
    request: async (url, options) => {
      calls.push({url,options});
      if (new URL(url).pathname === '/user') return json({login:'test-user'});
      return json([]);
    }, ...overrides,
  });
  return {connector,calls,processes};
}
test('gh authorization is private, fixed-host and read-only; one process per paginated batch', async () => {
  const f = fixture();
  const result = await f.connector.fetch(source);
  assert.deepEqual(result.metadata,{access:'gh',identity:'test-user'});
  assert.equal(f.processes.length,1);
  const [command,args,options] = f.processes[0];
  assert.equal(command,'gh');assert.deepEqual(args,['auth','token','--hostname','github.com']);
  assert.equal(options.shell,undefined);assert.ok(options.timeout<=10_000);assert.ok(options.maxBuffer<=8192);
  for (const call of f.calls) {
    assert.equal(new URL(call.url).origin,'https://api.github.com');assert.equal(call.options.method,'GET');
    assert.equal(call.options.redirect,'error');assert.equal(call.options.headers.Authorization,`Bearer ${secret}`);
  }
  assert.equal(new URL(f.calls.find(c=>c.url.includes('/issues?')).url).searchParams.get('state'),'all');
  assert.equal(f.connector.status().ready,true);assert.equal(f.connector.status().canPublish,false);
  assert.doesNotMatch(JSON.stringify([result,f.connector.status(),f.connector]),new RegExp(secret));
  await assert.rejects(f.connector.publish(),error=>error.definitelyNotSent===true);
  assert.equal(f.calls.length,3);
});
test('gh process failures, missing cli, invalid tokens and timeout never expose command output', async () => {
  for (const failure of [new Error(`Command failed with stderr ${secret}`),Object.assign(new Error(secret),{code:'ENOENT'}),Object.assign(new Error(secret),{killed:true})]) {
    const f=fixture({run:async()=>{throw failure;}});
    await assert.rejects(f.connector.fetch(source),error=>!error.message.includes(secret)&&/gh/.test(error.message));
    assert.equal(f.calls.length,0);assert.equal(f.connector.status().ready,false);
    assert.doesNotMatch(JSON.stringify(f.connector.status()),new RegExp(secret));
  }
  for (const token of ['',`${secret}\nINJECTED`,secret.repeat(300)]) {
    const f=fixture({run:async()=>({stdout:token})});await assert.rejects(f.connector.fetch(source));assert.equal(f.calls.length,0);
  }
});
test('gh validates actual identity, refuses auth failures without anonymous downgrade and can recover', async () => {
  let status=401;
  const f=fixture({request:async()=>status===200?json({login:'recovered'}):new Response(secret,{status})});
  for (status of [401,403,429]) {
    await assert.rejects(f.connector.fetch(source),error=>!error.message.includes(secret));
    assert.equal(f.connector.status().identity,null);assert.equal(f.connector.status().ready,false);
  }
  status=200;assert.equal((await f.connector.connect()).identity.name,'recovered');assert.equal(f.processes.length,4);
  const invalid=fixture({request:async()=>json({login:secret+'\ninvalid'})});await assert.rejects(invalid.connector.fetch(source),/有效/);
});
test('gh sanitizes network and malformed JSON failures and propagates abort to credential process', async () => {
  const f=fixture({request:async()=>{throw new Error(secret);}});
  await assert.rejects(f.connector.fetch(source),error=>!error.message.includes(secret)&&/网络/.test(error.message));
  const invalid=fixture({request:async()=>new Response(secret)});
  await assert.rejects(invalid.connector.fetch(source),error=>!error.message.includes(secret)&&/JSON/.test(error.message));
  const controller=new AbortController();controller.abort();
  const aborted=fixture({run:async(command,args,options)=>{assert.equal(options.signal,controller.signal);throw new Error(secret);}});
  await assert.rejects(aborted.connector.fetch(source,{signal:controller.signal}));assert.equal(aborted.calls.length,0);
});
test('gh preserves rate cooldown and rejects hostile pagination before sending credentials', async () => {
  const calls=[];
  const f=fixture({request:async(url,options)=>{
    calls.push(url);if(new URL(url).pathname==='/user')return json({login:'test-user'});
    return new Response('[]',{headers:{link:'<https://attacker.test/steal>; rel="next"'}});
  }});
  await assert.rejects(f.connector.fetch(source),/跨站/);assert.equal(calls.length,2);
  const limited=fixture({request:async(url)=>new URL(url).pathname==='/user'?json({login:'test-user'}):new Response(secret,{status:429,headers:{'retry-after':'120'}})});
  await assert.rejects(limited.connector.fetch(source),error=>error.retryMs===120000&&!error.message.includes(secret));
});
