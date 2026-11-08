// Harbor manga source plugin: Manhwax
// Site engine: MangaThemesia (WordPress "mangareader" theme).
//
// This whole file runs as the body of a function that receives one argument named
// harbor. Network only through harbor.http, HTML only through harbor.parseHtml.

const BASE = "https://manhwax.com";
const PLUGIN_ID = "manhwax";
const PLUGIN_NAME = "Manhwax";
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


// ---------- listing ----------

function parseCards(doc) {
  const els = doc.querySelectorAll("div.listupd div.bs div.bsx, div.utao div.uta div.imgu, div.listo div.bs div.bsx");
  return els
    .map((el) => {
      const a = el.querySelector("a");
      if (!a) return null;
      const id = pathId(a.attr("href"));
      if (!id) return null;
      const tt = el.querySelector(".tt") || el.querySelector(".bigor .tt");
      const title = clean(a.attr("title")) || clean(tt && tt.text()) || clean(a.text()) || id;
      return { id, title, cover: imgSrc(el.querySelector("img")) };
    })
    .filter(Boolean);
}

// The series directory is usually /manga/, but some sites renamed it.
const DIRS = ["manga", "series", "comics", "komik"];
let dir = null;

function dirUrl(d, page, query, tagId, order) {
  let u = BASE + "/" + d + "/?page=" + page;
  if (query) u += "&title=" + encodeURIComponent(query);
  if (order) u += "&order=" + order;
  if (tagId) u += "&genre%5B%5D=" + encodeURIComponent(tagId);
  return u;
}

async function directoryPage(page, query, tagId, order) {
  if (dir) return parseCards(await getDoc(dirUrl(dir, page, query, tagId, order)));
  for (const d of DIRS) {
    try {
      const items = parseCards(await getDoc(dirUrl(d, page, query, tagId, order)));
      if (items.length) {
        dir = d;
        return items;
      }
    } catch (e) {}
  }
  return [];
}

async function searchPage(page, query, tagId) {
  try {
    const items = await directoryPage(page, query, tagId, "");
    if (items.length || tagId) return items;
  } catch (e) {}
  // Plain WordPress search as a fallback.
  try {
    return parseCards(await getDoc(BASE + "/" + (page > 1 ? "page/" + page + "/" : "") + "?s=" + encodeURIComponent(query || "")));
  } catch (e) {
    return [];
  }
}

// ---------- detail ----------

function infoRows(doc) {
  const info = {};
  const put = (k, v) => {
    k = clean(k).replace(/:$/, "").toLowerCase();
    v = clean(v);
    if (k && v && !(k in info)) info[k] = v;
  };
  for (const r of doc.querySelectorAll("div.tsinfo div.imptdt, div.imptdt")) {
    const val = r.querySelector("i") || r.querySelector("a");
    if (val) put(clean(r.text()).replace(clean(val.text()), ""), val.text());
  }
  for (const tr of doc.querySelectorAll("table.infotable tr")) {
    const tds = tr.querySelectorAll("td");
    if (tds.length >= 2) put(tds[0].text(), tds[1].text());
  }
  for (const f of doc.querySelectorAll("div.fmed")) {
    const b = f.querySelector("b");
    const s = f.querySelector("span");
    if (b && s) put(b.text(), s.text());
  }
  for (const s of doc.querySelectorAll("div.spe span")) {
    const t = clean(s.text());
    const i = t.indexOf(":");
    if (i > 0) put(t.slice(0, i), t.slice(i + 1));
  }
  return info;
}

function pickInfo(info, keys) {
  for (const k of Object.keys(info)) if (keys.some((x) => k.includes(x))) return info[k];
  return undefined;
}

// ---------- plugin ----------

const plugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,

  async popular(offset, tagId) {
    return windowed("popular", (page) => directoryPage(page, "", tagId, "popular").catch(() => []), offset || 0);
  },

  async search(query, offset, tagId) {
    return windowed("search", (page) => searchPage(page, query, tagId), offset || 0);
  },

  async detail(id) {
    const doc = await getDoc(pageOf(id));
    const h = doc.querySelector("h1.entry-title") || doc.querySelector("h1");
    if (!h) return null;
    const info = infoRows(doc);
    const alt = doc.querySelector("div.wd-full span.alter") || doc.querySelector("div.seriestualt") || doc.querySelector("span.alternative");
    const desc =
      doc.querySelector("div.entry-content[itemprop=description]") ||
      doc.querySelector("div.desc") ||
      doc.querySelector("div.synp div.entry-content") ||
      doc.querySelector("div.entry-content");
    const cover =
      doc.querySelector("div.thumb img") ||
      doc.querySelector("div.thumbook img") ||
      doc.querySelector("div.infomanga img") ||
      doc.querySelector("div.bigcontent img");
    const latest = doc.querySelector("#chapterlist li .chapternum") || doc.querySelector("#chapterlist li a");
    return {
      id,
      title: clean(h.text()) || id,
      altTitle: (alt && clean(alt.text())) || pickInfo(info, ["alternative", "other name"]),
      cover: imgSrc(cover),
      description: desc ? clean(desc.text()) : undefined,
      status: pickInfo(info, ["status"]),
      author: pickInfo(info, ["author", "posted by"]),
      lastChapter: latest ? clean(latest.text()) : undefined,
    };
  },

  async chapters(id) {
    const doc = await getDoc(pageOf(id));
    const els = doc.querySelectorAll("#chapterlist li, div.eplister li, div.bxcl li, div.cl li");
    const list = els
      .map((li) => {
        const a = li.querySelector("a");
        const cid = pathId(a && a.attr("href"));
        if (!cid) return null;
        const nameEl = li.querySelector(".chapternum") || li.querySelector(".lch a") || li.querySelector(".chapter-name");
        const parts = splitChapter(nameEl ? nameEl.text() : a.text());
        const dataNum = li.attr("data-num");
        const date = li.querySelector(".chapterdate");
        return {
          id: cid,
          chapter: parts.chapter || (dataNum ? clean(dataNum) : null),
          title: parts.title,
          volume: parts.volume,
          pages: 0,
          language: CHAPTER_LANG,
          publishAt: parseDate(date && date.text()),
        };
      })
      .filter(Boolean);
    return uniqueBy(list, (c) => c.id);
  },

  async pageUrls(chapterId) {
    const html = await getText(pageOf(chapterId));
    // The image list usually lives in a ts_reader.run({...}) script call.
    const m = html.match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const src = (data.sources || []).find((s) => s && Array.isArray(s.images) && s.images.length);
        if (src) return uniqueBy(src.images.map(abs).filter(Boolean), (u) => u);
      } catch (e) {}
    }
    const doc = harbor.parseHtml(html);
    return uniqueBy(doc.querySelectorAll("div#readerarea img").map(imgSrc).filter(Boolean), (u) => u);
  },

  async tags() {
    for (const d of dir ? [dir] : DIRS) {
      try {
        const doc = await getDoc(BASE + "/" + d + "/");
        const tags = doc
          .querySelectorAll("ul.genrez li")
          .map((li) => {
            const input = li.querySelector("input");
            const label = li.querySelector("label");
            const id = input && input.attr("value");
            const name = clean(label && label.text());
            return id && name ? { id, name, group: "Genre" } : null;
          })
          .filter(Boolean);
        if (tags.length) return tags;
      } catch (e) {}
    }
    return [];
  },
};

return hardenPlugin(plugin);
