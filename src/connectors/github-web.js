import {load} from 'cheerio';
import {CookieAuthenticationError} from './cookies.js';
const contentText=($,node)=>$(node).text().trim();
export function parsePage(html,{structured=true,authenticated=true}={}) {
  const $=load(html),login=$('meta[name="user-login"]').attr('content');
  if(authenticated&&!login)throw new CookieAuthenticationError('GitHub未识别到登录身份，请更新Chrome Cookie');
  let payload;
  if(structured)try {payload=JSON.parse($('script[data-target="react-app.embeddedData"]').text()).payload;} catch {throw new Error('GitHub页面结构发生变化，未推进采集基线');}
  return {$,payload,login};
}
export function parseListing(page,kind) {
  const route=kind==='pr'?page.payload.repoPullsDashboardContentRoute:page.payload.issuesIndexContentRoute;
  if(!route)throw new Error('GitHub来源列表不可用');
  if(kind==='issue'&&!route.results&&/0 results.*No results/s.test(page.$('[data-testid="issues-list-surface"]').text()))return {rows:[],pages:1,total:0};
  const rows=kind==='pr'?route.results:route.results?.map(row=>row.issue);
  const pages=kind==='pr'?route.totalPages:route.pageInfo?.totalPages,total=kind==='pr'?route.totalCount:route.pageInfo?.totalCount;
  if(!Array.isArray(rows)||rows.some(row=>!Number.isInteger(row?.number))||!Number.isInteger(total)||!Number.isInteger(pages))throw new Error('GitHub列表分页结构不完整');
  return {rows,pages:Math.max(1,pages),total};
}
export function parseIssue(page,repo,row) {
  const issue=page.payload.issueViewerRoute?.data?.repository?.issue;
  if(!issue||issue.number!==row.number)throw new Error('GitHub Issue详情不可用');
  const comments=new Map();
  for(const timeline of [issue.timelineItems,issue.backTimelineItems])for(const edge of timeline?.edges??[]){const node=edge.node;if(node?.__typename==='IssueComment')comments.set(node.id,{id:String(node.databaseId??node.id),author:node.author?.login??'',body:node.body??'',updatedAt:node.lastEditedAt??node.createdAt});}
  const complete=comments.size===issue.totalCommentsCount;
  return {remoteId:`issue:${issue.databaseId}`,kind:'issue',title:issue.title,body:issue.body??'',url:`https://github.com/${repo}/issues/${row.number}`,payload:{number:row.number,state:issue.state,comments:[...comments.values()],contextComplete:complete,contextLimit:complete?'已读取Issue正文及全部页面可见评论；未检查仓库代码或复现。':'讨论存在尚未取得的评论，仅展示已读取部分，不执行核实分析。'}};
}
export function parsePull(page,repo,row) {
  const {$,payload}=page,pr=payload.pullRequestsLayoutRoute?.pullRequest;
  if(!pr||pr.number!==row.number)throw new Error('GitHub PR详情不可用');
  let body='',author='',issueId;const comments=[];
  $('.comment-body').not('.js-preview-body').each((i,e)=>{
    const container=$(e).closest('[id]'),id=container.attr('id')??'';
    const text=contentText($,e);if(!text)return;
    const login=$(e).closest('.js-comment-container').find('.author').first().text().trim();
    if(id.startsWith('pullrequest-')){body=text;author=login;}
    else comments.push({id,author:login,body:text});
  });
  for(const element of $('include-fragment[src]').toArray()) {const src=$(element).attr('src');const match=src.match(/textarea_id=issue-(\d+)-body/);if(match)issueId=match[1];}
  // The web page does not prove review-thread exhaustion; retain partial data for reading only.
  const complete=false;
  return {remoteId:`pr:${issueId??'web-'+row.number}`,kind:'pr',title:pr.title,body,url:`https://github.com/${repo}/pull/${row.number}`,payload:{number:row.number,head:pr.headSha,state:pr.state,author,comments,contextComplete:complete,contextLimit:'已读取网页讨论与PR diff；未执行代码或测试，未取完整仓库。尚未验证全部审查线程及diff对应提交的一致性，仅展示采集内容，不自动分析。'}};
}
function releasePage(page,repo) {
  const {$}=page;
  if($('meta[name="route-controller"]').attr('content')!=='releases'||$('meta[name="octolytics-dimension-repository_nwo"]').attr('content')?.toLowerCase()!==repo.toLowerCase())throw new Error('GitHub Release页面或仓库不匹配');
  return $;
}
function releaseLink(href,repo) {
  const url=new URL(href,'https://github.com'),prefix=`/${repo}/releases/tag/`;
  if(url.origin!=='https://github.com'||url.username||url.password||url.search||url.hash||!url.pathname.toLowerCase().startsWith(prefix.toLowerCase()))throw new Error('GitHub Release标签链接无效');
  const tag=decodeURIComponent(url.pathname.slice(prefix.length));
  if(!tag)throw new Error('GitHub Release标签缺失');
  return {tag,path:`/${repo}/releases/tag/${encodeURIComponent(tag)}`};
}
export function parseReleaseListing(page,repo,pageNumber=1) {
  const $=releasePage(page,repo),rows=[];
  $('section[data-release-anchor]').each((i,element)=>{
    const link=$(element).find('a[href*="/releases/tag/"]').first();
    if(!link.length)throw new Error('GitHub Release列表结构不完整');
    rows.push(releaseLink(link.attr('href'),repo));
  });
  if(!rows.length&&!/There (?:aren[’']t any|are no) releases here/i.test($('.blankslate').text()))throw new Error('GitHub Release列表不可识别，未推进采集基线');
  const pagination=$('.pagination'),nextLink=pagination.find('a[rel="next"],a.next_page');let next=null;
  if(nextLink.length){
    const url=new URL(nextLink.first().attr('href'),'https://github.com');
    if(url.origin!=='https://github.com'||url.username||url.password||url.hash||url.pathname.toLowerCase()!==`/${repo}/releases`.toLowerCase()||url.searchParams.get('page')!==String(pageNumber+1)||[...url.searchParams.keys()].some(key=>key!=='page'))throw new Error('GitHub Release分页地址无效');
    next=`/${repo}/releases?page=${pageNumber+1}`;
  }else if(pagination.length&&!pagination.find('.next_page.disabled,[aria-label="Next page"][aria-disabled="true"]').length)throw new Error('GitHub Release分页结构不完整');
  if(!rows.length&&next)throw new Error('GitHub Release分页为空，未推进采集基线');
  return {rows,next};
}
export function parseRelease(page,repo,row) {
  const $=releasePage(page,repo),canonical=releaseLink($('meta[property="og:url"]').attr('content'),repo);
  const container=$('h1').filter((i,e)=>$(e).closest('.Box-body').length).closest('.Box-body');
  const title=container.find('h1').first().text().trim(),publishedAt=container.find('relative-time[datetime]').first().attr('datetime');
  const assetPath=`/${repo}/releases/expanded_assets/${encodeURIComponent(row.tag)}`;
  const hasAssets=container.closest('.Box').find('include-fragment[src]').toArray().some(e=>{
    const url=new URL($(e).attr('src'),'https://github.com');return url.origin==='https://github.com'&&decodeURIComponent(url.pathname)===decodeURIComponent(assetPath);
  });
  if(canonical.tag!==row.tag||container.length!==1||!title||!publishedAt||!Number.isFinite(Date.parse(publishedAt))||!hasAssets)throw new Error('GitHub Release详情结构不完整或标签已变化');
  const body=container.find('[data-test-selector="body-content"]').clone();
  body.find('br').replaceWith('\n');body.find('p,li,h1,h2,h3,h4,h5,h6,pre,blockquote').append('\n');
  return {remoteId:`release:web-${row.tag}`,kind:'release',title,body:body.text().trim(),url:`https://github.com${canonical.path}`,payload:{tag:row.tag,prerelease:container.find('.Label').toArray().some(e=>$(e).text().trim()==='Pre-release'),publishedAt,contextComplete:true,contextLimit:'已读取Release标题、说明及发布时间；不包含附件内容或关联讨论。'}};
}
export class GitHubWebConnector {
  constructor(transport,{maxPages=100}={}){this.transport=transport;this.maxPages=maxPages;}
  status(){const status=this.transport.status('github');return this.cookieAuthError?{...status,identity:null,reason:'GitHub Cookie需更新；公开Release可匿名读取'}:status;}
  async page(path,options,structured=true,anonymous=false){
    try{
      const response=await this.transport.get('github',`https://github.com${path}`,{...options,accept:'text/html',anonymous});
      const result=parsePage(await response.text(),{structured,authenticated:!anonymous});
      if(!anonymous){this.transport.identities.github={name:result.login};this.cookieAuthError=null;}
      return result;
    }catch(error){
      if(error instanceof CookieAuthenticationError){delete this.transport.identities.github;this.cookieAuthError=error.message;}
      throw error;
    }
  }
  async withReleaseAccess(read){
    try{return {result:await read(false),access:'cookie',fallbackReason:null};}
    catch(error){
      if(!(error instanceof CookieAuthenticationError))throw error;
      return {result:await read(true),access:'public',fallbackReason:error.message};
    }
  }
  async releases(source,options,anonymous=false){
    const rows=new Map();let next=`/${source.target}/releases`,first;
    for(let pageNumber=1;next;pageNumber++){
      if(pageNumber>this.maxPages)throw new Error('GitHub Release列表超过分页上限，未推进采集基线');
      const parsed=parseReleaseListing(await this.page(next,options,false,anonymous),source.target,pageNumber);
      if(pageNumber===1)first=JSON.stringify(parsed);
      const before=rows.size;for(const row of parsed.rows)rows.set(row.tag,row);
      if(parsed.next&&rows.size===before)throw new Error('GitHub Release分页未取得新内容');
      next=parsed.next;
    }
    const items=[];
    for(const row of rows.values())items.push(parseRelease(await this.page(row.path,options,false,anonymous),source.target,row));
    const latest=parseReleaseListing(await this.page(`/${source.target}/releases`,options,false,anonymous),source.target);
    if(JSON.stringify(latest)!==first)throw new Error('GitHub Release列表在采集期间发生变化，请重新采集');
    return items;
  }
  async fetch(source,options={}){
    const items=[];let releaseMetadata={};
    for(const kind of source.types){
      if(kind==='release'){const batch=await this.withReleaseAccess(anonymous=>this.releases(source,options,anonymous));items.push(...batch.result);releaseMetadata={releaseAccess:batch.access,releaseFallbackReason:batch.fallbackReason};continue;}
      const route=kind==='pr'?'pulls':'issues',rows=new Map();let pages=1,total;
      for(let page=1;page<=pages;page++){
        const parsed=parseListing(await this.page(`/${source.target}/${route}?q=is%3A${kind==='pr'?'pr':'issue'}&page=${page}`,options),kind);
        pages=parsed.pages;if(pages>this.maxPages)throw new Error('GitHub列表超过分页上限');
        if(total!==undefined&&total!==parsed.total)throw new Error('GitHub列表在分页期间发生变化，请重新采集');total=parsed.total;
        for(const row of parsed.rows)rows.set(row.number,row);
      }
      if(rows.size!==total)throw new Error('GitHub列表未完整取得，本轮未推进基线');
      for(const row of rows.values()){
        const page=await this.page(`/${source.target}/${kind==='pr'?'pull':'issues'}/${row.number}`,options);
        const item=kind==='pr'?parsePull(page,source.target,row):parseIssue(page,source.target,row);
        if(kind==='pr'){
          try {
            const diff=await(await this.transport.get('github',`https://github.com/${source.target}/pull/${row.number}.diff`,{...options,accept:'text/plain'})).text();
            if(diff.length>2_000_000||diff&&!diff.startsWith('diff --git '))throw new Error('PR变更未完整读取或过大');
            item.payload.diff=diff;
          }catch(error){item.payload.contextComplete=false;item.payload.contextLimit=error.message;}
        }
        items.push(item);
      }
    }
    return {complete:true,items,metadata:{issues:items.filter(x=>x.kind==='issue').length,prs:items.filter(x=>x.kind==='pr').length,releases:items.filter(x=>x.kind==='release').length,limitedContexts:items.filter(x=>!x.payload.contextComplete).length,...releaseMetadata}};
  }
  async getItem(source,item,options){if(item.kind==='release'){const row={tag:item.payload.tag};return(await this.withReleaseAccess(async anonymous=>parseRelease(await this.page(`/${source.target}/releases/tag/${encodeURIComponent(row.tag)}`,options,false,anonymous),source.target,row))).result;}const row={number:item.payload.number,commentCount:0};const page=await this.page(`/${source.target}/${item.kind==='pr'?'pull':'issues'}/${row.number}`,options);return item.kind==='pr'?parsePull(page,source.target,row):parseIssue(page,source.target,row);}
}
