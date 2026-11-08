// Harbor manga source plugin: Weeb Central
//
// This whole file runs as the body of a function that receives one argument named
// harbor. Network only through harbor.http, HTML only through harbor.parseHtml.

const BASE = "https://weebcentral.com";
const PLUGIN_ID = "weeb-central";
const PLUGIN_NAME = "Weeb Central";
const CHAPTER_LANG = "en";

const ORIGIN = BASE.replace(/^(https?:\/\/[^/]+).*$/i, "$1");
const WANT = 48; // items returned per popular()/search() call

async function getText(url, opts) {
  const res = await harbor.http(url, Object.assign({ responseType: "text" }, opts || {}));
  if (!res || !res.ok) throw new Error("http " + (res ? res.status : "?") + " for " + url);
  return res.body || "";
}

async function getDoc(url, opts) {
  return harbor.parseHtml(await getText(url, opts));
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


const TAGS = [
  "Action", "Adult", "Adventure", "Comedy", "Doujinshi", "Drama", "Ecchi", "Fantasy",
  "Gender Bender", "Harem", "Hentai", "Historical", "Horror", "Isekai", "Josei",
  "Martial Arts", "Mature", "Mecha", "Mystery", "Psychological", "Romance", "School Life",
  "Sci-fi", "Seinen", "Shoujo", "Shoujo Ai", "Shounen", "Shounen Ai", "Slice of Life",
  "Smut", "Sports", "Supernatural", "Tragedy", "Yaoi", "Yuri", "Other",
];

// The site's own search endpoint takes an item offset, which maps directly onto Harbor's.
function searchDataUrl(text, sort, offset, tagId) {
  let u =
    BASE +
    "/search/data?author=&text=" + encodeURIComponent(text || "") +
    "&sort=" + encodeURIComponent(sort) +
    "&order=Descending&official=Any&anime=Any&adult=Any" +
    "&display_mode=" + encodeURIComponent("Full Display") +
    "&limit=" + WANT + "&offset=" + (offset || 0);
  if (tagId) u += "&included_tag=" + encodeURIComponent(tagId);
  return u;
}

function seriesId(href) {
  const m = (href || "").match(/\/series\/([^?#]+)/);
  return m ? m[1].replace(/\/+$/, "") : "";
}

function parseCards(doc) {
  return uniqueBy(
    doc
      .querySelectorAll("article")
      .map((el) => {
        const links = el.querySelectorAll("a").filter((a) => /\/series\//.test(a.attr("href") || ""));
        if (!links.length) return null;
        const id = seriesId(links[0].attr("href"));
        if (!id) return null;
        const img = el.querySelector("img");
        const named = links.map((a) => clean(a.text())).find((t) => t && t.length < 200);
        const alt = clean(img && img.attr("alt")).replace(/\s*cover$/i, "");
        return { id, title: named || alt || id, cover: imgSrc(img) };
      })
      .filter(Boolean),
    (i) => i.id
  );
}

function labelled(doc, label) {
  for (const li of doc.querySelectorAll("li")) {
    const strong = li.querySelector("strong");
    if (!strong) continue;
    const key = clean(strong.text()).toLowerCase();
    if (key.startsWith(label)) {
      const value = clean(li.text()).slice(clean(strong.text()).length);
      return clean(value) || undefined;
    }
  }
  return undefined;
}

const plugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,

  async popular(offset, tagId) {
    return parseCards(await getDoc(searchDataUrl("", "Popularity", offset, tagId)));
  },

  async search(query, offset, tagId) {
    return parseCards(await getDoc(searchDataUrl(query, "Best Match", offset, tagId)));
  },

  async detail(id) {
    const doc = await getDoc(BASE + "/series/" + id);
    const h = doc.querySelector("h1");
    if (!h) return null;
    const desc = doc.querySelector("p.whitespace-pre-wrap");
    const cover = doc.querySelector("picture img") || doc.querySelector("section img");
    return {
      id,
      title: clean(h.text()) || id,
      altTitle: labelled(doc, "associated name"),
      cover: imgSrc(cover),
      description: desc ? clean(desc.text()) : undefined,
      status: labelled(doc, "status"),
      author: labelled(doc, "author"),
      lastChapter: undefined,
    };
  },

  async chapters(id) {
    const sid = id.split("/")[0];
    const doc = await getDoc(BASE + "/series/" + sid + "/full-chapter-list");
    const list = doc
      .querySelectorAll("a")
      .map((a) => {
        const m = (a.attr("href") || "").match(/\/chapters\/([^/?#]+)/);
        if (!m) return null;
        const spans = a.querySelectorAll("span").map((s) => clean(s.text()));
        const name = spans.find((t) => /\d/.test(t) && t.length < 80 && !/ago$/i.test(t)) || clean(a.text());
        const parts = splitChapter(name);
        const time = a.querySelector("time");
        return {
          id: m[1],
          chapter: parts.chapter,
          title: parts.title,
          volume: parts.volume,
          pages: 0,
          language: CHAPTER_LANG,
          publishAt: (time && (time.attr("datetime") || parseDate(time.text()))) || undefined,
        };
      })
      .filter(Boolean);
    return uniqueBy(list, (c) => c.id);
  },

  async pageUrls(chapterId) {
    const doc = await getDoc(
      BASE + "/chapters/" + chapterId + "/images?is_prev=False&current_page=1&reading_style=long_strip"
    );
    return uniqueBy(doc.querySelectorAll("img").map(imgSrc).filter(Boolean), (u) => u);
  },

  async tags() {
    return TAGS.map((t) => ({ id: t, name: t, group: "Genre" }));
  },
};

return plugin;
