import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Store } from '../src/store.js';
import { ConsoleService } from '../src/core.js';
import { createHandler } from '../src/http.js';

await mkdir('.local/demo', { recursive:true });
await build({entryPoints:['scripts/demo-client.jsx'],outfile:'.local/demo/app.js',bundle:true,format:'esm',platform:'browser',jsx:'automatic',loader:{'.css':'text'}});
const directory=await mkdtemp(join(process.cwd(),'.local/demo/state-'));
const store=await new Store(directory).start();
let changed=false;
const data={
  github:[
    {remoteId:'pr:12',kind:'pr',title:'PR #12 · 缓存更新后，旧请求可能覆盖新结果',body:'新增了异步缓存更新逻辑。请帮助检查请求交错时的状态一致性。',url:'https://github.com/example/compass/pull/12',payload:{number:12,head:'demo-sha',comments:[]}},
    {remoteId:'issue:35',kind:'issue',title:'Issue #35 · 切换筛选条件后列表偶尔为空',body:'从全部内容切到未读，再返回全部时列表没有恢复。刷新后正常。',url:'https://github.com/example/compass/issues/35',payload:{number:35,comments:[]}},
  ],
  bilibili:[
    {remoteId:'comment:101',kind:'comment',title:'观众想了解视频里使用的快捷键',body:'最后那个一键展开所有面板的操作是怎么做的？之前没见过这个功能。',url:'https://www.bilibili.com',payload:{comments:[]}},
    {remoteId:'comment:102',kind:'comment',title:'关于下一期内容的建议',body:'可以做一期完整配置过程吗？想看看你平时怎么用。',url:'https://www.bilibili.com',payload:{comments:[]}},
    {remoteId:'comment:103',kind:'comment',title:'一条需要补充背景的合作邀请',body:'上次讨论的那个合作方案，我们这周可以开始吗？',url:'https://www.bilibili.com',payload:{comments:[]}},
  ],
};
const connector=platform=>({status:()=>({ready:true,canPublish:false,reason:'本地模拟数据，不连接真实账号'}),fetch:async()=>({complete:true,items:data[platform].map(item=>({...item,body:item.body+(changed?'\n（新增了讨论内容）':'')}))})});
const executor={catalog:()=>({providers:[],decisionProfiles:[],defaultDecisionProfile:''}),models:async()=>[],conversation:async()=>`demo-human`,analyze:async({item,recordSession,recordDecision})=>{
  if(item.kind==='comment')await recordDecision({input:{state:item.body,options:['无需回复','准备回复','人工介入']},output:{probabilities:{ignore:.05,draft:.9,human:.05}},demo:true});
  if(item.remoteId==='comment:103')return{summary:'这条对话需要你补充此前约定。未提前拟回复。',importance:2,urgent:false,reason:'涉及未提供的合作背景和个人决定',intervention:'human'};
  await recordSession(item.kind==='pr'?'review':'writer',`demo-${item.remoteId}`);await recordSession('supervisor',`demo-supervisor-${item.remoteId}`);
  if(item.kind==='pr')return{summary:'审查发现一个需要确认的竞态条件：旧请求可能覆盖新结果。建议在合并前核对取消机制。',importance:3,urgent:false,reason:'可能影响实际数据正确性；未运行测试',intervention:'review',draft:{body:'建议检查请求完成时是否仍属于当前查询。如果旧请求后返回，当前实现可能覆盖新筛选结果。可以增加请求版本校验，并补充交错响应的测试。',supervision:{approved:true,reason:'建议范围明确，没有声称已经运行测试。'}}};
  if(item.kind==='issue')return{summary:'现象可能与筛选状态恢复有关。需要补充稳定复现步骤，尚未证实根因。',importance:2,urgent:false,reason:'影响常用查看路径，需要进一步核实',intervention:'review',draft:{body:'感谢反馈。方便补充一下切换的具体顺序、是否存在未读内容，以及刷新前后的表现吗？目前还不能确定根因。',supervision:{approved:true,reason:'准确区分了观察和未证实判断。'}}};
  const blocked=item.remoteId==='comment:102';
  return{summary:blocked?'回复涉及下一期制作安排，监督认为需要你先决定。':'观众提出具体使用问题，回复已准备，等待你审核。',importance:blocked?2:1,urgent:false,reason:blocked?'不能替你承诺发布时间':'有明确问题，适合简短回应',intervention:'review',draft:{body:blocked?'没问题，下周一定更新完整教程！':'这个操作可以在面板菜单里找到“展开全部”。如果方便，可以告诉我你使用的版本，我再确认具体入口。',supervision:{approved:!blocked,reason:blocked?'“下周一定更新”是未经用户确认的个人承诺，已拦截。':'回复没有越过已有信息，也没有擅自承诺。'}}};
}};
const service=new ConsoleService({store,connectors:{github:connector('github'),bilibili:connector('bilibili')},executor,workspaces:{resolve:async()=>({path:process.cwd()}),list:async()=>[{id:'demo',title:'演示工作区',path:process.cwd(),status:'ok'}]}});
const gh=await service.saveSource({workspaceId:'demo',name:'Compass 项目',platform:'github',target:'example/compass',types:['pr','issue']});
const bili=await service.saveSource({workspaceId:'demo',name:'我的视频评论',platform:'bilibili',target:'BV1111111111',types:['comment']});
await service.refresh(gh.id);await service.refresh(bili.id);changed=true;await service.refresh(gh.id);await service.refresh(bili.id);
const api=createHandler(service,req=>{const host=req.headers.host??'';return /^(127\.0\.0\.1|localhost):\d+$/.test(host)&&(!req.headers.origin||req.headers.origin===`http://${host}`)?{}:{rejection:403};});
const server=createServer(async(req,res)=>{
  if(req.url.startsWith('/api/dsh-message-console/'))return api(req,res);
  if(req.url==='/app.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile('.local/demo/app.js'));return;}
  if(req.url!=='/'){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>看点什么 · 本地模拟</title><body style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
});
const port=Number(process.env.DMC_DEMO_PORT??3147);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));console.log(`Local synthetic preview: http://127.0.0.1:${port}`);
async function close(){server.close();await service.close();process.exit(0);}process.on('SIGINT',close);process.on('SIGTERM',close);
