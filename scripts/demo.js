import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
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
data.bilibili.push(...Array.from({length:60},(_,index)=>({remoteId:`comment:${200+index}`,kind:'comment',title:`评论 ${index+4} · 分页验证${index===59?' · 最后一页标记':''}`,body:`这是第 ${index+4} 条评论。用于验证服务端分页、搜索和筛选。`,url:'https://www.bilibili.com',payload:{comments:[]}})));
data.bilibili[0].body+='\n'+'这是完整保留的原文内容，用于验证按需分块读取。'.repeat(1600)+'\n完整原文结尾MARKER';
data.bilibili[0].payload.comments=Array.from({length:25},(_,index)=>({id:`demo-comment-${index}`,author:`合成作者${index}`,body:`第${index+1}条完整评论。`+'评论原文。'.repeat(index===0?3500:5),...(index?{parent:'demo-comment-0'}:{})}));
const connector=platform=>({status:()=>({ready:true,canPublish:false,reason:'本地模拟数据，不连接真实账号'}),fetch:async()=>({complete:true,items:data[platform].map(item=>({...item,body:item.body+(changed?'\n（新增了讨论内容）':'')}))})});
let service;
const bind=(runId,role,source,draftId)=>{const sessionId=`demo-${role}-${randomUUID()}`;service.bindSession({sessionId,runId,role,workspaceId:source.workspaceId,cwd:process.cwd(),...(draftId?{draftId}:{})});return sessionId;};
const executor={catalog:()=>({providers:[],decisionProfiles:[],defaultDecisionProfile:''}),models:async()=>[],conversation:async({runId,source})=>bind(runId,'human',source),analyze:async({runId,item,source,recordDecision})=>{
  if(item.kind==='comment')await recordDecision({input:{state:item.body,options:['无需回复','准备回复','人工介入']},output:{probabilities:{ignore:.05,draft:.9,human:.05}},demo:true});
  const human=item.remoteId==='comment:103',blocked=item.remoteId==='comment:102',pending=item.remoteId==='comment:101';
  const analysis={summary:human?'这条对话需要你补充此前约定。未提前拟回复。':blocked?'回复涉及下一期制作安排，监督认为需要你先决定。':pending?'工作工具已保存草稿，等待独立监督。':'已完成合成内容分析，等待人工查看。',importance:human||blocked||pending?2:1,urgent:false,reason:human?'涉及未提供的合作背景和个人决定':'合成数据用于验证工作记录与审核界面',intervention:human?'human':'review',evidence:'inferred'};
  const sessionId=bind(runId,item.kind==='pr'?'review':item.kind==='issue'?'investigate':'writer',source);
  const receipt=await service.submitFromSession({sessionId,callId:`demo-call-${runId}`},{kind:'analysis',operationKey:'analysis',analysis,draftBody:human?null:blocked?'没问题，下周一定更新完整教程！':'感谢提问。这是通过工具持久保存的合成回复，等待你查看。'});
  if(receipt.draft&&!pending){const supervisor=bind(runId,'supervisor',source,receipt.draft.id);await service.submitFromSession({sessionId:supervisor,callId:`demo-supervision-${runId}`},{kind:'supervision',operationKey:'supervision',approved:!blocked,reason:blocked?'“下周一定更新”是未经用户确认的个人承诺，已拦截。':'合成监督检查通过。仍需人工批准发布。'});}
  return {...receipt.result,processing:'analysis',committed:true,draftId:receipt.draftId};
},learn:async({batchId,source,signal})=>{
  const sessionId=`demo-learning-${randomUUID()}`;
  await service.bindLearningSession({batchId,sessionId,workspaceId:source.workspaceId,cwd:process.cwd()});
  await new Promise(resolve=>setTimeout(resolve,700));
  if(signal.aborted)throw new Error('合成学习已中止');
  const actor={sessionId,actualCwd:process.cwd(),callId:`demo-learning-call-${batchId}`};
  const {items:cases}=service.readLearningFromSession(actor,{section:'cases',page:1,pageSize:50});
  const caseIds=cases.map(entry=>entry.id);
  return service.proposeLearningFromSession(actor,{operationKey:'demo-learning-proposal',summary:'合成演示提案：根据普通评论的评价调整关注规则，并补充文字资料。请人工核对。',changes:[{target:'source',field:'attentionRules',after:'普通感谢、单纯表情和无行动要求的简短评论按一般关注处理。涉及具体问题或个人承诺时说明依据。',caseIds},{target:'source',field:'textMaterial',materialName:'合成演示 · 用户评价记录',after:'这段资料来自本地模拟案例，用于验证提案审核与来源文字资料保存。它不代表真实用户偏好。',caseIds},{target:'global',field:'learningGuidance',after:'合成演示规则：对普通感谢降低关注级别，涉及行动和时限时说明具体依据。',caseIds}]});
},supervise:async({runId,draft,source})=>{const sessionId=bind(runId,'supervisor',source,draft.id);return service.submitFromSession({sessionId,callId:`demo-retry-${draft.id}`},{kind:'supervision',operationKey:'supervision-retry',approved:true,reason:'合成独立监督检查通过。仍等待人工批准发布。'});}};
service=new ConsoleService({store,connectors:{github:connector('github'),bilibili:connector('bilibili')},executor,workspaces:{resolve:async()=>({path:process.cwd()}),list:async()=>[{id:'demo',title:'演示工作区',path:process.cwd(),status:'ok'}]}});
const gh=await service.saveSource({workspaceId:'demo',name:'Compass 项目',platform:'github',target:'example/compass',types:['pr','issue']});
const bili=await service.saveSource({workspaceId:'demo',name:'我的视频评论',platform:'bilibili',target:'BV1111111111',types:['comment']});
await service.refresh(gh.id,{organize:false});await service.refresh(bili.id,{organize:false});changed=true;await service.refresh(gh.id);await service.refresh(bili.id);
const feedbackItems=[...store.items(bili.id,{page:1,pageSize:50}).items,...store.items(bili.id,{page:2,pageSize:50}).items].slice(0,55);
for(const item of feedbackItems)service.saveFeedback(item.id,{text:`合成评价：${item.title}。普通评论不需要高关注，请依据实际行动需要判断。`,expectedRevision:0,itemVersion:item.version,analysisRevision:item.analysisRevision});
const api=createHandler(service,req=>{const host=req.headers.host??'';return /^(127\.0\.0\.1|localhost):\d+$/.test(host)&&(!req.headers.origin||req.headers.origin===`http://${host}`)?{}:{rejection:403};});
const server=createServer(async(req,res)=>{
  if(req.url.startsWith('/api/dsh-message-console/'))return api(req,res);
  if(req.url==='/app.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await readFile('.local/demo/app.js'));return;}
  if(req.url!=='/'){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>看点什么 · 本地模拟</title><body style="margin:0"><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
});
const port=Number(process.env.DMC_DEMO_PORT??3147);await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));console.log(`Local synthetic preview: http://127.0.0.1:${port}`);
async function close(){server.close();await service.close();process.exit(0);}process.on('SIGINT',close);process.on('SIGTERM',close);
