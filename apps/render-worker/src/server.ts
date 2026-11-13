import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { executeRenderJob, type RenderJobParams } from "./job.js";
import { executeRun, type RunParams } from "./run.js";

function json(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function startHttpServer(port = Number(process.env.PORT || 8080)) {
  const authKey = process.env.DONOVA_WORKER_KEY;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json(res, 200, {
        status: "ok",
        service: "donova-render-worker",
        version: "0.1.0",
        time: new Date().toISOString(),
      });
    }

    const authed = (() => {
      if (!authKey) return true;
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      return token === authKey;
    })();

    if (req.method === "POST" && url.pathname === "/render") {
      if (!authed) return json(res, 401, { error: "Unauthorized" });

      let params: RenderJobParams;
      try {
        const raw = await readBody(req);
        params = JSON.parse(raw);
      } catch (err) {
        return json(res, 400, { error: "Invalid JSON body" });
      }

      if (!params.bundleKey && !params.bundleUrl && !params.projectPrefix) {
        return json(res, 400, { error: "Missing bundleKey, bundleUrl, or projectPrefix" });
      }
      if (!params.outputKey && !params.uploadUrl) {
        return json(res, 400, { error: "Missing outputKey or uploadUrl" });
      }

      try {
        const result = await executeRenderJob(params);
        return json(res, 200, result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Render job failed:", err);
        return json(res, 500, { ok: false, error: message });
      }
    }

    if (req.method === "POST" && url.pathname === "/run") {
      if (!authed) return json(res, 401, { error: "Unauthorized" });

      let params: RunParams;
      try {
        const raw = await readBody(req);
        params = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: "Invalid JSON body" });
      }

      if (!params.cmd || !params.projectPrefix) {
        return json(res, 400, { error: "Missing cmd or projectPrefix" });
      }

      const result = await executeRun(params);
      return json(res, result.ok ? 200 : 500, result);
    }

    return json(res, 404, { error: "Not found" });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Donova render worker listening on http://0.0.0.0:${port}`);
  });

  return server;
}
