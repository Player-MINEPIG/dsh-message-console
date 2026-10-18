const ROOT = "/api/dsh-message-console";
async function jsonBody(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) throw new Error("请求过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function createHandler(service, admission) {
  return async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(data));
    };
    try {
      const accepted = admission(req);
      if (!accepted || "rejection" in accepted) return send(accepted?.rejection ?? 403, { error: "宿主认证未通过" });
      const url = new URL(req.url, "http://local");
      if (!url.pathname.startsWith(`${ROOT}/`)) return send(404, { error: "路径不存在" });
      const path = url.pathname.slice(ROOT.length).split("/").filter(Boolean).map(decodeURIComponent), key = path.join("/"), query = Object.fromEntries(url.searchParams);
      if (req.method === "GET") {
        let result2;
        if (key === "learning") result2 = service.learningList(query);
        else if (path[0] === "learning" && path.length === 2) result2 = service.learning(path[1]);
        else if (key === "overview") result2 = service.overview(query);
        else if (key === "session-directory") result2 = service.sessionDirectory(query);
        else if (key === "catalog") result2 = await service.catalog();
        else if (path[0] === "catalog" && path[1] === "models" && path.length === 3) result2 = await service.models(path[2]);
        else if (key === "workspaces") result2 = await service.workspaces.list();
        else if (path[0] === "sources" && ["suggest", "preview"].includes(path[1])) return send(405, { error: "不支持此方法" });
        else if (path[0] === "drafts" && path.length === 2) result2 = service.draft(path[1]);
        else if (path[0] === "sources" && path.length === 2) result2 = service.source(path[1]);
        else if (path[0] === "sources" && path[2] === "items" && path.length === 3) result2 = service.items(path[1], query);
        else if (path[0] === "items" && path.length === 2) result2 = service.item(path[1], query.version);
        else if (path[0] === "items" && path.length === 3) {
          if (path[2] === "feedback") result2 = service.feedback(path[1]);
          else if (path[2] === "content") result2 = service.content(path[1], query);
          else if (path[2] === "comments") result2 = service.comments(path[1], query.version, query);
          else if (["runs", "drafts", "versions"].includes(path[2])) result2 = service[path[2]](path[1], query);
          else return send(404, { error: "路径不存在" });
        } else if (path[0] === "runs" && path[2] === "decision" && path.length === 3) result2 = service.decision(path[1]);
        else return send(404, { error: "路径不存在" });
        return send(200, result2);
      }
      if (req.method !== "POST") return send(405, { error: "不支持此方法" });
      if (req.headers["x-dsh-message-console"] !== "1" || !req.headers["content-type"]?.startsWith("application/json")) return send(403, { error: "请求来源校验失败" });
      const body = await jsonBody(req);
      let result = { ok: true };
      if (key === "read-all") result = service.markAllRead(body);
      else if (key === "learning") result = await service.startLearning(body);
      else if (path[0] === "learning" && path.length === 3 && path[2] === "apply") result = await service.applyLearning(path[1], body);
      else if (path[0] === "learning" && path.length === 3 && path[2] === "reject") result = service.rejectLearning(path[1], body);
      else if (path[0] === "learning" && path.length === 3 && path[2] === "retry") result = service.retryLearning(path[1]);
      else if (key === "settings") await service.configure(body);
      else if (key === "sources/suggest") result = await service.suggestSource(body);
      else if (key === "sources/preview") result = await service.previewInput(body);
      else if (path[0] === "sources" && path.length === 1) result = await service.saveSource(body);
      else if (path[0] === "sources" && path.length === 2) result = await service.saveSource(body, path[1]);
      else if (path[0] === "sources" && path[2] === "refresh" && path.length === 3) result = await service.refresh(path[1]);
      else if (path[0] === "sources" && path[2] === "organize" && path.length === 3) result = await service.organize(path[1], { scope: "history" });
      else if (path[0] === "items" && path[2] === "feedback" && path.length === 3) result = service.saveFeedback(path[1], body);
      else if (path[0] === "items" && path[2] === "read" && path.length === 3) await service.markRead(path[1], body.version);
      else if (path[0] === "items" && path[2] === "handling" && path.length === 3) await service.setHandling(path[1], body.handling);
      else if (path[0] === "items" && path[2] === "conversation" && path.length === 3) result = await service.openConversation(path[1]);
      else if (path[0] === "drafts" && path[2] === "publish" && path.length === 3) result = await service.approveAndPublish(path[1], body);
      else if (path[0] === "drafts" && path[2] === "dismiss" && path.length === 3) await service.dismissDraft(path[1]);
      else if (path[0] === "drafts" && path[2] === "supervise" && path.length === 3) result = await service.superviseDraft(path[1], body);
      else return send(404, { error: "操作不存在" });
      return send(200, result);
    } catch (error) {
      return send(400, { error: String(error.publicMessage ?? error.message).slice(0, 1e3) });
    }
  };
}
export {
  createHandler
};
