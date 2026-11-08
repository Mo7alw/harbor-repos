// Harbor manga source plugin: Elite Manga
// Site engine: Madara (WordPress "wp-manga" theme).
//
// This whole file runs as the body of a function that receives one argument named
// harbor. Network only through harbor.http, HTML only through harbor.parseHtml.

const BASE = "https://www.elitemanga.org";
const PLUGIN_ID = "elite-manga";
const PLUGIN_NAME = "Elite Manga";
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
  let els = doc.querySelectorAll("div.c-tabs-item__content");
  if (!els.length) els = doc.querySelectorAll("div.page-item-detail, div.manga-item, div.manga__item");
  return els
    .map((el) => {
      const a =
        el.querySelector(".post-title a") ||
        el.querySelector("h3 a") ||
        el.querySelector("h4 a") ||
        el.querySelector(".tab-thumb a") ||
        el.querySelector(".item-thumb a") ||
        el.querySelector("a");
      if (!a) return null;
      const id = pathId(a.attr("href"));
      if (!id) return null;
      const thumbLink = el.querySelector(".tab-thumb a, .item-thumb a");
      const title = clean(a.text()) || clean(a.attr("title")) || clean(thumbLink && thumbLink.attr("title")) || id;
      return { id, title, cover: imgSrc(el.querySelector("img")) };
    })
    .filter(Boolean);
}

// Most Madara sites expose sorting + genre filtering through their search page.
function searchUrl(page, query, tagId, order) {
  let u = BASE + "/" + (page > 1 ? "page/" + page + "/" : "") + "?s=" + encodeURIComponent(query || "") + "&post_type=wp-manga";
  if (order) u += "&m_orderby=" + order;
  if (tagId) u += "&genre%5B%5D=" + encodeURIComponent(tagId) + "&op=&author=&artist=&release=&adult=";
  return u;
}

// Fallback for sites whose search page refuses empty queries.
function listingUrl(page, tagId) {
  const dir = tagId ? "manga-genre/" + encodeURIComponent(tagId) : "manga";
  return BASE + "/" + dir + "/" + (page > 1 ? "page/" + page + "/" : "") + "?m_orderby=views";
}

let useListing = false;
async function popularPage(page, tagId) {
  if (!useListing) {
    try {
      const items = parseCards(await getDoc(searchUrl(page, "", tagId, "views")));
      if (items.length || page > 1) return items;
    } catch (e) {
      if (page > 1) throw e;
    }
    useListing = true;
  }
  try {
    return parseCards(await getDoc(listingUrl(page, tagId)));
  } catch (e) {
    return [];
  }
}

async function searchPage(page, query, tagId) {
  try {
    return parseCards(await getDoc(searchUrl(page, query, tagId, "")));
  } catch (e) {
    return [];
  }
}

// ---------- detail ----------

function infoRows(doc) {
  const info = {};
  for (const row of doc.querySelectorAll("div.post-content_item, div.manga-info-row")) {
    const h = clean(row.querySelector(".summary-heading") && row.querySelector(".summary-heading").text()).toLowerCase();
    const v = clean(row.querySelector(".summary-content") && row.querySelector(".summary-content").text());
    if (h && v && !(h in info)) info[h] = v;
  }
  return info;
}

function pickInfo(info, keys) {
  for (const k of Object.keys(info)) if (keys.some((x) => k.includes(x))) return info[k];
  return undefined;
}

// ---------- chapters ----------

async function chapterItems(id) {
  const html = await getText(pageOf(id));
  const doc = harbor.parseHtml(html);
  let els = doc.querySelectorAll("li.wp-manga-chapter");
  if (els.length) return els;

  // Newer Madara: chapters load from <manga url>/ajax/chapters/
  try {
    const d = await getDoc(pageOf(id) + "ajax/chapters/", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", Referer: pageOf(id) },
    });
    els = d.querySelectorAll("li.wp-manga-chapter");
    if (els.length) return els;
  } catch (e) {}

  // Older Madara: admin-ajax with the numeric post id.
  const holder = doc.querySelector("#manga-chapters-holder");
  const rating = doc.querySelector("input.rating-post-id");
  const scriptId = html.match(/"manga_id"\s*:\s*"?(\d+)/);
  const postId = (holder && holder.attr("data-id")) || (rating && rating.attr("value")) || (scriptId && scriptId[1]);
  if (postId) {
    try {
      const d = await getDoc(ORIGIN + "/wp-admin/admin-ajax.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", Referer: pageOf(id) },
        body: "action=manga_get_chapters&manga=" + postId,
      });
      els = d.querySelectorAll("li.wp-manga-chapter");
    } catch (e) {}
  }
  return els;
}

// ---------- plugin ----------

const plugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,

  async popular(offset, tagId) {
    return windowed("popular", (page) => popularPage(page, tagId), offset || 0);
  },

  async search(query, offset, tagId) {
    return windowed("search", (page) => searchPage(page, query, tagId), offset || 0);
  },

  async detail(id) {
    const doc = await getDoc(pageOf(id));
    const h = doc.querySelector("div.post-title h1") || doc.querySelector("div.post-title h3") || doc.querySelector("h1");
    if (!h) return null;
    const badge = doc.querySelector("div.post-title span.manga-title-badges");
    let title = clean(h.text());
    if (badge && clean(badge.text())) title = clean(title.replace(clean(badge.text()), ""));
    const info = infoRows(doc);
    const desc =
      doc.querySelector("div.description-summary div.summary__content") ||
      doc.querySelector("div.summary__content") ||
      doc.querySelector("div.manga-excerpt") ||
      doc.querySelector("div.manga-summary") ||
      doc.querySelector("div.description-summary");
    const author = doc.querySelector("div.author-content");
    const firstChapter = doc.querySelector("li.wp-manga-chapter a");
    return {
      id,
      title: title || id,
      altTitle: pickInfo(info, ["alternative", "alt name", "other name"]),
      cover: imgSrc(doc.querySelector("div.summary_image img")),
      description: desc ? clean(desc.text()) : undefined,
      status: pickInfo(info, ["status"]),
      author: (author && clean(author.text())) || pickInfo(info, ["author"]),
      lastChapter: firstChapter ? clean(firstChapter.text()) : undefined,
    };
  },

  async chapters(id) {
    const els = await chapterItems(id);
    const list = els
      .map((li) => {
        const a = li.querySelector("a");
        const cid = pathId(a && a.attr("href"));
        if (!cid) return null;
        const parts = splitChapter(a.text());
        const dateEl = li.querySelector("span.chapter-release-date i") || li.querySelector("span.chapter-release-date");
        const newBadge = li.querySelector("span.chapter-release-date a");
        const dateText = clean(dateEl && dateEl.text()) || (newBadge && newBadge.attr("title"));
        return {
          id: cid,
          chapter: parts.chapter,
          title: parts.title,
          volume: parts.volume,
          pages: 0,
          language: CHAPTER_LANG,
          publishAt: parseDate(dateText),
        };
      })
      .filter(Boolean);
    return uniqueBy(list, (c) => c.id);
  },

  async pageUrls(chapterId) {
    // ?style=list makes Madara render every page on one screen.
    const html = await getText(pageOf(chapterId) + "?style=list");
    const doc = harbor.parseHtml(html);
    let urls = doc
      .querySelectorAll("div.page-break img, div.reading-content img, div.read-container img")
      .map(imgSrc)
      .filter(Boolean);
    if (!urls.length) {
      // Some sites keep the list in a script; parseHtml cannot see <script>, so regex the body.
      const m = html.match(/chapter_preloaded_images\s*=\s*(\[[^\]]*\])/);
      if (m) {
        try {
          urls = JSON.parse(m[1]).map(abs).filter(Boolean);
        } catch (e) {}
      }
    }
    return uniqueBy(urls, (u) => u);
  },

  async tags() {
    try {
      const doc = await getDoc(BASE + "/?s=&post_type=wp-manga");
      const fromForm = doc
        .querySelectorAll("div.checkbox-group div.checkbox")
        .map((box) => {
          const input = box.querySelector("input");
          const label = box.querySelector("label");
          const id = input && input.attr("value");
          const name = clean(label && label.text());
          return id && name ? { id, name, group: "Genre" } : null;
        })
        .filter(Boolean);
      if (fromForm.length) return fromForm;
    } catch (e) {}
    try {
      const doc = await getDoc(BASE + "/");
      return uniqueBy(
        doc
          .querySelectorAll("a[href*='/manga-genre/']")
          .map((a) => {
            const m = (a.attr("href") || "").match(/manga-genre\/([^/?#]+)/);
            const name = clean(a.text()).replace(/\s*\(\d+\)\s*$/, "");
            return m && name ? { id: m[1], name, group: "Genre" } : null;
          })
          .filter(Boolean),
        (t) => t.id
      );
    } catch (e) {
      return [];
    }
  },
};

return hardenPlugin(plugin);
