// Minimal POST helper using node:http.
//
// Node's global fetch (undici) enforces a 300s headers/body timeout that
// AbortSignal.timeout does NOT override, so any request whose first byte takes
// longer than that dies with an unhelpful "fetch failed". Prompt evaluation on
// this machine routinely exceeds 300s, so we use node:http, which imposes no
// timeout of its own.
//
// This is very likely the same 300s ceiling that made pi report "Request timed
// out" on deep sessions: the OpenAI SDK runs on the same HTTP stack.
import http from "node:http";

export function postJson(path, body, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: 8080,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* leave null; caller inspects raw */
          }
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error("client timeout")));
    }
    req.on("error", reject);
    req.end(payload);
  });
}
