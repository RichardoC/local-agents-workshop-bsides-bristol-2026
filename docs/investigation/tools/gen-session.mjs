#!/usr/bin/env node
/**
 * gen-session.mjs — generate SYNTHETIC pi session files at a precise context depth.
 *
 *   node /workspace/gen-session.mjs --tokens <N> --id <sessionId> [--out <path>]
 *
 * Produces a pi 0.84.2 / session version 3 JSONL that reads like a genuine
 * phishing-triage conversation, built from REAL .eml samples and the REAL output
 * of the workshop's own triage library (extensions/lib/{eml,signals}.ts, rendered
 * with a byte-identical copy of phish-triage.ts's render()).
 *
 * WHAT "<N> TOKENS" MEANS HERE
 * ---------------------------
 * pi computes context depth from the LAST assistant message's usage object
 * (pi-ai/dist/utils/estimate.js -> getLastAssistantUsageInfo +
 * calculateContextTokens = usage.totalTokens || input+output+cacheRead+cacheWrite).
 * So the number that actually drives the experiment is the final assistant
 * message's usage.totalTokens, and this script pins that to --tokens.
 *
 * The usage objects are not decorative: they are derived from real token counts
 * of the real text in the file, so the declared depth and the actual content
 * agree. For every assistant message:
 *
 *   usage.input       = SYSTEM_OVERHEAD + tokens of all message content before it
 *   usage.output      = tokens of that assistant message's own content
 *   usage.totalTokens = input + output
 *   cacheRead/cacheWrite/reasoning = 0
 *
 * SYSTEM_OVERHEAD (1608) is not a guess: it is derived from the real session
 * file, whose first assistant message reports usage.input = 1626 against an
 * 18-token first user turn, i.e. 1608 tokens of system prompt + tool schemas
 * sitting in front of the conversation.
 *
 * Consequently the conversation text itself is built to (N - 1608) tokens, and
 * both numbers are printed at the end so they can be checked against each other.
 *
 * Token counting uses the local llamafile server's POST /tokenize when reachable
 * and falls back to Math.ceil(chars / 3.5) otherwise; the method used is always
 * printed.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

// The local llamafile must never go through the agent proxy.
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const REPO = "/workspace/local-agents-workshop-bsides-bristol-2026";
const SESSION_DIR = join(
  REPO,
  ".pi/agent/sessions/--workspace-local-agents-workshop-bsides-bristol-2026--",
);
const EMAIL_DIR_REL = "samples/phishing_pot/email";
const SERVER = "http://127.0.0.1:8080";

/** System prompt + tool definitions sitting in front of every request.
 *  Derived from the real session: usage.input 1626 - 18 tokens of first user turn. */
const SYSTEM_OVERHEAD = 1608;

/** Separator used when measuring "the concatenated text that would form the prompt". */
const JOIN = "\n";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tokens") out.tokens = Number(argv[++i]);
    else if (a === "--id") out.id = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.tokens || !args.id) {
  console.error(
    "Usage: node gen-session.mjs --tokens <N> --id <sessionId> [--out <path>]",
  );
  process.exit(args.help ? 0 : 1);
}
if (!Number.isFinite(args.tokens) || args.tokens < SYSTEM_OVERHEAD + 300) {
  console.error(
    `--tokens must be a number >= ${SYSTEM_OVERHEAD + 300} ` +
      `(${SYSTEM_OVERHEAD} of that is system prompt + tool definitions, which are ` +
      `present in any real run and cannot be undercut).`,
  );
  process.exit(1);
}

const TARGET = Math.floor(args.tokens);
const SESSION_ID = args.id;
/** Token budget for the conversation text itself. */
const CONTENT_BUDGET = TARGET - SYSTEM_OVERHEAD;

// ---------------------------------------------------------------------------
// seeded PRNG — the same --id reproduces the same session byte-for-byte (modulo time)
// ---------------------------------------------------------------------------

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(hashSeed(SESSION_ID));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const HEX = "0123456789abcdef";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const randStr = (n, alphabet) => {
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
};
const recordId = () => randStr(8, HEX); // real file: 8 lowercase hex
const toolCallId = () => randStr(32, ALNUM); // real file: 32 mixed-case alnum
const responseId = () => `chatcmpl-${randStr(32, ALNUM)}`; // real file: 32-char suffix

// ---------------------------------------------------------------------------
// token counting
// ---------------------------------------------------------------------------

let COUNT_METHOD = null; // "server" | "heuristic"

async function serverAvailable() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const health = await fetch(`${SERVER}/health`, { signal: ac.signal });
    clearTimeout(t);
    if (!health.ok) return false;
    // Prove POST /tokenize really exists and returns the expected shape.
    const ac2 = new AbortController();
    const t2 = setTimeout(() => ac2.abort(), 8000);
    const res = await fetch(`${SERVER}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "tokenizer probe" }),
      signal: ac2.signal,
    });
    clearTimeout(t2);
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body?.tokens) && body.tokens.length > 0;
  } catch {
    return false;
  }
}

const heuristic = (s) => Math.ceil(s.length / 3.5);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tokenize one string. Retries: the sample-pool phase blocks the event loop on
 * child processes for several seconds, which lets the server drop idle
 * keep-alive sockets — the next fetch then fails on a dead socket.
 */
async function tokenizeExact(text, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${SERVER}/tokenize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) throw new Error(`tokenize failed: HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body?.tokens)) throw new Error("tokenize: unexpected body");
      return body.tokens.length;
    } catch (err) {
      lastErr = err;
      await sleep(100 * (i + 1));
    }
  }
  throw new Error(
    `tokenize failed after ${attempts} attempts: ${lastErr?.cause?.message || lastErr?.message}`,
  );
}

const countCache = new Map();

async function count(text) {
  if (countCache.has(text)) return countCache.get(text);
  const n = COUNT_METHOD === "server" ? await tokenizeExact(text) : heuristic(text);
  countCache.set(text, n);
  return n;
}

/** Count many strings with bounded concurrency — batched, not one call per record. */
async function countMany(texts, concurrency = 8) {
  const results = new Array(texts.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, texts.length)) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= texts.length) return;
        results[i] = await count(texts[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// real triage data from the workshop's own libraries
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
import { readFileSync } from 'node:fs';
import { parseEmail } from './extensions/lib/eml.ts';
import { triage } from './extensions/lib/signals.ts';
const paths = JSON.parse(process.env.PATHS_JSON);
const out = [];
for (const p of paths) {
  try { out.push({ path: p, triage: triage(parseEmail(readFileSync(p))) }); }
  catch (err) { out.push({ path: p, error: String((err && err.message) || err) }); }
}
process.stdout.write(JSON.stringify(out));
`;

function triageBatch(relPaths) {
  const stdout = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", CHILD_SCRIPT],
    {
      cwd: REPO,
      env: { ...process.env, PATHS_JSON: JSON.stringify(relPaths) },
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).toString();
  return JSON.parse(stdout);
}

/** Byte-identical copy of render() from extensions/phish-triage.ts. */
function render(t, path) {
  const lines = [];
  lines.push(`FILE: ${path}`);
  lines.push(`SUBJECT: ${t.subject || "(none)"}`);
  lines.push(
    `FROM: display="${t.from.display}" address=${t.from.address || "(unparseable)"}`,
  );
  if (t.replyTo.address) lines.push(`REPLY-TO: ${t.replyTo.address}`);
  if (t.returnPath.address) lines.push(`RETURN-PATH: ${t.returnPath.address}`);
  lines.push(`DATE: ${t.date || "(none)"}`);
  lines.push(
    t.auth.absent
      ? "AUTH: no Authentication-Results header present"
      : `AUTH: spf=${t.auth.spf || "-"} dkim=${t.auth.dkim || "-"} dmarc=${t.auth.dmarc || "-"}`,
  );
  lines.push(`RECEIVED HOPS: ${t.hops}`);

  if (t.attachments.length) {
    lines.push("");
    lines.push("ATTACHMENTS:");
    for (const a of t.attachments) {
      lines.push(
        `  - ${a.filename || "(unnamed)"}  type=${a.declaredType}  ${a.bytes} bytes  sha256=${a.sha256.slice(0, 16)}...`,
      );
    }
  }

  const hosts = [...new Set(t.links.map((l) => l.hostname).filter(Boolean))];
  if (hosts.length) {
    lines.push("");
    lines.push(`LINK HOSTS (${hosts.length}): ${hosts.slice(0, 15).join(", ")}`);
  }

  lines.push("");
  if (t.signals.length === 0) {
    lines.push("DETERMINISTIC SIGNALS: none raised.");
  } else {
    lines.push(`DETERMINISTIC SIGNALS (${t.signals.length}):`);
    for (const s of t.signals) {
      lines.push(`  [${s.severity.toUpperCase()}] ${s.id}: ${s.detail}`);
    }
  }

  lines.push("");
  lines.push(
    "NOTE: signals above are facts extracted from the message itself. No DNS, " +
      "WHOIS or reputation lookup was performed, so SPF/DKIM/DMARC values are " +
      "what the receiving server recorded at delivery time, not a re-check.",
  );

  return lines.join("\n");
}

/** Deterministic, varied pool of usable real samples. */
function buildSamplePool(wanted) {
  const all = readdirSync(join(REPO, EMAIL_DIR_REL)).filter((f) => f.endsWith(".eml"));
  const shuffled = all.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const pool = [];
  const seenSubjects = new Set();
  let cursor = 0;
  while (pool.length < wanted && cursor < shuffled.length) {
    const names = shuffled.slice(cursor, cursor + 80);
    cursor += 80;
    if (!names.length) break;
    let results;
    try {
      results = triageBatch(names.map((n) => `${EMAIL_DIR_REL}/${n}`));
    } catch {
      continue;
    }
    for (const r of results) {
      if (pool.length >= wanted) break;
      if (r.error || !r.triage) continue;
      const t = r.triage;
      if (!t.subject || !t.from?.address) continue;
      if (!Array.isArray(t.signals) || t.signals.length === 0) continue;
      const text = render(t, r.path);
      if (text.length < 500 || text.length > 2400) continue; // keep turn sizes sane
      const key = t.subject.slice(0, 40).toLowerCase();
      if (seenSubjects.has(key)) continue; // avoid near-duplicate content
      seenSubjects.add(key);
      pool.push({ path: r.path, triage: t, text });
    }
  }
  return pool;
}

// ---------------------------------------------------------------------------
// conversation content
// ---------------------------------------------------------------------------

const shortName = (p) => p.split("/").pop();
const sev = (t, s) => t.signals.filter((x) => x.severity === s).length;
const hostsOf = (t) => [...new Set(t.links.map((l) => l.hostname).filter(Boolean))];

function verdictWord(t) {
  const high = sev(t, "high");
  if (high >= 2) return "almost certainly phishing";
  if (high === 1) return "likely phishing";
  if (sev(t, "medium") >= 2) return "suspicious, worth a second pair of eyes";
  return "low confidence — suspicious but not conclusive";
}

const FIRST_QUESTIONS = [
  (p) => `Is ${p} a phishing email?`,
  (p) => `Can you triage ${p} for me?`,
  (p) => `Take a look at ${p} — a user reported it this morning.`,
  (p) => `Run the triage tool over ${p} and tell me what you see.`,
];

const FOLLOW_QUESTIONS = [
  (p) => `Now check ${p} and tell me what you find.`,
  (p) => `Have a look at ${p} as well.`,
  (p) => `Next one: ${p}. Same treatment please.`,
  (p) => `Another report just came in — ${p}. Is it the same campaign?`,
  (p) => `Check ${p} too. I want to know if the auth results line up.`,
  (p) => `What does the triage tool say about ${p}?`,
  (p) => `Someone in finance forwarded ${p}. Worth escalating?`,
  (p) => `Triage ${p} next — it was quarantined but the user wants it released.`,
];

// Reflection turns pair a question with an answer that actually answers it —
// question and answer are generated together so they always refer to the same
// samples and the same facts.


function signalBullets(t, style) {
  return t.signals
    .map((s, i) => {
      const label = `[${s.severity.toUpperCase()}] ${s.id}`;
      if (style === "numbered") return `${i + 1}. **${label}** — ${s.detail}`;
      if (style === "dash") return `- **${label}**: ${s.detail}`;
      return `  * ${label}: ${s.detail}`;
    })
    .join("\n");
}

function authSentence(t) {
  if (t.auth.absent) {
    return "There is no Authentication-Results header on this message at all, so the receiving server recorded neither SPF, DKIM nor DMARC. That absence is itself worth noting, because legitimate bulk senders almost always land with some authentication verdict attached.";
  }
  const spf = t.auth.spf || "not recorded";
  const dkim = t.auth.dkim || "not recorded";
  const dmarc = t.auth.dmarc || "not recorded";
  const head = `Authentication as recorded at delivery: SPF ${spf}, DKIM ${dkim}, DMARC ${dmarc}.`;
  if (/^pass/i.test(dmarc)) {
    return `${head} DMARC passing means SPF or DKIM passed with an identifier aligned to the From domain, so the sending domain itself is genuine. That does not make the message safe — a real domain can still be compromised, newly registered for the purpose, or simply lying in its body text — but it does mean the From header is not spoofed.`;
  }
  if (/bestguess/i.test(dmarc)) {
    return `${head} A "bestguess" DMARC result means the domain publishes no DMARC record and the receiver applied a default policy, so nobody has told us what to do with unauthenticated mail from it. Treat it as unauthenticated rather than as a pass.`;
  }
  return `${head} DMARC only passes when SPF or DKIM passes and the passing identifier aligns with the From domain, so a DMARC result of ${dmarc} tells us the envelope and the visible From did not agree in a way the receiver was willing to trust.`;
}

function replyToSentence(t) {
  if (t.replyTo.address && t.replyTo.domain && t.replyTo.domain !== t.from.domain) {
    return `The Reply-To is ${t.replyTo.address} on ${t.replyTo.domain}, while the From is ${t.from.address} on ${t.from.domain}. Any reply therefore leaves the domain the message claims to come from, which is the classic free-mailbox collection pattern and the strongest single indicator in this message.`;
  }
  if (t.returnPath.domain && t.returnPath.domain !== t.from.domain) {
    return `Return-Path sits on ${t.returnPath.domain} rather than the From domain ${t.from.domain}, so the bounce address and the visible sender disagree. That is normal for some mailing-list software, but it does weaken SPF alignment and it is worth recording.`;
  }
  return `Reply-To and Return-Path both stay on ${t.from.domain}, so at least the reply path is not being diverted off-domain.`;
}

function linkSentence(t) {
  const hosts = hostsOf(t);
  if (!hosts.length) {
    return "The body carries no links, so there is no landing page to sandbox. Where that is true the payload is usually the conversation itself: the sender wants a reply, not a click.";
  }
  const shown = hosts.slice(0, 5).join(", ");
  return `Link hosts seen in the body: ${shown}${hosts.length > 5 ? ` and ${hosts.length - 5} more` : ""}. Those are what I would push into the proxy blocklist first, ahead of the sending domain itself.`;
}

const VERDICT_TEMPLATES = [
  (t, p) =>
    `**${p}** is ${verdictWord(t)}.\n\n${signalBullets(t, "numbered")}\n\n${authSentence(t)}\n\n${replyToSentence(t)}\n\nThe subject line is "${t.subject}" and the message crossed ${t.hops} Received hops on the way in. ${linkSentence(t)}`,

  (t, p) =>
    `Triage of ${shortName(p)} — verdict: ${verdictWord(t)}.\n\nWhat the deterministic pass raised:\n\n${signalBullets(t, "dash")}\n\n${replyToSentence(t)}\n\n${authSentence(t)}\n\nNone of that required a DNS or reputation lookup; every one of those facts came out of the headers as delivered.`,

  (t, p) =>
    `Short version: I would treat ${shortName(p)} as ${verdictWord(t)}.\n\nThe sender presents as "${t.from.display || "(no display name)"}" <${t.from.address}>. ${authSentence(t)}\n\n${signalBullets(t, "star")}\n\n${linkSentence(t)}\n\nIf you want to act on this, blocking ${t.from.domain} at the gateway and sweeping the mail store for other copies of "${t.subject}" is the cheap first move.`,

  (t, p) =>
    `I ran the triage tool over ${p}. It came back with ${t.signals.length} signal${t.signals.length === 1 ? "" : "s"} (${sev(t, "high")} high, ${sev(t, "medium")} medium), which puts it at ${verdictWord(t)}.\n\n${signalBullets(t, "numbered")}\n\n${replyToSentence(t)}\n\nDated ${t.date || "(no Date header)"}, ${t.hops} Received hops. ${linkSentence(t)}`,

  (t, p) =>
    `${shortName(p)}: ${verdictWord(t)}.\n\n${authSentence(t)} On its own that would not convict a message — plenty of legitimate forwarded mail breaks SPF — but it does not stand alone here.\n\n${signalBullets(t, "dash")}\n\n${replyToSentence(t)}\n\nSubject: "${t.subject}". ${linkSentence(t)}`,

  (t, p) =>
    `Verdict on ${shortName(p)}: ${verdictWord(t)}.\n\nHeader facts first, interpretation second. From ${t.from.address} (${t.from.domain || "no parseable domain"}), ${t.hops} Received hops, subject "${t.subject}".\n\n${authSentence(t)}\n\nSignals raised:\n\n${signalBullets(t, "dash")}\n\n${replyToSentence(t)} ${linkSentence(t)}`,
];

/** Compact verdict, used when the remaining budget cannot hold a full write-up. */
const TERSE_VERDICT = (t, p) =>
  `${shortName(p)}: ${verdictWord(t)}. ${t.signals.length} signal${t.signals.length === 1 ? "" : "s"} (${sev(t, "high")} high), From ${t.from.address}, SPF ${t.auth.spf || "unrecorded"} / DMARC ${t.auth.dmarc || "unrecorded"}.\n\n${signalBullets(t, "dash")}`;

const REFLECT_TURNS = [
  // compare the two most recent samples
  (hist) => {
    const a = hist[hist.length - 2];
    const b = hist[hist.length - 1];
    if (!a || !b) return null;
    const worse = sev(b.triage, "high") >= sev(a.triage, "high") ? b : a;
    return {
      q: `How does ${shortName(b.path)} compare to ${shortName(a.path)}? Which is more suspicious?`,
      a: `Comparing the two: ${shortName(b.path)} raised ${b.triage.signals.length} signal${b.triage.signals.length === 1 ? "" : "s"} against ${a.triage.signals.length} for ${shortName(a.path)}.\n\n${shortName(a.path)} came from ${a.triage.from.domain} with SPF ${a.triage.auth.spf || "unrecorded"} and DMARC ${a.triage.auth.dmarc || "unrecorded"}; ${shortName(b.path)} came from ${b.triage.from.domain} with SPF ${b.triage.auth.spf || "unrecorded"} and DMARC ${b.triage.auth.dmarc || "unrecorded"}.\n\nI would rank ${shortName(worse.path)} as the more dangerous of the two, on the strength of its high-severity signals rather than the raw count. Signal count is a poor proxy for risk: one reply-to mismatch on a credential-harvesting lure beats three cosmetic formatting oddities.`,
    };
  },

  // same actor?
  (hist) => {
    const a = hist[hist.length - 2];
    const b = hist[hist.length - 1];
    if (!a || !b) return null;
    const sameDomain = a.triage.from.domain === b.triage.from.domain;
    const shared = a.triage.signals
      .map((s) => s.id)
      .filter((id) => b.triage.signals.some((s) => s.id === id));
    return {
      q: `Are ${shortName(a.path)} and ${shortName(b.path)} likely from the same actor?`,
      a: `On the evidence in the headers, ${sameDomain ? "quite possibly" : "probably not — or at least I cannot show it"}.\n\nThe sending domains are ${a.triage.from.domain} and ${b.triage.from.domain}${sameDomain ? ", which is the same infrastructure" : ", which are unrelated as far as these two files go"}. ${shared.length ? `They do share ${shared.length} signal type${shared.length === 1 ? "" : "s"} (${shared.join(", ")}), but those are generic enough to show up across unrelated campaigns.` : "They share no signal types at all, which argues against a common origin."}\n\nAttribution from two messages is guesswork. What would actually settle it is infrastructure overlap — the same relay IPs in the Received chain, the same DKIM selector, the same landing host — and none of that is visible from a single .eml pair. I would keep them as separate clusters until something links them.`,
    };
  },

  // running summary
  (hist) => {
    const doms = [...new Set(hist.map((h) => h.triage.from.domain).filter(Boolean))];
    return {
      q: `Summarise what you have found across all the emails so far.`,
      a: `Across the ${hist.length} message${hist.length === 1 ? "" : "s"} triaged so far the sending domains were ${doms.slice(0, 6).join(", ")}${doms.length > 6 ? ", and others" : ""}.\n\nThe recurring pattern is authentication the receiver would not vouch for — a mixture of SPF softfail and outright DMARC failure — combined with reply paths that leave the claimed domain. None of that needed a reputation feed to call; the headers as delivered were enough.\n\nWhere they differ is intent. Some read as bulk commodity lures blasted at a list, others are written to a specific recipient and reference plausible internal detail. The second kind is what I would put in front of a human analyst first.`,
    };
  },

  // what to escalate
  (hist) => {
    const worst = hist.slice().sort((x, y) => sev(y.triage, "high") - sev(x.triage, "high"))[0];
    if (!worst) return null;
    return {
      q: `Which of these would you escalate first, and why?`,
      a: `If you only have time for one, escalate ${shortName(worst.path)}.\n\nIt carries ${sev(worst.triage, "high")} high-severity signal${sev(worst.triage, "high") === 1 ? "" : "s"}, the From domain is ${worst.triage.from.domain}, and the recorded DMARC result was ${worst.triage.auth.dmarc || "not recorded"}. ${replyToSentence(worst.triage)}\n\nPractically: block the sending domain at the gateway, sweep the mail store for other copies of the subject "${worst.triage.subject}", and check whether anyone replied. Replies matter more than clicks for this style of lure, because the payload is a conversation rather than a link.`,
    };
  },

  // auth recap on a specific sample
  (hist) => {
    const a = hist[hist.length - 1];
    if (!a) return null;
    return {
      q: `Remind me what the SPF and DMARC results were on ${shortName(a.path)}.`,
      a: `On ${shortName(a.path)}: ${authSentence(a.triage)}\n\nKeep the caveat in mind, though. Those values are what the receiving server wrote at delivery time, not a fresh re-check. If the sending infrastructure has since been cleaned up, or the SPF record has changed, a re-test today would tell you something different from what the header records. For triage that is fine; for anything that ends up in an incident report, say plainly that the result is historical.`,
    };
  },

  // one domain to block
  (hist) => {
    const worst = hist
      .slice()
      .sort(
        (x, y) =>
          sev(y.triage, "high") - sev(x.triage, "high") ||
          y.triage.signals.length - x.triage.signals.length,
      )[0];
    if (!worst?.triage.from.domain) return null;
    return {
      q: `If I only had time to block one sending domain today, which one?`,
      a: `${worst.triage.from.domain}, from ${shortName(worst.path)}.\n\nIt is the domain behind the worst signal set we have seen in this batch, and blocking at the domain rather than the individual address costs nothing if — as here — the domain has no legitimate correspondence with us. ${replyToSentence(worst.triage)}\n\nOne caveat before you push the rule: check the domain is not shared hosting or a bulk sender that legitimate mail also traverses. Blocking a whole ESP domain because one tenant abused it is how you end up with a business-impacting outage and an angry ticket queue.`,
    };
  },

  // advice for users
  (hist) => {
    const doms = [...new Set(hist.map((h) => h.triage.from.domain).filter(Boolean))];
    return {
      q: `What would you tell the affected users about these messages?`,
      a: `What I would tell affected users, in plain language: these messages did not come from who they appear to come from, or at least the mail system could not confirm that they did.\n\nThe technical basis is DMARC. A domain publishes a policy saying that mail claiming to be from it should pass SPF or DKIM, aligned with its name. When the receiving server records a DMARC failure — as it did for several of ${doms.slice(0, 3).join(", ")} — nobody could vouch for the sender.\n\nAdvice: do not reply, do not act on any payment or credential request, and forward the message to the security mailbox as an attachment so the headers survive. Deleting it afterwards is fine.`,
    };
  },
];

/** Pick a reflection turn that is valid for the current history, without repeating. */
function nextReflectTurn(hist, usedIdx) {
  const order = REFLECT_TURNS.map((_, i) => i).sort(() => rand() - 0.5);
  for (const i of order) {
    if (usedIdx.has(i)) continue;
    const turn = REFLECT_TURNS[i](hist);
    if (turn) {
      usedIdx.add(i);
      return turn;
    }
  }
  // All used once — allow reuse, but regenerate against the newer history so the
  // text differs from the earlier occurrence.
  for (const i of order) {
    const turn = REFLECT_TURNS[i](hist);
    if (turn) return turn;
  }
  return null;
}

/** Sentence-ish split used for trimming a turn into the remaining budget. */
function sentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z*`\-0-9"])/).filter((s) => s.length);
}

// ---------------------------------------------------------------------------
// phase 1: fit the conversation to the content budget
// ---------------------------------------------------------------------------

/**
 * Builds an ordered list of logical messages:
 *   { kind: "user",       text, tokens }
 *   { kind: "toolCall",   name, argumentsObj, text (=JSON args), tokens }
 *   { kind: "toolResult", name, text, details, tokens }
 *   { kind: "assistant",  text, tokens }
 */
async function fitConversation(pool) {
  const msgs = [];
  const history = [];
  const usedReflections = new Set();
  let used = 0;
  let poolIdx = 0;
  let turnNo = 0;
  let misses = 0;

  // With a tight budget, work from the smallest tool outputs upwards so at least
  // one genuine triage turn fits.
  if (CONTENT_BUDGET < 1200) pool = pool.slice().sort((a, b) => a.text.length - b.text.length);

  while (poolIdx < pool.length && misses < 8) {
    const s = pool[poolIdx];
    const isFirst = turnNo === 0;
    const reflect = !isFirst && history.length >= 2 && turnNo % 3 === 2;

    if (reflect) {
      turnNo++;
      const turn = nextReflectTurn(history, usedReflections);
      if (!turn) continue;
      const [qT, aT] = await countMany([turn.q, turn.a]);
      if (used + qT + aT > CONTENT_BUDGET) break;
      msgs.push({ kind: "user", text: turn.q, tokens: qT });
      msgs.push({ kind: "assistant", text: turn.a, tokens: aT });
      used += qT + aT;
      continue;
    }

    const q = (isFirst ? pick(FIRST_QUESTIONS) : pick(FOLLOW_QUESTIONS))(s.path);
    const argumentsObj = { path: s.path };
    const argsText = JSON.stringify(argumentsObj);
    // When room is short, answer tersely rather than skipping the turn entirely.
    const roomLeft = CONTENT_BUDGET - used;
    const answer =
      roomLeft < 700 ? TERSE_VERDICT(s.triage, s.path) : pick(VERDICT_TEMPLATES)(s.triage, s.path);
    const [qT, argT, resT, ansT] = await countMany([q, argsText, s.text, answer]);
    if (used + qT + argT + resT + ansT > CONTENT_BUDGET) {
      // This sample is too big for what's left; try the next one before giving up.
      poolIdx++;
      misses++;
      continue;
    }

    msgs.push({ kind: "user", text: q, tokens: qT });
    msgs.push({
      kind: "toolCall",
      name: "phish_triage",
      argumentsObj,
      text: argsText,
      tokens: argT,
    });
    msgs.push({
      kind: "toolResult",
      name: "phish_triage",
      text: s.text,
      details: s.triage,
      tokens: resT,
    });
    msgs.push({ kind: "assistant", text: answer, tokens: ansT });
    used += qT + argT + resT + ansT;
    history.push(s);
    poolIdx++;
    turnNo++;
  }

  if (!history.length) return { msgs, used, history };

  // Fill the remaining gap with trimmed reflection turns, sentence by sentence.
  for (let round = 0; round < 8 && CONTENT_BUDGET - used > 30; round++) {
    const turn = nextReflectTurn(history, usedReflections);
    if (!turn) break;
    const q = turn.q;
    const answer = turn.a;
    const qT = await count(q);
    const gap = CONTENT_BUDGET - used - qT;
    if (gap < 20) break;

    const sents = sentences(answer);
    const counts = await countMany(sents);
    let take = 0;
    let acc = 0;
    while (take < sents.length && acc + counts[take] <= gap) {
      acc += counts[take];
      take++;
    }
    if (take === 0 || acc < 10) break;
    const trimmed = sents.slice(0, take).join(" ");
    const trimmedT = await count(trimmed);
    if (used + qT + trimmedT > CONTENT_BUDGET) break;

    msgs.push({ kind: "user", text: q, tokens: qT });
    msgs.push({ kind: "assistant", text: trimmed, tokens: trimmedT });
    used += qT + trimmedT;
    if (take === sents.length) continue; // whole answer fitted; try another round
    break; // we ran out of room mid-answer, so we are as close as we get
  }

  return { msgs, used, history };
}

// ---------------------------------------------------------------------------
// phase 2: emit records (ids, chain, timestamps, usage)
// ---------------------------------------------------------------------------

function emitRecords(msgs, sessionId, startMs) {
  const records = [];
  const startIso = new Date(startMs).toISOString();

  records.push({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: startIso,
    cwd: REPO,
  });

  let now = startMs + randInt(70, 110);
  const mc = {
    type: "model_change",
    id: recordId(),
    parentId: null,
    timestamp: new Date(now).toISOString(),
    provider: "local",
    modelId: "bonsai-8b",
  };
  records.push(mc);
  const tl = {
    type: "thinking_level_change",
    id: recordId(),
    parentId: mc.id,
    timestamp: new Date(now).toISOString(),
    thinkingLevel: "off",
  };
  records.push(tl);

  let prevId = tl.id;
  // Running total of content tokens seen so far; usage.input = SYSTEM_OVERHEAD + this.
  let priorTokens = 0;
  let pendingToolCallId = null;
  let finalUsageTotal = 0;

  for (const m of msgs) {
    if (m.kind === "user") {
      now += randInt(1200, 3200);
      const msgTs = now;
      const topTs = msgTs + randInt(1, 3);
      now = topTs;
      records.push({
        type: "message",
        id: recordId(),
        parentId: prevId,
        timestamp: new Date(topTs).toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: m.text }],
          timestamp: msgTs,
        },
      });
      prevId = records[records.length - 1].id;
      priorTokens += m.tokens;
      continue;
    }

    if (m.kind === "toolCall") {
      const msgTs = now + randInt(40, 90); // generation starts
      const topTs = msgTs + randInt(60_000, 300_000); // slow local model finishes
      now = topTs;
      const callId = toolCallId();
      pendingToolCallId = callId;
      const input = SYSTEM_OVERHEAD + priorTokens;
      const output = m.tokens;
      records.push({
        type: "message",
        id: recordId(),
        parentId: prevId,
        timestamp: new Date(topTs).toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: callId, name: m.name, arguments: m.argumentsObj },
          ],
          api: "openai-completions",
          provider: "local",
          model: "bonsai-8b",
          usage: {
            input,
            output,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: input + output,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: msgTs,
          responseId: responseId(),
          responseModel: "/zip/Bonsai-8B-Q1_0.gguf",
          rawStopReason: "tool_calls",
        },
      });
      prevId = records[records.length - 1].id;
      priorTokens += m.tokens;
      finalUsageTotal = input + output;
      continue;
    }

    if (m.kind === "toolResult") {
      now += randInt(5, 16);
      const ts = now;
      records.push({
        type: "message",
        id: recordId(),
        parentId: prevId,
        timestamp: new Date(ts).toISOString(),
        message: {
          role: "toolResult",
          toolCallId: pendingToolCallId,
          toolName: m.name,
          content: [{ type: "text", text: m.text }],
          details: m.details,
          isError: false,
          timestamp: ts,
        },
      });
      prevId = records[records.length - 1].id;
      priorTokens += m.tokens;
      continue;
    }

    // assistant text
    const msgTs = now + randInt(1, 3);
    const topTs = msgTs + randInt(90_000, 480_000);
    now = topTs;
    const input = SYSTEM_OVERHEAD + priorTokens;
    const output = m.tokens;
    records.push({
      type: "message",
      id: recordId(),
      parentId: prevId,
      timestamp: new Date(topTs).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: m.text }],
        api: "openai-completions",
        provider: "local",
        model: "bonsai-8b",
        usage: {
          input,
          output,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
          totalTokens: input + output,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: msgTs,
        responseId: responseId(),
        responseModel: "/zip/Bonsai-8B-Q1_0.gguf",
        rawStopReason: "stop",
      },
    });
    prevId = records[records.length - 1].id;
    priorTokens += m.tokens;
    finalUsageTotal = input + output;
  }

  return { records, startIso, finalUsageTotal, contentTokens: priorTokens };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  COUNT_METHOD = (await serverAvailable()) ? "server" : "heuristic";
  const methodLabel =
    COUNT_METHOD === "server"
      ? "llama.cpp POST /tokenize on 127.0.0.1:8080 (exact)"
      : "Math.ceil(chars / 3.5) heuristic (tokenize endpoint unavailable)";

  const wantedSamples = Math.max(6, Math.ceil(CONTENT_BUDGET / 420) + 4);
  const pool = buildSamplePool(wantedSamples);
  if (pool.length < 2) {
    console.error("Could not assemble a usable sample pool from the .eml corpus.");
    process.exit(1);
  }

  const { msgs } = await fitConversation(pool);
  if (!msgs.length || !msgs.some((m) => m.kind === "toolResult")) {
    console.error(
      `--tokens ${TARGET} leaves only ${CONTENT_BUDGET} tokens of conversation, ` +
        `which is not enough for a triage turn. Try a larger value.`,
    );
    process.exit(1);
  }
  // Must end on a completed assistant text message.
  while (msgs.length && msgs[msgs.length - 1].kind !== "assistant") msgs.pop();

  const { records, startIso, finalUsageTotal, contentTokens } = emitRecords(
    msgs,
    SESSION_ID,
    Date.now(),
  );

  // Independent check: tokenize the whole concatenated prompt text in one call,
  // so cross-message boundary effects are included rather than summed away.
  const concatText = msgs.map((m) => m.text).join(JOIN);
  const concatTokens =
    COUNT_METHOD === "server" ? await tokenizeExact(concatText) : heuristic(concatText);

  const outPathDefault = join(
    SESSION_DIR,
    `${startIso.replace(/:/g, "-").replace(/\./g, "-")}_${SESSION_ID}.jsonl`,
  );
  const outPath = args.out || outPathDefault;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const depthPct = ((finalUsageTotal / TARGET) * 100).toFixed(2);
  const faithful = SYSTEM_OVERHEAD + concatTokens;
  const drift = faithful - finalUsageTotal;
  const driftPct = ((Math.abs(drift) / finalUsageTotal) * 100).toFixed(2);

  console.log(`output path:              ${outPath}`);
  console.log(`session id:               ${SESSION_ID}`);
  console.log(`record count:             ${records.length}`);
  console.log(`target tokens:            ${TARGET}`);
  console.log(
    `final usage.totalTokens:  ${finalUsageTotal}   <- what pi reads as context depth ` +
      `(${depthPct}% of target, ${TARGET - finalUsageTotal} under)`,
  );
  console.log(
    `measured content tokens:  ${contentTokens} (per-message sum) / ${concatTokens} (single concatenated tokenize)`,
  );
  console.log(
    `faithfulness check:       system overhead ${SYSTEM_OVERHEAD} + concatenated content ${concatTokens} = ${faithful}, ` +
      `vs declared ${finalUsageTotal} (drift ${drift >= 0 ? "+" : ""}${drift} tokens, ${driftPct}%)`,
  );
  console.log(`counting method:          ${methodLabel}`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
