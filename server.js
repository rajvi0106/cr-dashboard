const express = require("express");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const { Redis } = require("@upstash/redis");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HIDDEN_FILE = path.join(__dirname, "hidden.txt"); // starting hidden list (optional)
const DATA_DIR = path.join(__dirname, "data"); // local-only storage

const CONTEST_NAME = process.env.CONTEST_NAME || "CodeRumble 4.0";
const CONTEST_TZ = process.env.CONTEST_TZ || "Asia/Kolkata";
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const PER_PAGE = Number(process.env.PER_PAGE) || 50; // rows per page
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ON_VERCEL = !!process.env.VERCEL;
const MAX_SNAPS = 60;

const REQUIRED = ["rank", "user_handle", "score"];
const NON_PROBLEM = new Set([
  "user_id",
  "rank",
  "user_handle",
  "name",
  "score",
  "total_time",
  "penalty",
  "country",
  "country_code",
  "institution",
  "institution_type",
  "rating",
  "user_gender",
  "html_handle",
  "is_user_premium",
]);

// ---------- storage: Redis on Vercel, plain files on your laptop ----------
const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis =
  REDIS_URL && REDIS_TOKEN
    ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN })
    : null;

const fileKey = (k) =>
  path.join(DATA_DIR, k.replace(/[^a-z0-9_.-]/gi, "_") + ".json");
const store = {
  async get(k) {
    if (redis) return (await redis.get(k)) ?? null;
    try {
      return JSON.parse(fs.readFileSync(fileKey(k), "utf8"));
    } catch {
      return null;
    }
  },
  async set(k, v) {
    if (redis) return redis.set(k, v);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(fileKey(k), JSON.stringify(v));
  },
  async del(k) {
    if (redis) return redis.del(k);
    try {
      fs.unlinkSync(fileKey(k));
    } catch {}
  },
};

const app = express();
app.use(express.urlencoded({ extended: false }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // Vercel allows about 4.5 MB per request
});
const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// stop early with a clear message if Redis is not connected on Vercel
app.use((req, res, next) => {
  if (ON_VERCEL && !redis)
    return res
      .status(500)
      .send(
        "Storage not connected. In Vercel: Storage tab, create an Upstash Redis store, connect it to this project, then redeploy.",
      );
  next();
});

// ---------- helpers ----------
const norm = (s) => (s || "").trim().toLowerCase();
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmtDate = (d, withDate) =>
  withDate
    ? d.toLocaleString("en-GB", {
        timeZone: CONTEST_TZ,
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : d.toLocaleTimeString("en-GB", { timeZone: CONTEST_TZ, hour12: false });
const isSolved = (v) => {
  const t = String(v ?? "").trim();
  return t !== "" && t !== "0";
};
const stamp = (d) => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);

async function readHiddenText() {
  const v = await store.get("cr:hidden");
  if (v && typeof v.text === "string") return v.text;
  return fs.existsSync(HIDDEN_FILE) ? fs.readFileSync(HIDDEN_FILE, "utf8") : "";
}
async function readHidden() {
  const out = new Set();
  for (let line of (await readHiddenText()).split(/\r?\n/)) {
    line = line.trim();
    if (line && !line.startsWith("#")) out.add(norm(line));
  }
  return out;
}

// Returns { rows, problems, cols } or { error }.
function parseCsv(buf) {
  let records;
  const text = buf.toString("utf8").replace(/^\uFEFF/, "");
  try {
    records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  } catch (e) {
    return { error: "Could not read the file as CSV: " + e.message };
  }
  if (!records.length) return { error: "File has no participants." };
  const cols = Object.keys(records[0]);
  const missing = REQUIRED.filter((c) => !cols.includes(c));
  if (missing.length)
    return { error: "Missing columns: " + missing.join(", ") };

  const seen = new Set();
  const rows = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const line = i + 2;
    const h = norm(r.user_handle);
    if (!h) return { error: `Line ${line}: empty username.` };
    if (seen.has(h)) return { error: "Duplicate username: " + r.user_handle };
    seen.add(h);
    const rank = Number(r.rank);
    const score = Number(r.score);
    if (
      !/^\d+$/.test(String(r.rank).trim()) ||
      !Number.isFinite(score) ||
      String(r.score).trim() === ""
    )
      return {
        error: `Line ${line} (${r.user_handle}): rank or score is not a number.`,
      };
    r._rank = rank;
    r._score = score;
    rows.push(r);
  }
  const problems = cols.filter((c) => !NON_PROBLEM.has(c));
  return { rows, problems, cols };
}

// new rank = CodeChef rank - hidden users ranked strictly above. Ties stay ties.
function applyHiding(rows, hidden) {
  const sorted = [...rows].sort((a, b) => a._rank - b._rank);
  const hiddenRanks = sorted
    .filter((r) => hidden.has(norm(r.user_handle)))
    .map((r) => r._rank);
  const shown = [];
  for (const r of sorted) {
    if (hidden.has(norm(r.user_handle))) continue;
    const above = hiddenRanks.filter((hr) => hr < r._rank).length;
    shown.push({ ...r, _newrank: r._rank - above });
  }
  return { shown, hiddenCount: hiddenRanks.length };
}

// ---------- snapshots (each upload fully replaces the live one) ----------
async function listSnaps() {
  const v = await store.get("cr:snaps");
  return Array.isArray(v) ? v : []; // newest first: [{name, at}]
}
async function liveName() {
  const v = await store.get("cr:live");
  return v && v.name ? v.name : null;
}
async function loadSnap(name) {
  const s = await store.get("cr:snap:" + name);
  if (!s || !Array.isArray(s.rows)) return null;
  return {
    name,
    rows: s.rows,
    cols: s.cols,
    problems: s.cols.filter((c) => !NON_PROBLEM.has(c)),
    mtime: new Date(s.at),
  };
}
async function loadLive() {
  const n = await liveName();
  return n ? loadSnap(n) : null;
}
async function saveSnap(result) {
  const d = new Date();
  const name = stamp(d);
  // html_handle is not used by the site and is large, so it is not stored
  const cols = result.cols.filter((c) => c !== "html_handle");
  const rows = result.rows.map((r) => {
    const o = {};
    for (const c of cols) o[c] = r[c];
    o._rank = r._rank;
    o._score = r._score;
    return o;
  });
  await store.set("cr:snap:" + name, { at: d.toISOString(), cols, rows });
  const list = [
    { name, at: d.toISOString() },
    ...(await listSnaps()).filter((s) => s.name !== name),
  ];
  const keep = list.slice(0, MAX_SNAPS);
  const drop = list.slice(MAX_SNAPS);
  await store.set("cr:snaps", keep);
  await store.set("cr:live", { name });
  for (const s of drop) await store.del("cr:snap:" + s.name);
  return name;
}

// How many (visible) people solved each problem
function solveStats(shown, problems) {
  const total = shown.length;
  const list = problems.map((p, i) => {
    const solved = shown.filter((r) => isSolved(r[p])).length;
    return {
      label: `P${i + 1}`,
      solved,
      pct: total ? Math.round((100 * solved) / total) : 0,
    };
  });
  return { total, list };
}

// ---------- dot banner  ----------
function dotBanner() {
  const cols = 90,
    rows = 4,
    step = 12;
  let out = "";
  for (let c = 0; c < cols; c++) {
    const t = c / (cols - 1);
    const op = Math.max(0.04, Math.pow(1 - t, 1.3));
    for (let r = 0; r < rows; r++) {
      out += `<circle cx="${c * step + 6}" cy="${r * step + 6}" r="3.4" fill="#e9e5dc" opacity="${op.toFixed(3)}"/>`;
    }
  }
  return `<svg viewBox="0 0 ${cols * step} ${rows * step}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block" aria-hidden="true">${out}</svg>`;
}
const BANNER = dotBanner();

// ---------- shared look ----------
const CSS = `
:root{--black:#0a0a0a;--cream:#e9e5dc;--orange:#ff5a1b;--dim:#8a877d;--line:#4a4a46}
*{box-sizing:border-box}
body{margin:0;background:var(--black);color:var(--cream);
  font-family:"JetBrains Mono","IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace}
.page{padding:26px 44px 0}
.brand{display:flex;align-items:flex-end;gap:22px;margin-top:18px}
.logo{color:var(--orange);font-weight:800;font-size:40px;line-height:.95;letter-spacing:-1px}
.ver{color:var(--orange);font-weight:800;font-size:76px;line-height:.8;letter-spacing:-2px}
.live{margin-left:auto;text-align:right;font-size:13px;letter-spacing:1px;color:#d8d6c5;text-transform:uppercase;line-height:1.6}
.live i{color:var(--orange);font-style:normal}
.tabs{display:flex;gap:10px;margin:20px 0 18px}
.tab{display:inline-block;font-size:14px;letter-spacing:1px;padding:8px 18px;border:2px solid var(--cream);border-radius:10px;color:var(--cream);text-decoration:none}
.tab.act{background:var(--orange);border-color:var(--orange);color:var(--black);font-weight:700}
.empty{padding:80px 0;text-align:center;color:var(--dim);letter-spacing:2px;text-transform:uppercase}
.note{font-size:12px;color:var(--dim);margin:12px 0}
.pods{display:flex;gap:14px;align-items:flex-end;margin:6px 0 18px}
.pod{flex:1;border-radius:12px;padding:14px 16px;color:var(--black);background:var(--cream);min-width:0}
.pod.first{background:var(--cream);padding-top:22px;padding-bottom:22px}
.pod .n{font-size:38px;font-weight:800;line-height:1}
.pod.first .n{font-size:52px}
.pod .u{font-size:18px;font-weight:700;margin-top:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pod .s{font-size:13px;opacity:.75;margin-top:4px}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:760px;font-size:17px}
th{background:var(--cream);color:var(--black);font-weight:700;padding:12px 8px;font-size:13px;letter-spacing:1px;text-align:center;white-space:nowrap}
td{padding:12px 8px;text-align:center;border-bottom:2px dotted #3a3a37}
td.l{text-align:center;padding:12px 8px;white-space:nowrap;font-weight:700}
td.l a{color:var(--cream);text-decoration:none}
td.l small{display:block;color:var(--dim);font-size:12px;font-weight:400;max-width:280px;overflow:hidden;text-overflow:ellipsis;margin:0 auto}
td.r{color:var(--orange);font-size:22px;font-weight:800}
td.sc{color:var(--orange);font-weight:800}
tr:hover td{background:#141414}
.sd,.nd{display:inline-block;width:13px;height:13px;border-radius:50%}
.sd{background:#fff}
.nd{border:1.5px solid #8a877d}.pager{margin:18px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pager a,.pager b{padding:6px 12px;border:2px solid var(--cream);text-decoration:none;color:var(--cream);font-size:14px;border-radius:6px}
.pager b{background:var(--orange);border-color:var(--orange);color:var(--black)}
.strip{display:grid;grid-template-columns:repeat(2,1fr);margin:6px 0 18px;border-top:2px dotted var(--line);border-bottom:2px dotted var(--line)}
.strip div{padding:14px 10px;text-align:center;border-right:2px dotted var(--line)}
.strip div:last-child{border-right:0}
.strip b{display:block;font-size:34px;font-weight:800;color:var(--orange)}
.strip span{font-size:12px;letter-spacing:1px;color:var(--dim)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.card{background:var(--cream);color:var(--black);border-radius:12px;padding:16px}
.card .pn{display:inline-block;background:var(--black);color:var(--cream);font-size:14px;padding:4px 11px;border-radius:7px;letter-spacing:1px;font-weight:700}
.card .nm{font-size:15px;margin-top:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .big{font-size:48px;font-weight:800;line-height:1;margin-top:10px}
.card .big small{font-size:15px;font-weight:400;opacity:.7;margin-left:6px}
.meter{display:grid;grid-template-columns:repeat(20,1fr);gap:4px;margin-top:14px}
.meter i{display:block;aspect-ratio:1;border-radius:50%;border:1.5px solid #a9a69b}
.meter i.f{background:var(--black);border-color:var(--black)}
.card .pc{font-size:14px;margin-top:10px;opacity:.85}
.foot{display:flex;justify-content:space-between;margin:34px 0 0;padding:16px 0 28px;border-top:3px solid var(--orange);color:var(--orange);font-size:22px;letter-spacing:2px}`;

function layout({ active, updated, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap" rel="stylesheet">
<title>Code Rumble 4.0 - ${active === "rank" ? "Rankings" : "Questions"}</title><style>${CSS}</style></head><body>
<div class="page">
${BANNER}
<div class="brand"><div class="logo">code<br>rumble</div><div class="ver">4.0</div>
<div class="live"><i>&#9679;</i> Live<br>${esc(CONTEST_NAME)} | Updated ${esc(updated)}</div></div>
<div class="tabs"><a class="tab${active === "rank" ? " act" : ""}" href="/">RANKINGS</a><a class="tab${active === "q" ? " act" : ""}" href="/questions">QUESTIONS</a></div>
${body}
<div class="foot"><span>TPC</span><span>IIITDMJ</span><span>CR 4.0</span></div>
</div></body></html>`;
}

// short CDN cache: keeps Redis reads low while updates still show within seconds
const publicCache = (req, res, next) => {
  res.set(
    "Cache-Control",
    "public, max-age=0, s-maxage=5, stale-while-revalidate=10",
  );
  next();
};

// ---------- rankings page ----------
function rankingsBody({ rows, problems, hasTime, hasPen, pages, page }) {
  if (!rows.length)
    return `<div class="empty">Standings will appear here shortly</div>`;

  const podium = page === 1 ? rows.slice(0, 3) : [];
  const tableRows = page === 1 ? rows.slice(3) : rows;

  const pod = (r, first) =>
    `<div class="pod${first ? " first" : ""}"><div class="n">${r._newrank}</div>
<div class="u">${esc(r.user_handle)}</div>
<div class="s">score ${esc(Number.isInteger(r._score) ? r._score : r.score)}${hasTime ? " | " + esc(r.total_time) : ""}</div></div>`;
  let podHtml = "";
  if (podium.length) {
    const order = [podium[1], podium[0], podium[2]].filter(Boolean);
    podHtml = `<div class="pods">${order.map((r) => pod(r, r === podium[0])).join("")}</div>`;
  }

  let tableHtml = "";
  if (tableRows.length) {
    const head =
      `<th>RANK</th><th>USERNAME</th><th>SCORE</th>` +
      (hasTime ? `<th>TIME</th>` : "") +
      (hasPen ? `<th>PENALTY</th>` : "") +
      problems.map((p, i) => `<th title="${esc(p)}">P${i + 1}</th>`).join("");
    const trs = tableRows
      .map((r) => {
        const inst = r.institution
          ? `<small title="${esc(r.institution)}">${esc(r.institution)}</small>`
          : "";
        const cells = problems
          .map((p) => {
            const v = String(r[p] ?? "").trim();
            if (!isSolved(v)) return `<td><span class="nd"></span></td>`;
            if (v === "1") return `<td><span class="sd"></span></td>`;
            return `<td class="sc">${esc(v)}</td>`;
          })
          .join("");
        return `<tr><td class="r">${r._newrank}</td>
<td class="l"><a href="https://www.codechef.com/users/${encodeURIComponent(r.user_handle)}" target="_blank" rel="noopener">${esc(r.user_handle)}</a>${inst}</td>
<td class="sc">${esc(Number.isInteger(r._score) ? r._score : r.score)}</td>
${hasTime ? `<td>${esc(r.total_time)}</td>` : ""}${hasPen ? `<td>${esc(r.penalty)}</td>` : ""}${cells}</tr>`;
      })
      .join("\n");
    tableHtml = `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${trs}</tbody></table></div>`;
  }

  let pager = "";
  if (pages > 1)
    for (let n = 1; n <= pages; n++)
      pager += n === page ? `<b>${n}</b>` : `<a href="?page=${n}">${n}</a>`;
  return `${podHtml}${tableHtml}
<div class="pager">${pager}</div>`;
}

app.get(
  "/",
  publicCache,
  ah(async (req, res) => {
    const data = await loadLive();
    if (!data)
      return res.send(
        layout({
          active: "rank",
          updated: "-",
          body: rankingsBody({ rows: [], problems: [], pages: 1, page: 1 }),
        }),
      );
    const { shown } = applyHiding(data.rows, await readHidden());
    const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
    let page = parseInt(req.query.page, 10);
    page = Math.min(Math.max(Number.isFinite(page) ? page : 1, 1), pages);
    res.send(
      layout({
        active: "rank",
        updated: fmtDate(data.mtime, true),
        body: rankingsBody({
          rows: shown.slice((page - 1) * PER_PAGE, page * PER_PAGE),
          problems: data.problems,
          hasTime: data.cols.includes("total_time"),
          hasPen: data.cols.includes("penalty"),
          pages,
          page,
        }),
      }),
    );
  }),
);

// ---------- questions page ----------
const meter = (pct) => {
  const n = 20,
    on = Math.round((n * pct) / 100);
  let h = "";
  for (let i = 0; i < n; i++) h += `<i class="${i < on ? "f" : ""}"></i>`;
  return `<div class="meter">${h}</div>`;
};

app.get(
  "/questions",
  publicCache,
  ah(async (req, res) => {
    const data = await loadLive();
    if (!data)
      return res.send(
        layout({
          active: "q",
          updated: "-",
          body: `<div class="empty">Questions will appear here shortly</div>`,
        }),
      );
    const { shown } = applyHiding(data.rows, await readHidden());
    const s = solveStats(shown, data.problems);

    const cards = s.list
      .map(
        (it) => `<div class="card">
<span class="pn">${it.label}</span>
<div class="nm" title="${esc(it.name)}">${esc(it.name)}</div>
<div class="big">${it.solved}<small>/ ${s.total}</small></div>
${meter(it.pct)}
<div class="pc">${it.pct}% solved</div></div>`,
      )
      .join("");

    const body = `<div class="strip">
<div><b>${s.total}</b><span>PARTICIPANTS</span></div>
<div><b>${s.list.length}</b><span>QUESTIONS</span></div>
</div>
<div class="grid">${cards}</div>`;

    res.send(layout({ active: "q", updated: fmtDate(data.mtime, true), body }));
  }),
);

// ---------- admin (password protected) ----------
const safeEqual = (a, b) =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(String(a)).digest(),
    crypto.createHash("sha256").update(String(b)).digest(),
  );
function auth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    if (!ON_VERCEL) return next(); // local use without a password is fine
    return res
      .status(503)
      .send(
        "Admin is locked. Set the ADMIN_PASSWORD environment variable in Vercel and redeploy.",
      );
  }
  const hdr = req.headers.authorization || "";
  if (hdr.startsWith("Basic ")) {
    const [u, ...p] = Buffer.from(hdr.slice(6), "base64").toString().split(":");
    if (safeEqual(u, ADMIN_USER) && safeEqual(p.join(":"), ADMIN_PASSWORD))
      return next();
  }
  res
    .set("WWW-Authenticate", 'Basic realm="Admin"')
    .status(401)
    .send("Login required");
}
app.use("/admin", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  auth(req, res, next);
});

async function adminPage(msg, bad) {
  const hidden = await readHidden();
  const data = await loadLive();
  let stats = `<div class="box">No standings uploaded yet.</div>`;
  if (data) {
    const { shown, hiddenCount } = applyHiding(data.rows, hidden);
    const present = new Set(data.rows.map((r) => norm(r.user_handle)));
    const unmatched = [...hidden].filter((h) => !present.has(h)).sort();
    const neg = shown
      .filter((r) =>
        String(r.total_time || "")
          .trim()
          .startsWith("-"),
      )
      .map((r) => r.user_handle);
    stats = `<div class="box"><b>Live file:</b> ${esc(fmtDate(data.mtime, true))} (${esc(data.name)})<br>
<b>${hiddenCount} hidden, ${shown.length} shown</b> (total in file: ${data.rows.length})
${unmatched.length ? `<div class="warn">Names in your hidden list NOT found in the live file (typo?): ${esc(unmatched.join(", "))}</div>` : ""}
${neg.length ? `<div class="warn">Visible users with a negative total_time (possible test accounts): ${esc(neg.join(", "))}</div>` : ""}</div>`;
  }
  const live = await liveName();
  const snaps = (await listSnaps()).map((s) => {
    const action =
      s.name === live
        ? "<b>LIVE</b>"
        : `<form method="post" action="/admin/rollback"><input type="hidden" name="name" value="${esc(s.name)}"><button>Make live</button></form>`;
    return `<tr><td>${esc(fmtDate(new Date(s.at), true))}</td><td>${action}</td></tr>`;
  });
  return `<!doctype html><meta charset="utf-8"><title>Admin</title>
<style>body{font-family:Arial,sans-serif;max-width:760px;margin:30px auto;padding:0 16px;color:#222}
h2{margin-top:34px}.box{border:1px solid #ddd;border-radius:4px;padding:14px;margin-top:10px}
.err{background:#fde8e8;border:1px solid #e0a0a0;padding:10px;border-radius:4px}
.ok{background:#e6f4ea;border:1px solid #9bc9a6;padding:10px;border-radius:4px}
.warn{background:#fff6dd;border:1px solid #e3c96b;padding:10px;border-radius:4px;margin-top:8px}
textarea{width:100%;height:140px;font-family:monospace}button{padding:7px 14px}
table{border-collapse:collapse;width:100%}td{padding:5px 8px;border-bottom:1px solid #eee;font-size:14px}</style>
<h1>Admin - ${esc(CONTEST_NAME)}</h1>
${msg ? `<div class="${bad ? "err" : "ok"}">${esc(msg)}</div>` : ""}
${stats}
<h2>1. Upload new standings CSV</h2>
<form class="box" method="post" action="/admin/upload" enctype="multipart/form-data">
<input type="file" name="file" accept=".csv" required>
<label><input type="checkbox" name="force"> Publish even if the file has far fewer participants than the last one</label><br><br>
<button>Upload and publish</button></form>
<h2>2. Hidden usernames (test accounts)</h2>
<form class="box" method="post" action="/admin/hidden">
<textarea name="hidden">${esc(await readHiddenText())}</textarea><br>
<small>One username per line. Case and extra spaces are ignored. Shows on the public page within a few seconds.</small><br><br>
<button>Save hidden list</button></form>
<h2>3. Previous uploads (roll back, last ${MAX_SNAPS} kept)</h2>
<div class="box"><table>${snaps.join("") || "<tr><td>None yet</td></tr>"}</table></div>
<p><a href="/" target="_blank">Rankings</a> | <a href="/questions" target="_blank">Questions</a></p>`;
}

app.get(
  "/admin",
  ah(async (req, res) => res.send(await adminPage())),
);

app.post(
  "/admin/upload",
  upload.single("file"),
  ah(async (req, res) => {
    if (!req.file) return res.send(await adminPage("No file chosen.", true));
    const result = parseCsv(req.file.buffer);
    if (result.error)
      return res.send(
        await adminPage(
          `REJECTED. ${result.error} Still showing the previous standings.`,
          true,
        ),
      );
    const old = await loadLive();
    if (old && !req.body.force && result.rows.length < 0.8 * old.rows.length)
      return res.send(
        await adminPage(
          `REJECTED. New file has ${result.rows.length} participants, last one had ${old.rows.length}. Wrong or old file? Tick the override box if this is correct.`,
          true,
        ),
      );
    await saveSnap(result);
    res.send(
      await adminPage(
        `Published (${result.rows.length} participants). Reload the public page to see it.`,
      ),
    );
  }),
);

app.post(
  "/admin/hidden",
  ah(async (req, res) => {
    await store.set("cr:hidden", { text: String(req.body.hidden || "") });
    res.send(await adminPage("Hidden list saved."));
  }),
);

app.post(
  "/admin/rollback",
  ah(async (req, res) => {
    const n = String(req.body.name || "");
    const exists = (await listSnaps()).some((s) => s.name === n);
    if (!exists) return res.sendStatus(404);
    await store.set("cr:live", { name: n });
    res.send(await adminPage("Rolled back."));
  }),
);

// ---------- errors ----------
app.use((err, req, res, next) => {
  console.error(err);
  const msg =
    err && err.code === "LIMIT_FILE_SIZE"
      ? "File is too big (4 MB limit)."
      : "Something went wrong: " +
        (err && err.message ? err.message : "unknown error");
  res.status(500).send(esc(msg));
});

// ---------- start (local only; Vercel imports the exported app) ----------
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`Rankings:   http://localhost:${PORT}/`);
    console.log(`Questions:  http://localhost:${PORT}/questions`);
    console.log(`Admin:      http://localhost:${PORT}/admin`);
    console.log(redis ? "Storage: Redis" : "Storage: local data/ folder");
  });
  server.on("error", (err) => {
    console.error("COULD NOT START:", err.message);
    if (err.code === "EADDRINUSE")
      console.error(`Port ${PORT} is busy. Try: PORT=4000 npm start`);
    process.exit(1);
  });
}
module.exports = app;
