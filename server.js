// R-AI TRINITY — server.js (Node 18+, hakuna dependencies)
// Endesha: node server.js   → http://localhost:3000
// USALAMA: Faili hili lina Tavily key. Usilipakie kwenye GitHub ya umma.

const http = require("http");
const fs = require("fs");
const path = require("path");

const CONFIG = {
  PORT: process.env.PORT || 3000,

  // === TAVILY API KEY MOJA kwa AI zote tatu ===
  TAVILY_API_KEY: "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",

  // === Modeli ya AI (inahitajika ili mjadala halisi ufanye kazi) ===
  // Inafanya kazi na API yoyote ya OpenAI-compatible.
  LLM_API_KEY: process.env.LLM_API_KEY || "",
  LLM_BASE_URL: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
  LLM_MODEL: process.env.LLM_MODEL || "gpt-4o-mini",

  MAX_SEARCHES_PER_SESSION: 6, // kikomo cha utafutaji kwa mjadala mmoja
  DEBATE_ROUNDS: 1,            // mizunguko ya mjadala (inasanidika)
  CACHE_TTL_MS: 10 * 60 * 1000,
  SEARCH_TIMEOUT_MS: 15000,
  LLM_TIMEOUT_MS: 60000,
  RATE_LIMIT_PER_MIN: 10,      // mijadala kwa IP kwa dakika
};

// ---------- TavilySearchService (huduma moja kwa AI zote) ----------
class TavilySearchService {
  constructor() { this.cache = new Map(); }

  async search({ query, by, session }) {
    const q = String(query || "").trim().slice(0, 300);
    if (!q) return { ok: false, error: "Query tupu", results: [] };
    const key = q.toLowerCase();

    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.t < CONFIG.CACHE_TTL_MS) {
      return { ok: true, cached: true, results: hit.results.map(r => ({ ...r, requestedBy: by })) };
    }
    if (session.searches >= CONFIG.MAX_SEARCHES_PER_SESSION) {
      return { ok: false, error: "Kikomo cha utafutaji kwa mjadala huu kimefikiwa.", results: [] };
    }
    session.searches++;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CONFIG.SEARCH_TIMEOUT_MS);
    try {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + CONFIG.TAVILY_API_KEY },
        body: JSON.stringify({ query: q, max_results: 5, search_depth: "basic" }),
        signal: ctl.signal,
      });
      if (!r.ok) {
        const msg = r.status === 401 ? "Tavily key si sahihi (401)"
          : r.status === 429 || r.status === 432 || r.status === 433 ? "Kikomo cha matumizi ya Tavily kimefikiwa (" + r.status + ")"
          : "Tavily imerudisha hitilafu " + r.status;
        return { ok: false, error: msg, results: [] };
      }
      const data = await r.json();
      const results = (data.results || []).map(x => ({
        title: x.title || "",
        url: x.url || "",
        snippet: String(x.content || "").slice(0, 500),
        score: typeof x.score === "number" ? x.score : null,
        date: x.published_date || null,
        query: q,
        requestedBy: by,
      }));
      this.cache.set(key, { t: Date.now(), results });
      return { ok: true, cached: false, results };
    } catch (e) {
      return { ok: false, error: e.name === "AbortError" ? "Tavily imechelewa (timeout)" : "Tavily haipatikani: " + e.message, results: [] };
    } finally { clearTimeout(timer); }
  }
}
const tavily = new TavilySearchService();

// ---------- Modeli ya AI ----------
async function llm(system, user) {
  if (!CONFIG.LLM_API_KEY) throw new Error("NO_LLM");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CONFIG.LLM_TIMEOUT_MS);
  try {
    const r = await fetch(CONFIG.LLM_BASE_URL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + CONFIG.LLM_API_KEY },
      body: JSON.stringify({
        model: CONFIG.LLM_MODEL,
        temperature: 0.4,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error("LLM " + r.status);
    const d = await r.json();
    return d.choices[0].message.content.trim();
  } finally { clearTimeout(timer); }
}

const PERSONAS = {
  sade: "Wewe ni Sade, kiongozi wa mjadala na mchambuzi mkuu. Jibu kwa Kiswahili sanifu. Usibuni makubaliano; eleza tofauti za hoja na sababu. Tofautisha kilichothibitishwa na kisichothibitishwa.",
  fire: "Wewe ni R-AI Fire, mtaalamu wa uchambuzi wa kiufundi (zimamoto, uokoaji, fire science, vifaa, usalama, teknolojia). Jibu kwa Kiswahili. Toa mapendekezo yanayotekelezeka na ukubali marekebisho hoja ikithibitishwa dhaifu.",
  search: "Wewe ni R-AI Search, mtafiti. Jibu kwa Kiswahili. Tumia TU vyanzo vilivyotolewa (taja kwa namba [n]). Tofautisha ushahidi na makisio. Usibuni chanzo wala URL. Kama hakuna vyanzo, sema wazi kuwa hukutafuta mtandaoni.",
};

function ctxFrom(sources) {
  if (!sources.length) return "(Hakuna matokeo ya wavuti yaliyopatikana.)";
  return sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}${s.date ? " (" + s.date + ")" : ""}\n${s.snippet}`).join("\n\n");
}

// ---------- Mjadala ----------
async function runDebate(question, ip, emit) {
  const session = { searches: 0 };
  const sources = [];
  const seen = new Set();
  let llmOk = true;

  const say = (ai, kind, text, extra = {}) => emit("message", { ai, kind, text, ...extra });
  const ask = async (ai, prompt, kind) => {
    if (!llmOk) return null;
    try {
      const text = await llm(PERSONAS[ai], prompt);
      say(ai, kind, text);
      return text;
    } catch (e) {
      llmOk = false;
      say("sade", "Hitilafu", e.message === "NO_LLM"
        ? "AI model API haijawekwa. Weka LLM_API_KEY (na LLM_BASE_URL / LLM_MODEL) kwenye mazingira ya server ili mjadala halisi ufanye kazi. Utafutaji wa Tavily bado unaonyeshwa."
        : "Modeli ya AI imeshindwa: " + e.message);
      return null;
    }
  };

  emit("status", { text: "Sade anachambua" });
  say("sade", "Mapokezi", "Nimepokea swali lako. Nitalichambua, kisha tutashirikiana na R-AI Fire pamoja na R-AI Search kupata jibu bora.");

  // Hatua 2: Sade anapanga utafutaji
  let plan = { needsSearch: true, queries: { sade: question, fire: question, search: question } };
  if (llmOk) {
    const raw = await ask("sade",
      `Swali la mtumiaji: "${question}"\nChambua nia na ugumu. Rudisha JSON TU (bila maelezo mengine) kwa muundo:\n{"analysis":"muhtasari mfupi","needsSearch":true,"queries":{"sade":"query ya jumla","fire":"query ya kiufundi","search":"query ya uthibitisho/vyanzo"}}`,
      "Uchambuzi");
    if (raw) {
      try {
        const j = JSON.parse(raw.replace(/```json|```/g, "").trim());
        plan.needsSearch = j.needsSearch !== false;
        plan.queries = { ...plan.queries, ...(j.queries || {}) };
      } catch { /* tumia query ya swali lenyewe */ }
    }
  }

  // Hatua 3: Utafutaji wa pamoja kupitia huduma moja
  if (plan.needsSearch) {
    emit("status", { text: "R-AI Search anatafuta" });
    for (const [ai, label] of [["sade", "Sade"], ["fire", "R-AI Fire"], ["search", "R-AI Search"]]) {
      const q = plan.queries[ai];
      if (!q) continue;
      const res = await tavily.search({ query: q, by: label, session });
      if (!res.ok) {
        say(ai, "Utafutaji", `Utafutaji wa "${q}" haukufanikiwa: ${res.error}. Tunaendelea bila matokeo haya.`, { error: true });
        continue;
      }
      const fresh = res.results.filter(r => r.url && !seen.has(r.url));
      fresh.forEach(r => { seen.add(r.url); sources.push(r); });
      say(ai, "Utafutaji", `Nimetafuta: "${q}"${res.cached ? " (kutoka cache)" : ""} — vyanzo ${res.results.length}.`, { sources: res.results });
    }
  }

  const ctx = ctxFrom(sources);

  // Hatua 4: Majibu ya awali
  emit("status", { text: "R-AI Fire anajibu" });
  const fire = await ask("fire", `Swali: ${question}\n\nMatokeo ya wavuti:\n${ctx}\n\nToa uchambuzi wa kiufundi: changamoto, hatari, na mapendekezo.`, "Uchambuzi wa kiufundi");
  emit("status", { text: "R-AI Search anatafuta" });
  const srch = await ask("search", `Swali: ${question}\n\nMatokeo ya wavuti:\n${ctx}\n\nTaja ushahidi uliopatikana na namba za vyanzo, taarifa zinazokinzana, na mapengo.`, "Ushahidi");

  // Hatua 5: Mjadala
  let transcript = `FIRE: ${fire}\n\nSEARCH: ${srch}`;
  if (llmOk) emit("status", { text: "AI zinajadili" });
  for (let r = 0; r < CONFIG.DEBATE_ROUNDS && llmOk; r++) {
    const s = await ask("sade", `Swali: ${question}\n\nMajadiliano hadi sasa:\n${transcript}\n\nUliza swali moja kali kwa Fire na Search, au onyesha hoja isiyo na ushahidi.`, "Hoja");
    const f = await ask("fire", `Majadiliano:\n${transcript}\n\nSADE: ${s}\n\nJibu hoja ya Sade kwa ufupi; kubali marekebisho ikibidi.`, "Jibu la kiufundi");
    const x = await ask("search", `Vyanzo:\n${ctx}\n\nMajadiliano:\n${transcript}\n\nSADE: ${s}\nFIRE: ${f}\n\nThibitisha au kanusha kwa vyanzo vilivyopo tu.`, "Uthibitisho");
    transcript += `\n\nSADE: ${s}\nFIRE: ${f}\nSEARCH: ${x}`;
  }

  // Hatua 6–7: Hitimisho
  if (llmOk) {
    emit("status", { text: "Sade anatengeneza hitimisho" });
    await ask("sade",
      `Swali: ${question}\n\nVyanzo:\n${ctx}\n\nMajadiliano:\n${transcript}\n\nToa jibu la mwisho lililopangwa: hitimisho, hatua za kufuata, tofauti za maoni (kama zipo), na marejeo [n]. Usionyeshe kisichothibitishwa kama ukweli.`,
      "Jibu la mwisho");
  }
  emit("status", { text: "Mjadala umekamilika" });
}

// ---------- HTTP ----------
const rate = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (rate.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); rate.set(ip, arr);
  return arr.length > CONFIG.RATE_LIMIT_PER_MIN;
}

http.createServer((req, res) => {
  const ip = req.socket.remoteAddress;
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
  }
  if (req.method === "POST" && req.url === "/api/debate") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on("end", async () => {
      let question = "";
      try { question = String(JSON.parse(body).question || "").trim().slice(0, 1000); } catch {}
      if (!question) { res.writeHead(400); return res.end("Swali linahitajika"); }
      if (limited(ip)) { res.writeHead(429); return res.end("Maombi mengi mno. Subiri kidogo."); }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const emit = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      try { await runDebate(question, ip, emit); }
      catch (e) { emit("message", { ai: "sade", kind: "Hitilafu", text: "Hitilafu ya mfumo: " + e.message, error: true }); }
      emit("done", {}); res.end();
    });
    return;
  }
  res.writeHead(404); res.end("Not found");
}).listen(CONFIG.PORT, () => {
  console.log("R-AI Trinity: http://localhost:" + CONFIG.PORT);
  if (!CONFIG.LLM_API_KEY) console.log("ONYO: LLM_API_KEY haijawekwa — mjadala wa AI hautafanya kazi (Tavily itafanya).");
});
