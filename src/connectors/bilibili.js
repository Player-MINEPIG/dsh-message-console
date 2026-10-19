const pageCount=page=>{if(!Number.isInteger(page?.count)||page.count<0||!Number.isInteger(page.size)||page.size<1)throw new Error('B站分页计数缺失或无效');return page.count;};
export class BilibiliConnector {
  constructor(transport,{maxPages=200}={}) { this.transport=transport;this.maxPages=maxPages; }
  status(){return this.transport.status('bilibili');}
  async call(path,params,options) { return this.transport.json('bilibili',`https://api.bilibili.com${path}?${new URLSearchParams(params)}`,options); }
  async metadata(source,options={}){
    const video=await this.call('/x/web-interface/view',source.target.startsWith('BV')?{bvid:source.target}:{aid:source.target.slice(2)},options);
    if(typeof video.title!=='string'||typeof video.desc!=='string'||!Number.isSafeInteger(video.aid)||video.aid<1||source.target.startsWith('BV')&&video.bvid!==source.target||source.target.startsWith('av')&&String(video.aid)!==source.target.slice(2))throw new Error('B站视频元信息结构不完整或目标不匹配');
    const categories=[...new Set([video.tname,video.tname_v2].filter(name=>typeof name==='string'&&name.trim()).map(name=>name.trim()))];
    let tags=[],note='已读取视频标签及可用分类；未读取评论。';
    options.signal?.throwIfAborted();
    try{
      const rows=await this.call('/x/tag/archive/tags',{aid:String(video.aid)},options);
      if(!Array.isArray(rows))throw new Error('标签响应结构无效');
      tags=rows.map(row=>row?.tag_name).filter(name=>typeof name==='string'&&name.trim()).map(name=>name.trim());
      if(!tags.length)note=categories.length?'平台未返回可用视频标签，已使用视频分类；可手动补充。':'平台未返回可用视频标签或分类，可手动补充标签。';
    }catch(error){
      if(options.signal?.aborted)throw options.signal.reason;
      if(error?.name==='AbortError'||error?.code==='ABORT_ERR')throw error;
      note=`视频标签读取失败：${String(error?.message??error).slice(0,180)}；已保留标题简介，可手动填写标签。`;
    }
    return {name:video.title,description:video.desc,tags:[...tags,...categories],access:'cookie',note};
  }
  async fetch(source,options={}) {
    const identity=await this.call('/x/web-interface/nav',{},options);
    if(!identity.isLogin)throw new Error('B站Cookie已失效，请重新导入');
    this.transport.identities.bilibili={id:String(identity.mid),name:identity.uname};
    const video=await this.call('/x/web-interface/view',source.target.startsWith('BV')?{bvid:source.target}:{aid:source.target.slice(2)},options);
    const roots=new Map();let exhausted=false,lastSignature='',totalCount;
    for(let pn=1;pn<=this.maxPages;pn++){
      const data=await this.call('/x/v2/reply',{type:1,oid:String(video.aid),pn,ps:20,sort:0},options);
      if(!data.page||!Array.isArray(data.replies)&&data.replies!==null)throw new Error('B站评论分页结构发生变化');
      const count=pageCount(data.page);if(totalCount!==undefined&&totalCount!==count)throw new Error('B站评论计数在采集期间发生变化');totalCount=count;
      const rows=data.replies??[];
      const signature=rows.map(row=>row.rpid_str??row.rpid).join(',');
      if(rows.length&&signature===lastSignature)throw new Error('B站评论分页重复，本轮未完成');
      lastSignature=signature;
      for(const row of [data.upper?.top,...(data.top_replies??[]),...rows].filter(Boolean))roots.set(String(row.rpid_str??row.rpid),row);
      if(rows.length<data.page.size){exhausted=true;break;}
    }
    if(!exhausted)throw new Error('B站根评论超过本轮分页上限，本轮未完成');
    const items=[];
    for(const [rootId,root] of roots){
      const replies=new Map();const expected=root.rcount;if(!Number.isInteger(expected)||expected<0)throw new Error('B站根评论回复计数无效');
      if(expected>0){
        let done=false,previous='';
        for(let pn=1;pn<=this.maxPages;pn++){
          const data=await this.call('/x/v2/reply/reply',{type:1,oid:String(video.aid),root:rootId,pn,ps:20},options);
          if(!data.page||!Array.isArray(data.replies)&&data.replies!==null)throw new Error('B站楼中楼分页结构发生变化');
          if(pageCount(data.page)!==expected)throw new Error('B站楼中楼计数变化或存在不可见回复');
          const rows=data.replies??[],signature=rows.map(row=>row.rpid_str??row.rpid).join(',');
          if(rows.length&&signature===previous)throw new Error('B站楼中楼分页重复，本轮未完成');previous=signature;
          for(const row of rows)replies.set(String(row.rpid_str??row.rpid),row);
          if(rows.length<data.page.size){done=true;break;}
        }
        if(!done)throw new Error('B站楼中楼超过分页上限，本轮未完成');
        if(replies.size!==expected)throw new Error('B站评论数量在采集期间发生变化或存在不可见回复，本轮未推进基线');
      }
      const comment=row=>({id:String(row.rpid_str??row.rpid),parent:String(row.parent_str??row.parent??0),author:row.member?.uname??'',authorId:String(row.mid??row.member?.mid??''),body:row.content?.message??'',createdAt:row.ctime});
      const latestTime=Math.max(0,...[root,...replies.values()].map(row=>Number(row.ctime)).filter(value=>Number.isFinite(value)&&value>0));
      items.push({remoteId:`comment:${video.aid}:${rootId}`,kind:'comment',title:(root.content?.message??'评论').slice(0,100),body:root.content?.message??'',url:`https://www.bilibili.com/video/${video.bvid}/#reply${rootId}`,updatedAt:latestTime?new Date(latestTime*1000).toISOString():null,payload:{bvid:video.bvid,aid:String(video.aid),root:rootId,author:root.member?.uname??'',video:{title:video.title,description:video.desc,owner:video.owner?.name},comments:[...replies.values()].map(comment).sort((a,b)=>a.id.localeCompare(b.id))}});
    }
    if(items.length+items.reduce((n,x)=>n+x.payload.comments.length,0)!==totalCount)throw new Error('B站评论总数与已采集内容不一致，本轮不推进基线');
    return {complete:true,items,metadata:{title:video.title,bvid:video.bvid,threads:items.length,replies:items.reduce((n,x)=>n+x.payload.comments.length,0)}};
  }
  async getItem(source,item,options){return(await this.fetch(source,options)).items.find(x=>x.remoteId===item.remoteId);}
}
