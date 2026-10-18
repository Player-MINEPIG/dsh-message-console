import React, { useState } from 'react';
import { time, roleLabel, ModelWorkflowInfo, useRemoteResource, ResourceError, ListPagination } from './ui-shared.jsx';
const statuses={open:'会话进行中',running:'处理中',completed:'已完成',failed:'失败',interrupted:'已中断',stale:'输入已变化，本轮未采用'};
export function WorkRecords({item,root,revision,openSession}) {
  const [page,setPage]=useState(1),resource=useRemoteResource(`${root}/runs?page=${page}&pageSize=10`,{revision,pollMs:5000}),data=resource.data;
  const sessionLink=(session,index)=><button className="dmc-session" key={session.sessionId+index} onClick={()=>openSession(session.sessionId)}>{roleLabel(session.role,item.kind)}<small>{time(session.at)} ↗</small></button>;
  return <><h3>工作记录</h3><p className="dmc-muted">按实际发生的决策与会话显示。完成一项整理不等于调用一次模型。</p><ModelWorkflowInfo/><ResourceError error={resource.error}/>{data&&!data.items.length&&<p className="dmc-muted">尚无整理或人工会话记录。</p>}{data?.items.map(run=><details key={run.id} open={run.status==='failed'||run.status==='interrupted'}><summary>{time(run.startedAt)} · {run.kind==='human'?'人工处理 · ':''}{statuses[run.status]??run.status}</summary>{run.error&&<pre className="dmc-error">{run.error}</pre>}{run.failure&&<p className="dmc-muted">宿主终止代码 {run.failure.code}{run.failure.status?` · HTTP ${run.failure.status}`:''} · 原会话 {run.failure.sessionId}</p>}{run.processing==='context-incomplete'&&<p className="dmc-muted">上下文不足，本轮仅标记人工介入，未调用模型。</p>}{run.processing==='decision-only'&&<p className="dmc-muted">本轮在决策分流后结束。显示固定处理提示，没有生成内容摘要或回复。</p>}{run.processing==='analysis'&&<p className="dmc-muted">本轮执行生成 / 分析。是否执行监督以实际会话记录为准。</p>}{run.hasDecision&&<Decision runId={run.id}/ >}{(run.sessions??[]).map(sessionLink)}{!run.hasDecision&&!run.sessions?.length&&!run.processing&&<p className="dmc-muted">此记录没有 Jev 结果或工作会话，请查看错误或原始上下文限制。</p>}</details>)}{data&&<ListPagination pagination={data} onPage={setPage} label="工作记录分页"/>}</>;
}
function Decision({runId}) {
  const [expanded,setExpanded]=useState(false),resource=useRemoteResource(expanded?`runs/${encodeURIComponent(runId)}/decision`:null);
  return <details open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}><summary>Jev 轻量决策 · 输入与输出</summary>{expanded&&<><ResourceError error={resource.error}/>{resource.data?<pre>{JSON.stringify(resource.data,null,2)}</pre>:!resource.error&&<p>正在加载 Jev 记录…</p>}</>}</details>;
}
