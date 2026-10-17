import React, { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './api.js';
import { changeProvider, modelRoute, canInheritModel } from './model-selection.js';
const INHERIT = '@inherit';
export function useModelCatalog() {
  const [data,setData]=useState({providers:[],decisionProfiles:[],defaultDecisionProfile:''}),[error,setError]=useState(''),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0),[lists,setLists]=useState({});
  const generation=useRef(0),requests=useRef(new Map());
  const refresh=useCallback(async()=>{const current=++generation.current;setLoading(true);setError('');requests.current.clear();setLists({});setRevision(value=>value+1);try{const result=await request('catalog');if(current===generation.current)setData(result);}catch(error){if(current===generation.current)setError(error.message);}finally{if(current===generation.current)setLoading(false);}},[]);
  const loadModels=useCallback(provider=>{
    if(!provider||requests.current.has(provider))return;
    const current=generation.current;
    const task=request(`catalog/models/${encodeURIComponent(provider)}`).then(models=>{if(current===generation.current)setLists(previous=>({...previous,[provider]:{models,status:'ready'}}));}).catch(error=>{if(current===generation.current)setLists(previous=>({...previous,[provider]:{models:[],status:'error',error:error.message}}));});
    requests.current.set(provider,task);setLists(previous=>({...previous,[provider]:{models:[],status:'loading'}}));
  },[]);
  useEffect(()=>{void refresh();return()=>{generation.current++;};},[refresh]);
  return {...data,error,loading,revision,lists,refresh,loadModels};
}
export function CatalogStatus({catalog}) {
  return <div className="dmc-catalog-status"><p className="dmc-muted">复用 DSH 已有提供商与模型。目录按需读取，包含宿主注册的订阅提供商；此处不编辑 API 或凭据。</p><button type="button" disabled={catalog.loading} onClick={catalog.refresh}>{catalog.loading?'目录读取中…':'刷新模型目录'}</button>{(catalog.error||catalog.providerError||catalog.decisionError)&&<p className="dmc-error">{catalog.error||catalog.providerError||catalog.decisionError}</p>}</div>;
}
function choiceLabel(entries,id) { const found=entries.find(entry=>entry.id===id);return found?`${found.name} · ${found.id}`:id||'尚未选择'; }
export function ModelSettingField({field,label,values,onChange,effective,catalog}) {
  const inherited=Boolean(effective&&!Object.hasOwn(values,field));
  const defaults=Object.fromEntries(Object.entries(effective??{}).map(([key,value])=>[key,value.value]));
  const settings={...defaults,...values},supervisor=field.startsWith('supervisor'),route=modelRoute(settings,supervisor),providerField=field.endsWith('Provider'),modelField=field.endsWith('Model');
  const provider=route.provider,list=catalog.lists[provider],entries=field==='decisionProfile'?catalog.decisionProfiles:providerField?catalog.providers:list?.models??[];
  useEffect(()=>{if(modelField&&provider)catalog.loadModels(provider);},[modelField,provider,catalog.revision,catalog.loadModels]);
  const stored=values[field]??'',value=inherited?INHERIT:stored;
  const selectionKnown=stored?entries.some(entry=>entry.id===stored):true;
  const missing=!inherited&&stored&&!selectionKnown;
  const checking=modelField?Boolean(provider&&(!list||list.status==='loading')):catalog.loading;
  let emptyLabel='尚未选择';
  if(field==='decisionProfile')emptyLabel=`使用 Jev 默认${catalog.defaultDecisionProfile?' · '+choiceLabel(catalog.decisionProfiles,catalog.defaultDecisionProfile):''}`;
  else if(supervisor)emptyLabel=providerField?'跟随生成 / 分析提供商':route.model?'跟随生成 / 分析模型':route.provider!==settings.writerProvider?'请选择此提供商的模型':'跟随生成 / 分析模型（尚未选择）';
  else if(modelField)emptyLabel='请选择模型';else emptyLabel='请选择提供商';
  const inheritCompatible=!modelField||canInheritModel(defaults,settings,supervisor);
  const defaultValue=defaults[field]??'';
  const inheritedText=field==='decisionProfile'?(defaultValue?choiceLabel(entries,defaultValue):'使用 Jev 默认'):defaultValue?choiceLabel(entries,defaultValue):emptyLabel;
  const update=selection=>{
    if(providerField)onChange(changeProvider(values,field,selection,{inherit:selection===INHERIT,defaults}));
    else {const next={...values};if(selection===INHERIT)delete next[field];else next[field]=selection;onChange(next);}
  };
  const inheritedUnavailable=inherited&&defaultValue&&!(modelField&&list?.status!=='ready')&&!entries.some(entry=>entry.id===defaultValue);
  return <label className="dmc-field"><span>{label}</span><select value={value} disabled={catalog.loading||modelField&&(!provider||checking)} onChange={event=>update(event.target.value)}>{effective&&<option value={INHERIT} disabled={!inheritCompatible||Boolean(modelField&&list?.status==='ready'&&defaultValue&&!entries.some(entry=>entry.id===defaultValue))}>继承全局 · {inheritedText}</option>}<option value="">{emptyLabel}</option>{missing&&<option value={stored}>{stored} · {checking?'正在核对目录':'当前目录不可用，请重新选择'}</option>}{entries.map(entry=><option key={entry.id} value={entry.id}>{entry.name} · {entry.id}</option>)}</select>{inherited?<small>继承全局值。选择其他选项可覆盖，恢复继承会继续跟随全局。</small>:<small>{stored?'单独选择':emptyLabel}</small>}{(missing||inheritedUnavailable)&&!checking&&<small className="dmc-error">原选择未在当前目录中找到，已保留该值。请刷新目录或重新选择。</small>}{modelField&&!inheritCompatible&&<small className="dmc-error">当前提供商与全局路线不同，不能继承该模型。请在当前提供商的模型列表中选择。</small>}{modelField&&list?.error&&<small className="dmc-error">{list.error}</small>}{modelField&&!provider&&<small>先选择提供商，再选择其模型。</small>}{modelField&&list?.status==='ready'&&!entries.length&&<small>此提供商目前没有可列出的模型。</small>}</label>;
}
