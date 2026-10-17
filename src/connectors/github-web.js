import {load} from 'cheerio';
const contentText=($,node)=>$(node).text().trim();
export function parsePage(html) {
  const $=load(html),login=$('meta[name="user-login"]').attr('content');
  if(!login)throw new Error('GitHub未识别到登录身份，请更新Chrome Cookie');
  let payload;
  try {payload=JSON.parse($('script[data-target="react-app.embeddedData"]').text()).payload;} catch {throw new Error('GitHub页面结构发生变化，未推进采集基线');}
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
export class GitHubWebConnector {
  constructor(transport,{maxPages=100}={}){this.transport=transport;this.maxPages=maxPages;}
  status(){return this.transport.status('github');}
  async page(path,options){
    const response=await this.transport.get('github',`https://github.com${path}`,{...options,accept:'text/html'});
    const result=parsePage(await response.text());this.transport.identities.github={name:result.login};return result;
  }
  async fetch(source,options={}){
    if(source.types.includes('release'))throw new Error('Cookie采集暂支持Issue和PR；Release请单独使用公开来源');
    const items=[];
    for(const kind of source.types){
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
    return {complete:true,items,metadata:{issues:items.filter(x=>x.kind==='issue').length,prs:items.filter(x=>x.kind==='pr').length,limitedContexts:items.filter(x=>!x.payload.contextComplete).length}};
  }
  async getItem(source,item,options){const row={number:item.payload.number,commentCount:0};const page=await this.page(`/${source.target}/${item.kind==='pr'?'pull':'issues'}/${row.number}`,options);return item.kind==='pr'?parsePull(page,source.target,row):parseIssue(page,source.target,row);}
}
