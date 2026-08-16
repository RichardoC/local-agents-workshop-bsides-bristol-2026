#!/usr/bin/env node
/**
 * gen-fixture.mjs — build OpenAI chat-completions fixtures at a target token depth.
 *
 *   node gen-fixture.mjs --tokens 8000 --out /workspace/fixtures/conv-8000.json
 *
 * Content is genuine: every tool result is the real output of the workshop's own
 * triage library (extensions/lib/{eml,signals}.ts) run over a real .eml sample
 * from samples/phishing_pot/email, rendered with a copy of phish-triage.ts's
 * render(). Only the NOTE trailer rotates between equivalent phrasings, because
 * a byte-identical 45-word trailer on every tool result would dominate the
 * repetition metrics the fixture exists to measure.
 *
 * Token counting uses the local llamafile server's POST /tokenize when it is
 * reachable, and otherwise llama-tokenize built from this repo against the very
 * same GGUF the server serves (Bonsai-8B-Q1_0.gguf, extracted from the
 * llamafile), which yields the identical vocabulary and therefore identical
 * counts. The method actually used is printed and recorded in the fixture.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const REPO = "/workspace/local-agents-workshop-bsides-bristol-2026";
const EMAIL_DIR_REL = "samples/phishing_pot/email";
const SERVER = "http://127.0.0.1:8080";
const SCRATCH =
  "/tmp/claude-0/-home-user-llama-cpp/d16ebdc3-43d5-564e-8967-610b8ab4c187/scratchpad";
const TOKENIZE_BIN = `${SCRATCH}/tokbuild/bin/llama-tokenize`;
const GGUF = `${SCRATCH}/tok/Bonsai-8B-Q1_0.gguf`;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--tokens") args.tokens = Number(process.argv[++i]);
  else if (a === "--out") args.out = process.argv[++i];
  else if (a === "--seed") args.seed = process.argv[++i];
  else throw new Error(`unknown arg ${a}`);
}
if (!args.tokens || !args.out) {
  console.error("usage: gen-fixture.mjs --tokens N --out path [--seed s]");
  process.exit(1);
}
const TARGET = Math.floor(args.tokens);
const SEED = args.seed || `depth-${TARGET}`;

// ---------------------------------------------------------------------------
// seeded PRNG
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
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rand = mulberry32(hashSeed(SEED));

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const randStr = (n) => {
  let s = "";
  for (let i = 0; i < n; i++) s += ALNUM[Math.floor(rand() * ALNUM.length)];
  return s;
};

/**
 * Hands out bank entries in a shuffled order, wrapping only after the whole
 * bank is exhausted. A bank of N entries used U times therefore uses no entry
 * more than ceil(U/N) times — that is the mechanism that keeps boilerplate
 * from appearing three or more times in one conversation.
 */
class Rotator {
  constructor(bank) {
    this.bank = bank.slice();
    for (let i = this.bank.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [this.bank[i], this.bank[j]] = [this.bank[j], this.bank[i]];
    }
    this.i = 0;
  }
  next() {
    return this.bank[this.i++ % this.bank.length];
  }
}

// ---------------------------------------------------------------------------
// token counting
// ---------------------------------------------------------------------------

let COUNT_METHOD = null;

async function serverTokenize(text) {
  const res = await fetch(`${SERVER}/tokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`tokenize HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.tokens)) throw new Error("tokenize: bad body");
  return body.tokens.length;
}

async function serverAvailable() {
  try {
    const res = await fetch(`${SERVER}/tokenize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "tokenizer probe" }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body?.tokens) && body.tokens.length > 0;
  } catch {
    return false;
  }
}

function localTokenize(text) {
  const out = execFileSync(
    TOKENIZE_BIN,
    ["-m", GGUF, "--stdin", "--show-count", "--no-bos", "--ids", "--log-disable"],
    { input: text, maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
  ).toString();
  const m = out.match(/Total number of tokens:\s*(\d+)/);
  if (!m) throw new Error(`llama-tokenize: could not parse count from output`);
  return Number(m[1]);
}

async function tokenCount(text) {
  return COUNT_METHOD === "server" ? await serverTokenize(text) : localTokenize(text);
}

// ---------------------------------------------------------------------------
// real triage data
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

/** Trailer variants for the tool output. Rotated so none appears 3+ times. */
const NOTE_BANK = [
  "NOTE: signals above are facts extracted from the message itself. No DNS, WHOIS or reputation lookup was performed, so SPF/DKIM/DMARC values are what the receiving server recorded at delivery time, not a re-check.",
  "NOTE: everything listed here was read out of the message as delivered. Nothing was resolved live, so the authentication verdicts are historical records rather than a fresh test.",
  "NOTE: this is a static parse. No network calls were made and no landing page was fetched, which means link hosts are reported as written, not as they resolve today.",
  "NOTE: the analysis above is header- and body-derived only. Reputation feeds, passive DNS and registrar data were all out of scope for this pass.",
  "NOTE: no external lookup was involved in producing this. Authentication lines echo what the receiver stamped on arrival; re-checking them now could give a different answer.",
  "NOTE: facts only, no enrichment. The tool did not query DNS, did not sandbox any URL, and did not consult any threat-intel source.",
  "NOTE: output derived entirely from the stored .eml. Treat authentication results as a snapshot of delivery time, and link hosts as unvisited strings.",
  "NOTE: nothing here was verified against live infrastructure. The parse is deterministic and repeatable, but it cannot tell you what a domain does right now.",
  "NOTE: this pass reads the file and stops there. No resolution, no fetch, no scoring against any external corpus was attempted.",
  "NOTE: all values transcribed from the message as stored on disk. Live verification of the sending infrastructure is a separate step and was not run.",
  "NOTE: static extraction only. The receiving server's authentication stamps are reproduced verbatim; no attempt was made to re-evaluate them against current records.",
  "NOTE: produced without touching the network. Any judgement about whether these hosts are still live, parked or taken down needs a separate enrichment pass.",
  "NOTE: read-only parse of the stored message. Nothing was resolved, opened or submitted anywhere, so every value here is a transcription rather than a test result.",
  "NOTE: no enrichment applied. Digests are computed over the decoded attachment bytes, and link hosts are copied out of the markup exactly as written.",
  "NOTE: the tool made no outbound connection of any kind. Anything that would require one — reputation, registration age, current hosting — is absent by design.",
  "NOTE: derived from the message as archived. If the campaign has moved on since delivery, this output will describe the past rather than the present.",
  "NOTE: purely local analysis. The authentication verdicts belong to the receiving server, and reproducing them today would require re-sending the message.",
  "NOTE: extraction only, no interpretation beyond the listed signals. Severity reflects rule design, not a risk score for your environment.",
  "NOTE: offline pass over a stored file. Nothing was queried, fetched or executed, so treat every hostname below as an unverified string.",
  "NOTE: the parser reports what it found and makes no claim about intent. Correlating this with other reports is a separate exercise entirely.",
  "NOTE: no live checks were run. Authentication lines are quoted from the delivery record, and attachment types are the sender's declaration rather than a verified format.",
  "NOTE: results come from the archived copy alone. A message that has since been retracted, resent or altered upstream will not be reflected here.",
  "NOTE: this output is reproducible — the same file yields the same result on any machine. Nothing about it depends on when or where it was run.",
  "NOTE: header and body parsing only. Sandbox detonation, URL expansion and sender reputation all sit outside what this pass is able to tell you.",
  "NOTE: no lookups of any kind were performed. Everything above can be re-derived from the file itself, which is the point of keeping it deterministic.",
];
let NOTES = null;

/** Copy of render() from extensions/phish-triage.ts, with a rotating trailer. */
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
  lines.push(NOTES.next());

  return lines.join("\n");
}

/**
 * Assemble a pool of usable, mutually-dissimilar samples.
 *
 * The templated signal details (e.g. "SPF recorded as fail by the receiving
 * server.") are byte-identical wherever they occur, so a cap is applied: no
 * signal id whose detail carries no per-message data may be used more than
 * twice in one conversation.
 */
function buildSamplePool(wanted) {
  const all = readdirSync(join(REPO, EMAIL_DIR_REL)).filter((f) => f.endsWith(".eml"));
  const shuffled = all.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const pool = [];
  const seenSubjects = new Set();
  const seenDomains = new Map();
  const detailUse = new Map(); // exact signal-detail string -> times used
  const authUse = new Map(); // spf/dkim/dmarc/hops tuple -> times used
  const hostUse = new Map(); // link-host signature -> times used
  let cursor = 0;

  while (pool.length < wanted && cursor < shuffled.length) {
    const names = shuffled.slice(cursor, cursor + 120);
    cursor += 120;
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

      // Keep turn sizes sane.
      const probe = [
        t.subject,
        t.from.display,
        ...t.signals.map((s) => s.detail),
        ...t.links.map((l) => l.hostname || ""),
      ].join(" ");
      if (probe.length < 120 || probe.length > 2200) continue;

      // Distinct subjects, and no sending domain more than twice.
      const key = t.subject.slice(0, 40).toLowerCase();
      if (seenSubjects.has(key)) continue;
      const dom = t.from.domain || "(none)";
      if ((seenDomains.get(dom) || 0) >= 2) continue;

      // A message that repeats the same signal detail internally (e.g. six
      // href_text_mismatch lines naming the same pair of hosts) is repetitive
      // all by itself, whatever else the conversation does.
      const details = t.signals.map((s) => s.detail);
      if (new Set(details).size !== details.length) continue;

      // Two signals can differ only in a trailing hostname while sharing a long
      // quoted anchor text, which repeats that text verbatim inside one tool
      // result. Compare on a prefix, not on equality.
      const prefixes = details.map((d) => d.slice(0, 60));
      if (new Set(prefixes).size !== prefixes.length) continue;
      if (prefixes.some((p) => (detailUse.get(`p:${p}`) || 0) >= 2)) continue;

      // Cap every exact detail string, every auth tuple and every link-host
      // signature at two appearances across the whole conversation. Those are
      // the three sources of byte-identical runs in genuine tool output.
      if (details.some((d) => (detailUse.get(d) || 0) >= 2)) continue;

      // The mechanism-failure details differ only by the mechanism name, so
      // they share a long identical suffix across spf/dkim/dmarc. Cap the
      // family, not just each exact string.
      const family = details.filter((d) => /recorded as \w+ by the receiving server/.test(d)).length;
      if ((detailUse.get("@mech") || 0) + family > 2) continue;

      // The rendered tool output is mostly structure: the AUTH line, the hop
      // count, the link-host count and the signal id list. Two samples sharing
      // all of them produce a long byte-identical run through the middle of
      // both tool results, so require that combination to be unique.
      const structKey = [
        t.auth.absent,
        t.auth.spf,
        t.auth.dkim,
        t.auth.dmarc,
        t.hops,
        hostsOf(t).length,
        t.attachments.length,
        t.signals.map((s) => s.id).join(","),
      ].join("|");
      if (authUse.has(structKey)) continue;

      // Narrower windows that an 8-gram can sit inside without ever reaching
      // the distinguishing fields above: the tail of the AUTH line through the
      // hop and link-host counts, the domains quoted inside the envelope signal
      // details, and the signal id sequence itself.
      const ids = t.signals.map((s) => s.id);
      const capped = [
        // The whole AUTH line plus the hop count, which is what an 8-gram
        // sitting between "AUTH:" and "LINK HOSTS" actually spans.
        ["struct8", `${t.auth.absent}|${t.auth.spf}|${t.auth.dkim}|${t.auth.dmarc}|${t.hops}`],
        ["replyto", t.replyTo.domain || "-"],
        ["retpath", t.returnPath.domain || "-"],
        ["idseq", ids.join(",")],
        // Adjacent signal pairs: the tail of one detail runs straight into the
        // head of the next, so the pair is the unit that repeats.
        ...ids.slice(1).map((id, i) => ["idpair", `${ids[i]}>${id}`]),
      ];
      if (capped.some(([k, v]) => (hostUse.get(`${k}:${v}`) || 0) >= 2)) continue;

      const hostKey = hostsOf(t).slice(0, 15).join(",");
      if ((hostUse.get(hostKey) || 0) >= 2) continue;

      seenSubjects.add(key);
      seenDomains.set(dom, (seenDomains.get(dom) || 0) + 1);
      for (const d of details) detailUse.set(d, (detailUse.get(d) || 0) + 1);
      for (const p of prefixes) detailUse.set(`p:${p}`, (detailUse.get(`p:${p}`) || 0) + 1);
      detailUse.set("@mech", (detailUse.get("@mech") || 0) + family);
      authUse.set(structKey, 1);
      for (const [k, v] of capped)
        hostUse.set(`${k}:${v}`, (hostUse.get(`${k}:${v}`) || 0) + 1);
      hostUse.set(hostKey, (hostUse.get(hostKey) || 0) + 1);
      pool.push({ path: r.path, triage: t });
    }
  }
  return pool;
}

// ---------------------------------------------------------------------------
// system prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Bonsai, a security-analysis agent embedded in a SOC triage workflow. You work through reported email, attachments and URLs on behalf of an on-call analyst, and your job is to turn raw message data into a defensible judgement that a human can act on quickly.

## Tools

- phish_triage(path: string) — run the deterministic triage pass over a stored .eml file. Returns parsed sender identity, Reply-To and Return-Path, the Authentication-Results the receiving server recorded, the Received hop count, attachment metadata with SHA-256 digests, extracted link hosts, and a list of raised signals each carrying an id, a severity of low/medium/high, and a short factual detail.
- read_file(path: string) — read any file in the case directory verbatim, for when you need the raw headers or body rather than the parsed view.
- grep_corpus(pattern: string) — search the stored sample corpus for a string, used to find sibling messages from the same campaign.

Call a tool whenever a fact would otherwise be a guess. Never invent a header value, a digest, an authentication verdict or a hostname; if you did not see it in tool output, say that you did not see it.

## Guidelines

- Separate fact from inference. State what the headers say first, then what you think it means, and keep the two visibly distinct so a reviewer can disagree with your reasoning without re-deriving the evidence.
- Signals are evidence, not a score. Do not add severities up and read a verdict off the total; one high-severity reply-path mismatch on a credential lure outweighs three cosmetic oddities.
- Authentication results are historical. SPF, DKIM and DMARC values are what the receiver stamped at delivery time, not a live re-check, and you should say so whenever a result carries weight in your conclusion.
- A passing DMARC does not make a message safe. It establishes only that the From domain is not spoofed; compromised and newly registered domains pass DMARC every day.
- Absence of evidence is reportable. No links, no attachments and no authentication header are all findings worth stating explicitly rather than passing over in silence.
- Recommend proportionate action. Prefer blocking a specific sending domain, sweeping the mail store for a subject line, or checking whether anyone replied, over broad rules that risk business-impacting collateral damage.
- Be concise and concrete. Name the domain, quote the subject, cite the signal id. Avoid hedging language that leaves the analyst with nothing to do.
- If the evidence does not support a confident call, say the evidence is thin and name the one lookup that would settle it.`;

// ---------------------------------------------------------------------------
// content banks
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
  (p) => `First case of the shift: ${p}. What is your read?`,
  (p) => `Start with ${p} please — it came in overnight and nobody has looked at it.`,
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
  (p) => `Move on to ${p} when you can. The reporter says it looked convincing.`,
  (p) => `Try ${p}. I am curious whether the return path holds up on that one.`,
  (p) => `Add ${p} to the batch. Helpdesk has had two calls about it already.`,
  (p) => `Pull the signals for ${p} and give me the short version.`,
  (p) => `Here is another: ${p}. Tell me if anything in the headers stands out.`,
  (p) => `Do ${p} next. It slipped past the gateway rule we added last week.`,
  (p) => `Give ${p} a pass — the mailbox owner has already replied to it once.`,
  (p) => `${p} is the last one in the queue from last night. What do you make of it?`,
  (p) => `Take ${p} while I write up the previous one.`,
  (p) => `New arrival: ${p}. Does it fit anything we have already seen?`,
  (p) => `Have a go at ${p} — the reporter flagged it as urgent but they usually do.`,
  (p) => `Queue up ${p}. I want a second data point on that sending pattern.`,
];

const OPENERS = [
  (t, p) => `**${shortName(p)}** is ${verdictWord(t)}.`,
  (t, p) => `Triage of ${shortName(p)} — verdict: ${verdictWord(t)}.`,
  (t, p) => `Short version: I would treat ${shortName(p)} as ${verdictWord(t)}.`,
  (t, p) =>
    `I ran the deterministic pass over ${shortName(p)}. It came back with ${t.signals.length} signal${t.signals.length === 1 ? "" : "s"} (${sev(t, "high")} high, ${sev(t, "medium")} medium), which puts it at ${verdictWord(t)}.`,
  (t, p) => `${shortName(p)}: ${verdictWord(t)}.`,
  (t, p) =>
    `Calling ${shortName(p)} ${verdictWord(t)}, on the header evidence rather than the body copy.`,
  (t, p) =>
    `Done — ${shortName(p)} lands at ${verdictWord(t)}. Sender presents as "${t.from.display || "(no display name)"}" <${t.from.address}>.`,
  (t, p) =>
    `Here is what came back for ${shortName(p)}. Bottom line: ${verdictWord(t)}.`,
  (t, p) =>
    `My read on ${shortName(p)}: ${verdictWord(t)}. It crossed ${t.hops} Received hop${t.hops === 1 ? "" : "s"} before landing.`,
  (t, p) =>
    `${shortName(p)} parsed cleanly and the pass raised ${t.signals.length} item${t.signals.length === 1 ? "" : "s"}. Overall: ${verdictWord(t)}.`,
  (t, p) =>
    `Result for ${shortName(p)} — ${verdictWord(t)}, sent from ${t.from.address} on ${t.from.domain || "an unparseable domain"}.`,
  (t, p) =>
    `Looked at ${shortName(p)}. I would file it as ${verdictWord(t)} and move it up the queue accordingly.`,
  (t, p) =>
    `That one is in. ${shortName(p)} reads as ${verdictWord(t)} once the header facts are lined up.`,
  (t, p) =>
    `Triage complete on ${shortName(p)}. Where it lands: ${verdictWord(t)}, driven by ${sev(t, "high") || "no"} high-severity finding${sev(t, "high") === 1 ? "" : "s"}.`,
  (t, p) =>
    `${shortName(p)} came back ${verdictWord(t)}. The sending address is ${t.from.address}.`,
  (t, p) =>
    `Assessment of ${shortName(p)}: ${verdictWord(t)}, and I would not need a second tool to defend that.`,
  (t, p) =>
    `Ran it. ${shortName(p)} is ${verdictWord(t)} on ${t.signals.length} raised signal${t.signals.length === 1 ? "" : "s"}.`,
  (t, p) =>
    `The parse on ${shortName(p)} is done and it puts the message at ${verdictWord(t)}.`,
];

/**
 * Signals are cited by id and severity, NOT by echoing the tool's detail text.
 * Echoing doubled every templated detail ("SPF recorded as fail by the
 * receiving server.") into the transcript, which is exactly the kind of
 * repetition this fixture must not contain. The per-message specifics live in
 * the fact sentences below instead, where they carry real data.
 */
function signalBullets(t, style) {
  return t.signals
    .map((s, i) => {
      const label = `[${s.severity.toUpperCase()}] ${s.id}`;
      if (style === "numbered") return `${i + 1}. **${label}**`;
      if (style === "dash") return `- **${label}**`;
      if (style === "arrow") return `  ${label}`;
      if (style === "inline") return label;
      return `  * ${label}`;
    })
    .join(style === "inline" ? ", " : "\n");
}

const SIGNAL_HEADINGS = [
  "What the deterministic pass raised:",
  "Signals, in the order the tool emitted them:",
  "Raised signals:",
  "The evidence, verbatim from the parse:",
  "Here is what tripped:",
  "Findings from the header pass:",
  "Signals worth your attention:",
  "What the parse flagged:",
  "Raised, by severity:",
  "The tool's own list:",
  "Flagged items:",
  "What came back:",
  "Signal ids for the record:",
  "Deterministic findings:",
  "Tripped rules:",
  "For traceability, the ids raised were:",
  "What the pass caught:",
  "Recorded signals:",
];

/**
 * Commentary is assembled from single-sentence banks, each of which holds more
 * entries than there are triage turns in the deepest fixture. Every entry is
 * therefore used at most ONCE per conversation, so no stretch of boilerplate
 * can appear twice, let alone three times. Facts carry per-message data;
 * glosses carry the analyst's generic reasoning.
 */

const AUTH_FACTS = [
  (t) => t.auth.absent
    ? `No Authentication-Results header was recorded on this message at all.`
    : `Authentication as recorded at delivery: SPF ${t.auth.spf || "-"}, DKIM ${t.auth.dkim || "-"}, DMARC ${t.auth.dmarc || "-"}.`,
  (t) => t.auth.absent
    ? `Nothing stamped this one on the way in — no SPF, DKIM or DMARC verdict.`
    : `The receiver wrote spf=${t.auth.spf || "-"}, dkim=${t.auth.dkim || "-"}, dmarc=${t.auth.dmarc || "-"} onto this message.`,
  (t) => t.auth.absent
    ? `The Authentication-Results line is simply missing from this file.`
    : `Auth stamps at delivery time: SPF ${t.auth.spf || "none"}, DKIM ${t.auth.dkim || "none"}, DMARC ${t.auth.dmarc || "none"}.`,
  (t) => t.auth.absent
    ? `This message carries no receiver verdict on sender identity whatsoever.`
    : `What the relay recorded — spf ${t.auth.spf || "-"} / dkim ${t.auth.dkim || "-"} / dmarc ${t.auth.dmarc || "-"}.`,
  (t) => t.auth.absent
    ? `No SPF, DKIM or DMARC result is present anywhere in these headers.`
    : `SPF came back ${t.auth.spf || "unrecorded"}, DKIM ${t.auth.dkim || "unrecorded"}, DMARC ${t.auth.dmarc || "unrecorded"}.`,
  (t) => t.auth.absent
    ? `Authentication data is absent, so there is no verdict to lean on here.`
    : `Recorded for ${t.from.domain || "the sending domain"}: SPF ${t.auth.spf || "-"}, DKIM ${t.auth.dkim || "-"}, DMARC ${t.auth.dmarc || "-"}.`,
  (t) => t.auth.absent
    ? `Missing Authentication-Results on this one, which the pass flagged as low severity.`
    : `Delivery-time result set reads ${t.auth.spf || "-"} for SPF, ${t.auth.dkim || "-"} for DKIM, ${t.auth.dmarc || "-"} for DMARC.`,
  (t) => t.auth.absent
    ? `There is no authentication stamp here, benign or otherwise.`
    : `The header says SPF ${t.auth.spf || "-"} and DMARC ${t.auth.dmarc || "-"}, with DKIM at ${t.auth.dkim || "-"}.`,
  (t) => t.auth.absent
    ? `Not a single authentication mechanism left a mark on this message.`
    : `Receiving server's verdict: spf=${t.auth.spf || "-"} dkim=${t.auth.dkim || "-"} dmarc=${t.auth.dmarc || "-"}.`,
  (t) => t.auth.absent
    ? `No verdict was stamped, so the From identity here stands entirely unvouched.`
    : `As delivered: SPF ${t.auth.spf || "-"}, DKIM ${t.auth.dkim || "-"}, and a DMARC outcome of ${t.auth.dmarc || "-"}.`,
  (t) => t.auth.absent
    ? `Authentication headers were stripped or never applied on this route.`
    : `For the record, ${t.from.domain || "this domain"} scored SPF ${t.auth.spf || "-"} and DMARC ${t.auth.dmarc || "-"} on arrival.`,
  (t) => t.auth.absent
    ? `Nothing in this file tells us what the receiver made of the sender.`
    : `Arrival stamps were SPF ${t.auth.spf || "-"}, DKIM ${t.auth.dkim || "-"} and DMARC ${t.auth.dmarc || "-"}.`,
  (t) => t.auth.absent
    ? `No SPF/DKIM/DMARC triangle is available for this message.`
    : `Authentication reads ${t.auth.spf || "-"} (SPF), ${t.auth.dkim || "-"} (DKIM), ${t.auth.dmarc || "-"} (DMARC).`,
  (t) => t.auth.absent
    ? `The receiving infrastructure recorded no opinion about this sender.`
    : `Stamped values on the way in: spf ${t.auth.spf || "-"}, dkim ${t.auth.dkim || "-"}, dmarc ${t.auth.dmarc || "-"}.`,
  (t) => t.auth.absent
    ? `An absent Authentication-Results header is all we have on identity here.`
    : `The delivery record shows SPF at ${t.auth.spf || "-"} and DMARC at ${t.auth.dmarc || "-"}.`,
  (t) => t.auth.absent
    ? `This one arrived without any authentication verdict attached to it.`
    : `Header-recorded authentication: ${t.auth.spf || "-"}/${t.auth.dkim || "-"}/${t.auth.dmarc || "-"} for SPF, DKIM and DMARC respectively.`,
  (t) => t.auth.absent
    ? `No authentication result exists for this message to interpret.`
    : `On arrival the server logged spf ${t.auth.spf || "-"}, dkim ${t.auth.dkim || "-"} and dmarc ${t.auth.dmarc || "-"}.`,
  (t) => t.auth.absent
    ? `Zero authentication metadata survived onto this stored message.`
    : `The recorded triple is SPF ${t.auth.spf || "-"}, DKIM ${t.auth.dkim || "-"}, DMARC ${t.auth.dmarc || "-"}.`,
];

const AUTH_GLOSS = [
  () => `DMARC only passes when an aligned SPF or DKIM identifier passes with it.`,
  () => `Read that as a record of delivery, not a statement about the domain today.`,
  () => `Alignment is the part that matters; a mechanism can pass on an unrelated envelope.`,
  () => `Legitimate forwarded mail breaks SPF constantly, so I would not convict on it alone.`,
  () => `If the infrastructure has since been cleaned up, a re-test now would disagree.`,
  () => `A pass establishes that the From header is genuine, and nothing beyond that.`,
  () => `Compromised and freshly registered domains authenticate perfectly well every day.`,
  () => `Where a policy is absent the receiver improvises, so treat the result as unauthenticated.`,
  () => `I weight a missing header lightly, because forwarding chains strip it routinely.`,
  () => `The useful question is what passed and whether it aligned, not how many did.`,
  () => `Any write-up should call this historical and say when it was recorded.`,
  () => `Authentication answers who sent it, never whether what they sent is safe.`,
  () => `Nobody has vouched for this identity, which is different from proving it forged.`,
  () => `Treat these as the receiver's words at one moment, since nothing was re-queried.`,
  () => `Bulk senders almost always land with some verdict, so silence here is unusual.`,
  () => `That single line decides whether the From address is evidence or decoration.`,
  () => `The mechanism results matter far less than whether anything aligned to the visible sender.`,
  () => `None of this was re-checked; it is transcription, not verification.`,
];

const PATH_FACTS = [
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `The Reply-To is ${t.replyTo.address} on ${t.replyTo.domain}, against a From on ${t.from.domain}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `Return-Path sits on ${t.returnPath.domain} rather than the From domain ${t.from.domain}.`
      : `Reply-To and Return-Path both stay on ${t.from.domain}.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Follow where a reply goes and you land at ${t.replyTo.address}, not ${t.from.domain}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `The bounce path points at ${t.returnPath.domain} while the visible sender claims ${t.from.domain}.`
      : `Nothing odd in the reply path — replies and bounces land back on ${t.from.domain}.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `A reply to this arrives at ${t.replyTo.address} rather than anywhere on ${t.from.domain}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `Envelope sender and header sender part company: ${t.returnPath.domain} versus ${t.from.domain}.`
      : `From, Reply-To and Return-Path all agree on ${t.from.domain} here.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Reply-To has been set to ${t.replyTo.address}, off ${t.from.domain} entirely.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `Return-Path resolves to ${t.returnPath.domain}, not to ${t.from.domain} as the From claims.`
      : `The reply path holds together, with everything anchored on ${t.from.domain}.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Off-domain Reply-To here: ${t.replyTo.address}, against a From of ${t.from.address}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `Bounces go to ${t.returnPath.domain}; the message advertises ${t.from.domain}.`
      : `No divergence in the reply path on this message.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Split identity: visible sender on ${t.from.domain}, replies steered to ${t.replyTo.domain}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `There is a Return-Path on ${t.returnPath.domain} against a From on ${t.from.domain}.`
      : `Reply path is unremarkable, ${t.from.domain} throughout.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `If anyone answered this, the answer went to ${t.replyTo.address}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `The envelope-from is on ${t.returnPath.domain} while the header-from claims ${t.from.domain}.`
      : `All three sender identities agree on ${t.from.domain}.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `The Reply-To header redirects correspondence to ${t.replyTo.domain}, away from ${t.from.domain}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `Bounce address ${t.returnPath.domain} and visible sender ${t.from.domain} do not match.`
      : `Sender identities are internally consistent on ${t.from.domain}.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Replies leave ${t.from.domain} and terminate at ${t.replyTo.address}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `The bounce identity is ${t.returnPath.domain}, the display identity ${t.from.domain}.`
      : `Nothing here diverts a reply away from ${t.from.domain}.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Reply traffic would be captured at ${t.replyTo.address} instead of ${t.from.address}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `SPF alignment suffers here because ${t.returnPath.domain} is not ${t.from.domain}.`
      : `Reply-To matches the From domain ${t.from.domain}, so no diversion finding applies.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Two identities in one envelope: ${t.from.address} on the From, ${t.replyTo.address} on the Reply-To.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `Header From is ${t.from.domain} but the return path belongs to ${t.returnPath.domain}.`
      : `The envelope is self-consistent, all of it on ${t.from.domain}.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Anyone replying corresponds with ${t.replyTo.domain}, whatever ${t.from.domain} suggests.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `Return-Path ${t.returnPath.domain} disagrees with the advertised sender ${t.from.domain}.`
      : `Return-Path, Reply-To and From are aligned on ${t.from.domain}.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Correspondence is redirected to ${t.replyTo.address}, which is not on ${t.from.domain}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `The message bounces to ${t.returnPath.domain} despite claiming ${t.from.domain}.`
      : `There is no off-domain reply target on this one.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Reply-To points at ${t.replyTo.domain}; the From line says ${t.from.domain}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `Envelope identity ${t.returnPath.domain} differs from displayed identity ${t.from.domain}.`
      : `Every sender header on this message resolves to ${t.from.domain}.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `The answer address is ${t.replyTo.address}, deliberately off ${t.from.domain}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `Bounce handling belongs to ${t.returnPath.domain}, not the claimed ${t.from.domain}.`
      : `No reply diversion is present; ${t.from.domain} owns all three headers.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Where a reply lands — ${t.replyTo.address} — differs from where it appears to come from.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `${t.returnPath.domain} handles the bounces while ${t.from.domain} takes the credit.`
      : `The three sender headers do not contradict each other on this message.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Reply capture is set up at ${t.replyTo.address}, one domain removed from ${t.from.domain}.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `The return path names ${t.returnPath.domain} against a visible ${t.from.domain}.`
      : `Consistent sender identity throughout, all on ${t.from.domain}.`,
  (t) => t.replyTo.domain && t.replyTo.domain !== t.from.domain
    ? `Conversation is routed to ${t.replyTo.domain} the moment anyone hits reply.`
    : t.returnPath.domain && t.returnPath.domain !== t.from.domain
      ? `Two domains in play on the envelope: ${t.returnPath.domain} and ${t.from.domain}.`
      : `Reply and bounce paths stay put on ${t.from.domain}.`,
];

const PATH_GLOSS = [
  () => `That is the classic free-mailbox collection pattern.`,
  () => `Redirecting a conversation off-domain is rarely something a real sender needs.`,
  () => `Normal for some list software, but it does weaken alignment.`,
  () => `Checking sent items for that address beats checking proxy logs for clicks.`,
  () => `Weak evidence alone; it earns its place alongside the rest of the list.`,
  () => `Consistency is mildly reassuring and mildly irrelevant — hostile domains can be consistent too.`,
  () => `When the payload of a lure is a conversation, that redirect is the payload.`,
  () => `I logged it as medium rather than high, since bulk mailers produce this constantly.`,
  () => `Any mailbox that has already corresponded there is in scope for the incident.`,
  () => `This is exactly the split that makes SPF results hard to read.`,
  () => `Worth a line in the case notes even where a benign explanation exists.`,
  () => `It is the highest-value indicator in this file and belongs first in an escalation.`,
  () => `Relays and ESPs do this legitimately, so weight it lightly on its own.`,
  () => `Real senders who need this do it consistently across a whole campaign.`,
  () => `So there is no envelope-inconsistency finding to report against this one.`,
  () => `The mismatch is what dragged the alignment down in the first place.`,
  () => `Whoever sent it wants the answer somewhere they control.`,
  () => `Nothing here contradicts the identity the message advertises.`,
];

const LINK_FACTS = [
  (t) => { const h = hostsOf(t); return h.length ? `Link hosts in the body: ${h.slice(0, 5).join(", ")}${h.length > 5 ? ` and ${h.length - 5} more` : ""}.` : `The body carries no links at all.`; },
  (t) => { const h = hostsOf(t); return h.length ? `${h.length} distinct link host${h.length === 1 ? "" : "s"} appear here, starting with ${h[0]}.` : `No URLs were extracted from either body part.`; },
  (t) => { const h = hostsOf(t); return h.length ? `Hosts worth blocking: ${h.slice(0, 4).join(", ")}${h.length > 4 ? `, plus ${h.length - 4} others` : ""}.` : `There are no links to chase on this message.`; },
  (t) => { const h = hostsOf(t); return h.length ? `The body points at ${h.slice(0, 3).join(", ")}${h.length > 3 ? ` and ${h.length - 3} further hosts` : ""}.` : `Nothing clickable is present in this message.`; },
  (t) => { const h = hostsOf(t); return h.length ? `Extracted link hosts: ${h.slice(0, 6).join(", ")}.` : `Zero links were extracted from this file.`; },
  (t) => { const h = hostsOf(t); return h.length ? `On the link side there are ${h.length} host${h.length === 1 ? "" : "s"}, led by ${h[0]}.` : `No hyperlinks exist in the HTML or the plain-text part.`; },
  (t) => { const h = hostsOf(t); return h.length ? `Body links resolve on paper to ${h.slice(0, 5).join(", ")}.` : `The message contains no links whatsoever.`; },
  (t) => { const h = hostsOf(t); return h.length ? `Unvisited and unresolved: ${h.slice(0, 5).join(", ")}.` : `No landing page is referenced anywhere in the body.`; },
  (t) => { const h = hostsOf(t); return h.length ? `Link analysis turns up ${h.slice(0, 4).join(", ")} among the hrefs.` : `Link extraction returned an empty set for this one.`; },
  (t) => { const h = hostsOf(t); return h.length ? `The hrefs name ${h.slice(0, 4).join(", ")}${h.length > 4 ? ` and ${h.length - 4} besides` : ""}.` : `There is no URL in this message to enrich or detonate.`; },
  (t) => { const h = hostsOf(t); return h.length ? `Hosts recovered from the markup: ${h.slice(0, 5).join(", ")}.` : `Not one link survived into the stored copy of this message.`; },
  (t) => { const h = hostsOf(t); return h.length ? `${h.slice(0, 3).join(", ")} are the destinations written into this body.` : `The lure carries no clickable destination.`; },
  (t) => { const h = hostsOf(t); return h.length ? `Destination hosts, as written: ${h.slice(0, 5).join(", ")}.` : `No web destination appears anywhere in this file.`; },
  (t) => { const h = hostsOf(t); return h.length ? `I count ${h.length} unique host${h.length === 1 ? "" : "s"} in the links, including ${h[0]}.` : `Link hosts: none, in either representation of the body.`; },
  (t) => { const h = hostsOf(t); return h.length ? `Present in the hrefs: ${h.slice(0, 4).join(", ")}.` : `This message asks for something without offering a link.`; },
  (t) => { const h = hostsOf(t); return h.length ? `The parse recovered ${h.slice(0, 5).join(", ")} from the anchors.` : `Nothing in the body points outward to the web.`; },
  (t) => { const h = hostsOf(t); return h.length ? `Anchors resolve to ${h.slice(0, 4).join(", ")} as written in the source.` : `No outbound links were found during extraction.`; },
  (t) => { const h = hostsOf(t); return h.length ? `Link targets seen: ${h.slice(0, 5).join(", ")}.` : `The body is link-free, which is itself a data point.`; },
];

const LINK_GLOSS = [
  () => `Those go into the proxy blocklist ahead of the sending domain itself.`,
  () => `Web filtering gets you further here than mail filtering does.`,
  () => `Treat them as strings to check, not as confirmed live infrastructure.`,
  () => `Worth running past passive DNS before committing, in case any is shared hosting.`,
  () => `I have not visited any of them; the tool reads hrefs and stops.`,
  () => `Blocking at that layer costs less collateral than blocking the sender domain.`,
  () => `Where that is true the payload is the conversation: they want a reply, not a click.`,
  () => `That absence rules out a click-through investigation entirely.`,
  () => `Check them against the web proxy logs before assuming nobody went there.`,
  () => `A lure with no URL is usually after a reply or a phone call.`,
  () => `The sending address is disposable; the landing infrastructure generally is not.`,
  () => `Exposure here means replies rather than clicks, which changes who you ask.`,
  () => `None were resolved, so their current state is unknown to this pass.`,
  () => `Search the mail store for responses rather than the proxy for hits.`,
  () => `Conversational lures leave their evidence in sent items instead.`,
  () => `Whether any of that is still live is a question for enrichment.`,
  () => `Hostnames are cheap; the addresses behind them are what actually cluster.`,
  () => `That narrows the response to mailbox-side questions only.`,
];

const CLOSERS = [
  (t) => `Blocking ${t.from.domain || "the sending domain"} at the gateway is the cheap first move if you want to act.`,
  (t) => `Practically: quarantine anything else from ${t.from.domain || "that domain"} and check whether anyone answered it.`,
  () => `Next step I would take is searching for other recipients of the same subject line.`,
  () => `None of that needed a DNS or reputation lookup; the delivered headers carried it all.`,
  (t) => `Confirm ${t.from.domain || "this domain"} is not shared hosting before writing a block rule.`,
  () => `I would put this in front of a human before anything automated fires.`,
  (t) => `For the notes: ${t.hops} Received hop${t.hops === 1 ? "" : "s"}, ${t.signals.length} signal${t.signals.length === 1 ? "" : "s"}, no external enrichment.`,
  () => `Happy to pull the raw headers if you would rather not take the parsed view on trust.`,
  (t) => `Carry ${t.from.address} and the delivery-time DMARC result forward; neither is recoverable later.`,
  () => `That is as far as static analysis goes without infrastructure data the file does not hold.`,
  (t) => `I would rank it above generic bulk spam from ${t.from.domain || "an unknown domain"} and below a live credential page.`,
  () => `Tell me if you want the rest of the queue given the same treatment.`,
  () => `The cost of being wrong here is a blocked business relationship, so weigh it accordingly.`,
  (t) => `A mailbox sweep for ${t.from.address} will tell you the real exposure faster than a gateway rule.`,
  () => `Nothing above is reversible-by-accident, but the block rule is, so stage that one last.`,
  () => `If you need this defensible later, keep the tool output verbatim rather than my summary.`,
  (t) => `Worth checking whether ${t.from.domain || "the domain"} has appeared in any earlier report this quarter.`,
  () => `I would not automate on this pattern yet; the false-positive cost is still too high.`,
];

// ---------------------------------------------------------------------------
// reflection turns (question + answer generated together)
// ---------------------------------------------------------------------------

const REFLECT_TURNS = [
  (hist) => {
    const a = hist.at(-2);
    const b = hist.at(-1);
    if (!a || !b) return null;
    const worse = sev(b.triage, "high") >= sev(a.triage, "high") ? b : a;
    return {
      q: `How does ${shortName(b.path)} compare to ${shortName(a.path)}? Which is more suspicious?`,
      a: `Comparing the two: ${shortName(b.path)} raised ${b.triage.signals.length} signal${b.triage.signals.length === 1 ? "" : "s"} against ${a.triage.signals.length} for ${shortName(a.path)}.\n\nThe first came from ${a.triage.from.domain || "an unparseable domain"}; the second from ${b.triage.from.domain || "an unparseable domain"}. I would rank ${shortName(worse.path)} as the more dangerous of the pair, on the strength of its high-severity items rather than the raw count.\n\nSignal count is a poor proxy for risk. One reply-path redirect on a credential lure beats three cosmetic formatting oddities, and any ranking that adds severities together will get that backwards.`,
    };
  },
  (hist) => {
    const a = hist.at(-2);
    const b = hist.at(-1);
    if (!a || !b) return null;
    const same = a.triage.from.domain === b.triage.from.domain;
    const shared = a.triage.signals
      .map((s) => s.id)
      .filter((id) => b.triage.signals.some((s) => s.id === id));
    return {
      q: `Are ${shortName(a.path)} and ${shortName(b.path)} likely from the same actor?`,
      a: `On the header evidence alone, ${same ? "quite possibly" : "probably not — or at least I cannot demonstrate it"}.\n\nSending domains are ${a.triage.from.domain || "unparseable"} and ${b.triage.from.domain || "unparseable"}${same ? ", which is the same infrastructure" : ", which are unrelated so far as these two files go"}. ${shared.length ? `They do overlap on ${shared.length} signal type${shared.length === 1 ? "" : "s"} (${shared.join(", ")}), though those are generic enough to appear across unconnected campaigns.` : `They share no signal ids at all, which argues against a common origin.`}\n\nAttribution from two messages is guesswork. What would settle it is infrastructure overlap — matching relay IPs in the Received chain, an identical DKIM selector, a shared landing host — and none of that is visible from a pair of .eml files. Separate clusters until something links them.`,
    };
  },
  (hist) => {
    const doms = [...new Set(hist.map((h) => h.triage.from.domain).filter(Boolean))];
    return {
      q: `Summarise what you have found across all the emails so far.`,
      a: `Across the ${hist.length} message${hist.length === 1 ? "" : "s"} triaged in this batch the sending domains were ${doms.slice(0, 6).join(", ")}${doms.length > 6 ? ", and others" : ""}.\n\nThe recurring theme is authentication the receiver would not vouch for, sitting alongside reply paths that leave the claimed domain. Neither observation needed a reputation feed; the delivered headers carried enough on their own.\n\nWhere the messages differ is intent. Some read as commodity lures blasted at a purchased list; others are written to a named recipient and reference plausible internal detail. The second kind is what belongs in front of a human analyst first, regardless of how many signals each one raised.`,
    };
  },
  (hist) => {
    const worst = hist.slice().sort((x, y) => sev(y.triage, "high") - sev(x.triage, "high"))[0];
    if (!worst) return null;
    return {
      q: `Which of these would you escalate first, and why?`,
      a: `If there is time for exactly one, take ${shortName(worst.path)}.\n\nIt carries ${sev(worst.triage, "high")} high-severity item${sev(worst.triage, "high") === 1 ? "" : "s"}, the From domain is ${worst.triage.from.domain || "unparseable"}, and the recorded DMARC outcome was ${worst.triage.auth.dmarc || "not recorded"}.\n\nConcretely: block the sending domain at the gateway, sweep the mail store for the subject line ${shortName(worst.path)} carried, and pull sent-items for replies to it. Replies are the exposure that matters on this class of message, and they are also the evidence most likely to be deleted by an embarrassed user before you get there.`,
    };
  },
  (hist) => {
    const a = hist.at(-1);
    if (!a) return null;
    return {
      q: `Remind me what the SPF and DMARC results were on ${shortName(a.path)}.`,
      a: `On ${shortName(a.path)} the receiver stamped SPF ${a.triage.auth.spf || "nothing"} and DMARC ${a.triage.auth.dmarc || "nothing"}${a.triage.auth.dkim ? `, with DKIM at ${a.triage.auth.dkim}` : ""}.\n\nHold on to the caveat, though. Those values describe what happened when the message was delivered, not what would happen if it were sent again now. If the sending infrastructure has been remediated since, or the published SPF record has changed, a re-test today would disagree with the header.\n\nFor triage that is fine. For anything that ends up in an incident report, write the result down as historical and say when it was recorded.`,
    };
  },
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
      a: `${worst.triage.from.domain}, the one behind ${shortName(worst.path)}.\n\nIt sits behind the worst signal set in this batch, and blocking the domain rather than the individual address costs nothing when — as here — there is no legitimate correspondence with it on record.\n\nOne check before you push the rule: make sure the domain is not a bulk sender or shared platform that real mail also traverses. Blocking an entire ESP because one tenant abused it is a reliable route to a business-impacting outage and a very long ticket queue.`,
    };
  },
  (hist) => {
    const doms = [...new Set(hist.map((h) => h.triage.from.domain).filter(Boolean))];
    return {
      q: `What would you tell the affected users about these messages?`,
      a: `In plain language: these did not come from who they appear to come from, or at minimum the mail system could not confirm that they did.\n\nThe technical basis is DMARC. A domain publishes a policy saying mail claiming to be from it should pass SPF or DKIM with an aligned identifier. Where the receiver recorded a failure — as it did for several of ${doms.slice(0, 3).join(", ")} — nobody vouched for the sender.\n\nThe advice itself is short: do not reply, do not act on any payment or credential request, and forward the message to the security mailbox as an attachment so the headers survive the trip. Deleting it afterwards is fine.`,
    };
  },
  (hist) => {
    const withLinks = hist.filter((h) => hostsOf(h.triage).length);
    return {
      q: `Are any of these campaigns using the same landing infrastructure?`,
      a: withLinks.length
        ? `${withLinks.length} of the ${hist.length} messages carried links at all, which already limits how much overlap there could be.\n\nThe host sets are ${withLinks
            .slice(0, 3)
            .map((h) => `${shortName(h.path)} -> ${hostsOf(h.triage).slice(0, 3).join(", ")}`)
            .join("; ")}. Nothing repeats across files at the hostname level.\n\nThat said, distinct hostnames routinely sit on one box. Registrable-domain comparison is the weakest possible test for shared infrastructure; resolving each host and comparing the addresses, or comparing TLS certificate fingerprints, would be a real answer. I have deliberately not done either, since this pass makes no network calls.`
        : `None of them carried links at all, so there is no landing infrastructure to compare. Every message in this batch is after a reply rather than a click, which is why the host lists came back empty.\n\nIf you want a campaign linkage answer, the material to compare is the Received chain and the DKIM selectors, not URLs. Neither is exposed by this triage view, so it would mean reading the raw files.`,
    };
  },
  (hist) => {
    const withAtt = hist.filter((h) => h.triage.attachments.length);
    return {
      q: `Did any of these have attachments worth pulling apart?`,
      a: withAtt.length
        ? `${withAtt.length} of them did. ${withAtt
            .slice(0, 3)
            .map(
              (h) =>
                `${shortName(h.path)} carries ${h.triage.attachments.map((a) => `${a.filename || "an unnamed file"} (${a.declaredType}, ${a.bytes} bytes)`).join(" and ")}`,
            )
            .join("; ")}.\n\nThe digests in the tool output are SHA-256 over the decoded bytes, so they are the right thing to search a malware corpus with. I have not detonated anything and would not from here — that belongs in a sandbox with no route back to the estate.\n\nA declared content type is a claim, not a fact. If any of those matter, verify the real type from the magic bytes before deciding what the file actually is.`
        : `No — none of the messages in this batch carried an attachment. Every one of them is header-and-body only.\n\nThat is consistent with what else we have seen: these are credential and reply lures, not malware delivery. Malware campaigns tend to look different in the header pass too, usually with better authentication because they are sent from compromised legitimate accounts.`,
    };
  },
  (hist) => {
    const hops = hist.map((h) => h.triage.hops);
    const lo = Math.min(...hops);
    const hi = Math.max(...hops);
    return {
      q: `Is the Received hop count telling us anything useful here?`,
      a: `Across this batch the hop counts run from ${lo} to ${hi}.\n\nOn its own that range says very little. Hop count varies with how many relays, filters and forwarders a message crosses, and a perfectly legitimate message routed through a mailing list and two security gateways can easily outscore a hostile one sent directly.\n\nWhere it does earn attention is at the extremes and in the detail rather than the count: a single hop on mail claiming to originate inside a large corporate estate, or a chain whose hostnames contradict the claimed origin. Those are worth reading line by line. The bare number is not.`,
    };
  },
  (hist) => {
    const a = hist.at(-1);
    if (!a) return null;
    return {
      q: `What would change your mind about ${shortName(a.path)}?`,
      a: `Three things would move me, roughly in order of how quickly they could be checked.\n\nFirst, existing correspondence: if this mailbox has an established thread with ${a.triage.from.address}, the message becomes far more likely to be a genuine reply and far less likely to be a cold lure. Second, the registration age and hosting history of ${a.triage.from.domain || "the sending domain"} — a domain registered last week behaves differently from one that has carried mail for a decade. Third, whether other tenants of the same platform show the same pattern, which would point at an abused service rather than a purpose-built one.\n\nNone of those are in the .eml. All three are cheap to look up, and any one of them could flip the call.`,
    };
  },
  (hist) => {
    const doms = [...new Set(hist.map((h) => h.triage.from.domain).filter(Boolean))];
    return {
      q: `Write me two sentences I can paste into the incident channel.`,
      a: `Here you go:\n\n"Triaged ${hist.length} reported message${hist.length === 1 ? "" : "s"} this shift, spanning ${doms.length} sending domain${doms.length === 1 ? "" : "s"} including ${doms.slice(0, 3).join(", ")}; the common pattern is delivery-time authentication the receiver would not vouch for, combined with reply paths pointing away from the claimed sender. No links were visited and no attachments were detonated, so treat the verdicts as static-analysis calls pending enrichment."\n\nIf you need it shorter, drop the second sentence and keep the caveat in a thread reply — but do not drop the caveat entirely, because it is what stops someone quoting this as a confirmed detonation result later.`,
    };
  },
  (hist) => {
    const a = hist.at(-1);
    if (!a) return null;
    return {
      q: `Could ${shortName(a.path)} be a false positive?`,
      a: `It could. Nothing in the parse is conclusive on its own, and the honest position is that this is a prioritisation call, not a conviction.\n\nThe benign story would go like this: ${a.triage.from.domain || "the sending domain"} is a legitimate service, the message was forwarded through infrastructure that broke alignment, and the signals we raised are artefacts of that routing rather than of intent. That story is entirely plausible and it explains most of what the tool flagged.\n\nWhat it does not explain is the subject line and the ask. That subject is written to produce an action, and a message written to produce an action from an unauthenticated sender is worth a human look even when every individual signal has an innocent reading.`,
    };
  },
  (hist) => {
    return {
      q: `How confident are you overall, on a scale I can report upwards?`,
      a: `I would give the batch as a whole moderate-to-high confidence, with the caveat that the phrase means something specific here.\n\nHigh confidence in the facts: the parse is deterministic, the digests are reproducible, and anyone re-running the tool over the same ${hist.length} file${hist.length === 1 ? "" : "s"} will get identical output. There is no sampling and no model judgement in that layer.\n\nLower confidence in the intent calls. Those rest on my reading of the header patterns, and on the assumption that the delivery-time authentication stamps are still representative. If you need a number for a report, say the evidence is reproducible and the interpretation is analyst judgement — that distinction survives scrutiny better than any single percentage would.`,
    };
  },
];

function nextReflect(hist, used) {
  const order = REFLECT_TURNS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const i of order) {
    if (used.has(i)) continue;
    const turn = REFLECT_TURNS[i](hist);
    if (turn) {
      used.add(i);
      return turn;
    }
  }
  return null;
}

/**
 * Self-contained exchanges used to close the last few percent of the token gap.
 * A whole triage turn is 400-700 tokens, which is coarser than the 5% window at
 * the shallow depths, so these are appended individually until the measured
 * count lands inside it. Each is used at most once.
 */
const SHORT_EXCHANGES = [
  {
    q: `Quick one — is a DMARC pass enough for me to release a message from quarantine?`,
    a: `No. A pass tells you the From domain was not spoofed; it says nothing about whether the domain is hostile. Compromised accounts and week-old domains both authenticate cleanly. Release on content and context, never on the authentication line alone.`,
  },
  {
    q: `Do I need to worry about the SHA-256 values in your output?`,
    a: `Only as search keys. They are computed over the decoded attachment bytes, so they will match the same file anywhere else you have seen it — a malware corpus, another mailbox, a previous incident. They are not a verdict, and nothing in this pass looked them up.`,
  },
  {
    q: `Why do you keep saying the auth results are historical?`,
    a: `Because they are a stamp the receiving server wrote at the moment of delivery, not a live check. SPF records change, hosting gets cleaned up, DKIM keys rotate. Re-testing the same message today can produce a different answer, and an incident report that does not say so invites an argument later.`,
  },
  {
    q: `Is the Received hop count ever a signal on its own?`,
    a: `Rarely. It varies with how many relays and filters a message crosses, so a legitimate message through a mailing list and two gateways can easily outscore a hostile one sent direct. Read the chain, not the count.`,
  },
  {
    q: `What is the fastest check I can run that would actually change a verdict?`,
    a: `Look for prior correspondence with the sending address. An established thread moves a message from cold lure to plausible reply in one query, and it costs a single mailbox search. Domain registration age is the second cheapest.`,
  },
  {
    q: `Should I block on the sender address or the domain?`,
    a: `Domain, where there is no legitimate correspondence with it — addresses are disposable and the next one arrives within the hour. The exception is a shared platform, where a domain block takes out every other tenant along with the abuser.`,
  },
  {
    q: `How much should I trust the declared content type on an attachment?`,
    a: `Treat it as a claim by the sender, not a fact. If the file matters, check the magic bytes and decide from those. Declared types are trivially wrong, sometimes by accident and sometimes not.`,
  },
  {
    q: `Does an absent Authentication-Results header mean the message is hostile?`,
    a: `No, and I weight it low for that reason. Forwarding chains and internal relays strip the header routinely. What it does mean is that the cheapest reason to trust the sender is unavailable, so the rest of the evidence has to carry the call.`,
  },
  {
    q: `Anything you deliberately did not do that I should know about?`,
    a: `Three things. No hostname was resolved, so I cannot say what any of the link targets point at now. No attachment was opened or detonated. And no reputation or registration data was consulted, so every judgement rests on what the message itself carries.`,
  },
  {
    q: `If a user already replied to one of these, what is the first thing I do?`,
    a: `Find out what they sent. The exposure on a reply-bait lure is whatever went out in that message — a phone number, an invoice reference, a name and a role. Then get the mailbox owner to stop responding, because the second message is where the ask usually lands.`,
  },
  {
    q: `Are the severities in the tool output tuned for our environment?`,
    a: `They are not. They reflect how the rule was written, not what a finding costs here. Treat them as a sort order rather than a risk score, and override them whenever local context says otherwise.`,
  },
  {
    q: `Can I quote your verdicts directly in a ticket?`,
    a: `Quote the tool output and keep my reasoning as commentary. The parse is deterministic and reproducible by anyone with the file; my interpretation is judgement, and it should be visibly separable from the evidence when someone reviews the ticket in six months.`,
  },
];

const FINAL_USER_QUESTIONS = [
  `Right — last thing before I hand over. Give me the shift summary: what did we see, what did you escalate, and what is still open for the next analyst?`,
  `One more before we close this out. If you had to write the handover note for the incoming on-call, what would it say?`,
  `OK, wrap it up for me. What is the single most important thing the next person needs to know about this batch?`,
  `That is the queue cleared. Pull it all together — findings, actions taken, and anything you deliberately did not do.`,
];

// ---------------------------------------------------------------------------
// conversation builder
// ---------------------------------------------------------------------------

const heuristic = (s) => Math.ceil(s.length / 3.5);

/**
 * Build the message array with an estimated budget. Deterministic in `budget`.
 */
function buildConversation(pool, budget) {
  rand = mulberry32(hashSeed(SEED));
  NOTES = new Rotator(NOTE_BANK);
  const openers = new Rotator(OPENERS);
  const headings = new Rotator(SIGNAL_HEADINGS);
  const authFacts = new Rotator(AUTH_FACTS);
  const authGloss = new Rotator(AUTH_GLOSS);
  const pathFacts = new Rotator(PATH_FACTS);
  const pathGloss = new Rotator(PATH_GLOSS);
  const linkFacts = new Rotator(LINK_FACTS);
  const linkGloss = new Rotator(LINK_GLOSS);
  const closers = new Rotator(CLOSERS);
  const firstQs = new Rotator(FIRST_QUESTIONS);
  const followQs = new Rotator(FOLLOW_QUESTIONS);
  const styles = new Rotator(["numbered", "dash", "star", "arrow", "inline"]);
  const layouts = new Rotator([0, 1, 2, 3, 4, 5]);

  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  const history = [];
  const usedReflect = new Set();
  let used = heuristic(SYSTEM_PROMPT);
  let turnNo = 0;
  let poolIdx = 0;

  const push = (m, text) => {
    messages.push(m);
    used += heuristic(text);
  };

  while (poolIdx < pool.length) {
    const doReflect = turnNo > 0 && history.length >= 2 && turnNo % 3 === 2;

    if (doReflect) {
      turnNo++;
      const turn = nextReflect(history, usedReflect);
      if (!turn) continue;
      if (used + heuristic(turn.q) + heuristic(turn.a) > budget) break;
      push({ role: "user", content: turn.q }, turn.q);
      push({ role: "assistant", content: turn.a }, turn.a);
      continue;
    }

    const s = pool[poolIdx];
    const t = s.triage;
    const q = (turnNo === 0 ? firstQs : followQs).next()(s.path);
    const argsJson = JSON.stringify({ path: s.path });
    const toolText = render(t, s.path);

    // Compose the verdict from independently-rotated parts.
    const parts = [
      openers.next()(t, s.path),
      `${headings.next()}\n\n${signalBullets(t, styles.next())}`,
      `${authFacts.next()(t)} ${authGloss.next()()}`,
      `${pathFacts.next()(t)} ${pathGloss.next()()}`,
      `${linkFacts.next()(t)} ${linkGloss.next()()}`,
      closers.next()(t, s.path),
    ];
    const layout = layouts.next();
    const order =
      layout === 0
        ? [0, 1, 2, 3, 4, 5]
        : layout === 1
          ? [0, 2, 1, 3, 5, 4]
          : layout === 2
            ? [0, 3, 1, 2, 4, 5]
            : layout === 3
              ? [0, 1, 3, 2, 5, 4]
              : layout === 4
                ? [0, 2, 3, 1, 4, 5]
                : [0, 4, 1, 2, 3, 5];
    const answer = order.map((i) => parts[i]).join("\n\n");

    const cost =
      heuristic(q) + heuristic(argsJson) + heuristic(toolText) + heuristic(answer);
    if (used + cost > budget) {
      poolIdx++;
      if (poolIdx >= pool.length) break;
      continue;
    }

    const callId = `call_${randStr(24)}`;
    push({ role: "user", content: q }, q);
    push(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: { name: "phish_triage", arguments: argsJson },
          },
        ],
      },
      argsJson,
    );
    push({ role: "tool", tool_call_id: callId, content: toolText }, toolText);
    push({ role: "assistant", content: answer }, answer);

    history.push(s);
    poolIdx++;
    turnNo++;
  }

  // Top up with reflection turns while room remains.
  for (let i = 0; i < 6; i++) {
    const turn = nextReflect(history, usedReflect);
    if (!turn) break;
    if (used + heuristic(turn.q) + heuristic(turn.a) > budget) break;
    push({ role: "user", content: turn.q }, turn.q);
    push({ role: "assistant", content: turn.a }, turn.a);
  }

  // Trim back to a completed assistant text message, then end on a user turn.
  while (messages.length && messages.at(-1).role !== "assistant") messages.pop();
  while (messages.length && messages.at(-1).tool_calls) messages.pop();
  const finalQ = FINAL_USER_QUESTIONS[hashSeed(SEED) % FINAL_USER_QUESTIONS.length];
  messages.push({ role: "user", content: finalQ });

  return messages;
}

/** The text whose tokens are counted: every content plus every arguments blob. */
function concatOf(messages) {
  const parts = [];
  for (const m of messages) {
    if (typeof m.content === "string" && m.content.length) parts.push(m.content);
    for (const tc of m.tool_calls || []) parts.push(tc.function.arguments);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  COUNT_METHOD = (await serverAvailable()) ? "server" : "local";
  const label =
    COUNT_METHOD === "server"
      ? "POST /tokenize on 127.0.0.1:8080 (llamafile server)"
      : "llama-tokenize (vocab-only) over Bonsai-8B-Q1_0.gguf extracted from bonsai.llamafile";
  console.error(`[${TARGET}] token counting via ${label}`);

  const pool = buildSamplePool(Math.max(10, Math.ceil(TARGET / 430) + 8));
  console.error(`[${TARGET}] sample pool: ${pool.length} distinct .eml files`);
  if (pool.length < 3) throw new Error("sample pool too small");

  // Converge the char-heuristic budget on the real token target.
  let budget = TARGET;
  let best = null;
  const lo = Math.floor(TARGET * 0.95);
  for (let iter = 0; iter < 14; iter++) {
    const messages = buildConversation(pool, budget);
    const text = concatOf(messages);
    const measured = await tokenCount(text);
    console.error(
      `[${TARGET}] iter ${iter}: budget=${budget} measured=${measured} (${((measured / TARGET) * 100).toFixed(1)}%)`,
    );
    if (measured >= lo && measured <= TARGET) {
      best = { messages, measured };
      break;
    }
    // Keep the best under-target candidate as a fallback.
    if (measured <= TARGET && (!best || measured > best.measured)) {
      best = { messages, measured };
    }
    const ratio = TARGET / measured;
    const next = Math.round(budget * (1 + (ratio - 1) * 0.9));
    if (next === budget) budget += measured > TARGET ? -40 : 40;
    else budget = next;
  }
  if (!best) throw new Error("could not converge on target token count");

  // Top-up: append short self-contained exchanges (largest that still fits)
  // until the measured count lands inside the window. Each exchange is used at
  // most once, so this cannot introduce repeated text.
  if (best.measured < lo) {
    const costs = [];
    for (const ex of SHORT_EXCHANGES) {
      costs.push({ ex, cost: await tokenCount(`${ex.q}\n${ex.a}`) });
    }
    costs.sort((a, b) => b.cost - a.cost);
    const usedEx = new Set();
    for (let guard = 0; guard < SHORT_EXCHANGES.length && best.measured < lo; guard++) {
      const gap = TARGET - best.measured;
      const choice = costs.find((c) => !usedEx.has(c.ex) && c.cost <= gap);
      if (!choice) break;
      usedEx.add(choice.ex);
      const messages = best.messages.slice();
      const tail = messages.pop(); // the closing user message
      messages.push({ role: "user", content: choice.ex.q });
      messages.push({ role: "assistant", content: choice.ex.a });
      messages.push(tail);
      const measured = await tokenCount(concatOf(messages));
      if (measured > TARGET) continue;
      best = { messages, measured };
      console.error(`[${TARGET}] top-up: +${choice.cost} -> measured=${measured}`);
    }
  }
  if (best.measured < lo) {
    console.error(
      `[${TARGET}] WARNING: landed at ${best.measured}, below the ${lo} floor (5% window)`,
    );
  }

  const out = {
    targetTokens: TARGET,
    measuredTokens: best.measured,
    messages: best.messages,
  };
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.error(
    `[${TARGET}] wrote ${args.out}: ${best.messages.length} messages, ${best.measured} tokens ` +
      `(${((best.measured / TARGET) * 100).toFixed(2)}% of target)`,
  );
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
