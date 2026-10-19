import React from 'react';
import { currentAnalysis, hasUrgency } from './dashboard.js';
import { labels, time, safeURL, githubStateLabel, useRemoteResource, ResourceError, ListPagination } from './ui-shared.jsx';

function PriorityTags({stats}) {
  return <div className="dmc-tags">{stats.analyzed?<span>{['一般','普通','重要','高度重要'][stats.importance]}</span>:<span>未整理</span>}{stats.urgent&&<span className="dmc-tag-warm">有依据的时效要求</span>}</div>;
}
export function Dashboard({state,page,onNavigate,order,setOrder,action,pending}) {
  const platforms=state.platforms, sources=state.sources;
  const showPlatforms=['overview','platforms'].includes(page.kind), showSources=page.kind!=='platforms';
  return <main className="dmc-dashboard">
    {action&&<ReadAllControl action={action} pending={pending}/>}
    {page.kind!=='overview'&&<div className="dmc-page-title"><button onClick={()=>onNavigate({kind:'overview'})}>← 返回总览</button><h2>{page.kind==='platforms'?'全部平台':page.kind==='platform'?`${labels[page.id]} 的来源`:'全部来源'}</h2></div>}
    {showPlatforms&&<section className="dmc-section"><div className="dmc-section-heading"><div><span className="dmc-eyebrow">YOUR PLATFORMS</span><h2>平台</h2></div>{page.kind==='overview'&&<button onClick={()=>onNavigate({kind:'platforms'})}>全部平台 ↗</button>}</div><div className="dmc-platforms">{(page.kind==='overview'?platforms.slice(0,3):platforms).map(platform=><button className={`dmc-platform dmc-platform-${platform.id}`} key={platform.id} onClick={()=>onNavigate({kind:'platform',id:platform.id})}><div><strong>{labels[platform.id]}</strong><span className="dmc-platform-symbol">{platform.id==='github'?'⌘':'▣'}</span></div><p>{platform.sources} 个来源 · {platform.total} 个内容项</p><div className="dmc-platform-metrics"><span><b>{platform.unread}</b> 项未读变化</span><span><b>{platform.handling}</b> 项需要处理</span></div><PriorityTags stats={platform}/></button>)}</div></section>}
    {showSources&&<section className="dmc-section"><div className="dmc-section-heading"><div><span className="dmc-eyebrow">KEEP AN EYE ON</span><h2>{page.kind==='platform'?'平台来源':'来源'}</h2><p className="dmc-muted">变化数按未读内容项统计，包含其讨论变化。</p></div><div className="dmc-section-actions"><select aria-label="来源排序" value={order} onChange={e=>setOrder(e.target.value)}><option value="priority">综合优先级</option><option value="updated">最近更新</option></select>{page.kind==='overview'&&<button onClick={()=>onNavigate({kind:'sources'})}>展开来源 ↗</button>}</div></div><div className="dmc-source-cards">{sources.map(source=><button className="dmc-source-card" key={source.id} onClick={()=>onNavigate({kind:'source',id:source.id})}><div className="dmc-source-identity"><small>{labels[source.platform]} · {source.target}</small><h3>{source.name}</h3><p>{source.description||'尚未填写来源简介'}</p><div className="dmc-tags">{source.tags?.map(tag=><span key={tag}>{tag}</span>)}</div>{(source.fetchError||!source.connection.ready)&&<small className="dmc-error">{source.fetchError||source.connection.reason}</small>}</div><div className="dmc-source-metrics"><div><span><b>{source.unread}</b> 项未读变化</span><span><b>{source.handling}</b> 项需要处理</span></div><PriorityTags stats={source}/><small>{source.total} 个内容项 · {source.changedAt?`内容更新 ${time(source.changedAt)}`:'尚未抓取内容'}</small></div><div className="dmc-source-summary"><small>变化摘要</small>{source.summaries?.length?source.summaries.map((summary,index)=><p key={index}>{summary}</p>):<p>{source.unread?source.unreadUnorganized?'新变化尚未整理':'已整理，暂无内容摘要':source.analyzed?'暂无未读变化':'暂无变化摘要 · 未整理'}</p>}</div></button>)}{!sources.length&&<div className="dmc-empty"><h3>还没有来源</h3><p>添加一个 GitHub 仓库或 B 站视频，开始关注后续变化。</p><button onClick={()=>onNavigate({kind:'create'})}>添加来源</button></div>}</div></section>}
  </main>;
}
export function SourcePage({source,state,action,pending,onBack,onEdit,onLearn,onLearningHistory,selected,onSelect,onDeselect=()=>{},detail,revision=0}) {
  const [query,setQuery]=React.useState(''),[filter,setFilter]=React.useState('all'),[showClosed,setShowClosed]=React.useState(false),[itemOrder,setItemOrder]=React.useState('updated-desc'),[operation,setOperation]=React.useState(null);
  const [page,setPage]=React.useState(1),[pageSize,setPageSize]=React.useState(10),[factsOpen,setFactsOpen]=React.useState(false);
  const workspaces=useRemoteResource(factsOpen?'workspaces':null);
  const busy=Boolean(operation||state.busy?.includes(`source:${source.id}`));
  const organizeAction=async kind=>{setOperation(kind);try{await action(`sources/${source.id}/${kind}`);}finally{setOperation(null);}};
  const learning=useRemoteResource(`learning?${new URLSearchParams({sourceId:source.id,page:'1',pageSize:'10'})}`,{revision,pollMs:5000});
  const stats=source;
  const path=`sources/${encodeURIComponent(source.id)}/items?${new URLSearchParams({page:String(page),pageSize:String(pageSize),filter,q:query,showClosed:String(showClosed),order:itemOrder})}`;
  const list=useRemoteResource(path,{revision,pollMs:5000}),pagination=list.data;
  const changePage=next=>setPage(next);
  const resetList=change=>{change();setPage(1);};
  const outsidePage=detail&&pagination&&!pagination.items.some(item=>item.id===selected);
  const liveReport=busy||Boolean(source.lastOrganization?.failed);
  const workspace=workspaces.data?.find(entry=>entry.id===source.workspaceId)?.title??source.workspaceTitle??source.workspaceId??'请重新选择';
  return <main className="dmc-source-page">
    <div className="dmc-source-navigation"><button onClick={onBack}>← 返回来源</button><small>来源详情</small></div>
    <div className="dmc-source-overview">
      <section className="dmc-source-hero"><small>{labels[source.platform]} · {source.target}</small><h2>{source.name}</h2><p>{source.description||'关注这个来源的后续变化'}</p><div className="dmc-tags">{source.types?.map(type=><span key={type}>{labels[type]}</span>)}{source.tags?.map(tag=><span key={tag}>{tag}</span>)}</div></section>
      <section className="dmc-source-stat dmc-source-stat-unread"><span>未读变化</span><strong>{stats.unread}</strong><small>共 {stats.total} 个内容项</small></section>
      <section className="dmc-source-stat dmc-source-stat-handling"><span>需要处理</span><strong>{stats.handling}</strong><small>待处理、稍后与待审核</small></section>
    </div>
    <div className="dmc-source-actions"><div className="dmc-section-actions"><button className="dmc-primary" disabled={pending||busy} onClick={()=>organizeAction('refresh')}>{operation==='refresh'?'刷新并整理中…':'刷新并整理'}</button><button disabled={pending||busy} onClick={()=>organizeAction('organize')}>{operation==='organize'?'正在整理已有数据…':'整理已有数据'}</button></div><div className="dmc-section-actions"><ReadAllControl sourceId={source.id} action={action} pending={pending}/><button onClick={onEdit}>编辑来源</button></div></div>
    <section className="dmc-source-learning"><div><strong>用户评价学习</strong><small>{learning.data?`${learning.data.unlearnedCount} 条未学习评价 · 每批最多 50 条`:learning.error?'暂时无法获取评价数量':'正在加载评价数量…'}</small><ResourceError error={learning.error}/></div><div className="dmc-section-actions"><button disabled={pending||!learning.data?.unlearnedCount} onClick={onLearn}>整理用户评价</button><button onClick={onLearningHistory}>学习记录 ↗</button></div></section>
    {source.metadata?.access==='gh'&&<p className="dmc-source-notice" role="status">最近一次成功采集使用服务器 gh 身份：{source.metadata.identity}，仅采集。</p>}
    {source.connection.access!=='gh'&&source.metadata?.releaseAccess==='public'&&<p className="dmc-source-notice" role="status">最近一次成功采集的 Release 通过公开页面读取；GitHub Cookie 需更新。</p>}
    {(source.fetchError||!source.connection.ready)&&<div className="dmc-source-error" role="alert">{source.fetchError||source.connection.reason}</div>}
    {liveReport&&<OrganizationStatus source={source} busy={busy} operation={operation}/>}
    <details className="dmc-source-facts" onToggle={event=>setFactsOpen(event.currentTarget.open)}><summary>来源与整理详情 <span>工作区、抓取时间与整理记录</span></summary><div className="dmc-source-facts-body"><ResourceError error={workspaces.error}/>{source.description&&<p>{source.description}</p>}<dl><div><dt>工作区</dt><dd>{workspace}</dd></div><div><dt>最近抓取</dt><dd>{time(source.fetchedAt)}</dd></div><div><dt>内容更新</dt><dd>{time(stats.changedAt)}</dd></div><div><dt>已整理</dt><dd>{stats.analyzed} / {stats.total} 项</dd></div></dl>{!liveReport&&<OrganizationStatus source={source} busy={false}/>}</div></details>
    <div className="dmc-item-toolbar"><div className="dmc-filter-buttons">{[['all','全部内容'],['unread','未读变化'],['handling','需要处理']].map(([key,label])=><button key={key} className={filter===key?'active':''} aria-pressed={filter===key} onClick={()=>resetList(()=>setFilter(key))}>{label}</button>)}</div>{source.platform==='github'&&<label className="dmc-display-closed"><input type="checkbox" checked={showClosed} onChange={e=>resetList(()=>setShowClosed(e.target.checked))}/>显示全部（含已关闭 / 已合并）</label>}<select aria-label="内容最后更新时间排序" value={itemOrder} onChange={e=>resetList(()=>setItemOrder(e.target.value))}><option value="updated-desc">最后更新：新到旧</option><option value="updated-asc">最后更新：旧到新</option></select><input aria-label="搜索内容" placeholder="搜索当前来源…" value={query} onChange={e=>resetList(()=>setQuery(e.target.value))}/></div>
    {pagination&&<ListPagination pagination={pagination} pageSize={pageSize} onPage={changePage} onPageSize={size=>resetList(()=>setPageSize(size))} label="上方内容分页"/>}
    <ResourceError error={list.error}/>{list.loading&&!pagination&&<p role="status">正在加载内容…</p>}
    {outsidePage&&<p className="dmc-selection-notice" role="status">正在查看的内容不在当前页，详情仍保留。<button onClick={onDeselect}>关闭详情</button></p>}
    <div className="dmc-item-layout"><div className="dmc-cards">{pagination?.items.map(item=><ItemCard key={item.id} item={item} selected={selected===item.id} onSelect={onSelect}/>)}{pagination&&!pagination.items.length&&<div className="dmc-empty"><h3>{source.total?'没有匹配的内容':'这里暂时很安静'}</h3><p>{source.total?'尝试其他关键词或筛选条件。':'首次接入内容作为已读基线，后续变化会提示未读。'}</p>{source.total>0&&<button onClick={()=>resetList(()=>{setQuery('');setFilter('all');setShowClosed(true);})}>显示全部内容</button>}</div>}</div>{detail}</div>
    {pagination&&<ListPagination pagination={pagination} pageSize={pageSize} onPage={changePage} label="下方内容分页"/>}
  </main>;
}
export function ItemCard({item,selected,onSelect}) {
  const analysis=currentAnalysis(item),status=item.status,state=status==='handling'?(item.handling==='later'?'later':'pending'):item.handling==='done'&&item.attentionAcknowledged!==false?'done':status,hasSummary=Boolean(analysis?.summary&&!['context-incomplete','decision-only'].includes(analysis.processing));
  return <article className={`dmc-card dmc-card-${status} ${selected?'selected':''}`}><button type="button" className="dmc-card-open" aria-pressed={Boolean(selected)} onClick={()=>onSelect(item)}><div className="dmc-card-meta"><span>{labels[item.kind]} · <span className={`dmc-item-status dmc-item-status-${state}`}>{{read:'已读',unread:'未读',pending:'待处理',later:'稍后处理',done:'已处理'}[state]}</span></span><span title="内容最后更新时间；平台未提供时使用采集到变化的时间">{time(item.updatedAt??item.changedAt)}</span></div><div className="dmc-card-title"><h3>{item.title}</h3></div><div className="dmc-excerpt-label"><span>{hasSummary?'整理摘要':'原文摘录'}</span><span>{selected?'正在查看详情':'展开详情 / 查看全文'} ↗</span></div><p className="dmc-card-excerpt">{hasSummary?analysis.summary:item.excerpt||'暂无正文，打开详情查看已采集的上下文。'}</p><div className="dmc-tags">{githubStateLabel(item)&&<span>{githubStateLabel(item)}</span>}<span>{analysis?'已整理':'未整理'}</span>{item.payload?.contextComplete===false&&<span className="dmc-tag-warm">上下文不完整</span>}{!item.attentionAcknowledged&&analysis?.importance>=2&&<span className="dmc-tag-warm">{analysis.importance===3?'高度重要':'重要'}</span>}{!item.attentionAcknowledged&&hasUrgency(item)&&<span className="dmc-tag-warm">有时效要求</span>}</div>{analysis?.reason&&<small>{analysis.reason}</small>}</button><div className="dmc-card-footer">{safeURL(item.url)?<a href={safeURL(item.url)} target="_blank" rel="noreferrer">打开原始来源 ↗</a>:<small>未提供有效原始链接</small>}</div></article>;
}

function OrganizationStatus({source,busy,operation}) {
  const report=source.lastOrganization;
  if(busy)return <section className="dmc-organization" role="status" aria-live="polite"><strong>{operation==='refresh'?'正在刷新并整理新变化':'正在整理内容，请稍候…'}</strong><p>处理结果与实际工作记录会在完成后显示。无需重复点击。</p></section>;
  if(!report)return <p className="dmc-organize-hint dmc-muted">“整理已有数据”包含尚未分析的历史内容；“刷新并整理”和自动整理只处理新变化。新指导用于后续内容，已完成项不会重复整理。</p>;
  const status={completed:'整理完成',partial:'整理部分完成，存在失败',failed:'整理失败',skipped:'本轮没有执行整理'}[report.status]??report.status;
  return <section className={`dmc-organization ${report.failed?'dmc-organization-error':''}`} role="status" aria-live="polite"><strong>{status}</strong><p>{{manual:'手动触发',scheduled:'定时触发'}[report.trigger]??'触发来源未知'} · {report.scope==='history'?'整理已有数据':'新变化整理'} · 候选 {report.candidates} 项 · 完成 {report.completed} 项 · 失败 {report.failed} 项 · 跳过 {report.skipped} 项</p><p className="dmc-muted">{report.excludedClosed>0&&`已关闭或已合并跳过 ${report.excludedClosed} 项 · `}{time(report.finishedAt)} · 完成数按内容项统计，包含无需调用模型的上下文检查与分流结果。</p>{report.reason&&<p>{report.reason}</p>}{report.contextVersion&&source.contextVersion&&report.contextVersion!==source.contextVersion&&<p className="dmc-muted">本轮使用的来源背景已变更，后续整理将采用新背景。</p>}{report.errors?.length>0&&<details open><summary>查看本轮失败原因</summary>{report.errors.map((error,index)=><div key={error.itemId+index}><p>{error.title}</p><pre className="dmc-error">{error.message}</pre></div>)}</details>}</section>;
}

export function ReadAllControl({sourceId,action,pending}) {
  const [result,setResult]=React.useState(null);
  return <div className="dmc-read-all"><div className="dmc-section-actions"><button type="button" disabled={pending} onClick={async()=>{const response=await action('read-all',sourceId?{sourceId}:{});if(response)setResult(response);}}>全部已读</button>{result&&<small role="status">已处理 {result.count} 个内容项</small>}</div><small>{sourceId?'覆盖当前来源所有分页':'覆盖全部来源'}，清除当前未读与关注提示，保留草稿、评价和历史。新变化仍会提醒。</small></div>;
}
