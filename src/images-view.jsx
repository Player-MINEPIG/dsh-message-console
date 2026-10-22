import React, { useEffect, useRef, useState } from 'react';
import { request, useRemoteResource, ResourceError } from './ui-shared.jsx';

function CachedImage({ path, alt }) {
  const ref = useRef(null), [visible, setVisible] = useState(false), [state, setState] = useState({});
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '120px' });
    observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController(); let blobURL;
    setState({});
    void (async () => {
      try {
        const response = await fetch(`/api/dsh-message-console/${path}`, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error((await response.json()).error ?? '图片加载失败');
        const blob = await response.blob(); if (controller.signal.aborted) return;
        blobURL = URL.createObjectURL(blob); setState({ url: blobURL });
      } catch (error) { if (!controller.signal.aborted) setState({ error: error.message }); }
    })();
    return () => { controller.abort(); if (blobURL) URL.revokeObjectURL(blobURL); };
  }, [path, visible]);
  return <span className="dmc-cached-image" ref={ref}>{state.url ? <img src={state.url} alt={alt} onError={() => setState({ error: '图片无法显示，原文件可能损坏' })}/> : <span>{state.error ?? (visible ? '正在加载图片…' : '[图片]')}</span>}</span>;
}
export function ImageGallery({ itemId, version, commentId, images, interactive = true }) {
  const [opened, setOpened] = useState(null);
  if (!images?.length) return null;
  const base = `items/${encodeURIComponent(itemId)}/image?version=${encodeURIComponent(version)}${commentId == null ? '' : `&commentId=${encodeURIComponent(commentId)}`}`;
  const shown = interactive ? images : images.slice(0, 3);
  return <div className="dmc-image-gallery">
    <small>图片 {images.length} 张 · 在决策升级时输入模型</small>
    <div className="dmc-image-thumbnails">{shown.map((image, index) => interactive ? <button type="button" key={index} aria-label={`查看第 ${index + 1} 张原图`} onClick={() => setOpened(index)}><CachedImage path={`${base}&index=${index}&variant=thumbnail`} alt={`评论图片 ${index + 1}`}/></button> : <CachedImage key={index} path={`${base}&index=${index}&variant=thumbnail`} alt={`评论图片 ${index + 1}`}/>)}</div>
    {!interactive && <small>展开详情查看{images.length > 3 ? `全部 ${images.length} 张图片和` : ''}大图</small>}
    {opened !== null && <div className="dmc-image-full" role="region" aria-label="评论原图"><button type="button" onClick={() => setOpened(null)}>关闭原图</button><CachedImage key={opened} path={`${base}&index=${opened}&variant=original`} alt={`评论原图 ${opened + 1}`}/></div>}
  </div>;
}
export function ImageCachePanel({ revision = 0 }) {
  const [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const resource = useRemoteResource('image-cache', { revision: revision + refresh }), data = resource.data;
  const mb = bytes => (bytes / 1048576).toFixed(1);
  const clear = async () => { setBusy(true); setError(''); try { await request('image-cache/clear', {}); setRefresh(n => n + 1); } catch (error) { setError(error.message); } finally { setBusy(false); } };
  return <section className="dmc-image-cache"><h3>图片缓存</h3><ResourceError error={error || resource.error}/>{data && <p>已使用 {mb(data.usedBytes)} / {mb(data.maxBytes)} MiB · {data.files} 个文件 · 原图 {mb(data.originalBytes)} MiB · 缩略图 {mb(data.thumbnailBytes)} MiB</p>}<p className="dmc-muted">按需下载。决策升级图片只在内存转发，不新增会话附件。超过容量先清理最久未使用的原图，再清理缩略图。清理保留评论、图片链接和分析结果，再次查看时尝试重新下载。</p><button type="button" disabled={busy} onClick={() => void clear()}>{busy ? '正在清理…' : '清空图片缓存'}</button></section>;
}
