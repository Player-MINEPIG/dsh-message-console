import React from 'react';
import { currentAnalysis, hasUrgency } from './dashboard.js';
import { labels, time, useRemoteResource, ResourceError, ListPagination } from './ui-shared.jsx';

function PriorityTags({stats}) {
  return <div className="dmc-tags">{stats.analyzed?<span>{['一般关注','普通重要','值得关注','高度重要'][stats.importance]}</span>:<span>未整理</span>}{stats.urgent&&<span className="dmc-tag-warm">有依据的时效要求</span>}</div>;
}
export function Dashboard({state,page,onNavigate,order,setOrder}) {
  const platforms=state.platforms, sources=state.sources;
  const showPlatforms=['overview','platforms'].includes(page.kind), showSources=page.kind!=='platforms';
  return <main className="dmc-dashboard">
    {page.kind!=='overview'&&<div className="dmc-page-title"><button onClick={()=>onNavigate({kind:'overview'})}>← 返回总览</button><h2>{page.kind==='platforms'?'全部平台':page.kind==='platform'?`${labels[page.id]} 的来源`:'全部来源'}</h2></div>}
    {showPlatforms&&<section className="dmc-section"><div className="dmc-section-heading"><div><span className="dmc-eyebrow">YOUR PLATFORMS</span><h2>平台</h2></div>{page.kind==='overview'&&<button onClick={()=>onNavigate({kind:'platforms'})}>全部平台 ↗</button>}</div><div className="dmc-platforms">{(page.kind==='overview'?platforms.slice(0,3):platforms).map(platform=><button className={`dmc-platform dmc-platform-${platform.id}`} key={platform.id} onClick={()=>onNavigate({kind:'platform',id:platform.id})}><div><strong>{labels[platform.id]}</strong><span className="dmc-platform-symbol">{platform.id==='github'?'⌘':'▣'}</span></div><p>{platform.sources} 个来源 · {platform.total} 个内容项</p><div className="dmc-platform-metrics"><span><b>{platform.unread}</b> 项未读变化</span><span><b>{platform.handling}</b> 项需要处理</span></div><PriorityTags stats={platform}/></button>)}</div></section>}
    {showSources&&<section className="dmc-section"><div className="dmc-section-heading"><div><span className="dmc-eyebrow">KEEP AN EYE ON</span><h2>{page.kind==='platform'?'平台来源':'来源'}</h2><p className="dmc-muted">变化数按未读内容项统计，包含其讨论变化。</p></div><div className="dmc-section-actions"><select aria-label="来源排序" value={order} onChange={e=>setOrder(e.target.value)}><option value="priority">综合优先级</option><option value="updated">最近更新</option></select>{page.kind==='overview'&&<button onClick={()=>onNavigate({kind:'sources'})}>展开来源 ↗</button>}</div></div><div className="dmc-source-cards">{sources.map(source=><button className="dmc-source-card" key={source.id} onClick={()=>onNavigate({kind:'source',id:source.id})}><div className="dmc-source-identity"><small>{labels[source.platform]} · {source.target}</small><h3>{source.name}</h3><p>{source.description||'尚未填写来源简介'}</p><div className="dmc-tags">{source.tags?.map(tag=><span key={tag}>{tag}</span>)}</div>{(source.fetchError||!source.connection.ready)&&<small className="dmc-error">{source.fetchError||source.connection.reason}</small>}</div><div className="dmc-source-metrics"><div><span><b>{source.unread}</b> 项未读变化</span><span><b>{source.handling}</b> 项需要处理</span></div><PriorityTags stats={source}/><small>{source.total} 个内容项 · {source.changedAt?`内容更新 ${time(source.changedAt)}`:'尚未抓取内容'}</small></div><div className="dmc-source-summary"><small>变化摘要</small>{source.summaries?.length?source.summaries.map((summary,index)=><p key={index}>{summary}</p>):<p>{source.unread?source.unreadUnorganized?'新变化尚未整理':'已整理，暂无内容摘要':source.analyzed?'暂无未读变化':'暂无变化摘要 · 未整理'}</p>}</div></button>)}{!sources.length&&<div className="dmc-empty"><h3>还没有来源</h3><p>添加一个 GitHub 仓库或 B 站视频，开始关注后续变化。</p><button onClick={()=>onNavigate({kind:'create'})}>添加来源</button></div>}</div></section>}
  </main>;
}
export function SourcePage({source,state,action,pending,onBack,onEdit,selected,onSelect,onDeselect=()=>{},detail,revision=0}) {
  const [query,setQuery]=React.useState(''),[filter,setFilter]=React.useState('all'),[operation,setOperation]=React.useState(null);
  const [page,setPage]=React.useState(1),[pageSize,setPageSize]=React.useState(10),[factsOpen,setFactsOpen]=React.useState(false);
  const workspaces=useRemoteResource(factsOpen?'workspaces':null);
  const busy=Boolean(operation||state.busy?.includes(`source:${source.id}`));
  const organizeAction=async kind=>{setOperation(kind);try{await action(`sources/${source.id}/${kind}`);}finally{setOperation(null);}};
  const stats=source;
  const path=`sources/${encodeURIComponent(source.id)}/items?${new URLSearchParams({page:String(page),pageSize:String(pageSize),filter,q:query})}`;
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
      <section className="dmc-source-stat dmc-source-stat-handling"><span>需要处理</span><strong>{stats.handling}</strong><small>待处理、暂后与待审核</small></section>
    </div>
    <div className="dmc-source-actions"><div className="dmc-section-actions"><button className="dmc-primary" disabled={pending||busy} onClick={()=>organizeAction('refresh')}>{operation==='refresh'?'刷新并整理中…':'刷新并整理'}</button><button disabled={pending||busy} onClick={()=>organizeAction('organize')}>{operation==='organize'?'正在整理已有数据…':'整理已有数据'}</button></div><button onClick={onEdit}>编辑来源</button></div>
    {source.metadata?.releaseAccess==='public'&&<p className="dmc-source-notice" role="status">最近一次成功采集的 Release 通过公开页面读取；GitHub Cookie 需更新。</p>}
    {(source.fetchError||!source.connection.ready)&&<div className="dmc-source-error" role="alert">{source.fetchError||source.connection.reason}</div>}
    {liveReport&&<OrganizationStatus source={source} busy={busy} operation={operation}/>}
    <details className="dmc-source-facts" onToggle={event=>setFactsOpen(event.currentTarget.open)}><summary>来源与整理详情 <span>工作区、抓取时间与整理记录</span></summary><div className="dmc-source-facts-body"><ResourceError error={workspaces.error}/>{source.description&&<p>{source.description}</p>}<dl><div><dt>工作区</dt><dd>{workspace}</dd></div><div><dt>最近抓取</dt><dd>{time(source.fetchedAt)}</dd></div><div><dt>内容更新</dt><dd>{time(stats.changedAt)}</dd></div><div><dt>已整理</dt><dd>{stats.analyzed} / {stats.total} 项</dd></div></dl>{!liveReport&&<OrganizationStatus source={source} busy={false}/>}</div></details>
    <div className="dmc-item-toolbar"><div className="dmc-filter-buttons">{[['all','全部内容'],['unread','未读变化'],['handling','需要处理']].map(([key,label])=><button key={key} className={filter===key?'active':''} aria-pressed={filter===key} onClick={()=>resetList(()=>setFilter(key))}>{label}</button>)}</div><input aria-label="搜索内容" placeholder="搜索当前来源…" value={query} onChange={e=>resetList(()=>setQuery(e.target.value))}/></div>
    {pagination&&<ListPagination pagination={pagination} pageSize={pageSize} onPage={changePage} onPageSize={size=>resetList(()=>setPageSize(size))} label="上方内容分页"/>}
    <ResourceError error={list.error}/>{list.loading&&!pagination&&<p role="status">正在加载内容…</p>}
    {outsidePage&&<p className="dmc-selection-notice" role="status">正在查看的内容不在当前页，详情仍保留。<button onClick={onDeselect}>关闭详情</button></p>}
    <div className="dmc-item-layout"><div className="dmc-cards">{pagination?.items.map(item=><ItemCard key={item.id} item={item} selected={selected===item.id} onSelect={onSelect}/>)}{pagination&&!pagination.items.length&&<div className="dmc-empty"><h3>{source.total?'没有匹配的内容':'这里暂时很安静'}</h3><p>{source.total?'尝试其他关键词或筛选条件。':'首次接入内容作为已读基线，后续变化会提示未读。'}</p>{source.total>0&&<button onClick={()=>resetList(()=>{setQuery('');setFilter('all');})}>显示全部内容</button>}</div>}</div>{detail}</div>
    {pagination&&<ListPagination pagination={pagination} pageSize={pageSize} onPage={changePage} label="下方内容分页"/>}
  </main>;
}
export function ItemCard({item,selected,onSelect}) {
  const analysis=currentAnalysis(item),status=item.status,hasSummary=Boolean(analysis?.summary&&!['context-incomplete','decision-only'].includes(analysis.processing));
  return <button className={`dmc-card dmc-card-${status} ${selected?'selected':''}`} aria-pressed={selected} onClick={()=>onSelect(item)}><div className="dmc-card-meta"><span>{labels[item.kind]} · <span className="dmc-item-status">{{read:'已读',unread:'未读变化',handling:'需要处理'}[status]}</span>{status==='handling'&&item.readVersion!==item.version&&' · 未读'}</span><span>{time(item.changedAt)}</span></div><div className="dmc-card-title"><h3>{item.title}</h3></div><div className="dmc-excerpt-label"><span>{hasSummary?'整理摘要':'原文摘录'}</span><span>查看全文 ↗</span></div><p className="dmc-card-excerpt">{hasSummary?analysis.summary:item.excerpt||'暂无正文，打开详情查看已采集的上下文。'}</p><div className="dmc-tags"><span>{analysis?'已整理':'未整理'}</span>{item.payload?.contextComplete===false&&<span className="dmc-tag-warm">上下文不完整</span>}{analysis?.importance>=2&&<span className="dmc-tag-warm">值得关注</span>}{hasUrgency(item)&&<span className="dmc-tag-warm">有时效要求</span>}{item.handling!=='none'&&<span>{labels[item.handling]}</span>}</div>{analysis?.reason&&<small>{analysis.reason}</small>}</button>;
}

function OrganizationStatus({source,busy,operation}) {
  const report=source.lastOrganization;
  if(busy)return <section className="dmc-organization" role="status" aria-live="polite"><strong>{operation==='refresh'?'正在刷新并整理新变化':'正在整理内容，请稍候…'}</strong><p>处理结果与实际工作记录会在完成后显示。无需重复点击。</p></section>;
  if(!report)return <p className="dmc-organize-hint dmc-muted">“整理已有数据”包含尚未分析的历史内容；“刷新并整理”和自动整理只处理新变化及需要更新的分析。</p>;
  const status={completed:'整理完成',partial:'整理部分完成，存在失败',failed:'整理失败',skipped:'本轮没有执行整理'}[report.status]??report.status;
  return <section className={`dmc-organization ${report.failed?'dmc-organization-error':''}`} role="status" aria-live="polite"><strong>{status}</strong><p>{report.scope==='history'?'手动整理已有数据':'新变化整理'} · 候选 {report.candidates} 项 · 完成 {report.completed} 项 · 失败 {report.failed} 项 · 跳过 {report.skipped} 项</p><p className="dmc-muted">{time(report.finishedAt)} · 完成数按内容项统计，包含无需调用模型的上下文检查与分流结果。</p>{report.reason&&<p>{report.reason}</p>}{report.contextVersion&&source.contextVersion&&report.contextVersion!==source.contextVersion&&<p className="dmc-muted">本轮使用的来源背景已变更，后续整理将采用新背景。</p>}{report.errors?.length>0&&<details open><summary>查看本轮失败原因</summary>{report.errors.map((error,index)=><div key={error.itemId+index}><p>{error.title}</p><pre className="dmc-error">{error.message}</pre></div>)}</details>}</section>;
}
