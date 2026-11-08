// Harbor manga source plugin: Comix (comix.to)
// Uses the site's JSON API. Browse, search and details are plain JSON.
// The chapter list may come back signed/encrypted; if so this plugin reports it clearly.
//
// This whole file runs as the body of a function that receives one argument named
// harbor. Network only through harbor.http, HTML only through harbor.parseHtml.

const BASE = "https://comix.to";
const API = BASE + "/api/v1";
const PLUGIN_ID = "comix";
const PLUGIN_NAME = "Comix";
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
  const data = await fetchJson(url);
  if (data && typeof data.e === "string" && Object.keys(data).length <= 2) {
    lastError = new Error("Comix: the site encrypted this response (" + url + "); a plugin can't read it");
    throw lastError;
  }
  return data;
}

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

function poster(p) {
  if (p && typeof p === "object") p = p.large || p.medium || p.small || p.url;
  return abs(typeof p === "string" ? p : undefined);
}

const hid = (m) => m && (m.hash_id || m.hid || m.hashId);
const isManga = (m) => hid(m) && m.title;

function toSummary(m) {
  if (!isManga(m)) return null;
  return { id: String(hid(m)), title: clean(m.title), cover: poster(m.poster || m.cover || m.image) };
}

function names(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (x && (x.title || x.name)) || x).filter((x) => typeof x === "string");
}

function isoDate(v) {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const t = Date.parse(v);
  return isNaN(t) ? parseDate(v) : new Date(t).toISOString();
}

async function listPage(page, extra) {
  const data = await getJson(API + "/manga?limit=" + WANT + "&page=" + page + extra);
  return uniqueBy(findArray(data, isManga).map(toSummary).filter(Boolean), (i) => i.id);
}

const plugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,

  async popular(offset, tagId) {
    return windowed("popular", (page) => listPage(page, "&order%5Bviews_30d%5D=desc"), offset || 0);
  },

  async search(query, offset, tagId) {
    const q = "&keyword=" + encodeURIComponent(query || "") + "&order%5Brelevance%5D=desc";
    return windowed("search", (page) => listPage(page, q), offset || 0);
  },

  async detail(id) {
    const data = await getJson(API + "/manga/" + encodeURIComponent(id));
    const m = (data && data.result) || data;
    if (!m || !m.title) return null;
    const alts = names(m.alt_titles || m.altTitles);
    const authors = names(m.author || m.authors);
    return {
      id,
      title: clean(m.title),
      altTitle: alts.length ? clean(alts[0]) : undefined,
      cover: poster(m.poster || m.cover),
      description: clean(m.synopsis || m.description) || undefined,
      status: m.status ? clean(String(m.status)) : undefined,
      author: authors.length ? authors.join(", ") : undefined,
      lastChapter: m.latest_chapter != null ? String(m.latest_chapter) : undefined,
    };
  },

  async chapters(id) {
    const all = [];
    for (let page = 1; page <= 40; page++) {
      const data = await getJson(
        API + "/manga/" + encodeURIComponent(id) + "/chapters?limit=100&page=" + page + "&order%5Bnumber%5D=desc"
      );
      const items = findArray(data, (c) => c && (c.chapter_id || c.id) && c.number != null);
      if (!items.length) break;
      all.push(...items);
      if (items.length < 100) break;
    }
    // English only, and one entry per chapter number (the site lists every uploader's copy).
    const english = all.filter((c) => !c.language || String(c.language).toLowerCase().startsWith("en"));
    const list = english.map((c) => {
      const num = String(c.number);
      const name = clean(c.name || c.title);
      return {
        id: String(c.chapter_id || c.id),
        chapter: num,
        title: name && name !== num ? name : undefined,
        volume: c.volume != null && c.volume !== 0 ? String(c.volume) : null,
        pages: 0,
        language: CHAPTER_LANG,
        publishAt: isoDate(c.created_at || c.updated_at),
      };
    });
    return uniqueBy(list, (c) => c.chapter);
  },

  async pageUrls(chapterId) {
    const data = await getJson(API + "/chapters/" + encodeURIComponent(chapterId));
    const imgs = findArray(data, (p) => p && (typeof p === "string" || p.url));
    return uniqueBy(imgs.map((p) => abs(typeof p === "string" ? p : p.url)).filter(Boolean), (u) => u);
  },
};

return hardenPlugin(plugin);
