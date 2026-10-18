import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const directory=await mkdtemp(join(process.cwd(),'.local/ui-test-'));
await build({stdin:{contents:"export {Dashboard,ItemCard} from './src/dashboard-view.jsx'; export {ListPagination} from './src/ui-shared.jsx'; export {VideoContext} from './src/client.jsx';",resolveDir:process.cwd()},outfile:join(directory,'ui.mjs'),bundle:true,format:'esm',platform:'node',packages:'external',loader:{'.css':'empty'}});
const {Dashboard,ItemCard,ListPagination,VideoContext}=await import(join(directory,'ui.mjs'));
test.after(()=>rm(directory,{recursive:true,force:true}));
const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
test('overview renders server summaries without any item or draft collection',()=>{
  const html=render(Dashboard,{state:{platforms:[],sources:[{id:'s',platform:'github',name:'Source',target:'owner/repo',total:10000,unread:180,handling:40,analyzed:10,importance:2,summaries:['服务端变化摘要'],connection:{ready:true}}]},page:{kind:'overview'},order:'priority',onNavigate(){},setOrder(){}});
  assert.match(html,/服务端变化摘要/);assert.match(html,/10000 个内容项/);assert.match(html,/>180</);assert.match(html,/>40</);
});
test('cards use server status and explicit original excerpt without full payload',()=>{
  const html=render(ItemCard,{item:{id:'i',status:'handling',title:'评论',kind:'comment',excerpt:'服务器返回的摘录',handling:'none',readVersion:'v1',version:'v1',payload:{contextComplete:true}},onSelect(){}});
  assert.match(html,/dmc-card-handling/);assert.match(html,/需要处理/);assert.match(html,/原文摘录/);assert.match(html,/服务器返回的摘录/);assert.match(html,/查看全文/);
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
