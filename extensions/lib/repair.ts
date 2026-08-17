/**
 * Repair the tool arguments a small model actually sends.
 *
 * An 8B model quantised to one bit per weight gets tool calls *nearly* right a
 * lot of the time. The schema wants `{"path": "x.eml"}` and it sends
 * `{"file": "x.eml"}`, or `{"path": ["x.eml"]}`, or the whole object encoded as
 * a JSON string, or valid JSON with a trailing comma. On a big cloud model you
 * would let the schema reject it and let the model try again. Here a retry costs
 * a full prompt evaluation — minutes on a CPU — so it is worth repairing what we
 * can before validation rather than after.
 *
 * pi gives us the right hook for this: `prepareArguments(args)` runs *before*
 * schema validation and before `execute()`. That keeps the published schema
 * strict — the model is still told exactly one correct shape — while accepting
 * near-misses at the door.
 *
 * Deliberately conservative. Every rule here maps a recognisable mistake onto
 * the one obvious intent. Nothing guesses: if the input is not clearly a
 * near-miss, it is returned untouched so the schema can reject it properly and
 * the model gets a real error message.
 *
 * No pi imports and no typebox, so `npm test` can load this directly.
 */

/** Field names a model plausibly reaches for instead of `path`. */
const PATH_ALIASES = [
  "path",
  "file",
  "filename",
  "file_path",
  "filepath",
  "eml",
  "eml_path",
  "email",
  "email_path",
  "input",
  "target",
];

export interface RepairResult {
  /** The arguments to hand to schema validation. */
  args: unknown;
  /** Human-readable description of each fix, for logging and for tests. */
  repairs: string[];
}

/**
 * Strip one layer of JSON string encoding.
 *
 * Models routinely emit `"{\"path\": \"x\"}"` — the arguments object serialised
 * as a JSON *string* rather than sent as an object. Some providers hand that
 * through as a plain string.
 */
function unwrapJsonString(value: unknown): { value: unknown; unwrapped: boolean } {
  if (typeof value !== "string") return { value, unwrapped: false };

  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { value, unwrapped: false };
  }

  try {
    return { value: JSON.parse(trimmed), unwrapped: true };
  } catch {
    return { value, unwrapped: false };
  }
}

/**
 * Parse JSON that is *nearly* valid.
 *
 * Handles the two malformations small models produce most: a trailing comma,
 * and truncation part-way through (an unterminated string or unclosed brace,
 * usually because the reply hit a token limit mid-call).
 */
export function parseLooseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to the repairs below */
  }

  // Trailing commas before a closing brace or bracket.
  const noTrailingCommas = trimmed.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(noTrailingCommas);
  } catch {
    /* keep going */
  }

  // Truncated: close any open string, then any open brackets, in order.
  let candidate = noTrailingCommas;
  const quotes = (candidate.match(/(?<!\\)"/g) ?? []).length;
  if (quotes % 2 === 1) candidate += '"';

  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i];
    if (c === '"' && candidate[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  candidate += stack.reverse().join("");

  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Coerce whatever the model sent into `{ path: string }`.
 *
 * Returns the input unchanged when it is not a recognisable near-miss, so the
 * schema can produce a proper error rather than this function inventing a call.
 */
export function repairPathArgs(input: unknown): RepairResult {
  const repairs: string[] = [];

  let args = input;

  // A whole-object JSON string.
  const unwrapped = unwrapJsonString(args);
  if (unwrapped.unwrapped) {
    args = unwrapped.value;
    repairs.push("decoded arguments that arrived as a JSON string");
  }

  // A bare string where an object was required: "samples/x.eml".
  if (typeof args === "string") {
    const bare = args.trim();
    // Only if it looks like a path, not arbitrary prose.
    if (bare && !/\s/.test(bare)) {
      return { args: { path: bare }, repairs: [...repairs, "wrapped a bare string as { path }"] };
    }
    return { args: input, repairs: [] };
  }

  if (args === null || typeof args !== "object") return { args: input, repairs: [] };

  // A single-element array of arguments.
  if (Array.isArray(args)) {
    if (args.length !== 1) return { args: input, repairs: [] };
    const inner = repairPathArgs(args[0]);
    return { args: inner.args, repairs: [...repairs, "unwrapped a single-element array", ...inner.repairs] };
  }

  const obj = { ...(args as Record<string, unknown>) };

  // Nested one level deeper: { arguments: {...} } or { parameters: {...} }.
  for (const wrapper of ["arguments", "params", "parameters", "input"]) {
    const inner = obj[wrapper];
    if (Object.keys(obj).length === 1 && inner && typeof inner === "object") {
      const r = repairPathArgs(inner);
      return { args: r.args, repairs: [...repairs, `unwrapped nested "${wrapper}"`, ...r.repairs] };
    }
  }

  // Find a usable path under any recognised alias.
  let found: { key: string; value: unknown } | undefined;
  for (const alias of PATH_ALIASES) {
    if (alias in obj && obj[alias] !== undefined && obj[alias] !== null) {
      found = { key: alias, value: obj[alias] };
      break;
    }
  }

  // Exactly one key with a string value is unambiguous even under an unknown name.
  if (!found) {
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj[keys[0]] === "string") {
      found = { key: keys[0], value: obj[keys[0]] };
    }
  }

  if (!found) return { args: input, repairs: [] };

  let value = found.value;

  // A single-element array of paths.
  if (Array.isArray(value) && value.length === 1) {
    value = value[0];
    repairs.push("took the single element from an array of paths");
  }

  // A number or boolean where a string belonged.
  if (typeof value === "number" || typeof value === "boolean") {
    value = String(value);
    repairs.push(`stringified a ${typeof found.value} path`);
  }

  if (typeof value !== "string") return { args: input, repairs: [] };

  const cleaned = value.trim().replace(/^["'`]|["'`]$/g, "");
  if (cleaned !== value) repairs.push("stripped surrounding quotes from the path");

  if (found.key !== "path") {
    repairs.push(`renamed "${found.key}" to "path"`);
  }

  if (!cleaned) return { args: input, repairs: [] };

  // Drop everything else: the schema takes only `path`, and extra keys from a
  // confused model are noise rather than intent.
  const dropped = Object.keys(obj).filter((k) => k !== found.key);
  if (dropped.length) repairs.push(`ignored unexpected key(s): ${dropped.join(", ")}`);

  return { args: { path: cleaned }, repairs };
}
