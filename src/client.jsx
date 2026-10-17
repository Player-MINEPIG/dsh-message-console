import { syncSessionDirectory } from './session-directory.js';
import React, { useEffect, useState } from 'react';
import styles from './style.css';
import { labels, time, safeURL, request, SettingFields, ModelWorkflowInfo } from './ui-shared.jsx';
import { Dashboard, SourcePage } from './dashboard-view.jsx';
import { SourceEditor } from './source-editor.jsx';
import { useModelCatalog, CatalogStatus } from './model-selector.jsx';
import { WorkRecords } from './work-records.jsx';
import { currentAnalysis } from './dashboard.js';

export const name = 'dsh-message-console-client';
export const inject = ['slots', 'uiWorkspace', 'layout', 'sessions'];
const PANEL_ID = 'dsh-message-console';
export function apply(ctx) {
  ctx.effect(() => {
    const sync=syncSessionDirectory(ctx.sessions,()=>request('session-directory'),{onError:error=>ctx.logger.warn(`看点什么会话目录同步失败：${error.message}`)});
    return () => sync.dispose();
  });
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => '看点什么' }, ConsoleIcon));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({ openSession: id => ctx.uiWorkspace.openSession(id) }) }, ConsoleApp));
}
function ConsoleIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="M7 9h10M7 13h6M7 17h3"/></svg>;
}
function useStyles() {
  useEffect(()=>{if(!document.getElementById('dmc-styles')){const style=document.createElement('style');style.id='dmc-styles';style.dataset.plugin='dsh-message-console';style.textContent=styles;document.head.appendChild(style);}},[]);
}
export function ConsoleApp({openSession=()=>{},close,demo=false}) {
  useStyles();
  const catalog=useModelCatalog();
  const [state,setState]=useState(null),[error,setError]=useState(''),[pending,setPending]=useState(false);
  const [page,setPage]=useState({kind:'overview'}),[order,setOrder]=useState('priority'),[selected,setSelected]=useState(null),[returnPage,setReturnPage]=useState({kind:'overview'});
  const fetchState=async()=>{const [data,workspaces]=await Promise.all([request('state'),request('workspaces')]);return {...data,workspaces};};
  const load=async()=>{const next=await fetchState();setState(next);return next;};
  useEffect(()=>{let active=true;const refresh=()=>fetchState().then(data=>{if(active)setState(data);}).catch(error=>{if(active)setError(error.message);});refresh();const timer=setInterval(refresh,5000);return()=>{active=false;clearInterval(timer);};},[]);
  const action=async(path,body={})=>{setPending(true);setError('');try{const result=await request(path,body);await load();return result;}catch(error){setError(error.message);return null;}finally{setPending(false);}};
  const navigate=next=>{if(next.kind==='source'&&['overview','sources','platform'].includes(page.kind))setReturnPage(page);else if(next.kind==='source'&&page.kind==='create')setReturnPage({kind:'overview'});setPage(next);setSelected(null);};
  const source=state?.sources.find(source=>source.id===page.id),item=state?.items.find(item=>item.id===selected&&item.sourceId===source?.id);
  const select=item=>{setSelected(item.id);void action(`items/${encodeURIComponent(item.id)}/read`,{version:item.version});};
  return <div className="dmc-app"><header className="dmc-header"><div><span className="dmc-eyebrow">YOUR SOURCES, IN ONE PLACE</span><h1>看点什么<span className="dmc-dot">.</span></h1></div><div className="dmc-top-actions">{demo&&<span className="dmc-pill">本地模拟 · 不连接真实账号</span>}<nav aria-label="看点什么导航"><button className={['overview','platforms','sources','platform','source'].includes(page.kind)?'active':''} onClick={()=>navigate({kind:'overview'})}>总览</button><button className={page.kind==='settings'?'active':''} onClick={()=>navigate({kind:'settings'})}>全局配置</button><button className={page.kind==='create'?'active':''} onClick={()=>navigate({kind:'create'})}>＋ 添加来源</button></nav>{close&&<button aria-label="关闭" onClick={close}>×</button>}</div></header>
    {error&&<div role="alert" className="dmc-alert">{error}<button onClick={()=>setError('')}>关闭</button></div>}
    {!state?<div className="dmc-empty">正在连接消息服务…</div>:page.kind==='settings'?<GlobalSettings catalog={catalog} state={state} action={action} pending={pending}/>:['create','edit'].includes(page.kind)?<SourceEditor catalog={catalog} key={page.id??'new'} source={source} state={state} action={action} pending={pending} onBack={()=>navigate(source?{kind:'source',id:source.id}:{kind:'overview'})} onSaved={id=>navigate({kind:'source',id})}/>:page.kind==='source'&&source?<SourcePage key={source.id} source={source} state={state} action={action} pending={pending} onBack={()=>navigate(returnPage)} onEdit={()=>navigate({kind:'edit',id:source.id})} selected={selected} onSelect={select} detail={item&&<Detail item={item} state={state} action={action} pending={pending} openSession={openSession} close={()=>setSelected(null)}/>}/>:<Dashboard state={state} page={page} order={order} setOrder={setOrder} onNavigate={navigate}/>}
  </div>;
}
function GlobalSettings({state,action,pending,catalog}) {
  const [values,setValues]=useState(state.settings);
  return <main className="dmc-settings dmc-global-settings"><span className="dmc-eyebrow">MAKE IT YOURS</span><h2>全局配置</h2><p className="dmc-muted">默认值按能力生效。来源可以单独覆盖，发布授权独立管理。清空字段恢复内置默认值。</p><CatalogStatus catalog={catalog}/><ModelWorkflowInfo/><form onSubmit={event=>{event.preventDefault();void action('settings',values);}}><SettingFields catalog={catalog} parameters={state.parameters} values={values} onChange={setValues}/><button className="dmc-primary" disabled={pending}>保存默认值</button></form></main>;
}
function Detail({item,state,action,pending,openSession,close}) {
  const source=state.sources.find(source=>source.id===item.sourceId), drafts=state.drafts.filter(draft=>draft.itemId===item.id), runs=state.runs.filter(run=>run.itemId===item.id);
  return <section className="dmc-detail"><header><span>{labels[item.kind]}</span><button aria-label="关闭详情" onClick={close}>×</button></header><h2>{item.title}</h2><a href={safeURL(item.url)} target="_blank" rel="noreferrer">查看原始来源 ↗</a><div className="dmc-detail-actions"><select aria-label="处理状态" value={item.handling} onChange={event=>action(`items/${encodeURIComponent(item.id)}/handling`,{handling:event.target.value})}>{['none','pending','later','done'].map(value=><option key={value} value={value}>{labels[value]}</option>)}</select><button disabled={pending} onClick={async()=>{const result=await action(`items/${encodeURIComponent(item.id)}/conversation`);if(result)openSession(result.sessionId);}}>进入会话处理 ↗</button></div>
    {currentAnalysis(item) && <div className="dmc-analysis"><h3>整理结果</h3><p>{item.analysis.summary}</p><small>{item.analysis.reason}</small></div>}
    {item.payload?.video&&<div className="dmc-analysis"><h3>{item.payload.video.title}</h3><p>{item.payload.video.description}</p></div>}{item.payload?.contextLimit&&<p className="dmc-muted">{item.payload.contextLimit}</p>}<details open><summary>原始内容</summary><pre>{item.body}</pre>{item.payload?.comments?.map(comment=><blockquote key={comment.id}><strong>{comment.author}</strong><p>{comment.body}</p></blockquote>)}</details>
    {item.payload?.diff!==undefined&&<details><summary>已采集的 PR diff</summary><pre>{item.payload.diff||"无文本变更"}</pre></details>}
    {item.previous&&<details><summary>上次版本</summary><pre>{item.previous.body}</pre></details>}
    {drafts.map(draft=><article key={draft.id} className="dmc-draft"><div className="dmc-tags"><span className={draft.status==='blocked'?'dmc-tag-warm':''}>{labels[draft.status]}</span></div><h3>拟发布内容</h3><pre>{draft.body}</pre><p className="dmc-muted">监督：{draft.supervision?.reason ?? '尚未完成'}</p>{draft.error&&<p className="dmc-error">{draft.error}</p>}{draft.status==='ready'&&<><button className="dmc-primary" disabled={pending||!source.connection.canPublish} onClick={()=>action(`drafts/${draft.id}/publish`,{version:draft.version,bodyHash:draft.bodyHash})}>批准并发布</button>{!source.connection.canPublish&&<p className="dmc-muted">尚未接入可发布账号；当前不会发送。</p>}</>}{['ready','blocked','stale'].includes(draft.status)&&<button disabled={pending} onClick={()=>action(`drafts/${draft.id}/dismiss`)}>暂不发布</button>}</article>)}
    <WorkRecords item={item} runs={runs} openSession={openSession}/>
  </section>;
}
