import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import { parseStringPromise as parseXml } from "xml2js";

const PORT = process.env.PORT || 8080;
const ORIGINS = (process.env.CORS_ORIGIN || "https://guardian360.co.za,https://www.guardian360.co.za,https://risk.guardian360.co.za")
  .split(",").map(s => s.trim()).filter(Boolean);
const TIMEOUT_MS = 10000;

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: "200kb" }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    cb(null, ORIGINS.includes(origin));
  }
}));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

async function getJson(url, init = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally { clearTimeout(id); }
}

async function getText(url, init = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally { clearTimeout(id); }
}

function kwSeverity(s = "") {
  const t = s.toLowerCase();
  if (/(bomb|explosion|blast|airstrike)/.test(t)) return 5;
  if (/(terror|shooting|kidnap|abduction|riot|violent protest|unrest)/.test(t)) return 4;
  return 3;
}

const item = (o) => ({
  id: o.id, ts: o.ts, source: o.source,
  title: o.title, summary: o.summary,
  severity: o.severity ?? 3,
  links: o.links || [],
  lat: o.lat, lng: o.lng
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), origins: ORIGINS });
});

app.get("/v1/gov/uk/za", async (req, res) => {
  try {
    const data = await getJson("https://www.gov.uk/api/content/foreign-travel-advice/south-africa", {
      headers: { "Accept": "application/json" }
    });
    const d = data?.details || {};
    const change = (d.latest_update || {}).published || data.public_updated_at || new Date().toISOString();
    const out = item({
      id: "govuk:za",
      ts: change,
      source: "gov.uk",
      title: "UK travel advice – South Africa",
      summary: d.change_description || d.summary || "Travel advice",
      severity: 3,
      links: ["https://www.gov.uk/foreign-travel-advice/south-africa"]
    });
    res.json([out]);
  } catch (e) {
    res.json([]);
  }
});

app.get("/v1/us/travel", async (req, res) => {
  try {
    const xml = await getText("https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.rss");
    const j = await parseXml(xml);
    const items = (j?.rss?.channel?.[0]?.item || []).filter(x => {
      const title = (x.title?.[0] || "").toLowerCase();
      const descr = (x.description?.[0] || "").toLowerCase();
      return title.includes("south africa") || descr.includes("south africa");
    }).map(x => item({
      id: "us:travel:" + (x.guid?.[0]?._ || x.link?.[0] || x.title?.[0]),
      ts: new Date(x.pubDate?.[0] || Date.now()).toISOString(),
      source: "travel.state.gov",
      title: x.title?.[0] || "US Travel Advisory",
      summary: (x.description?.[0] || "").replace(/<[^>]+>/g, "").slice(0, 280),
      severity: 3,
      links: [x.link?.[0] || "https://travel.state.gov"]
    }));
    res.json(items.slice(0, 5));
  } catch (e) {
    res.json([]);
  }
});

app.get("/v1/reliefweb/za", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(60, parseInt(req.query.days || "21", 10)));
    const body = {
      appname: "guardian360",
      filter: {
        operator: "AND",
        conditions: [
          { field: "primary_country.name", value: "South Africa" },
          { operator: "OR", conditions: [
            { field: "theme.name", value: "Safety and Security" },
            { field: "theme.name", value: "Protection and Human Rights" },
            { field: "theme.name", value: "Health" }
          ]},
          { field: "date.created", value: { from: `now-${days}d` } }
        ]
      },
      fields: { include: ["title","url","date.created","theme.name","source.name"] },
      limit: 30, profile: "list"
    };
    const data = await getJson("https://api.reliefweb.int/v1/reports?profile=list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const out = (data?.data || []).map(d => {
      const f = d.fields || {};
      const themes = (f.theme || []).map(x => x.name).join(", ");
      return item({
        id: "rw:" + d.id,
        ts: f["date.created"],
        source: "reliefweb",
        title: f.title,
        summary: themes,
        severity: /Epidemic|Conflict|Security|Protection/i.test(themes) ? 4 : 3,
        links: [f.url]
      });
    });
    res.json(out);
  } catch (e) {
    res.json([]);
  }
});

app.get("/v1/gdelt", async (req, res) => {
  try {
    const q = req.query.q || '(South Africa) (murder OR explosion OR bomb OR protest OR riot OR kidnapping OR shooting)';
    const hours = Math.max(1, Math.min(168, parseInt(req.query.hours || "24", 10)));
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&maxrecords=50&format=json&TIMESPAN=${hours}HRS`;
    const data = await getJson(url);
    const arts = data?.articles || [];
    const out = arts.map(a => item({
      id: "gdelt:" + (a.url || a.title),
      ts: new Date(a.seendate || a.timestamp || Date.now()).toISOString(),
      source: "gdelt",
      title: a.title,
      summary: a.sourceCountry ? `${a.domain} • ${a.sourceCountry}` : a.domain,
      severity: kwSeverity(`${a.title} ${a.url}`),
      links: [a.url]
    }));
    res.json(out);
  } catch (e) {
    res.json([]);
  }
});

app.listen(PORT, () => {
  console.log(`Guardian360 micro API running on :${PORT}`);
});
