// Harbor manga source plugin: Mangapill
//
// This whole file runs as the body of a function that receives one argument named
// harbor. Network only through harbor.http, HTML only through harbor.parseHtml.

const BASE = "https://mangapill.com";
const PLUGIN_ID = "mangapill";
const PLUGIN_NAME = "Mangapill";
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


const GENRES = [
  "Action", "Adventure", "Cars", "Comedy", "Dementia", "Demons", "Drama", "Ecchi", "Fantasy",
  "Game", "Harem", "Historical", "Horror", "Isekai", "Josei", "Kids", "Magic", "Martial Arts",
  "Mecha", "Military", "Music", "Mystery", "Parody", "Police", "Psychological", "Romance",
  "Samurai", "School", "Sci-Fi", "Seinen", "Shoujo", "Shoujo Ai", "Shounen", "Shounen Ai",
  "Slice of Life", "Space", "Sports", "Super Power", "Supernatural", "Thriller", "Tragedy",
  "Vampire", "Yaoi", "Yuri",
];

function mangaId(href) {
  const m = (href || "").match(/\/manga\/([^?#]+)/);
  return m ? m[1].replace(/\/+$/, "") : "";
}

function parseCards(doc) {
  return uniqueBy(
    doc
      .querySelectorAll("div.grid > div")
      .map((el) => {
        const link = el.querySelectorAll("a").find((a) => /\/manga\//.test(a.attr("href") || ""));
        if (!link) return null;
        const id = mangaId(link.attr("href"));
        if (!id) return null;
        const t = el.querySelector("div.line-clamp-2") || el.querySelector("div.font-black");
        const img = el.querySelector("img");
        return { id, title: clean(t && t.text()) || clean(img && img.attr("alt")) || id, cover: imgSrc(img) };
      })
      .filter(Boolean),
    (i) => i.id
  );
}

function searchUrl(page, query, tagId) {
  let u = BASE + "/search?q=" + encodeURIComponent(query || "") + "&type=&status=&page=" + page;
  if (tagId) u += "&genre=" + encodeURIComponent(tagId);
  return u;
}

const plugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,

  async popular(offset, tagId) {
    return windowed("list", async (page) => parseCards(await getDoc(searchUrl(page, "", tagId))), offset || 0);
  },

  async search(query, offset, tagId) {
    return windowed("list", async (page) => parseCards(await getDoc(searchUrl(page, query, tagId))), offset || 0);
  },

  async detail(id) {
    const doc = await getDoc(BASE + "/manga/" + id);
    const h = doc.querySelector("h1");
    if (!h) return null;
    const info = {};
    for (const box of doc.querySelectorAll("div")) {
      const label = box.querySelector("label");
      if (!label || box.querySelectorAll("label").length !== 1) continue;
      const k = clean(label.text()).toLowerCase();
      const v = clean(clean(box.text()).slice(clean(label.text()).length));
      if (k && v && v.length < 120 && !(k in info)) info[k] = v;
    }
    const desc = doc.querySelector("p.text--secondary") || doc.querySelector("p.text-sm");
    const first = doc.querySelector("#chapters a");
    return {
      id,
      title: clean(h.text()) || id,
      altTitle: undefined,
      cover: imgSrc(doc.querySelector("div.text-transparent img") || doc.querySelector("img")),
      description: desc ? clean(desc.text()) : undefined,
      status: info["status"],
      author: undefined,
      lastChapter: first ? clean(first.text()) : undefined,
    };
  },

  async chapters(id) {
    const doc = await getDoc(BASE + "/manga/" + id);
    const list = doc
      .querySelectorAll("#chapters a")
      .map((a) => {
        const cid = pathId(a.attr("href"));
        if (!/^chapters\//.test(cid)) return null;
        const parts = splitChapter(a.text());
        return {
          id: cid,
          chapter: parts.chapter,
          title: parts.title,
          volume: parts.volume,
          pages: 0,
          language: CHAPTER_LANG,
          publishAt: undefined,
        };
      })
      .filter(Boolean);
    return uniqueBy(list, (c) => c.id);
  },

  async pageUrls(chapterId) {
    const doc = await getDoc(BASE + "/" + chapterId);
    let imgs = doc.querySelectorAll("chapter-page img, img.js-page").map(imgSrc).filter(Boolean);
    return uniqueBy(imgs, (u) => u);
  },

  async tags() {
    return GENRES.map((g) => ({ id: g, name: g, group: "Genre" }));
  },
};

return hardenPlugin(plugin);
