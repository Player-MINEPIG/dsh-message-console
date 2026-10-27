import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const directory=await mkdtemp(join(process.cwd(),'.local/ui-test-'));
await build({stdin:{contents:"export {ImageGallery,ImageCachePanel} from './src/images-view.jsx'; export {WorkRecord} from './src/work-records.jsx'; export {Dashboard,SourcePage,ItemCard,ReadAllControl} from './src/dashboard-view.jsx'; export {ListPagination,SettingFields} from './src/ui-shared.jsx'; export {SourceEditor} from './src/source-editor.jsx'; export {CredentialCard} from './src/credentials-view.jsx'; export {ConsoleApp,VideoContext,ItemDetailBody} from './src/client.jsx'; export {FeedbackDiff,LearningBatch,FeedbackPanel,LearningHistory} from './src/feedback-view.jsx';",resolveDir:process.cwd()},outfile:join(directory,'ui.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',loader:{'.css':'empty'}});
const {SourceEditor,ImageGallery,ImageCachePanel,WorkRecord,Dashboard,SourcePage,ItemCard,ReadAllControl,ListPagination,SettingFields,ConsoleApp,VideoContext,ItemDetailBody,CredentialCard,FeedbackDiff,LearningBatch,FeedbackPanel,LearningHistory}=await import(join(directory,'ui.mjs'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
test('overview renders server summaries without any item or draft collection',()=>{
  const html=render(Dashboard,{state:{platforms:[],sources:[{id:'s',platform:'github',name:'Source',target:'owner/repo',total:10000,unread:180,handling:40,analyzed:10,importance:2,summaries:['服务端变化摘要'],connection:{ready:true}}]},page:{kind:'overview'},order:'priority',onNavigate(){},setOrder(){}});
  assert.match(html,/服务端变化摘要/);assert.match(html,/10000 个内容项/);assert.match(html,/>180</);assert.match(html,/>40</);assert.match(html,/>重要</);assert.doesNotMatch(html,/值得关注/);
});
test('cards use server status and explicit original excerpt without full payload',()=>{
  const html=render(ItemCard,{item:{id:'i',status:'handling',title:'评论',kind:'comment',excerpt:'服务器返回的摘录',handling:'none',readVersion:'v1',version:'v1',payload:{contextComplete:true}},onSelect(){}});
  assert.match(html,/dmc-card-handling/);assert.match(html,/待处理/);assert.match(html,/原文摘录/);assert.match(html,/服务器返回的摘录/);assert.match(html,/查看全文/);
});
test('server pagination renders clamped page, exact range and supported sizes',()=>{
  const html=render(ListPagination,{pagination:{items:[],page:4,pageSize:10,pageCount:4,total:31},onPage(){},onPageSize(){}});
  assert.match(html,/31–31 \/ 31 条/);assert.match(html,/第 4 \/ 4 页/);assert.match(html,/value="10"/);assert.match(html,/value="20"/);assert.match(html,/value="50"/);assert.match(html,/<button type="button" disabled="">下一页/);
});

test('pagination inside source form never creates implicit submit buttons',()=>{
  const html=renderToStaticMarkup(React.createElement('form',null,React.createElement(ListPagination,{pagination:{page:2,pageSize:10,pageCount:3,total:25},onPage(){}})));
  const buttons=[...html.matchAll(/<button\b([^>]*)>(上一页|下一页)<\/button>/g)];
  assert.equal(buttons.length,2);for(const button of buttons)assert.match(button[1],/type="button"/);
});

test('video detail keeps the collected title and a description section without embedding the full description in its header',()=>{
  const html=render(VideoContext,{root:'items/example',item:{version:'v1',payload:{video:{title:'已采集视频标题',descriptionLength:42000}}}});
  assert.match(html,/已采集视频标题/);assert.match(html,/视频简介/);assert.match(html,/<details open="">/);
  assert.equal(render(VideoContext,{root:'items/example',item:{version:'v1',payload:{}}}),'');
  assert.doesNotMatch(render(VideoContext,{root:'items/example',item:{version:'v1',payload:{video:{title:'无简介视频',descriptionLength:0}}}}),/视频简介/);
});

test('collapsed card keeps original link outside the detail button and suppresses acknowledged priority',()=>{
  const item={id:'i',status:'read',title:'一条短评论',url:'https://www.bilibili.com/video/BV1111111111',kind:'comment',excerpt:'谢谢',handling:'none',readVersion:'v1',version:'v1',analyzedVersion:'v1',analysis:{version:'v1',importance:3,urgent:true,reason:'保留当时分析',summary:'原摘要'},attentionAcknowledged:true};
  const html=render(ItemCard,{item,onSelect(){}});
  assert.match(html,/展开详情 \/ 查看全文/);assert.match(html,/打开原始来源 ↗/);
  assert.ok(html.indexOf('</button>')<html.indexOf('<a '));assert.match(html,/target="_blank" rel="noreferrer"/);
  assert.doesNotMatch(html,/值得关注|有时效要求/);
  assert.doesNotMatch(render(ItemCard,{item:{...item,url:'javascript:alert(1)'},onSelect(){}}),/<a /);
});

test('bulk read describes source-wide pagination scope and preservation',()=>{
  const source=render(ReadAllControl,{sourceId:'s',action(){}}),all=render(ReadAllControl,{action(){}});
  assert.match(source,/覆盖当前来源所有分页/);assert.match(all,/覆盖全部来源/);
  for(const html of [source,all]){assert.match(html,/已读仅清未读/);assert.match(html,/保留草稿、评价和历史/);}
});

test('feedback diff renders escaped before and after with case references and global scope',()=>{
  const html=render(FeedbackDiff,{index:0,change:{target:'global',field:'learningGuidance',before:'旧规则',after:'<script>new rule</script>',caseIds:['case-1','case-2']}});
  assert.match(html,/默认配置 · 学习指导/);assert.match(html,/修改前/);assert.match(html,/旧规则/);assert.match(html,/修改后/);assert.match(html,/&lt;script&gt;/);assert.match(html,/<summary>依据 2 条评价<\/summary>/);assert.match(html,/<summary>技术详情<\/summary>/);assert.doesNotMatch(html,/case-1、case-2/);
});

test('pending proposals require explicit confirmation and show actual session plus frozen cases',()=>{
  const batch={id:'b',status:'pending',caseCount:1,remainingCount:12,sessionId:'actual-session',proposal:{status:'pending',summary:'建议减少普通评论关注',revision:1,hash:'h',changes:[{target:'source',field:'attentionRules',before:'旧规则',after:'新规则',caseIds:['c']}]},cases:[{id:'c',title:'谢谢',text:'普通感谢无需关注',itemVersion:'v1',analysisRevision:3,feedbackRevision:2,analysisSnapshot:{summary:'当时摘要'},hasDecision:true,runId:'run-1'}]};
  const html=render(LearningBatch,{batch,action(){},openSession(){}});
  assert.match(html,/确认并应用修改/);assert.match(html,/拒绝此提案/);assert.match(html,/本提案只修改当前来源/);assert.match(html,/进入实际学习会话/);assert.match(html,/还有 12 条/);assert.match(html,/普通感谢无需关注/);assert.match(html,/当时摘要/);assert.match(html,/保留 Jev 输入输出引用/);assert.match(html,/案例 1 · 谢谢/);assert.match(html,/<summary>依据 1 条评价<\/summary>/);assert.match(html,/<summary>批次记录<\/summary>/);
  assert.doesNotMatch(html,/修改已应用/);
  const applied=render(LearningBatch,{batch:{...batch,status:'applied',proposal:{...batch.proposal,status:'applied'}},action(){},openSession(){}});
  assert.match(applied,/对应版本的评价已标记为已学习/);assert.doesNotMatch(applied,/确认并应用修改/);
});

test('learning records use fixed scope without source selection or batch creation forms',()=>{
  const sources=[{id:'s',name:'我的视频',platform:'bilibili'}];
  const source=render(FeedbackPanel,{sources,sourceId:'s',action(){},onBack(){}});
  assert.match(source,/我的视频 · 学习记录/);assert.match(source,/每批最多 50 条/);assert.match(source,/条未学习评价/);assert.match(source,/确认应用成功后/);assert.match(source,/← 返回来源/);
  const all=render(FeedbackPanel,{sources,action(){},onBack(){}});
  assert.match(all,/全部来源的学习批次与提案/);assert.match(all,/历史学习批次/);assert.match(all,/← 返回总览/);assert.doesNotMatch(all,/条未学习评价/);
  for(const html of [source,all]){assert.doesNotMatch(html,/<select|<form|整理哪个来源|请选择来源|整理本批评价/);}
});

test('global learning history identifies each source and preserves status, case count and pagination',()=>{
  const sources=[{id:'s',name:'我的视频',platform:'bilibili'},{id:'g',name:'Compass 项目',platform:'github'}];
  const html=render(LearningHistory,{sources,history:{items:[{id:'b',sourceId:'s',status:'pending',caseCount:50},{id:'c',sourceId:'g',status:'applied',caseCount:2},{id:'d',sourceId:'deleted',status:'failed',caseCount:1}],page:1,pageSize:10,pageCount:2,total:13},selected:'b',onSelect(){},onPage(){}});
  assert.match(html,/我的视频 · 哔哩哔哩/);assert.match(html,/Compass 项目 · GitHub/);assert.match(html,/已删除来源 · deleted/);assert.match(html,/等待确认/);assert.match(html,/已应用/);assert.match(html,/50 条案例/);assert.match(html,/dmc-learning-row selected/);assert.match(html,/第 1 \/ 2 页/);
});

test('learning records share the top navigation and source details own learning actions',()=>{
  const app=render(ConsoleApp,{}),nav=app.match(/<nav aria-label="看点什么导航">(.*?)<\/nav>/)[1];
  assert.match(nav,/>总览<\/button>/);assert.match(nav,/>学习记录<\/button>/);assert.match(nav,/>全局配置<\/button>/);assert.match(nav,/>＋ 添加来源<\/button>/);assert.doesNotMatch(app,/整理用户评价/);
  const source=render(SourcePage,{source:{id:'s',name:'我的视频',platform:'bilibili',connection:{ready:true}},state:{},action(){},onLearn(){},onLearningHistory(){}});
  assert.match(source,/>整理用户评价<\/button>/);assert.match(source,/>学习记录 ↗<\/button>/);assert.doesNotMatch(source,/评价整理来源|整理哪个来源|请选择来源/);
});


test('card status appears once, with handling separate from importance',()=>{
  const base={id:'i',status:'handling',kind:'comment',title:'需要评价',handling:'pending',readVersion:'v1',version:'v1',analyzedVersion:'v1',analysis:{importance:2,summary:'摘要'},attentionAcknowledged:false};
  const pending=render(ItemCard,{item:base,onSelect(){}});
  assert.equal((pending.match(/待处理/g)||[]).length,1);assert.equal((pending.match(/dmc-item-status /g)||[]).length,1);
  assert.match(pending,/dmc-item-status-pending/);assert.match(pending,/>重要</);assert.doesNotMatch(pending,/需要处理|值得关注/);
  assert.match(render(ItemCard,{item:{...base,handling:'later'},onSelect(){}}),/dmc-item-status-pending">待处理/);
  const done=render(ItemCard,{item:{...base,status:'read',handling:'done',attentionAcknowledged:true},onSelect(){}});
  assert.match(done,/dmc-item-status-done">已处理/);assert.doesNotMatch(done,/待处理|>重要</);
  const next=render(ItemCard,{item:{...base,status:'unread',handling:'none',analysis:null,version:'v2'},onSelect(){}});
  assert.match(next,/dmc-item-status-unread">未读/);assert.doesNotMatch(next,/已处理/);
  assert.match(render(ItemCard,{item:{...base,analysis:{...base.analysis,importance:3}},onSelect(){}}),/>高度重要</);
});


test('GitHub state badges remain distinct from personal handling without a closed organization setting',()=>{
  const html=render(ItemCard,{item:{id:'i',kind:'pr',status:'read',handling:'done',title:'PR',payload:{state:'MERGED'}},onSelect(){}});
  assert.match(html,/已合并/);assert.match(html,/已处理/);
  const settings=render(SettingFields,{parameters:{},values:{includeClosed:false},onChange(){}});
  assert.doesNotMatch(settings,/GitHub 整理范围|整理已关闭/);
});

test('source list displays independent closed visibility and time direction controls with honest organization triggers',()=>{
  const source={id:'s',name:'GitHub',platform:'github',connection:{ready:true}},props={source,state:{},action(){}};
  const html=render(SourcePage,props);
  assert.doesNotMatch(html,/显示全部（含已关闭|dmc-display-closed/);
  assert.match(html,/aria-label="内容最后更新时间排序"/);assert.match(html,/<option value="updated-desc" selected="">最后更新：新到旧/);assert.match(html,/最后更新：旧到新/);
  assert.doesNotMatch(render(SourcePage,{...props,source:{...source,platform:'bilibili'}}),/显示全部（含已关闭/);
  for(const [trigger,label] of [['manual','手动触发'],['scheduled','定时触发'],[undefined,'触发来源未知']]) {
    const report=render(SourcePage,{...props,source:{...source,lastOrganization:{trigger,status:'completed',scope:'changes',candidates:1,completed:1,failed:0,skipped:0}}});
    assert.match(report,new RegExp(label));
  }
  const card=render(ItemCard,{item:{id:'i',status:'read',title:'item',updatedAt:'2025-01-01T00:00:00Z',changedAt:'2026-10-19T00:00:00Z'},onSelect(){}});
  assert.match(card,/1月1日/);assert.doesNotMatch(card,/10月19日/);
});

test('work record preserves failed stage and separately presents later saved analysis and actual supervision',async()=>{
 const failed={id:'synthetic-timeout',trigger:'scheduled',status:'failed',startedAt:'2026-10-20T00:05:05Z',finishedAt:'2026-10-20T00:10:05Z',error:'DSH 调用失败 [TIMEOUT]：阶段执行超时',failure:{code:'TIMEOUT',sessionId:'synthetic-original',cancellationSource:'timeout',timeoutMs:300000},submission:{kind:'analysis',adopted:true,at:'2026-10-20T00:11:14Z'},sessions:[{sessionId:'synthetic-original',role:'investigate',at:'2026-10-20T00:05:05Z'}]};
 const normal={id:'synthetic-normal',trigger:'manual',status:'completed',startedAt:'2026-10-20T01:00:00Z',submission:{kind:'analysis',adopted:true,at:'2026-10-20T01:01:00Z',draftStatus:'ready'},sessions:[{sessionId:'synthetic-analysis',role:'investigate',at:'2026-10-20T01:00:00Z'},{sessionId:'synthetic-supervisor',role:'supervisor',at:'2026-10-20T01:00:40Z'}]};
 const lateDraft={...failed,id:'synthetic-late-draft',submission:{...failed.submission,draftStatus:'pending-supervision'}};
 const props=run=>({run,item:{kind:'issue'},openSession(){}}),html=render(WorkRecord,props(failed)),normalHtml=render(WorkRecord,props(normal)),lateHtml=render(WorkRecord,props(lateDraft));
 assert.match(html,/定时触发 · 失败/);assert.match(html,/TIMEOUT/);assert.match(html,/取消来源 阶段超时/);assert.match(html,/限时 5分钟/);assert.match(html,/后续已保存分析/);assert.match(html,/当时已采纳/);assert.doesNotMatch(html,/300000|监督通过/);assert.match(normalHtml,/业务结果/);assert.match(normalHtml,/监督通过，待发布审核/);assert.doesNotMatch(normalHtml,/后续已保存|阶段终止/);assert.match(lateHtml,/草稿待独立监督/);assert.doesNotMatch(lateHtml,/监督通过/);
 const css=await readFile('src/style.css','utf8');
 await writeFile(join(directory,'work-records-preview.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>工作记录 · 隔离合成验收</title><style>${css}</style><body><main class="dmc" style="max-width:900px;margin:36px auto"><h1>工作记录 · 隔离合成验收</h1><p>全部为合成记录，没有连接生产或真实会话。</p><h2>阶段5分钟失败后补交分析</h2>${html}<h2>正常分析与独立监督</h2>${normalHtml.replace('<details','<details open')}<h2>异步补交草稿仍待监督</h2>${lateHtml}</main></body></html>`);
});

test('outer comment card highlights changed replies, preserves root context and distinguishes whole-thread suggestions',()=>{
  const item={id:'i',kind:'comment',status:'handling',handling:'pending',title:'此前看过的根评论',excerpt:'根正文',version:'v2',analyzedVersion:'v2',analysis:{processing:'decision-only',reason:'新问题需要本人判断',importance:2},organization:{conclusion:'human',reason:{kind:'changes',itemKind:'comment',rootChanged:false,contextChanged:false,previousConclusion:'ignore',comments:{added:1,edited:0,removed:0,samples:[{id:'r',change:'added',author:'楼内观众',excerpt:'<script>楼内新问题</script>'}]}}}};
  const html=render(ItemCard,{item,onSelect(){}});
  assert.match(html,/<h3>楼中楼对话变化<\/h3>/);assert.match(html,/根评论：此前看过的根评论/);
  assert.match(html,/触发原因：楼中楼新增 1 条/);assert.match(html,/根评论未变化/);
  assert.match(html,/整楼处理建议：无需回复 → 需你判断/);assert.match(html,/楼内观众/);
  assert.match(html,/&lt;script&gt;楼内新问题&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
  assert.ok(html.indexOf('楼内新问题')<html.indexOf('根评论原文'));
  const removed=structuredClone(item);removed.organization.reason.comments={added:0,edited:0,removed:1,samples:[{id:'old',change:'removed',author:'原作者',excerpt:'之前影响判断的回复'}]};removed.organization.conclusion='ignore';
  const missing=render(ItemCard,{item:removed,onSelect(){}});
  assert.match(missing,/楼中楼不再可见 1 条/);assert.match(missing,/不再可见 · 此前采集的内容/);
  assert.match(missing,/之前影响判断的回复/);assert.match(missing,/整楼处理建议未变：无需回复/);assert.doesNotMatch(missing,/已删除/);
});

test('work record shows frozen cause and historical reply excerpt without inventing legacy cause',()=>{
  const base={id:'r',kind:'automatic',status:'completed',trigger:'scheduled',startedAt:'2026-10-21T00:00:00Z',processing:'decision-only',triggerReason:{kind:'changes',itemKind:'comment',rootChanged:false,comments:{added:0,edited:0,removed:1,samples:[{id:'old',change:'removed',author:'旧作者',excerpt:'旧楼中楼'}]}}};
  const html=render(WorkRecord,{run:base,item:{kind:'comment'},openSession(){}});
  assert.match(html,/定时触发/);assert.match(html,/触发原因：楼中楼不再可见 1 条/);assert.match(html,/旧楼中楼/);
  const unknown=render(WorkRecord,{run:{...base,triggerReason:{kind:'unknown'}},item:{kind:'comment'},openSession(){}});
  assert.match(unknown,/无法还原触发原因/);assert.doesNotMatch(unknown,/楼中楼不再可见/);
});

test('comment images use private lazy previews and explicit unread labels without external image URLs or nested card buttons',()=>{
 const images=[{url:'https://i0.hdslb.com/bfs/new_dyn/example.png'}];
 const gallery=render(ImageGallery,{itemId:'s:i',version:'v1',images});assert.match(gallery,/图片 1 张 · 在决策升级时输入模型/);assert.match(gallery,/查看第 1 张原图/);assert.match(gallery,/\[图片\]/);assert.doesNotMatch(gallery,/src="https:/);
 const card=render(ItemCard,{item:{id:'i',kind:'comment',title:'图片评论',status:'read',version:'v1',payload:{images}},onSelect(){}});
 assert.match(card,/在决策升级时输入模型/);assert.doesNotMatch(card,/查看第 1 张原图/);
 assert.equal([...card.matchAll(/<button/g)].length,1,'image previews do not nest interactive buttons inside card button');
 const panel=render(ImageCachePanel,{});assert.match(panel,/清空图片缓存/);assert.match(panel,/<button type="button"/);assert.match(panel,/保留评论、图片链接和分析结果/);
});


test('private source editor exposes only importance stage and settings, without video or reply authorization',()=>{
  const source={id:'s',name:'统一私信',platform:'bilibili',target:'private-messages',types:['private-message'],workspaceId:'ws',settings:{},materials:[]};
  const parameters={fetchHours:{scope:'common',default:6,type:'number'},decisionProfile:{scope:'decision',default:'',type:'string'},writerModel:{scope:'analysis',default:'',type:'string'},replyStyle:{scope:'reply',default:'',type:'string'}};
  const html=render(SourceEditor,{source,state:{settings:{},parameters,workspaces:[{id:'ws',title:'工作区',path:'/workspace',status:'ok'}]},action(){},onBack(){},onSaved(){},catalog:{providers:[],decisionProfiles:[],lists:{}}});
  assert.match(html,/统一私信/);assert.match(html,/仅评定重要程度/);assert.match(html,/人工阅读会话及评价学习使用全局/);assert.match(html,/Jev 决策 profile/);
  assert.doesNotMatch(html,/来源链接或目标|评论自动回复授权|回复风格|低置信决策升级 · 专属背景|独立监督 · 专属背景|生成 \/ 分析模型<\/legend>/);
});
test('private work record describes importance and has no comment workflow explanation',()=>{
  const html=render(WorkRecord,{run:{id:'r',status:'completed',kind:'automatic',processing:'decision-only',hasDecision:true,sessions:[]},item:{kind:'private-message'},openSession(){}});
  assert.match(html,/仅评定消息重要程度/);assert.match(html,/重要程度判断/);assert.doesNotMatch(html,/Jev 与升级判断|决策分流后结束/);
});

test('credentials renderer accepts backend platform fields/actions and never fills stored secrets',()=>{
 const html=render(CredentialCard,{platform:{id:'future',title:'新平台',description:'后端说明',status:{ready:true,identity:{name:'用户'}},fields:[{id:'token',label:'访问凭据',type:'secret',required:true}],actions:[{id:'save',label:'验证并保存',fields:true}]},onUpdated:()=>{}});
 assert.match(html,/新平台/);assert.match(html,/type="password"/);assert.match(html,/value=""/);assert.match(html,/验证并保存/);assert.match(html,/用户/);
});


test('source organization locks only its source and explains disabled buttons on hover',()=>{
  const source={id:'a',name:'来源 A',platform:'github',connection:{ready:true}};
  const props={source,state:{busy:['source:b']},action(){},onOrganize(){}};
  const buttons=html=>[...html.matchAll(/<button([^>]*)>(刷新并整理(?:中…)?|整理已有数据|正在整理已有数据…)<\/button>/g)];
  const idle=buttons(render(SourcePage,props));
  assert.equal(idle.length,2);
  for(const [,attributes] of idle)assert.doesNotMatch(attributes,/disabled/);
  for(const extra of [{state:{busy:['source:a']}},{operation:'refresh'},{operation:'organize'}]){
    const html=render(SourcePage,{...props,...extra}),locked=buttons(html);
    assert.equal(locked.length,2);
    for(const [,attributes] of locked){assert.match(attributes,/disabled/);assert.match(attributes,/title="当前来源已有刷新或整理正在运行，请完成后再试。"/);}
    assert.match(html,/<div class="dmc-section-actions" title="当前来源已有刷新或整理正在运行，请完成后再试。">/);
  }
});

test('settings explain the per-turn limit and render editable bounds with inherited value',()=>{
 const html=render(SettingFields,{parameters:{agentTimeoutSeconds:{scope:'common',type:'number',default:600,min:1,max:1800}},values:{},onChange(){}});
 assert.match(html,/单轮执行时限（秒）/);assert.match(html,/远端任务回报等待/);assert.match(html,/min="1"/);assert.match(html,/max="1800"/);assert.match(html,/placeholder="600"/);
});

test('organization failure has a close entry; dismissed report stays in details and new failures surface again',()=>{
 const source={id:'s',name:'来源',platform:'github',connection:{ready:true},organizationReportId:'report-1',lastOrganization:{status:'failed',failed:1,errors:[{itemId:'i',title:'内容',message:'synthetic failure'}]}};
 const props={source,state:{busy:[]},action(){},onOrganize(){}};
 const open=render(SourcePage,props);assert.match(open,/关闭提示/);assert.ok(open.indexOf('synthetic failure')<open.indexOf('<details class="dmc-source-facts"'));
 const dismissed=render(SourcePage,{...props,source:{...source,dismissedOrganizationId:'report-1'}});
 assert.doesNotMatch(dismissed,/关闭提示/);assert.ok(dismissed.indexOf('synthetic failure')>dismissed.indexOf('<details class="dmc-source-facts"'));
 assert.match(render(SourcePage,{...props,source:{...source,organizationReportId:'report-2',dismissedOrganizationId:'report-1'}}),/关闭提示/);
 assert.doesNotMatch(render(SourcePage,{...props,state:{busy:['source:s']}}),/关闭提示/);
 assert.match(render(SourcePage,{...props,pending:true}),/<button type="button" disabled="" title="关闭本轮提示/);
});


test('error cards separate the organization opinion from drafts and hide detailed evidence',()=>{
 const item={id:'i',kind:'issue',title:'需审核的条目',status:'handling',handling:'pending',version:'v',analyzedVersion:'v',analysis:{summary:'需要用户审核',reason:'LONG TECHNICAL EVIDENCE',importance:2},organizationError:{message:'整理失败'},autoOrganizationPaused:true,draftCount:1};
 const html=render(ItemCard,{item,onSelect(){}});
 assert.match(html,/>错误</);assert.doesNotMatch(html,/>已整理<|>未整理<|LONG TECHNICAL EVIDENCE/);
 assert.match(html,/整理意见/);assert.match(html,/需要用户审核/);assert.match(html,/回复草稿 · 1/);assert.match(html,/自动整理已暂停/);
});

test('item details offer a single-item retry and fold evidence and original content by default',()=>{
 const item={id:'i',kind:'issue',title:'需审核的条目',handling:'later',version:'v',analyzedVersion:'v',analysis:{summary:'需要用户审核',reason:'LONG TECHNICAL EVIDENCE'},organizationError:{message:'synthetic failure'},autoOrganizationPaused:true};
 const props={item,root:'items/i',source:{connection:{}},action(){},onReorganize(){},openSession(){}};
 const html=render(ItemDetailBody,props);
 assert.match(html,/value="pending" selected="">待处理/);assert.doesNotMatch(html,/value="later"|稍后处理/);
 assert.match(html,/>重新整理<\/button>/);assert.match(html,/>恢复自动整理<\/button>/);
 assert.match(html,/<strong>整理错误<\/strong>/);assert.match(html,/synthetic failure/);
 assert.match(html,/<h3>整理意见<\/h3>/);assert.match(html,/<h3>回复草稿<\/h3>/);
 assert.match(html,/<details><summary>判断依据与技术细节<\/summary><\/details>/);
 assert.match(html,/<details><summary>原始内容<\/summary><\/details>/);
 assert.doesNotMatch(html,/LONG TECHNICAL EVIDENCE|正在加载原文/);
 const busy=render(ItemDetailBody,{...props,busy:true});
 assert.match(busy,/<button disabled="" title="此来源正在刷新或整理，请完成后再试。">整理进行中…/);
 assert.match(busy,/<button disabled=""[^>]*>恢复自动整理/);
});

test('both visible and dismissed failure reports can open the matching item directly',()=>{
 const source={id:'s',name:'来源',platform:'github',connection:{ready:true},organizationReportId:'report-1',lastOrganization:{status:'failed',failed:1,errors:[{itemId:'outside-page',title:'不在当前页的内容',message:'synthetic failure'}]}};
 for(const dismissed of [false,true]){
  const html=render(SourcePage,{source:{...source,...dismissed?{dismissedOrganizationId:'report-1'}:{}},state:{},action(){},onSelectFailure(){}});
  assert.match(html,/不在当前页的内容/);assert.match(html,/>查看对应条目 ↗<\/button>/);
 }
});
