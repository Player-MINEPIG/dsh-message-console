import { syncSessionDirectory } from './session-directory.js';
import React, { useEffect, useRef, useState } from 'react';
import styles from './style.css';
import { labels, time, safeURL, githubStateLabel, request, SettingFields, ModelWorkflowInfo, useRemoteResource, ResourceError, ListPagination } from './ui-shared.jsx';
import { Dashboard, SourcePage } from './dashboard-view.jsx';
import { SourceEditor } from './source-editor.jsx';
import { useModelCatalog, CatalogStatus } from './model-selector.jsx';
import { WorkRecords } from './work-records.jsx';
import { currentAnalysis } from './dashboard.js';
import { FeedbackEditor, FeedbackPanel } from './feedback-view.jsx';

export const name = 'dsh-message-console-client';
export const inject = ['slots', 'uiWorkspace', 'layout', 'sessions'];
const PANEL_ID = 'dsh-message-console';
export function apply(ctx) {
  ctx.effect(() => {
    const sync=syncSessionDirectory(ctx.sessions,({after,limit})=>request(`session-directory?after=${after}&limit=${limit}`),{onError:error=>ctx.logger.warn(`看点什么会话目录同步失败：${error.message}`)});
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
  const [error,setError]=useState(''),[pending,setPending]=useState(false),[revision,setRevision]=useState(0);
  const [feedbackDirty,setFeedbackDirty]=useState(false);
  const mayLeave=()=>!feedbackDirty||window.confirm('评价尚未保存。离开会放弃本次修改，是否继续？');
  const [page,setPage]=useState({kind:'overview'}),[order,setOrder]=useState('priority'),[selected,setSelected]=useState(null),[returnPage,setReturnPage]=useState({kind:'overview'});
  const overviewPath=`overview?${new URLSearchParams({order,...(page.kind==='platform'?{platform:page.id}:{})})}`;
  const overview=useRemoteResource(overviewPath,{revision,pollMs:5000}),state=overview.data;
  const sourceResource=useRemoteResource(page.kind==='edit'?`sources/${encodeURIComponent(page.id)}`:null);
  const workspaces=useRemoteResource(['create','edit'].includes(page.kind)?'workspaces':null);
  const action=async(path,body={})=>{setPending(true);setError('');try{const result=await request(path,body);setRevision(value=>value+1);return result;}catch(error){setError(error.message);return null;}finally{setPending(false);}};
  const navigate=next=>{if(!mayLeave())return;setFeedbackDirty(false);if(next.kind==='source'&&['overview','sources','platform'].includes(page.kind))setReturnPage(page);else if(next.kind==='source'&&page.kind==='create')setReturnPage({kind:'overview'});setPage(next);setSelected(null);};
  const source=state?.sources.find(source=>source.id===page.id);
  const deselect=()=>{if(mayLeave()){setSelected(null);setFeedbackDirty(false);}};
  const learn=async sourceId=>{if(!mayLeave())return;const batch=await action('learning',{sourceId});if(batch){setFeedbackDirty(false);setSelected(null);setPage({kind:'feedback',id:sourceId,batchId:batch.id??batch.batchId});}};
  const select=item=>{if(selected?.id===item.id&&selected?.version===item.version)return;if(!mayLeave())return;setFeedbackDirty(false);setSelected({id:item.id,version:item.version});void action(`items/${encodeURIComponent(item.id)}/read`,{version:item.version});};
  return <div className="dmc-app"><header className="dmc-header"><div><span className="dmc-eyebrow">YOUR SOURCES, IN ONE PLACE</span><h1>看点什么<span className="dmc-dot">.</span></h1></div><div className="dmc-top-actions">{demo&&<span className="dmc-pill">本地模拟 · 不连接真实账号</span>}<nav aria-label="看点什么导航"><button className={['overview','platforms','sources','platform','source'].includes(page.kind)?'active':''} onClick={()=>navigate({kind:'overview'})}>总览</button><button className={page.kind==='feedback'?'active':''} onClick={()=>navigate({kind:'feedback'})}>学习记录</button><button className={page.kind==='settings'?'active':''} onClick={()=>navigate({kind:'settings'})}>全局配置</button><button className={page.kind==='create'?'active':''} onClick={()=>navigate({kind:'create'})}>＋ 添加来源</button></nav>{close&&<button aria-label="关闭" onClick={()=>{if(mayLeave())close();}}>×</button>}</div></header>
    {error&&<div role="alert" className="dmc-alert">{error}<button onClick={()=>setError('')}>关闭</button></div>}
    <ResourceError error={overview.error}/>
    {!state?<div className="dmc-empty">正在连接消息服务…</div>:page.kind==='feedback'?<FeedbackPanel key={page.id??'all'} sources={state.sources} sourceId={page.id} batchId={page.batchId} revision={revision} action={action} pending={pending} openSession={openSession} onBack={()=>navigate(page.id?{kind:'source',id:page.id}:{kind:'overview'})}/>:page.kind==='settings'?<GlobalSettings catalog={catalog} state={state} action={action} pending={pending}/>:['create','edit'].includes(page.kind)?<><ResourceError error={sourceResource.error||workspaces.error}/>{(page.kind==='create'||sourceResource.data)&&workspaces.data?<SourceEditor catalog={catalog} key={page.id??'new'} source={sourceResource.data} state={{...state,workspaces:workspaces.data}} action={action} pending={pending} onBack={()=>navigate(source?{kind:'source',id:source.id}:{kind:'overview'})} onSaved={id=>navigate({kind:'source',id})}/>:<p className="dmc-empty">正在加载来源配置…</p>}</>:page.kind==='source'&&source?<SourcePage key={source.id} source={source} state={state} action={action} pending={pending} revision={revision} onBack={()=>navigate(returnPage)} onEdit={()=>navigate({kind:'edit',id:source.id})} onLearn={()=>learn(source.id)} onLearningHistory={()=>navigate({kind:'feedback',id:source.id})} selected={selected?.id} onSelect={select} onDeselect={deselect} detail={selected&&<Detail key={`${selected.id}:${selected.version}`} selection={selected} source={source} revision={revision} action={action} pending={pending} openSession={openSession} close={deselect} onFeedbackDirty={setFeedbackDirty} onFeedbackSaved={()=>setRevision(value=>value+1)}/>}/>:<Dashboard state={state} page={page} order={order} setOrder={setOrder} onNavigate={navigate} action={action} pending={pending}/>}

  </div>;
}
function GlobalSettings({state,action,pending,catalog}) {
  const [values,setValues]=useState(state.settings);
  return <main className="dmc-settings dmc-global-settings"><span className="dmc-eyebrow">MAKE IT YOURS</span><h2>全局配置</h2><p className="dmc-muted">默认值按能力生效。来源可以单独覆盖，发布授权独立管理。清空字段恢复内置默认值。</p><CatalogStatus catalog={catalog}/><ModelWorkflowInfo/><form onSubmit={event=>{event.preventDefault();void action('settings',values);}}><SettingFields catalog={catalog} parameters={state.parameters} values={values} onChange={setValues}/><button className="dmc-primary" disabled={pending}>保存默认值</button></form></main>;
}
function Detail({selection,source,revision,action,pending,openSession,close,onFeedbackDirty,onFeedbackSaved}) {
  const root=`items/${encodeURIComponent(selection.id)}`;
  const header=useRemoteResource(`${root}?version=${encodeURIComponent(selection.version)}`,{revision,pollMs:5000}),item=header.data;
  return <section className="dmc-detail"><header><span>{item?labels[item.kind]:'内容详情'}</span><button aria-label="关闭详情" onClick={close}>×</button></header><ResourceError error={header.error}/>{!item?<p>正在加载详情…</p>:<><h2>{item.title}</h2>{githubStateLabel(item)&&<p>{githubStateLabel(item)}</p>}<a href={safeURL(item.url)} target="_blank" rel="noreferrer">查看原始来源 ↗</a><div className="dmc-detail-actions"><select aria-label="处理状态" value={item.handling} onChange={event=>action(`${root}/handling`,{handling:event.target.value})}>{['none','pending','later','done'].map(value=><option key={value} value={value}>{labels[value]}</option>)}</select><button disabled={pending} onClick={async()=>{const result=await action(`${root}/conversation`);if(result)openSession(result.sessionId);}}>进入会话处理 ↗</button></div>
    {currentAnalysis(item)&&<div className="dmc-analysis"><h3>整理结果</h3><p>{item.analysis.summary}</p><small>{item.analysis.reason}</small></div>}
    <FeedbackEditor item={item} revision={revision} onDirtyChange={onFeedbackDirty} onSaved={onFeedbackSaved}/>
    <VideoContext root={root} item={item}/>
    {item.payload?.contextLimit&&<p className="dmc-muted">{item.payload.contextLimit}</p>}
    <Expandable title="原始内容" initialOpen><ContentChunks path={`${root}/content?version=${encodeURIComponent(item.version)}&section=body`}/></Expandable>
    {item.commentsCount>0&&<Expandable title={`已采集的评论 · ${item.commentsCount} 条`}><Comments root={root} version={item.version}/></Expandable>}
    {item.diffLength>0&&<Expandable title="已采集的 PR diff"><ContentChunks path={`${root}/content?version=${encodeURIComponent(item.version)}&section=diff`}/></Expandable>}
    <Expandable title="历史版本"><Versions root={root}/></Expandable>
    <Drafts root={root} source={source} revision={revision} pending={pending} action={action}/>
    <WorkRecords item={item} root={root} revision={revision} openSession={openSession}/>
  </>}</section>;
}
export function VideoContext({root,item}) {
  const video=item.payload?.video;
  return video?<div className="dmc-analysis"><h3>{video.title}</h3>{video.descriptionLength>0&&<Expandable title="视频简介" initialOpen><ContentChunks path={`${root}/content?version=${encodeURIComponent(item.version)}&section=video-description`}/></Expandable>}</div>:null;
}
function Expandable({title,initialOpen=false,children}) {
  const [open,setOpen]=useState(initialOpen);
  return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{title}</summary>{open&&children}</details>;
}
function ContentChunks({path}) {
  const [content,setContent]=useState({text:'',nextOffset:0,total:0,complete:false}),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),inflight=useRef(false);
  const load=async(offset,first=false)=>{
    if(inflight.current)return;
    inflight.current=true;const current=generation.current;setBusy(true);setError('');
    try{const next=await request(`${path}&offset=${offset}&length=16000`);if(current===generation.current)setContent(previous=>({...next,text:(first?'':previous.text)+next.text}));}
    catch(error){if(current===generation.current)setError(error.message);}
    finally{if(current===generation.current){inflight.current=false;setBusy(false);}}
  };
  useEffect(()=>{generation.current++;inflight.current=false;setContent({text:'',nextOffset:0,total:0,complete:false});void load(0,true);return()=>{generation.current++;};},[path]);
  return <div className="dmc-original"><pre>{content.text||(!busy&&!error?'无文本内容':'')}</pre><ResourceError error={error}/>{busy?<p role="status">正在加载原文…</p>:!content.complete?<button onClick={()=>load(content.nextOffset)}>加载更多原文 · 已加载 {content.nextOffset??content.total} / {content.total||'未知'} 字符</button>:<small className="dmc-muted">全文已加载 · {content.total} 字符</small>}</div>;
}
function Comments({root,version}) {
  const [page,setPage]=useState(1),[pageSize,setPageSize]=useState(10);
  const resource=useRemoteResource(`${root}/comments?version=${encodeURIComponent(version)}&page=${page}&pageSize=${pageSize}`),data=resource.data;
  return <><ResourceError error={resource.error}/>{resource.loading&&!data&&<p>正在加载评论…</p>}{data?.items.map(comment=><blockquote key={comment.id}><strong>{comment.author||'未知作者'}</strong>{comment.parent&&<small> · 回复 {comment.parent}</small>}<p>{comment.excerpt}</p><Expandable title="查看此评论全文"><ContentChunks path={`${root}/content?version=${encodeURIComponent(version)}&section=comment&commentId=${encodeURIComponent(comment.id)}`}/></Expandable></blockquote>)}{data&&<ListPagination pagination={data} pageSize={pageSize} onPage={setPage} onPageSize={value=>{setPage(1);setPageSize(value);}} label="评论分页"/>}</>;
}
function Versions({root}) {
  const [page,setPage]=useState(1),resource=useRemoteResource(`${root}/versions?page=${page}&pageSize=10`),data=resource.data;
  return <><ResourceError error={resource.error}/>{data?.items.map(version=><div key={version.version}><p>{time(version.changedAt)} · {version.title}</p>{version.complete?<Expandable title={`查看版本 ${version.version}`}><ContentChunks path={`${root}/content?version=${encodeURIComponent(version.version)}&section=body`}/></Expandable>:<p className="dmc-muted">旧记录仅保留版本摘要，没有完整原文。</p>}</div>)}{data&&<ListPagination pagination={data} onPage={setPage} label="版本分页"/>}</>;
}
function Drafts({root,source,revision,pending,action}) {
  const [page,setPage]=useState(1),resource=useRemoteResource(`${root}/drafts?page=${page}&pageSize=10`,{revision,pollMs:5000}),data=resource.data;
  return <><h3>发布草稿</h3><p className="dmc-muted">存稿后由独立监督检查。监督通过仍等待你批准发布。</p><ResourceError error={resource.error}/>{data?.items.map(draft=><Draft key={draft.id} draft={draft} revision={revision} source={source} pending={pending} action={action}/>)}{data&&!data.items.length&&<p className="dmc-muted">尚无草稿。</p>}{data&&<ListPagination pagination={data} onPage={setPage} label="草稿分页"/>}</>;
}
function Draft({draft,source,revision,pending,action}) {
  const [expanded,setExpanded]=useState(false),resource=useRemoteResource(expanded?`drafts/${encodeURIComponent(draft.id)}`:null,{revision}),full=resource.data??draft;
  return <article className="dmc-draft"><div className="dmc-tags"><span className={draft.status==='blocked'?'dmc-tag-warm':''}>{labels[draft.status]??draft.status}</span></div><h3>拟发布内容</h3><p className="dmc-muted">草稿 {draft.id} · 输入版本 {draft.version}</p><details open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}><summary>查看草稿全文</summary><ResourceError error={resource.error}/>{resource.data?<pre>{full.body}</pre>:<p>正在加载草稿…</p>}</details><p className="dmc-muted">监督：{draft.supervision?.reason??'尚未完成'}</p>{draft.error&&<p className="dmc-error">{draft.error}</p>}{['pending-supervision','blocked'].includes(draft.status)&&<button disabled={pending} onClick={()=>action(`drafts/${encodeURIComponent(draft.id)}/supervise`,{bodyHash:draft.bodyHash})}>{draft.status==='blocked'?'重试独立监督':'启动独立监督'}</button>}{draft.status==='ready'&&<><button className="dmc-primary" disabled={pending||!source.connection.canPublish||!resource.data} onClick={()=>action(`drafts/${encodeURIComponent(draft.id)}/publish`,{version:draft.version,bodyHash:draft.bodyHash})}>批准并发布</button>{!resource.data&&<p className="dmc-muted">展开全文后可审核发布。</p>}{!source.connection.canPublish&&<p className="dmc-muted">尚未接入可发布账号；当前不会发送。</p>}</>}{['pending-supervision','ready','blocked','stale'].includes(draft.status)&&<button disabled={pending} onClick={()=>action(`drafts/${encodeURIComponent(draft.id)}/dismiss`)}>暂不发布</button>}</article>;
}
