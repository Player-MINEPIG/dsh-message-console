import { fetchPrivateMessages } from './bilibili-private.js';
import { commentImages } from '../images.js';
const pageCount=page=>{if(!Number.isInteger(page?.count)||page.count<0||!Number.isInteger(page.size)||page.size<1)throw new Error('B站分页计数缺失或无效');return page.count;};
export class BilibiliConnector {
  constructor(transport,{maxPages=200}={}) { this.transport=transport;this.maxPages=maxPages; }
  status(){return this.transport.status('bilibili');}
  async call(path,params,options) { return this.transport.json('bilibili',`https://api.bilibili.com${path}?${new URLSearchParams(params)}`,options); }
  async identity(options={}) {
    const value=await this.call('/x/web-interface/nav',{},options);
    if(!value.isLogin||!Number.isSafeInteger(Number(value.mid))||Number(value.mid)<1)throw new Error('B站Cookie已失效，请重新导入');
    const identity={id:String(value.mid),name:value.uname};
    this.transport.identities.bilibili=identity;
    return identity;
  }
  async metadata(source,options={}){
    if(source.types?.includes('private-message')) { const identity=await this.identity(options);return {name:`${identity.name||'B站'}的私信`,description:'统一查看联系人私信，仅评定重要程度，不拟回复。',tags:['私信'],access:'cookie',note:'保存时绑定当前账号。初次采集每位联系人最近100条，后续累积新增消息。'}; }
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
    if(source.types?.includes('private-message'))return fetchPrivateMessages(this,source,options);
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
      const comment=row=>({id:String(row.rpid_str??row.rpid),parent:String(row.parent_str??row.parent??0),author:row.member?.uname??'',authorId:String(row.mid??row.member?.mid??''),body:row.content?.message??'',createdAt:row.ctime,...commentImages(row.content)});
      const latestTime=Math.max(0,...[root,...replies.values()].map(row=>Number(row.ctime)).filter(value=>Number.isFinite(value)&&value>0));
      const rootImages=commentImages(root.content),message=root.content?.message??'';
      items.push({rootAuthorId:String(root.mid??root.member?.mid??''),remoteId:`comment:${video.aid}:${rootId}`,kind:'comment',title:message.trim()?message.slice(0,100):rootImages.images?.length?'图片评论':'评论',body:root.content?.message??'',url:`https://www.bilibili.com/video/${video.bvid}/#reply${rootId}`,updatedAt:latestTime?new Date(latestTime*1000).toISOString():null,payload:{bvid:video.bvid,aid:String(video.aid),root:rootId,author:root.member?.uname??'',...rootImages,video:{title:video.title,description:video.desc,owner:video.owner?.name},comments:[...replies.values()].map(comment).sort((a,b)=>a.id.localeCompare(b.id))}});
    }
    if(items.length+items.reduce((n,x)=>n+x.payload.comments.length,0)!==totalCount)throw new Error('B站评论总数与已采集内容不一致，本轮不推进基线');
    return {complete:true,items,metadata:{title:video.title,bvid:video.bvid,threads:items.length,replies:items.reduce((n,x)=>n+x.payload.comments.length,0)}};
  }
  async publish(source,item,draft,{actionId,signal,beforeSend}={}) {
    const id=value=>(typeof value==='string'&&/^[1-9]\d*$/.test(value))||(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)?String(value):null;
    const aid=id(item?.payload?.aid),root=id(item?.payload?.root);
    const parent=draft?.replyToCommentId===undefined&&!draft?.automatic?root:id(draft?.replyToCommentId);
    const bvid=item?.payload?.bvid;
    const matches=typeof source?.target==='string'&&(source.target===`av${aid}`||/^BV[0-9A-Za-z]{10}$/.test(bvid??'')&&source.target===bvid);
    const targetInThread=parent===root||Array.isArray(item?.payload?.comments)&&item.payload.comments.some(comment=>id(comment.id)===parent);
    if((source?.platform&&source.platform!=='bilibili')||item?.kind!=='comment'||!aid||!root||!parent||!matches||
      (item.remoteId&&item.remoteId!==`comment:${aid}:${root}`)||!targetInThread||typeof draft?.body!=='string'||
      !draft.body.trim()||[...draft.body].length>1000||typeof this.transport.postComment!=='function'){
      const error=new Error('B站评论发送目标、来源、正文或发布能力无效');error.definitelyNotSent=true;throw error;
    }
    const data=await this.transport.postComment({oid:aid,root,parent,message:draft.body},{signal,beforeSend});
    const remoteId=id(data?.rpid_str??data?.rpid),reply=data?.reply;
    const needsCaptcha=[data,reply].some(value=>value?.need_captcha!==undefined&&![false,0,'0'].includes(value.need_captcha));
    if(!remoteId||data.success===false||needsCaptcha||id(reply?.rpid_str??reply?.rpid)!==remoteId||
      id(reply?.root_str??reply?.root)!==root||id(reply?.parent_str??reply?.parent)!==parent||
      (reply?.oid!==undefined&&id(reply.oid)!==aid))throw new Error('B站评论回执不完整、目标不匹配或需要验证码，发送结果未确认，请核实远端，勿重复发送');
    return {
      remoteId,url:`https://www.bilibili.com/video/${/^BV[0-9A-Za-z]{10}$/.test(bvid??'')?bvid:`av${aid}`}/#reply${remoteId}`,
      aid,root,parent,authorId:id(reply?.mid??reply?.member?.mid)??this.transport.identities?.bilibili?.id??null,
      body:draft.body,...(typeof actionId==='string'?{actionId}:{}),
    };
  }
  async getItem(source,item,options){return(await this.fetch(source,options)).items.find(x=>x.remoteId===item.remoteId);}
}
