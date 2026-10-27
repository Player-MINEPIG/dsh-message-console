import React, { useEffect, useRef, useState } from 'react';
import { request } from './api.js';
import { ModelSettingField } from './model-selector.jsx';
export const labels = { github: 'GitHub', bilibili: '哔哩哔哩', issue: 'Issue', pr: 'Pull request', comment: '评论对话', 'private-message':'私信对话', release: 'Release', 'pending-supervision': '等待独立监督', superseded: '已被新稿替换', ready: '等待你审核', blocked: '监督已拦截', stale: '上下文已变化', sent: '已发布', sending: '发送中', unknown: '结果待核实', dismissed: '暂不发布', none: '无需处理', pending: '待处理', later: '待处理', done: '已处理' };
export const githubStateLabel = item => ['issue','pr'].includes(item.kind) ? (item.payload?.merged || String(item.payload?.state).toLowerCase()==='merged' ? '已合并' : ({open:'开放',closed:'已关闭'})[String(item.payload?.state).toLowerCase()]) : null;
export const time = value => value ? new Date(value).toLocaleString('zh-CN', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '尚未执行';
export const safeURL = value => { try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } };
export { request } from './api.js';

const settingNames = { agentTimeoutSeconds: '单轮执行时限（秒）', imageCacheMaxMB: '图片缓存总上限（MiB）', imageOriginalDays: '原图未使用保留天数', imageThumbnailDays: '缩略图未使用保留天数', imageCacheReserveMB: '磁盘预留空间（MiB）', fetchHours: '抓取间隔（小时）', organizeHours: '整理间隔（小时）', language: '摘要语言', decisionProfile: 'Jev 决策 profile', decisionConfidence: '决策概率阈值', decisionMargin: '决策概率差阈值', writerProvider: '生成 / 分析提供商', writerModel: '生成 / 分析模型', supervisorProvider: '监督提供商', supervisorModel: '监督模型', replyStyle: '回复风格', reviewFocus: 'PR 审查重点', learningGuidance: '默认学习指导' };
const settingGroups = [
  { title: '自动执行时限', keys: ['agentTimeoutSeconds'], hint: '可设置 1–1800 秒；未配置时沿用后端执行时限（初始为 300 秒）。每轮决策升级、生成分析、监督或评价学习分别计时，包含工具执行和上下文压缩；不限制整批整理、Jev 请求、人工继续会话或远端任务回报等待。保存后用于新发起的工作，在途计时不变。' },
  { title: '图片缓存容量与保留期限', keys: ['imageCacheMaxMB','imageOriginalDays','imageThumbnailDays','imageCacheReserveMB'], hint: '网页图片缓存共享预算，临时下载也计入上限；决策升级图片只在内存转发，不生成会话附件。低于磁盘预留空间时停止新增缓存；图片链接随评论历史保留。' },
  { title: '抓取与整理频率', keys: ['fetchHours','organizeHours'], hint: '自动整理只处理新变化和需要更新的既有分析。手动整理已有数据也包含尚未分析的历史基线。' },
  { title: 'Jev · 轻量决策', keys: ['decisionProfile','decisionConfidence','decisionMargin'], hint: '评论先由 Jev 输出无需回复、可自动回复、人工介入的选项概率，独立判断重要程度。私信仅评定重要程度，低置信也不升级或拟稿。普通模型的概率为自报估计，未经校准，阈值需用实际样本验证。选择默认项时使用 Jev 的默认 profile。此路线独立于生成模型。' },
  { title: '生成 / 分析模型', keys: ['writerProvider','writerModel'], hint: '用于低置信决策的一次升级、评论拟稿、PR 审查、issue 核实和 release 摘要。摘要与正文来自同一次生成 / 分析输出，没有独立总结调用。旧会话或来源模型不可用时，回退到当前全局默认；默认也不可用则报错。' },
  { title: '独立监督模型', keys: ['supervisorProvider','supervisorModel'], hint: '有拟发布正文后才检查草稿。未单独填写的字段继承生成 / 分析模型，但仍创建独立会话。已授权的B站评论可在监督通过后由插件自动发送，其他草稿等待你审核。' },
  { title: '评价学习指导', keys: ['learningGuidance'], hint: '作为四个模型阶段的共同指导。整理评价生成提案后，只有人工确认应用才会修改这里。也可手动编辑。' },
  { title: '内容偏好', keys: ['language','replyStyle','reviewFocus'], hint: '按来源平台和内容能力生效。' },
];
const emptySettingHints = {
  decisionProfile: '使用 Jev 默认 profile',
  supervisorProvider: '使用生成 / 分析模型的 provider ID',
  supervisorModel: '使用生成 / 分析模型的 model ID',
  writerProvider: '尚未选择 provider ID',
  writerModel: '尚未选择 model ID',
};
function settingHint(key, spec, values, effective) {
  const overridden = Object.hasOwn(values, key);
  const value = overridden ? values[key] : effective?.[key]?.value ?? spec.default;
  if (overridden && value !== '') return '单独设置';
  const origin = overridden ? '单独设置' : effective ? '继承' : '默认';
  return `${origin}：${value === '' ? emptySettingHints[key] ?? '尚未配置' : typeof value === 'boolean' ? value ? '开启' : '关闭' : value}`;
}
export function SettingFields({parameters,values,onChange,effective,catalog}) {
  const applicable=Object.entries(parameters).filter(([key])=>!effective||effective[key]);
  return settingGroups.map(group=>{
    const fields=applicable.filter(([key])=>group.keys.includes(key));
    return fields.length?<fieldset className="dmc-setting-group" key={group.title}><legend>{group.title}</legend><p className="dmc-muted">{group.hint}</p>{fields.map(([key,spec])=>['decisionProfile','writerProvider','writerModel','supervisorProvider','supervisorModel'].includes(key)?<ModelSettingField key={key} field={key} label={settingNames[key]} values={values} onChange={onChange} effective={effective} catalog={catalog}/>:<label key={key} className="dmc-field"><span>{settingNames[key]??key}</span>{spec.type==='boolean'?<select value={Object.hasOwn(values,key)?String(values[key]):''} onChange={event=>{const next={...values};if(event.target.value==='')delete next[key];else next[key]=event.target.value==='true';onChange(next);}}><option value="">{effective?'继承':'默认'}（{(effective?.[key]?.value??spec.default)?'开启':'关闭'}）</option><option value="false">关闭</option><option value="true">开启</option></select>:key==='learningGuidance'?<textarea rows="5" value={values[key]??''} placeholder={String(effective?.[key]?.value??spec.default)} onChange={event=>{const next={...values};if(event.target.value==='')delete next[key];else next[key]=event.target.value;onChange(next);}}/>:<input type={spec.type==='number'?'number':'text'} step={spec.type==='number'?'any':undefined} min={spec.min} max={spec.max} value={values[key]??''} placeholder={String(effective?.[key]?.value??spec.default)} onChange={event=>{const value=event.target.value; const next={...values};if(value==='')delete next[key];else next[key]=spec.type==='number'?Number(value):value;onChange(next);}}/>}<small>{settingHint(key,spec,values,effective)}</small></label>)}</fieldset>:null;
  });
}
export function ModelWorkflowInfo() {
  return <details className="dmc-model-info"><summary>模型调用与上下文如何分工</summary><p>DSH 的 API 配置负责连接模型服务。本插件还需在全局配置或来源覆盖中从下拉列表选择提供商和模型，才知道生成 / 分析时选择哪条宿主路由。</p><ol><li>评论先调用 Jev 轻量决策，返回各选项概率。忽略或人工介入时，界面显示固定的分流提示，不生成内容摘要或回复。</li><li>决策概率不足或评论含图片时，使用生成 / 分析模型升级判断一次。升级阶段附带根评论及楼中楼图片，仍不确定则交给用户。</li><li>需要拟稿时生成评论回复。PR、issue、release 分别执行审查、核实、摘要任务。内容摘要与正文是该次生成 / 分析的输出，没有单独总结调用。</li><li>有拟发布正文后，独立监督会话检查草稿。上下文不完整时直接交给用户；图片下载失败或升级模型不支持看图时，明确转人工处理。</li></ol><p>各阶段使用共用背景和仅属于当前阶段的专属上下文与资料，保留来源信息与原始内容及讨论。角色任务指令各不相同；决策升级附加 decision，监督附加 draft。共用原文与讨论完整保留，Jev 不带入其他阶段的专属背景。Jev 以 state 接收数据、问题 instructions 接收可信规则；Agent 使用真实 DSH 会话，人工会话保留完整历史。</p></details>;
}
export function roleLabel(role,itemKind) {
  return ({'decision-escalation':'普通模型初步判断',writer:itemKind==='release'?'Release 摘要':'评论拟稿 / 生成分析',review:'PR 审查',investigate:'Issue 核实',supervisor:'独立监督',human:'人工处理',learning:'评价学习'})[role]??role;
}
export function MoveButtons({index,length,onMove,label}) {
  return <span className="dmc-move"><button type="button" aria-label={`${label}上移`} disabled={index===0} onClick={()=>onMove(index,-1)}>↑</button><button type="button" aria-label={`${label}下移`} disabled={index===length-1} onClick={()=>onMove(index,1)}>↓</button></span>;
}
export function moveEntry(items,index,direction) {
  const next=[...items];[next[index],next[index+direction]]=[next[index+direction],next[index]];return next;
}

export function useRemoteResource(path, { revision = 0, pollMs = 0 } = {}) {
  const [resource, setResource] = useState({ path, data: null, error: '', loading: Boolean(path) });
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    let requestNumber = 0;
    if (!path) { setResource({ path, data: null, error: '', loading: false }); return; }
    setResource(previous => ({ path, data: previous.path === path ? previous.data : null, error: '', loading: true }));
    const pull = async () => {
      const attempt = ++requestNumber;
      try {
        const data = await request(path);
        if (generation.current === current && attempt === requestNumber) setResource({ path, data, error: '', loading: false });
      } catch (error) {
        if (generation.current === current && attempt === requestNumber) setResource(previous => ({ ...previous, error: error.message, loading: false }));
      }
    };
    void pull();
    const timer = pollMs > 0 ? setInterval(pull, pollMs) : null;
    return () => { generation.current++; if (timer !== null) clearInterval(timer); };
  }, [path, revision, pollMs]);
  return resource.path === path ? resource : { data: null, error: '', loading: Boolean(path) };
}
export function ResourceError({error}) { return error ? <p className="dmc-error" role="alert">{error}</p> : null; }
export function ListPagination({pagination,pageSize,onPage,onPageSize,label='内容分页'}) {
  const {page,pageCount,total}=pagination;
  const size=pageSize??pagination.pageSize, start=total?(page-1)*size+1:0, end=Math.min(page*size,total);
  return <nav className="dmc-pagination" aria-label={label}><div className="dmc-pagination-range"><span aria-live="polite">{start}–{end} / {total} 条</span>{onPageSize&&<label>每页 <select aria-label={`${label}每页条数`} value={size} onChange={e=>onPageSize(Number(e.target.value))}>{[10,20,50].map(value=><option key={value} value={value}>{value} 条</option>)}</select></label>}</div><div className="dmc-pagination-actions"><button type="button" disabled={page===1} onClick={()=>onPage(page-1)}>上一页</button><span>第 {page} / {pageCount} 页</span><button type="button" disabled={page===pageCount} onClick={()=>onPage(page+1)}>下一页</button></div></nav>;
}
