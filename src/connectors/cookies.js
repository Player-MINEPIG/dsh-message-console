import { readFile, stat } from 'node:fs/promises';

const HOSTS = {github: new Set(['github.com']), bilibili: new Set(['api.bilibili.com','www.bilibili.com'])};
export class CookieAuthenticationError extends Error {
  constructor(message){super(message);this.code='COOKIE_AUTH_REQUIRED';}
}
export class CookieTransport {
  constructor({cookieFile, request=fetch, intervalMs=1200}) { Object.assign(this,{cookieFile,request,intervalMs}); this.tail=Promise.resolve(); this.last=0; this.identities={}; }
  status(platform) { return {ready:Boolean(this.cookieFile),canPublish:false,identity:this.identities[platform]??null,reason:this.cookieFile?'Chrome Cookie · 只读采集':'尚未导入 Chrome Cookie'}; }
  async get(platform, url, {signal,accept='application/json',anonymous=false}={}) {
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||!HOSTS[platform]?.has(parsed.hostname))throw new Error('拒绝向非平台地址发送Cookie');
    if(anonymous&&(platform!=='github'||!/^\/[\w.-]+\/[\w.-]+\/releases(?:\/tag\/.+)?$/.test(parsed.pathname)))throw new Error('匿名回退仅支持GitHub Release网页');
    const work=async()=>{
      let cookie;
      if(!anonymous){
        if(!this.cookieFile)throw new CookieAuthenticationError('请先导入Chrome Cookie');
        const info=await stat(this.cookieFile);
        if(process.platform!=='win32'&&(info.mode&0o077))throw new Error('Cookie文件必须仅当前用户可读（0600）');
        const saved=JSON.parse(await readFile(this.cookieFile,'utf8'));
        const rows=saved.platforms?.[platform]??[];
        const applicable=rows.filter(row=>{
          const domain=row.domain.replace(/^\./,'');
          return (parsed.hostname===domain||(row.domain.startsWith('.')&&parsed.hostname.endsWith('.'+domain)))&&(parsed.pathname===row.path||parsed.pathname.startsWith(row.path.endsWith('/')?row.path:row.path+'/'))&&(!row.expires||row.expires>Date.now()/1000);
        });
        const login=platform==='github'?'user_session':'SESSDATA';
        if(!applicable.some(row=>row.name===login))throw new CookieAuthenticationError('登录Cookie缺失或已过期，请重新导入');
        cookie=applicable.map(row=>`${row.name}=${row.value}`).join('; ');
      }
      const delay=Math.max(0,this.last+this.intervalMs-Date.now());
      if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      signal?.throwIfAborted();this.last=Date.now();
      let response;
      try { response=await this.request(parsed.href,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),redirect:'manual',headers:{...(!anonymous?{Cookie:cookie}:{}),Accept:accept,'User-Agent':'Mozilla/5.0','Referer':platform==='bilibili'?'https://www.bilibili.com/':'https://github.com/'}}); }
      catch(error) { if(signal?.aborted)throw signal.reason; throw new Error('平台请求失败或超时；本轮未完成'); }
      if(response.status>=300&&response.status<400) {
        const location=response.headers.get('location');
        const next=location?new URL(location,parsed):null;
        if(!anonymous&&platform==='github'&&next?.origin==='https://github.com'&&!next.username&&!next.password&&next.pathname==='/login')throw new CookieAuthenticationError('GitHub要求跳转登录，请更新Chrome Cookie');
        const diffPath=parsed.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\.diff$/);
        if(platform==='github'&&diffPath&&next?.protocol==='https:'&&next.hostname==='patch-diff.githubusercontent.com'&&!next.port&&next.pathname===`/raw/${diffPath[1]}/${diffPath[2]}/pull/${diffPath[3]}.diff`) {
          // GitHub issues this narrowly scoped download URL. Never forward Chrome cookies.
          response=await this.request(next.href,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),headers:{Accept:'text/plain'}}).catch(()=>{throw new Error('GitHub变更下载失败');});
        } else throw new Error('平台要求跳转，登录状态或目标地址需检查');
      }
      if(!response.ok){if(!anonymous&&platform==='github'&&response.status===401)throw new CookieAuthenticationError('GitHub登录失效（HTTP 401），请更新Chrome Cookie');const error=new Error(`平台读取失败（HTTP ${response.status}）`);error.retryMs=[403,412,429].includes(response.status)?30*60000:60000;throw error;}
      return response;
    };
    const result=this.tail.catch(()=>{}).then(work);this.tail=result.catch(()=>{});return result;
  }
  async json(platform,url,options) {
    const response=await this.get(platform,url,options);let result;
    try{result=await response.json();}catch{throw new Error('平台未返回有效JSON，可能需要重新登录或完成验证');}
    if(platform==='bilibili'&&result.code!==0){const error=new Error(`B站读取失败（code ${result.code}）；本轮未完成`);error.retryMs=[-412,-509,-352,12002].includes(result.code)?30*60000:60000;throw error;}
    return platform==='bilibili'?result.data:result;
  }
}
