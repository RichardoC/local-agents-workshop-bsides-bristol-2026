// Logging proxy in front of llamafile.
//
// Unlike the first version, this one ABORTS the upstream request when the client
// disconnects. Without that, an abandoned request keeps occupying llamafile's
// single slot and every subsequent request queues behind it, which manufactures
// exactly the pile-up we are trying to measure.
import http from "node:http";
import { appendFileSync } from "node:fs";

const LOG = "/workspace/proxy.log";

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const started = Date.now();
      appendFileSync(
        LOG,
        `\n===== ${new Date().toISOString()} ${req.method} ${req.url} =====\n` +
          `HEADERS: ${JSON.stringify(req.headers)}\n` +
          `BODY_BYTES: ${body.length}\n` +
          `BODY_HEAD: ${body.slice(0, 400)}\n` +
          `PARAMS: ${(body.match(/"(max_completion_tokens|temperature|top_p|top_k|repeat_penalty)":[0-9.]+/g) || []).join(" ")}\n`,
      );

      const proxied = http.request(
        {
          hostname: "127.0.0.1",
          port: 8080,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: "127.0.0.1:8080" },
        },
        (up) => {
          const outChunks = [];
          up.on("data", (c) => outChunks.push(c));
          up.on("end", () => {
            const out = Buffer.concat(outChunks).toString("utf8");
            const finishes = (out.match(/"finish_reason":"[a-z_]+"/g) || []).join(" ");
            appendFileSync(
              LOG,
              `RESPONSE ${up.statusCode} after ${Math.round((Date.now() - started) / 1000)}s  FINISH: ${finishes}\n`,
            );
          });
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );

      // The important bit: if the client gives up, tear down upstream too.
      const abort = () => {
        if (!proxied.destroyed) {
          appendFileSync(
            LOG,
            `CLIENT DISCONNECTED after ${Math.round((Date.now() - started) / 1000)}s - aborting upstream\n`,
          );
          proxied.destroy();
        }
      };
      res.on("close", abort);
      req.on("aborted", abort);

      proxied.on("error", (e) => {
        appendFileSync(LOG, `UPSTREAM ERROR: ${e.message}\n`);
        if (!res.headersSent) res.writeHead(502);
        res.end("proxy error");
      });
      proxied.end(body);
    });
  })
  .listen(8081, "127.0.0.1", () => console.log("logging proxy on 8081 -> 8080"));
