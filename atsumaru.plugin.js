// Harbor manga source plugin: Atsumaru (atsu.moe)
// Uses the site's own JSON API; images are served from cdn.atsu.moe.
//
// This whole file runs as the body of a function that receives one argument named
// harbor. Network only through harbor.http, HTML only through harbor.parseHtml.

const BASE = "https://atsu.moe";
const CDN = "https://cdn.atsu.moe";
const PLUGIN_ID = "atsumaru";
const PLUGIN_NAME = "Atsumaru";
const CHAPTER_LANG = "en";

const ORIGIN = BASE.replace(/^(https?:\/\/[^/]+).*$/i, "$1");
const WANT = 48; // items returned per popular()/search() call

// Many sites reject requests that don't look like a browser, so send browser headers.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
let lastError = null;
let headersRejected = false;

function withHeaders(opts, accept) {
  const o = Object.assign({}, opts || {});
  if (headersRejected) {
    delete o.headers;
    return o;
  }
  o.headers = Object.assign(
    { "User-Agent": UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9", Referer: ORIGIN + "/" },
    (opts && opts.headers) || {}
  );
  return o;
}

async function rawHttp(url, opts, accept) {
  try {
    return await harbor.http(url, withHeaders(opts, accept));
  } catch (e) {
    if (headersRejected) throw e;
    // If this Harbor build refuses custom headers, retry once without them and remember.
    headersRejected = true;
    return await harbor.http(url, withHeaders(opts, accept));
  }
}

function blockedReason(body) {
  const b = String(body || "").slice(0, 4000);
  if (/just a moment\.\.\.|cf-chl|challenge-platform|cf_chl_opt|Attention Required! \| Cloudflare/i.test(b)) {
    return "blocked by a Cloudflare check";
  }
  return null;
}

async function getText(url, opts) {
  let res;
  try {
    res = await rawHttp(url, Object.assign({ responseType: "text" }, opts || {}), "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  } catch (e) {
    lastError = new Error(PLUGIN_NAME + ": network error for " + url + " (" + (e && e.message ? e.message : e) + ")");
    throw lastError;
  }
  const body = res && res.body != null ? String(res.body) : "";
  const blocked = blockedReason(body);
  if (!res || !res.ok || blocked) {
    lastError = new Error(PLUGIN_NAME + ": " + (blocked || "HTTP " + (res ? res.status : "?")) + " for " + url);
    throw lastError;
  }
  return body;
}

async function getDoc(url, opts) {
  return harbor.parseHtml(await getText(url, opts));
}

async function fetchJson(url, opts) {
  let data;
  try {
    data = await rawHttp(url, Object.assign({ responseType: "json" }, opts || {}), "application/json, text/plain, */*");
  } catch (e) {
    lastError = new Error(PLUGIN_NAME + ": network error for " + url + " (" + (e && e.message ? e.message : e) + ")");
    throw lastError;
  }
  if (data == null) {
    lastError = new Error(PLUGIN_NAME + ": the site didn't return data for " + url + " (it may be blocked by Cloudflare or down)");
    throw lastError;
  }
  return data;
}

// Turn "silently empty" results into a visible error message when a request failed.
function hardenPlugin(p) {
  for (const m of ["popular", "search", "chapters", "pageUrls"]) {
    const orig = p[m];
    if (typeof orig !== "function") continue;
    p[m] = async function () {
      lastError = null;
      const r = await orig.apply(p, arguments);
      if ((!r || !r.length) && lastError) throw lastError;
      return r;
    };
  }
  return p;
}

// Covers and page images MUST be absolute http(s) or Harbor drops them.
function abs(url) {
  if (!url) return undefined;
  url = String(url).trim();
  if (!url || url.startsWith("data:")) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return ORIGIN + url;
  return ORIGIN + "/" + url;
}

function lastSrcset(s) {
  if (!s) return null;
  const parts = String(s).split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// Lazy-loading sites hide the real image in data-* attributes.
function imgSrc(img) {
  if (!img) return undefined;
  const candidates = [
    img.attr("data-src"),
    img.attr("data-lazy-src"),
    img.attr("data-cfsrc"),
    lastSrcset(img.attr("data-srcset")),
    lastSrcset(img.attr("srcset")),
    img.attr("src"),
  ];
  for (const c of candidates) {
    const u = abs(c);
    if (u) return u;
  }
  return undefined;
}

function clean(s) {
  return s ? String(s).replace(/\s+/g, " ").trim() : "";
}

// Ids are the URL path (no host), so links on www/non-www both resolve.
function pathId(href) {
  if (!href) return "";
  return String(href)
    .trim()
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/[#?].*$/, "")
    .replace(/^\/+|\/+$/g, "");
}

function pageOf(id) {
  return ORIGIN + "/" + id + "/";
}

function uniqueBy(list, key) {
  const seen = new Set();
  return list.filter((x) => {
    const k = key(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Harbor asks by item offset; sites paginate by page number with their own page size.
// Learn the page size from page 1, then stitch pages to cover [offset, offset + WANT).
const pageSizes = {};
async function windowed(key, fetchPage, offset) {
  const cache = {};
  let size = pageSizes[key];
  if (!size) {
    const first = await fetchPage(1);
    if (!first.length) return [];
    size = pageSizes[key] = first.length;
    cache[1] = first;
  }
  const startPage = Math.floor(offset / size) + 1;
  let skip = offset - (startPage - 1) * size;
  const maxPages = Math.ceil(WANT / size) + 1;
  const out = [];
  const seen = new Set();
  for (let page = startPage; page < startPage + maxPages && out.length < WANT; page++) {
    const items = cache[page] || (await fetchPage(page));
    if (!items.length) break;
    const fresh = items.filter((i) => !seen.has(i.id));
    if (!fresh.length) break; // site is repeating its last page
    fresh.forEach((i) => seen.add(i.id));
    out.push(...items.slice(skip));
    skip = 0;
    if (items.length < size) break;
  }
  return uniqueBy(out, (i) => i.id).slice(0, WANT);
}

const UNIT_MS = { sec: 1e3, min: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
function parseDate(s) {
  if (!s) return undefined;
  const t = clean(s).toLowerCase();
  if (!t) return undefined;
  const now = Date.now();
  if (/^(just now|today)/.test(t)) return new Date(now).toISOString();
  if (/^yesterday/.test(t)) return new Date(now - UNIT_MS.day).toISOString();
  const rel = t.match(/(\d+|an?|one)\s*(sec|min|hour|hr|day|week|wk|month|mo|year|yr)/);
  if (rel && /ago/.test(t)) {
    const n = /^\d+$/.test(rel[1]) ? parseInt(rel[1], 10) : 1;
    const unit = { hr: "hour", wk: "week", mo: "month", yr: "year" }[rel[2]] || rel[2];
    return new Date(now - n * UNIT_MS[unit]).toISOString();
  }
  const parsed = Date.parse(t.replace(/(\d)(st|nd|rd|th)\b/, "$1"));
  return isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

// "Vol. 2 Chapter 12.5 - The Return" -> { volume: "2", chapter: "12.5", title: "The Return" }
function splitChapter(name) {
  let rest = clean(name);
  let volume = null;
  const v = rest.match(/\bvol(?:ume)?\.?\s*(\d+(?:\.\d+)?)/i);
  if (v) {
    volume = v[1];
    rest = rest.replace(v[0], " ");
  }
  const m = rest.match(/\b(?:chapter|chap|ch|episode|ep)\.?\s*(\d+(?:\.\d+)?)/i) || rest.match(/(\d+(?:\.\d+)?)/);
  const chapter = m ? m[1] : null;
  if (m) rest = rest.replace(m[0], " ");
  rest = rest.replace(/^[\s:\-–—|.,]+|[\s:\-–—|.,]+$/g, "").trim();
  return { volume, chapter, title: rest || (chapter ? undefined : clean(name)) };
}


async function getJson(url) {
  return fetchJson(url);
}

// Find the first array (searching depth-first) whose items pass the test.
function findArray(node, test, depth) {
  depth = depth || 0;
  if (!node || depth > 6) return [];
  if (Array.isArray(node)) {
    if (node.length && node.some(test)) return node;
    for (const x of node) {
      const r = findArray(x, test, depth + 1);
      if (r.length) return r;
    }
    return [];
  }
  if (typeof node === "object") {
    for (const k of Object.keys(node)) {
      const r = findArray(node[k], test, depth + 1);
      if (r.length) return r;
    }
  }
  return [];
}

// Posters/pages come as objects { image } or bare paths; files live on the CDN.
function cdn(p) {
  if (p && typeof p === "object") p = p.image || p.url || p.path || p.large || p.medium || p.small;
  if (!p || typeof p !== "string") return undefined;
  p = p.trim();
  if (/^https?:\/\//i.test(p)) return p.replace(/^https?:\/\/(www\.)?atsu\.moe/i, CDN);
  if (p.startsWith("//")) return "https:" + p;
  p = p.replace(/^\/+/, "");
  if (!p.startsWith("static/")) p = "static/" + p;
  return CDN + "/" + p;
}

const isManga = (x) => x && (x.id || (x.document && x.document.id)) && (x.title || x.englishTitle || (x.document && x.document.title));

function toSummary(m) {
  const d = m && m.document ? m.document : m;
  if (!d || !d.id) return null;
  return {
    id: String(d.id),
    title: clean(d.title || d.englishTitle || d.name) || String(d.id),
    cover: cdn(d.poster || d.posterSmall || d.posterMedium || d.image || d.cover),
  };
}

function isoDate(v) {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const t = Date.parse(v);
  return isNaN(t) ? parseDate(v) : new Date(t).toISOString();
}

// The API lists every scanlation group's copy of a chapter. Keep one per chapter number,
// preferring the group that covers the most chapters (so the reading stays consistent),
// and fall back to other groups only for chapters that group doesn't have.
function groupOf(c) {
  for (const k of Object.keys(c)) {
    if (!/scan|group|team|translat|uploader/i.test(k)) continue;
    const v = c[k];
    if (v == null || v === "") continue;
    if (typeof v === "object") return String(v.id || v.name || v.title || JSON.stringify(v));
    return String(v);
  }
  return "";
}

function chapterNumber(c) {
  if (c.number != null && c.number !== "") return String(Number(c.number));
  const p = splitChapter(c.title || "");
  return p.chapter != null ? String(Number(p.chapter)) : null;
}

function pickOnePerChapter(raw) {
  const coverage = {};
  for (const c of raw) {
    const g = groupOf(c);
    const n = chapterNumber(c);
    if (n == null) continue;
    (coverage[g] = coverage[g] || new Set()).add(n);
  }
  const rank = {};
  Object.keys(coverage)
    .sort((x, y) => coverage[y].size - coverage[x].size)
    .forEach((g, i) => (rank[g] = i));
  const best = new Map();
  const extras = [];
  for (const c of raw) {
    const n = chapterNumber(c);
    if (n == null) {
      extras.push(c);
      continue;
    }
    const cur = best.get(n);
    const r = rank[groupOf(c)];
    if (!cur) best.set(n, c);
    else {
      const rc = rank[groupOf(cur)];
      if (r < rc) best.set(n, c);
      else if (r === rc && String(c.createdAt || "") > String(cur.createdAt || "")) best.set(n, c);
    }
  }
  const out = Array.from(best.values()).concat(extras);
  // Newest chapter first, which is how Harbor's own sources list them.
  return out.sort((x, y) => (Number(chapterNumber(y)) || 0) - (Number(chapterNumber(x)) || 0));
}

const plugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,

  async popular(offset, tagId) {
    const data = await getJson(BASE + "/api/home2/popular");
    const list = uniqueBy(findArray(data, isManga).map(toSummary).filter(Boolean), (i) => i.id);
    return list.slice(offset || 0, (offset || 0) + WANT);
  },

  async search(query, offset, tagId) {
    const page = Math.floor((offset || 0) / WANT) + 1;
    const data = await getJson(
      BASE +
        "/collections/manga/documents/search?q=" + encodeURIComponent(query || "*") +
        "&query_by=title,englishTitle,otherNames&query_by_weights=3,2,1&num_typos=4,3,2" +
        "&per_page=" + WANT + "&page=" + page
    );
    const hits = Array.isArray(data.hits) ? data.hits : findArray(data, isManga);
    return uniqueBy(hits.map(toSummary).filter(Boolean), (i) => i.id);
  },

  async detail(id) {
    const data = await getJson(BASE + "/api/manga/page?id=" + encodeURIComponent(id));
    const m = data.mangaPage || data.manga || data;
    if (!m || !(m.title || m.englishTitle)) return null;
    const authors = Array.isArray(m.authors) ? m.authors.map((a) => (a && a.name) || a).filter((a) => typeof a === "string") : [];
    const alt = m.englishTitle && m.englishTitle !== m.title ? m.englishTitle : Array.isArray(m.otherNames) ? m.otherNames[0] : undefined;
    return {
      id,
      title: clean(m.title || m.englishTitle),
      altTitle: alt ? clean(alt) : undefined,
      cover: cdn(m.poster || m.posterSmall || m.image),
      description: clean(m.synopsis || m.description) || undefined,
      status: m.status ? clean(String(m.status)) : undefined,
      author: authors.length ? authors.join(", ") : undefined,
      lastChapter: undefined,
    };
  },

  async chapters(id) {
    // allChapters is the complete list; mangaPage.chapters is capped at 100.
    const data = await getJson(BASE + "/api/manga/allChapters?mangaId=" + encodeURIComponent(id));
    const raw = findArray(data, (c) => c && c.id && (c.number != null || c.title));
    return pickOnePerChapter(raw).map((c) => {
      const parts = splitChapter(c.title || "");
      const num = c.number != null ? String(c.number) : parts.chapter;
      return {
        // Pages need both ids, so pack them together.
        id: id + "/" + c.id,
        chapter: num,
        title: parts.title && parts.title !== num ? parts.title : undefined,
        volume: c.volume != null ? String(c.volume) : parts.volume,
        pages: typeof c.pageCount === "number" ? c.pageCount : 0,
        language: CHAPTER_LANG,
        publishAt: isoDate(c.createdAt || c.publishedAt || c.date),
      };
    });
  },

  async pageUrls(chapterId) {
    const cut = chapterId.lastIndexOf("/");
    const mangaId = chapterId.slice(0, cut);
    const chId = chapterId.slice(cut + 1);
    const data = await getJson(
      BASE + "/api/read/chapter?mangaId=" + encodeURIComponent(mangaId) + "&chapterId=" + encodeURIComponent(chId)
    );
    const pages = findArray(data, (p) => p && (p.image || p.url || p.path));
    const sorted = pages.slice().sort((a, b) => (a.number || a.page || 0) - (b.number || b.page || 0));
    return uniqueBy(sorted.map(cdn).filter(Boolean), (u) => u);
  },
};

return hardenPlugin(plugin);
