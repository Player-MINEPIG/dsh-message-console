import React, { useState } from 'react';
import { request, useRemoteResource, ResourceError, safeURL } from './ui-shared.jsx';

export function CredentialCard({ platform, onUpdated, disabled = false }) {
  const [values, setValues] = useState({}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const perform = async action => {
    setBusy(true); setError(''); setNotice('');
    const body = action.fields ? values : {};
    if (action.fields) setValues({});
    try {
      await request(`credentials/${encodeURIComponent(platform.id)}/${encodeURIComponent(action.id)}`, body);
      setNotice(action.id === 'save' ? '凭据已保存' : ''); onUpdated();
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  };
  const submit = platform.actions.find(action => action.fields);
  return <section className="dmc-credential-card" aria-label={`${platform.title}凭据`}><header><h3>{platform.title}</h3><span className="dmc-pill">{platform.status.ready ? '已连接' : '待验证'}</span></header>
    <p className="dmc-muted">{platform.description}</p>
    <p>{platform.status.message}{platform.status.identity?.name && <strong> · {platform.status.identity.name}</strong>}</p>
    <form autoComplete="off" onSubmit={event => { event.preventDefault(); if (submit) void perform(submit); }}>
      {platform.fields.map(field => <label key={field.id}>{field.label}<input name={`credential-${platform.id}-${field.id}`} type={field.type === 'secret' ? 'password' : 'text'} value={values[field.id] ?? ''} required={field.required} autoComplete="off" spellCheck={false} placeholder={field.placeholder} disabled={busy || disabled} onChange={event => setValues(previous => ({ ...previous, [field.id]: event.target.value }))}/></label>)}
      <div className="dmc-credential-actions">{platform.actions.map(action => <button key={action.id} type={action.fields ? 'submit' : 'button'} disabled={busy || disabled} className={action.fields ? 'dmc-primary' : ''} onClick={action.fields ? undefined : () => void perform(action)}>{busy ? '处理中…' : action.label}</button>)}</div>
    </form>
    {platform.login && platform.login.state !== 'idle' && <div className="dmc-credential-login" role="status"><p>{platform.login.message}</p>{platform.login.code && <><p>设备验证码：<strong className="dmc-device-code">{platform.login.code}</strong></p><a href={safeURL(platform.login.url)} target="_blank" rel="noreferrer">打开 GitHub 授权页 ↗</a></>}</div>}
    {notice && <p role="status">{notice}</p>}<ResourceError error={error}/>
  </section>;
}
export function CredentialsPanel() {
  const [revision, setRevision] = useState(0);
  const resource = useRemoteResource('credentials', { revision, pollMs: 2000 });
  const platforms = resource.data?.platforms;
  const active = platforms?.find(platform => ['starting', 'waiting'].includes(platform.login?.state));
  return <div className="dmc-credentials"><p className="dmc-muted">管理各平台的访问身份。同一平台的来源共用凭据，自动回复授权仍由来源单独管理。</p><ResourceError error={resource.error}/>{!platforms && !resource.error && <p>正在加载平台凭据…</p>}{platforms?.length === 0 && <p>当前运行环境没有提供凭据配置。</p>}{platforms?.map(platform => <CredentialCard key={platform.id} platform={platform} disabled={Boolean(active && active.id !== platform.id)} onUpdated={() => setRevision(value => value + 1)}/>)}</div>;
}
