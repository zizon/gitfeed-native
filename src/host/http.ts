// The one HTTP surface the native Client page talks to. It runs on the
// Harness web server under /gitfeed/api; no separate port or process.

const PREFIX = "/gitfeed/api";
const MAX_BODY = 1024 * 1024;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-gitfeed": "native"
  });
  res.end(body);
}

function sendEmpty(res, status, headers = {}) {
  res.writeHead(status, Object.assign({ "cache-control": "no-store" }, headers || {}));
  res.end();
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (err) {
    return false;
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    throw new Error("invalid JSON body");
  }
}

function message(err) {
  return String((err && err.message) || err || "unknown error").trim() || "unknown error";
}

/**
 * Create the Node request handler mounted at the web server prefix.
 * @param {object} service Host reader created by `createGitfeed`.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createHandler(service) {
  return async function handle(req, res) {
    try {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: "cross-origin request refused" });
        return;
      }
      const url = new URL(req.url || "/", "http://gitfeed.local");
      if (url.pathname !== PREFIX && url.pathname.indexOf(PREFIX + "/") !== 0) {
        sendJson(res, 404, { ok: false, error: "no such endpoint" });
        return;
      }
      const route = url.pathname.slice(PREFIX.length) || "/";
      const method = req.method || "GET";
      const known = new Set(["/state", "/mark", "/star", "/feeds", "/feeds/remove", "/fetch", "/pull", "/sync"]);
      if (!known.has(route)) {
        sendJson(res, 404, { ok: false, error: "no such endpoint" });
        return;
      }

      if (route === "/state" && (method === "GET" || method === "HEAD")) {
        const known = url.searchParams.get("version") || undefined;
        const state = await service.getState(known);
        if (method === "HEAD") {
          sendEmpty(res, 200);
          return;
        }
        sendJson(res, 200, state);
        return;
      }

      if (method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }

      const input = await readBody(req);

      if (route === "/mark") {
        const result = await service.mark(input.ids, input.read !== false);
        sendJson(res, 200, result);
        return;
      }
      if (route === "/star") {
        const result = await service.star(input.ids, input.star !== false);
        sendJson(res, 200, result);
        return;
      }
      if (route === "/feeds") {
        const feed = await service.addFeed({ url: input.url, folder: input.folder });
        sendJson(res, 200, { ok: true, feed: feed });
        return;
      }
      if (route === "/feeds/remove") {
        const result = await service.removeFeed(input.id);
        sendJson(res, 200, result);
        return;
      }
      if (route === "/fetch") {
        const result = await service.runLocalFetch();
        sendJson(res, 200, {
          ok: result.code === 0,
          action: "fetch",
          output: result.summary,
          error: result.code === 0 ? undefined : result.summary,
          fresh: result.fresh,
          failed: result.failed,
          logs: result.logs.slice(-8)
        });
        return;
      }
      if (route === "/pull") {
        const result = await service.pull();
        sendJson(res, 200, result);
        return;
      }
      if (route === "/sync") {
        const result = await service.sync();
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { ok: false, error: "no such endpoint" });
    } catch (err) {
      const status = /too large|invalid JSON/.test(message(err)) ? 400 : 500;
      if (!res.headersSent) sendJson(res, status, { ok: false, error: message(err) });
      else res.end();
    }
  };
}
