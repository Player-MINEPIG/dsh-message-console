import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const directory=await mkdtemp(join(process.cwd(),'.local/ui-test-'));
await build({stdin:{contents:"export {Dashboard,SourcePage,ItemCard,ReadAllControl} from './src/dashboard-view.jsx'; export {ListPagination,SettingFields} from './src/ui-shared.jsx'; export {ConsoleApp,VideoContext} from './src/client.jsx'; export {FeedbackDiff,LearningBatch,FeedbackPanel,LearningHistory} from './src/feedback-view.jsx';",resolveDir:process.cwd()},outfile:join(directory,'ui.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',loader:{'.css':'empty'}});
const {Dashboard,SourcePage,ItemCard,ReadAllControl,ListPagination,SettingFields,ConsoleApp,VideoContext,FeedbackDiff,LearningBatch,FeedbackPanel,LearningHistory}=await import(join(directory,'ui.mjs'));
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
  for(const html of [source,all]){assert.match(html,/清除当前未读与关注提示/);assert.match(html,/保留草稿、评价和历史/);}
});

test('feedback diff renders escaped before and after with case references and global scope',()=>{
  const html=render(FeedbackDiff,{index:0,change:{target:'global',field:'learningGuidance',before:'旧规则',after:'<script>new rule</script>',caseIds:['case-1','case-2']}});
  assert.match(html,/全局 · 全局学习指导/);assert.match(html,/修改前/);assert.match(html,/旧规则/);assert.match(html,/修改后/);assert.match(html,/&lt;script&gt;/);assert.match(html,/<summary>依据 2 条评价<\/summary>/);assert.match(html,/<summary>技术详情<\/summary>/);assert.doesNotMatch(html,/case-1、case-2/);
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
  assert.match(render(ItemCard,{item:{...base,handling:'later'},onSelect(){}}),/dmc-item-status-later">稍后处理/);
  const done=render(ItemCard,{item:{...base,status:'read',handling:'done',attentionAcknowledged:true},onSelect(){}});
  assert.match(done,/dmc-item-status-done">已处理/);assert.doesNotMatch(done,/待处理|>重要</);
  const next=render(ItemCard,{item:{...base,status:'unread',handling:'none',analysis:null,version:'v2'},onSelect(){}});
  assert.match(next,/dmc-item-status-unread">未读/);assert.doesNotMatch(next,/已处理/);
  assert.match(render(ItemCard,{item:{...base,analysis:{...base.analysis,importance:3}},onSelect(){}}),/>高度重要</);
});


test('GitHub status cards and boolean settings explain closed organization without confusing personal handling',()=>{
  const html=render(ItemCard,{item:{id:'i',kind:'pr',status:'read',handling:'done',title:'PR',payload:{state:'MERGED'}},onSelect(){}});
  assert.match(html,/已合并/);assert.match(html,/已处理/);
  const settings=render(SettingFields,{parameters:{includeClosed:{type:'boolean',default:false}},values:{includeClosed:false},onChange(){},effective:{includeClosed:{value:false,origin:'global'}}});
  assert.match(settings,/GitHub 整理范围/);assert.match(settings,/始终采集全部状态/);assert.match(settings,/<option value="false" selected="">关闭/);assert.match(settings,/<option value="">继承（关闭）/);
  const inherited=render(SettingFields,{parameters:{includeClosed:{type:'boolean',default:false}},values:{},onChange(){},effective:{includeClosed:{value:true,origin:'global'}}});
  assert.match(inherited,/<option value="" selected="">继承（开启）/);
});

test('source list displays independent closed visibility and time direction controls with honest organization triggers',()=>{
  const source={id:'s',name:'GitHub',platform:'github',connection:{ready:true}},props={source,state:{},action(){}};
  const html=render(SourcePage,props);
  assert.match(html,/显示全部（含已关闭 \/ 已合并）/);assert.match(html,/<input type="checkbox"\/>/);
  assert.match(html,/aria-label="内容最后更新时间排序"/);assert.match(html,/<option value="updated-desc" selected="">最后更新：新到旧/);assert.match(html,/最后更新：旧到新/);
  assert.doesNotMatch(render(SourcePage,{...props,source:{...source,platform:'bilibili'}}),/显示全部（含已关闭/);
  for(const [trigger,label] of [['manual','手动触发'],['scheduled','定时触发'],[undefined,'触发来源未知']]) {
    const report=render(SourcePage,{...props,source:{...source,lastOrganization:{trigger,status:'completed',scope:'changes',candidates:1,completed:1,failed:0,skipped:0}}});
    assert.match(report,new RegExp(label));
  }
  const card=render(ItemCard,{item:{id:'i',status:'read',title:'item',updatedAt:'2025-01-01T00:00:00Z',changedAt:'2026-10-19T00:00:00Z'},onSelect(){}});
  assert.match(card,/1月1日/);assert.doesNotMatch(card,/10月19日/);
});
