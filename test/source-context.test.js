import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm,symlink,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {normalizeTarget,prepareSource,postHistoryText,POST_HISTORY_GUARD} from '../src/source-context.js';
import {validateSource} from '../src/config.js';
test('Bilibili targets are individual video IDs and canonical URLs, never account UIDs',()=>{
 for(const input of ['BV1111111111','https://www.bilibili.com/video/BV1111111111/?t=1'])assert.equal(normalizeTarget('bilibili',input),'BV1111111111');
 assert.equal(normalizeTarget('bilibili','AV123'),'av123');
 for(const input of ['123','https://evil.example/video/BV1111111111','https://name:pass@www.bilibili.com/video/BV1111111111'])assert.throws(()=>normalizeTarget('bilibili',input));
});
test('source materials resolve only explicit workspace files; escape and hidden paths are rejected',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dmc-context-')),other=await mkdtemp(join(tmpdir(),'dmc-other-'));t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(other,{recursive:true,force:true});});
 await writeFile(join(root,'script.md'),'VIDEO_A_ONLY');await writeFile(join(other,'private.md'),'OTHER_VIDEO');await symlink(join(other,'private.md'),join(root,'escape.md'));
 await mkdir(join(root,'.local'));await writeFile(join(root,'.local','private.json'),'PRIVATE');await symlink(join(root,'.local','private.json'),join(root,'normal.json'));
 const source={context:'video a',materials:[{kind:'file',name:'script',path:'script.md'}]};
 const a=await prepareSource(source,{path:root});assert.equal(a.resolvedMaterials[0].text,'VIDEO_A_ONLY');
 const b=await prepareSource({context:'video b',materials:[]},{path:root});assert.deepEqual(b.resolvedMaterials,[]);
 await writeFile(join(root,'script.md'),'UPDATED');assert.notEqual((await prepareSource(source,{path:root})).contextVersion,a.contextVersion);
 for(const path of ['normal.json','escape.md','../private.md','.local/credentials.json'])await assert.rejects(prepareSource({...source,materials:[{kind:'file',name:'bad',path}]},{path:root}));
});
test('trusted post-history supplements do not replace the invariant boundary',()=>{
 const source=validateSource({workspaceId:'w',platform:'bilibili',target:'BV2222222222',name:'video',types:['comment'],context:'intro',materials:[{kind:'text',name:'FAQ',text:'answer'}],postHistoryInstruction:'CUSTOM_RULE'});
 assert.ok(postHistoryText(source).startsWith(POST_HISTORY_GUARD));assert.ok(postHistoryText(source).endsWith('CUSTOM_RULE'));assert.equal(source.materials.length,1);
});
