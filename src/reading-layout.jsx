import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

function scrollParent(element) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll|hidden)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}
function visibleBounds(element) {
  const viewport = window.visualViewport;
  let top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? window.innerHeight);
  let left = viewport?.offsetLeft ?? 0, right = left + (viewport?.width ?? window.innerWidth);
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, rect.top + node.clientTop); bottom = Math.min(bottom, rect.top + node.clientTop + node.clientHeight);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, rect.left + node.clientLeft); right = Math.min(right, rect.left + node.clientLeft + node.clientWidth);
    }
  }
  return { top, bottom, left, right };
}
export function ReadingLayout({selected,children,detail,listKey}) {
  const layout = useRef(null), pane = useRef(null), cards = useRef(null);
  const [jump,setJump] = useState(null);
  useLayoutEffect(() => {
    const root = layout.current;
    let frame = 0;
    const update = () => {
      frame = 0;
      const bounds = visibleBounds(root), card = cards.current.querySelector('.dmc-card.selected');
      const panel = pane.current;
      root.style.setProperty('--dmc-reading-height', `${Math.max(0, bounds.bottom - bounds.top - 24)}px`);
      if (panel) {
        const parent = scrollParent(panel), parentTop = parent ? parent.getBoundingClientRect().top + parent.clientTop : 0;
        const inset = Math.max(12, bounds.top - parentTop + 12);
        panel.style.top = `${inset}px`;
        const top = Math.max(bounds.top + 12, panel.getBoundingClientRect().top);
        panel.style.setProperty('--dmc-detail-height', `${Math.max(0, Math.min(bounds.bottom - 12, root.getBoundingClientRect().bottom) - top)}px`);
      }
      const rect = card?.getBoundingClientRect();
      const direction = !rect ? 'missing' : rect.bottom <= bounds.top ? 'up' : rect.top >= bounds.bottom ? 'down' : null;
      const listRect = cards.current.getBoundingClientRect();
      const left = Math.max(bounds.left + 12, listRect.left + 12), width = Math.min(350, bounds.right - left - 12, listRect.width - 24);
      const next = selected && detail && direction && bounds.bottom - bounds.top > 80 && width > 0
        ? { direction, left:Math.round(left), top:Math.round(bounds.bottom - 58), width:Math.round(width) } : null;
      setJump(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    for (let node = root; node; node = node.parentElement) resize.observe(node);
    if (cards.current) resize.observe(cards.current);
    if (pane.current) resize.observe(pane.current);
    document.addEventListener('scroll',schedule,true);
    window.addEventListener('scroll',schedule);
    window.addEventListener('resize',schedule);
    window.visualViewport?.addEventListener('resize',schedule);
    window.visualViewport?.addEventListener('scroll',schedule);
    update();
    return () => {
      cancelAnimationFrame(frame); resize.disconnect();
      document.removeEventListener('scroll',schedule,true);
      window.removeEventListener('scroll',schedule); window.removeEventListener('resize',schedule);
      window.visualViewport?.removeEventListener('resize',schedule); window.visualViewport?.removeEventListener('scroll',schedule);
    };
  },[selected,Boolean(detail),listKey]);
  const locate = () => {
    const card = cards.current.querySelector('.dmc-card.selected');
    if (!card) return;
    card.scrollIntoView({block:'center',inline:'nearest',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    card.querySelector('.dmc-card-open')?.focus({preventScroll:true});
  };
  return <div className="dmc-item-layout" ref={layout}><div className="dmc-cards" ref={cards}>{children}</div>{detail&&<aside className="dmc-detail-pane" ref={pane}>{detail}</aside>}{jump&&createPortal(<div role="status" className="dmc-selection-jump" style={{left:jump.left,top:jump.top,width:jump.width}}>{jump.direction==='missing'?<span>当前内容不在此页或筛选结果中</span>:<button type="button" onClick={locate}>{jump.direction==='up'?'↑ 选中内容在上方':'↓ 选中内容在下方'} · 点击定位</button>}</div>,document.body)}</div>;
}
