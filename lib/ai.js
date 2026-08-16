const i18n = require("./i18n");
const { statements } = require("./db");

/** AI-backed copy generation, over either a local Ollama or any
 * OpenAI-compatible hosted API (NanoGPT, OpenRouter, OpenAI itself...).
 *
 * Design constraint that drives everything here: generation must never
 * happen during an HTTP request. On a Pi doing CPU inference that would
 * stall page loads for a minute; even on a fast hosted API it would put a
 * third-party outage in the path of rendering the homepage. Instead a
 * timer writes into the ai_content table and pages read cached rows.
 *
 * Every read falls back to the hand-written arrays in lib/i18n.js, so the
 * site is fully functional with no AI configured at all - the same
 * "unset means the feature is simply off" contract as donations and SMTP.
 */

// ollama = local daemon; openai = any OpenAI-compatible /chat/completions
const AI_PROVIDER = (process.env.AI_PROVIDER || "ollama").toLowerCase();

const OLLAMA_HOST = process.env.OLLAMA_HOST || "";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2:1b";

// Hosted provider. AI_BASE_URL is the root; the /chat/completions path is
// appended, so NanoGPT is https://nano-gpt.com/api/v1
const AI_BASE_URL = (process.env.AI_BASE_URL || "").replace(/\/$/, "");
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "";

// A hosted model answers in seconds, a Pi takes a minute. One generous
// timeout covers both; nothing is waiting on it either way.
const AI_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || process.env.AI_TIMEOUT_MS || 180000);

const CONTENT_INTERVAL_MS = 3 * 60 * 60 * 1000; // quotes / examples / phrases
const AWARD_INTERVAL_MS = 60 * 60 * 1000;       // checked hourly, acts once a day

function usingHosted() {
  return AI_PROVIDER === "openai";
}

function isEnabled() {
  return usingHosted() ? Boolean(AI_BASE_URL && AI_API_KEY) : Boolean(OLLAMA_HOST);
}

function activeModel() {
  return usingHosted() ? (AI_MODEL || "(AI_MODEL not set)") : OLLAMA_MODEL;
}

function activeHost() {
  return usingHosted() ? (AI_BASE_URL || null) : (OLLAMA_HOST || null);
}

function describeConfig() {
  return {
    enabled: isEnabled(),
    provider: usingHosted() ? "openai-compatible" : "ollama",
    host: activeHost(),
    model: activeModel()
  };
}

async function callModel(prompt, { json = true } = {}) {
  if (!isEnabled()) throw new Error("No AI provider is configured.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    if (usingHosted()) {
      const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 1.0,
          max_tokens: 400,
          // Best-effort only. Not every gateway/model honours it, and
          // extractJson already copes with JSON buried in prose - so a
          // provider that ignores this still works.
          ...(json ? { response_format: { type: "json_object" } } : {})
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // Truncated: provider errors can echo request bodies back.
        throw new Error(`Provider returned ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
      }
      const body = await response.json();
      return String(body.choices?.[0]?.message?.content || "");
    }

    const response = await fetch(`${OLLAMA_HOST.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        ...(json ? { format: "json" } : {}),
        options: { temperature: 1.0, num_predict: 400 }
      }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const body = await response.json();
    return String(body.response || "");
  } finally {
    clearTimeout(timer);
  }
}

/** Small models wander outside the JSON they were asked for - a stray
 * sentence before the array, a trailing note after it. Pull out the first
 * balanced JSON value rather than trusting the whole response to parse. */
function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to bracket scanning
  }
  const start = trimmed.search(/[[{]/);
  if (start === -1) return null;
  const open = trimmed[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString) {
      if (char === open) depth += 1;
      else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

/** Anything the model returns is untrusted input that ends up on a public
 * page, so it gets the same treatment as a user upload: right shape, sane
 * length, no empties. Returns null (keep the fallback) rather than
 * publishing something malformed. */
/** Loose key for "is this the same line?" - lowercased, trailing punctuation
 * and whitespace removed. The few-shot examples for quotes end in a period
 * and the ones for phrases don't, and models mix the two, so an exact
 * comparison would miss half the echoes. */
function sameLineKey(text) {
  return text.toLowerCase().replace(/[.!?…\s]+$/u, "").trim();
}

function cleanStringList(value, { min, max, maxLength }, exclude = []) {
  // Asked for a bare JSON array, qwen2.5:0.5b actually returns
  // {"funny_strings": [...]} - it invents a wrapper key, and the key name
  // changes with the prompt. So: take the array if we got one, otherwise
  // take the first array-of-strings found among the object's values,
  // whatever it happens to be called.
  let list = null;
  if (Array.isArray(value)) {
    list = value;
  } else if (value && typeof value === "object") {
    list = Object.values(value).find(
      (candidate) => Array.isArray(candidate) && candidate.some((item) => typeof item === "string")
    ) || null;
  }
  if (!list) return null;

  const cleaned = list
    .filter((item) => typeof item === "string")
    .map((item) => item
      // The model likes appending social-media hashtags ("... #funny
      // #badvideo") which look wrong on the page. Strip any trailing run
      // of them, plus surrounding quotes it sometimes leaves behind.
      .replace(/(?:\s+#[\p{L}\p{N}_]+)+\s*$/gu, "")
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter((item) => item.length > 0 && item.length <= maxLength);

  // Models routinely hand the few-shot examples straight back as if they
  // were new - on real output more than half of one list was the prompt
  // echoed verbatim. Those look plausible on the page (they're the curated
  // fallback strings, after all), so nothing catches it downstream: the
  // site quietly pays for generation and displays its own hardcoded copy.
  // Drop anything matching a shot, and any duplicate within the list.
  const seen = new Set(exclude.map(sameLineKey));
  const fresh = [];
  for (const item of cleaned) {
    const key = sameLineKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(item);
  }

  if (fresh.length < min) return null;
  return fresh.slice(0, max);
}

const LANG_NAME = { en: "English", sl: "Slovenian" };

// Few-shot, not instructions. Told abstractly to "write something absurd",
// a 0.5b model produces surreal nonsense (a dog dressed as a clown, a
// bridge between galaxies). Shown four concrete examples of the exact
// register, it stays much closer to the joke: mundane, specific, and
// plausibly something a real person actually did.
const SHOTS = {
  quotes: {
    en: ["That's a certified Sejbosejbo.", "Peak human intelligence.", "This cannot be unseen.", "The vibes were tested. They failed."],
    sl: ["To je certificiran Sejbosejbo.", "Vrh človeške inteligence.", "Tega se ne da odvideti.", "Brez misli, samo Sejbosejbo."]
  },
  phrases: {
    en: ["Certified Sejbosejbo", "Brain.exe stopped working", "Maximum Sejbosejbo achieved", "Peak human intelligence"],
    sl: ["Certificiran Sejbosejbo", "Možgani.exe so nehali delati", "Dosežen maksimalni Sejbosejbo", "Vrh človeške inteligence"]
  },
  examples: {
    en: ["Someone microwaved ice.", "Someone installed Chrome to download Edge.", "Someone asked if Wi-Fi is wireless electricity.", "Someone charged the charger."],
    sl: ["Nekdo je pogrel led v mikrovalovki.", "Nekdo je namestil Chrome, da je prenesel Edge.", "Nekdo je vprašal, ali je Wi-Fi brezžična elektrika.", "Nekdo je polnil polnilec."]
  }
};

const ASKS = {
  quotes: { count: 7, what: "short deadpan reaction lines, the kind you'd caption a screenshot of something idiotic", limit: 60 },
  phrases: { count: 10, what: "short punchy labels, like achievement titles for doing something stupid", limit: 45 },
  examples: { count: 3, what: "one-sentence examples of someone doing something mundane and stupid with everyday objects or technology", limit: 70 }
};

function promptFor(kind, lang) {
  const language = LANG_NAME[lang] || "English";
  const ask = ASKS[kind];
  const shots = (SHOTS[kind][lang] || SHOTS[kind].en).map((s) => `  ${JSON.stringify(s)}`).join(",\n");

  return `"Sejbosejbo" is a made-up word for something so stupid it becomes legendary.

Here are real examples of the style, in ${language}:
[
${shots}
]

Now write ${ask.count} NEW ones in ${language}: ${ask.what}.
Rules: match the style above exactly. Everyday and specific, never surreal or fantastical. Each under ${ask.limit} characters. No hashtags, no emoji, no explanations.
Every line must be new. Do not repeat, translate or lightly reword any of the examples above.

Respond with only a JSON array of ${ask.count} strings.`;
}

// Minimums are deliberately below what the prompt asks for. A 0.5b model
// routinely returns fewer items than requested (asked 3, gave 2), and
// rejecting those would mean permanently falling back despite a working
// model. The box renders fine with fewer lines.
const SPECS = {
  quotes: { min: 3, max: 7, maxLength: 80 },
  phrases: { min: 4, max: 10, maxLength: 60 },
  examples: { min: 2, max: 3, maxLength: 90 }
};

async function generateList(kind, lang) {
  const spec = SPECS[kind];
  const raw = await callModel(promptFor(kind, lang));
  const parsed = extractJson(raw);
  // Exclude the shots this prompt showed - both languages, since a model
  // asked for Slovenian sometimes echoes the English examples back.
  const shots = [...(SHOTS[kind].en || []), ...(SHOTS[kind].sl || [])];
  const cleaned = cleanStringList(parsed, spec, shots);
  if (!cleaned) throw new Error(`${kind}/${lang}: model returned unusable output`);
  await statements.setAiContent.run(kind, lang, JSON.stringify(cleaned));
  contentCache.set(`${kind}:${lang}`, JSON.stringify(cleaned));
  return cleaned;
}

/** Picks the day's award post. The model only ever chooses among ids we
 * hand it, and the choice is validated against the visible set before
 * being stored - a hallucinated id falls back to the deterministic
 * date-hash pick rather than 500ing or showing a hidden post. */
async function generateDailyAward() {
  const posts = await statements.dailyPool.all();
  if (!posts.length) throw new Error("award: no posts to choose from");

  // Cap the candidate list - a tiny model's context is small and long
  // prompts on a Pi are slow. Newest 40 keeps it current and cheap.
  const candidates = posts.slice(-40);
  const listing = candidates.map((p) => `${p.id}: ${p.title}`).join("\n");

  const raw = await callModel(`"Sejbosejbo" means something so stupid it becomes legendary.
Below is a numbered list of posts. Pick the ONE that is the most absurd, stupid, or funny.

${listing}

Respond with only JSON: {"id": <the number>}`);

  const parsed = extractJson(raw);
  const chosenId = Number(parsed?.id);
  const match = candidates.find((p) => p.id === chosenId);
  if (!match) throw new Error(`award: model picked ${parsed?.id}, not a valid candidate`);

  const awardValue = JSON.stringify({ id: match.id, date: today() });
  await statements.setAiContent.run("daily_award", "", awardValue);
  contentCache.set("daily_award:", awardValue);
  return match;
}

/** The site's current calendar day, in the site's timezone - so the daily
 * award changes at local midnight rather than at 01:00/02:00 Slovenian
 * time, which is what UTC worked out to. en-CA formats as YYYY-MM-DD. */
function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.SITE_TIMEZONE || "Europe/Ljubljana"
  }).format(new Date());
}

// ------------------------------------------------------------- readers ---

/** In-memory mirror of the ai_content table, keyed "kind:lang".
 *
 * The accessors below run on every page render, and the database now lives
 * on another machine - reading it per render would put a network round trip
 * in front of every request to serve copy that only changes every few
 * hours. This is loaded at startup and refreshed after each generation, so
 * the getters stay synchronous and free. */
const contentCache = new Map();

/** Repopulates the whole cache from the database. Cheap (a handful of
 * rows), so it re-reads everything rather than tracking dirty keys. */
async function reloadContentCache() {
  try {
    const rows = await statements.allAiContent.all();
    contentCache.clear();
    for (const row of rows) contentCache.set(`${row.key}:${row.lang}`, row.value);
  } catch (err) {
    // A failed reload leaves the previous cache in place; the curated i18n
    // arrays are the floor either way, so this can't break a page render.
    console.error(`[ai] could not load content cache: ${err.message}`);
  }
}

function readCachedList(kind, lang) {
  const raw = contentCache.get(`${kind}:${lang}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

/** The four public accessors. Each takes the static i18n array as the
 * fallback, so callers never have to think about whether AI is on. */
function getQuotes(lang) {
  return readCachedList("quotes", lang) || i18n[lang].quotes;
}

function getPhrases(lang) {
  return readCachedList("phrases", lang) || i18n[lang].phrases;
}

/** The yellow box on the homepage: 3 generated lines plus the fixed
 * "Sejbosejbo." punchline, which is the bit that must not drift. */
function getExamples(lang) {
  const generated = readCachedList("examples", lang);
  if (!generated) return i18n[lang].examples;
  return [...generated.slice(0, 3), i18n[lang].examples[3]];
}

/** Today's award, if the AI picked one today and that post is still
 * visible. Returns null so the caller can use the existing deterministic
 * pick - which is what runs whenever AI is off, stale, or the post got
 * hidden or deleted since. */
/** Async because it resolves the winning post, which is a real row read -
 * unlike the list accessors above, which the in-memory cache keeps free. */
async function getDailyAwardPost() {
  const raw = contentCache.get("daily_award:");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.date !== today()) return null;
    return (await statements.uploadByIdPublic.get(Number(parsed.id))) || null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------- self-test ---

/** Walks the three things that can independently be wrong - reachable,
 * model present, model actually generates - and reports which step failed
 * rather than a single unhelpful "it didn't work". */
async function testConnection() {
  if (!isEnabled()) {
    return {
      ok: false,
      step: "config",
      message: usingHosted()
        ? "AI_BASE_URL and AI_API_KEY are not both set."
        : "OLLAMA_HOST is not set."
    };
  }

  const started = Date.now();

  // Ollama can be probed in stages (reachable / model present / generates),
  // which gives a much more useful diagnosis. A hosted API has no
  // equivalent cheap probe, so it goes straight to a real generation - a
  // wrong key or model name surfaces there as an HTTP error anyway.
  if (!usingHosted()) {
    const base = OLLAMA_HOST.replace(/\/$/, "");
    let tags;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${base}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) {
        return { ok: false, step: "reach", message: `${base} answered ${response.status}.` };
      }
      tags = await response.json();
    } catch (err) {
      return {
        ok: false,
        step: "reach",
        message: `Could not reach ${base} (${err.name === "AbortError" ? "timed out" : err.message}). ` +
          `From inside the container 127.0.0.1 is the container itself - use the host's LAN IP.`
      };
    }

    const models = (tags.models || []).map((m) => m.name);
    const hasModel = models.some((name) => name === OLLAMA_MODEL || name.split(":")[0] === OLLAMA_MODEL.split(":")[0]);
    if (!hasModel) {
      return {
        ok: false,
        step: "model",
        message: `Reachable, but "${OLLAMA_MODEL}" isn't installed. Available: ${models.join(", ") || "none"}. Run: ollama pull ${OLLAMA_MODEL}`
      };
    }
  }

  try {
    const raw = await callModel(
      'Reply with only this JSON and nothing else: {"ok":true}',
      { json: true }
    );
    const parsed = extractJson(raw);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (!parsed) {
      return {
        ok: false,
        step: "generate",
        message: `${activeModel()} responded in ${seconds}s but the output wasn't usable JSON: ${raw.slice(0, 120)}`
      };
    }
    return {
      ok: true,
      step: "generate",
      message: `Working. ${activeModel()} responded in ${seconds}s via ${usingHosted() ? "hosted API" : "Ollama"}.`
    };
  } catch (err) {
    return {
      ok: false,
      step: "generate",
      message: err.name === "AbortError"
        ? `Timed out after ${AI_TIMEOUT_MS / 1000}s calling ${activeModel()}.`
        : `Generation failed: ${err.message}`
    };
  }
}

// ----------------------------------------------------------- scheduling ---

let running = false;

async function refreshContent({ force = false } = {}) {
  if (!isEnabled() || running) return { skipped: true };
  running = true;
  const results = [];
  try {
    for (const kind of ["quotes", "phrases", "examples"]) {
      for (const lang of ["en", "sl"]) {
        const existing = await statements.getAiContent.get(kind, lang);
        const age = existing ? Date.now() - new Date(`${existing.updated_at}Z`).getTime() : Infinity;
        if (!force && age < CONTENT_INTERVAL_MS) continue;
        try {
          await generateList(kind, lang);
          results.push(`${kind}/${lang}: ok`);
        } catch (err) {
          // Logged, not thrown: one bad generation must not stop the rest
          // or kill the timer. The old cached value stays in place.
          console.error(`[ai] ${err.message}`);
          results.push(`${kind}/${lang}: failed`);
        }
      }
    }
  } finally {
    running = false;
  }
  return { results };
}

async function refreshAward({ force = false } = {}) {
  if (!isEnabled()) return { skipped: true };
  const row = await statements.getAiContent.get("daily_award", "");
  if (!force && row) {
    try {
      if (JSON.parse(row.value).date === today()) return { skipped: true };
    } catch {
      // corrupt row - fall through and regenerate
    }
  }
  try {
    const post = await generateDailyAward();
    return { ok: true, id: post.id };
  } catch (err) {
    console.error(`[ai] ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function start() {
  // Always prime the cache, even with no provider configured: rows written
  // by a previous run (or before AI was switched off) are still the best
  // copy available, and the getters read only from memory now.
  await reloadContentCache();

  if (!isEnabled()) {
    console.log("[ai] no provider configured - using the built-in phrase lists.");
    return;
  }
  const cfg = describeConfig();
  console.log(`[ai] using ${cfg.provider} at ${cfg.host} (model ${cfg.model})`);

  // Kick off shortly after boot rather than immediately, so a cold start
  // isn't competing with the app coming up.
  setTimeout(() => {
    refreshContent().catch((err) => console.error("[ai]", err.message));
    refreshAward().catch((err) => console.error("[ai]", err.message));
  }, 30000).unref();

  setInterval(() => {
    refreshContent().catch((err) => console.error("[ai]", err.message));
  }, CONTENT_INTERVAL_MS).unref();

  setInterval(() => {
    refreshAward().catch((err) => console.error("[ai]", err.message));
  }, AWARD_INTERVAL_MS).unref();
}

module.exports = {
  isEnabled,
  describeConfig,
  testConnection,
  getQuotes,
  getPhrases,
  getExamples,
  getDailyAwardPost,
  refreshContent,
  refreshAward,
  start,
  // exported for tests - the shot-dedupe is easy to regress silently,
  // since echoed output looks perfectly valid on the page
  _internal: { cleanStringList, SHOTS }
};
