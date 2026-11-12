// GET  /api/routee/:code  → { days, stops, v }                       (그룹 코드로 노션에서 읽기)
// PUT  /api/routee/:code  ← { days, stops, delDays, delStops }       (바뀐 항목만 반영 · 통째로 덮어쓰지 않음)
// 환경변수: NOTION_TOKEN, NOTION_DAYS_DB, NOTION_STOPS_DB
// 노션 컬럼(두 표 공통): 그룹 코드, 앱ID, rev(텍스트)
const NOTION = "https://api.notion.com/v1";
const HDR = () => ({ Authorization: "Bearer " + process.env.NOTION_TOKEN, "Notion-Version": "2022-06-28", "Content-Type": "application/json" });

async function nf(method, path, body, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(NOTION + path, { method, headers: HDR(), body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await new Promise(s => setTimeout(s, (+r.headers.get("retry-after") || 1) * 1000)); continue; }
    if (!r.ok) throw new Error("notion " + r.status + " " + (await r.text()).slice(0, 300));
    return r.json();
  }
  throw new Error("notion rate limit");
}
const rt = v => ({ rich_text: v ? [{ text: { content: String(v).slice(0, 1900) } }] : [] });
const txt = p => (p && p.rich_text ? p.rich_text.map(t => t.plain_text).join("") : "");
const sel = v => ({ select: v ? { name: String(v).replace(/,/g, " ") } : null });
const num = v => ({ number: typeof v === "number" && isFinite(v) ? v : null });

async function listGroup(db, code) {
  const out = []; let cursor;
  do {
    const r = await nf("POST", `/databases/${db}/query`, { filter: { property: "그룹 코드", rich_text: { equals: code } }, start_cursor: cursor, page_size: 100 });
    out.push(...r.results); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}
async function upsert(db, existing, props) {
  if (existing) return nf("PATCH", `/pages/${existing}`, { properties: props });
  return nf("POST", "/pages", { parent: { database_id: db }, properties: props });
}
const dayOf = (p) => ({ id: txt(p.properties["앱ID"]), date: (p.properties["날짜"].date || {}).start || "", note: txt(p.properties["한 줄 메모"]) });
const stopOf = (p, idOf) => {
  const q = p.properties, rel = (q["날짜"].relation || [])[0];
  return { id: txt(q["앱ID"]), day: rel ? idOf[rel.id] : "", s: txt(q["시작"]), e: txt(q["종료"]),
    n: (q["이름"].title || []).map(t => t.plain_text).join(""), c: (q["분류"].select || {}).name || "식사",
    a: (q["지역"].select || {}).name || "", m: txt(q["메모"]), mv: (q["이동수단"].select || {}).name || "도보",
    mm: q["이동시간(분)"].number || 0, md: q["이동거리(m)"].number || 0, g: q["구글지도 링크"].url || "",
    lat: q["위도"].number, lng: q["경도"].number, o: q["순서"].number || 0 };
};
// 바뀐 것만 노션에 쓰기 위한 비교용 값
const kd = d => JSON.stringify([d.date || "", d.note || ""]);
const ks = s => JSON.stringify([s.day, s.s || "", s.e || "", s.n || "", s.c || "", s.a || "", s.m || "", s.mv || "", +s.mm || 0, +s.md || 0, s.g || "", typeof s.lat === "number" ? s.lat : null, typeof s.lng === "number" ? s.lng : null]);

export default async function handler(req, res) {
  const code = String(req.query.code || "").toUpperCase().replace(/[^A-Z0-9가-힣-]/g, "").slice(0, 20);
  const DAYS = process.env.NOTION_DAYS_DB, STOPS = process.env.NOTION_STOPS_DB;
  if (!process.env.NOTION_TOKEN || !DAYS || !STOPS) return res.status(501).json({ error: "not configured" });
  if (code.length < 3) return res.status(400).json({ error: "bad code" });
  if (req.method === "PUT" && code === "DEMO") return res.status(403).json({ error: "DEMO is read-only" });
  res.setHeader("Cache-Control", "no-store");
  try {
    const dayPages = await listGroup(DAYS, code), stopPages = await listGroup(STOPS, code);
    const idOf = {}; dayPages.forEach(p => { idOf[p.id] = txt(p.properties["앱ID"]); });
    if (req.method === "GET") {
      const days = dayPages.map(dayOf).filter(d => d.id);
      const stops = stopPages.map(p => stopOf(p, idOf)).filter(s => s.id && s.day);
      // v: 이 그룹에서 가장 최근에 저장된 시각(ms). 화면은 이보다 오래된 응답을 무시합니다.
      let v = ""; dayPages.concat(stopPages).forEach(p => { const r = txt(p.properties["rev"]); if (r > v) v = r; });
      return res.json({ days, stops, v });
    }
    if (req.method === "PUT") {
      const b = req.body || {};
      const days = b.days || [], stops = b.stops || [], delDays = b.delDays || [], delStops = b.delStops || [];
      if (days.length > 60 || stops.length > 400 || delDays.length > 60 || delStops.length > 400) return res.status(413).json({ error: "too large" });
      const rev = String(Date.now());
      const dayMap = {}, oldDay = {};
      dayPages.forEach(p => { const o = dayOf(p); dayMap[o.id] = p.id; oldDay[o.id] = kd(o); });
      const stopMap = {}, oldStop = {};
      stopPages.forEach(p => { const o = stopOf(p, idOf); stopMap[o.id] = p.id; oldStop[o.id] = ks(o); });
      let wrote = false;
      for (const d of days) {
        if (!d || !d.id) continue;
        if (dayMap[d.id] && oldDay[d.id] === kd(d)) continue;
        const pg = await upsert(DAYS, dayMap[d.id], {
          "이름": { title: [{ text: { content: d.date || "날짜" } }] }, "날짜": { date: d.date ? { start: d.date } : null },
          "한 줄 메모": rt(d.note), "그룹 코드": rt(code), "앱ID": rt(d.id), "rev": rt(rev) });
        dayMap[d.id] = pg.id; wrote = true;
      }
      const seen = {};
      for (const s of stops) {
        if (!s || !s.id || !dayMap[s.day]) continue;   // 그 사이 다른 사람이 지운 날짜의 일정은 건너뜀
        if (stopMap[s.id] && oldStop[s.id] === ks(s)) continue;
        const idx = (seen[s.day] = (seen[s.day] || 0) + 1);
        const pg = await upsert(STOPS, stopMap[s.id], {
          "이름": { title: [{ text: { content: s.n || "(이름 없음)" } }] }, "날짜": { relation: [{ id: dayMap[s.day] }] },
          "시작": rt(s.s), "종료": rt(s.e), "분류": sel(s.c), "지역": sel(s.a), "메모": rt(s.m), "이동수단": sel(s.mv),
          "이동시간(분)": num(+s.mm || 0), "이동거리(m)": num(+s.md || 0), "구글지도 링크": { url: s.g || null },
          "위도": num(s.lat), "경도": num(s.lng), "순서": num(typeof s.o === "number" ? s.o : idx), "그룹 코드": rt(code), "앱ID": rt(s.id), "rev": rt(rev) });
        stopMap[s.id] = pg.id; wrote = true;
      }
      // 지우라고 요청된 것만 보관 처리 (화면이 모르는 항목은 건드리지 않음)
      for (const id of delStops) if (stopMap[id]) { await nf("PATCH", `/pages/${stopMap[id]}`, { archived: true }); delete stopMap[id]; wrote = true; }
      for (const id of delDays) if (dayMap[id]) { await nf("PATCH", `/pages/${dayMap[id]}`, { archived: true }); delete dayMap[id]; wrote = true; }
      return res.json({ ok: true, v: wrote ? rev : "" });
    }
    res.setHeader("Allow", "GET, PUT"); return res.status(405).end();
  } catch (e) { return res.status(502).json({ error: String(e.message || e) }); }
}
