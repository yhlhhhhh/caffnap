"use strict";
/* CaffNap v1.2 — 纯本地、零依赖（plain script，file:// 双击可用） */
const $ = id => document.getElementById(id);

// ==================== 工具 ====================
const toMin = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const toHM = t => {
  t = ((Math.round(t) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60), m = t % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
};
const dayKey = d => {
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};
const todayKey = () => dayKey(new Date());
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lsGet = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v === null || v === undefined ? fb : v; } catch (e) { return fb; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
function download(filename, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}

// ==================== 存储键 ====================
const LS = {
  day: "caffnap_v1", geno: "caffnap_geno_v1", hist: "caffnap_history_v2",
  sleep: "caffnap_sleep_v1", calib: "caffnap_calib_v1",
  custom: "caffnap_custom_bevs_v1", tab: "caffnap_tab_v1"
};

// ==================== 饮品库 ====================
const GENERIC_BEVS = [
  { k: "espresso", label: "浓缩 espresso", mg: 60 },
  { k: "americano", label: "美式", mg: 150 },
  { k: "filter", label: "手冲/大美式", mg: 200 },
  { k: "latte", label: "拿铁", mg: 75 },
  { k: "tea", label: "茶", mg: 45 },
  { k: "decaf", label: "低因/其他", mg: 0 }
];
const DB_META = window.CAFFNAP_DB || {};
let DB_ITEMS = DB_META.items || [];
if (!DB_ITEMS.length) console.warn("CaffNap: db.js 未加载，使用通用估算饮品");
let UBEVS = lsGet(LS.custom, []);   // 自定义饮品
function allBevs() { return (DB_ITEMS.length ? DB_ITEMS : GENERIC_BEVS).concat(UBEVS); }
function bevMid(b) { return b.mg !== undefined ? b.mg : (b.mg_min + b.mg_max) / 2; }
const TYPE_MAP = {
  "美式类": "美式", "美式": "美式", "冷萃类": "美式", "冷萃": "美式",
  "滴滤咖啡": "美式", "冰咖啡": "美式",
  "拿铁类": "拿铁", "拿铁": "拿铁", "摩卡": "拿铁", "星冰乐": "拿铁",
  "浓缩咖啡": "浓缩", "浓缩": "浓缩",
  "速溶咖啡": "速溶咖啡", "速溶": "速溶咖啡", "冻干": "速溶咖啡",
  "奶茶": "奶茶", "轻因系列": "奶茶", "纯茶": "奶茶", "特调": "奶茶",
  "茶咖": "奶茶", "轻咖": "奶茶", "其他非咖啡类": "奶茶", "无咖啡": "奶茶", "果茶": "奶茶"
};
function normType(b) {
  if (!b.brand && !b.category) return "通用";         // 兜底通用饮品
  return TYPE_MAP[b.category] || "奶茶";
}

// ==================== 状态 ====================
let state = { doses: [], napOn: false, napT: "14:10", napD: 20, wakeT: "07:00", targetBed: "23:00", day: new Date().toDateString() };
Object.assign(state, lsGet(LS.day, {}));
let HIST = lsGet(LS.hist, {});       // { "2026-11-09": { mg, doses:[...], pred, target } }
let SLEEP = lsGet(LS.sleep, {});     // { "2026-11-09": { bed:"01:30", wake:"08:00" } }
let CALIB = lsGet(LS.calib, { offset: 0, nights: 0, log: [] });
let dlmoOff = 0;                     // PER1 rs7221412 的 DLMO 偏移（分钟）

// 跨天归档：state 里残留的不是今天的剂量 → 归档到历史后清空
(function rollover() {
  const today = new Date().toDateString();
  if (state.day && state.day !== today && state.doses && state.doses.length) {
    const d = new Date(state.day);
    if (!isNaN(d)) {
      const k = dayKey(d);
      const mg = state.doses.reduce((s, x) => s + doseMg(x), 0);
      HIST[k] = Object.assign({ mg: Math.round(mg), doses: state.doses, pred: null, target: toMin(state.targetBed || "23:00") }, HIST[k] || {});
      HIST[k].mg = Math.round(mg); HIST[k].doses = state.doses;
      lsSet(LS.hist, HIST);
    }
    state.doses = [];
  }
  state.day = today;
  state.doses = (state.doses || []).filter(d => d.day === today);
})();
function save() { lsSet(LS.day, state); }

// ==================== 参数（基因 → 半衰期/阈值 + 个人修正） ====================
function baseTh() {
  let th = { AA: 3.2, AC: 4.5, CC: 7.5 }[$("cyp").value];
  th *= { TT: 1.10, GT: 1.0, GG: 0.90 }[$("ahr").value];
  th *= { AA: 0.95, AG: 1.0, GG: 1.05 }[$("abcg2").value];
  if ($("smoke").checked) th *= 0.7;
  if ($("oc").checked) th *= 1.5;
  return th;
}
function getParams() {
  const base = baseTh();
  const th = clamp(base + (CALIB.offset || 0), 2.0, 10);
  const thr = { TT: 1.3, CT: 1.0, CC: 0.8 }[$("ador").value];
  return { th, thr, base };
}

// ==================== 药代模型 ====================
function doseMg(d) { const b = allBevs().find(x => x.k === d.bev); return b ? bevMid(b) * d.cups : 0; }
function concentration(mg, th, dtH) { return dtH < 0 ? 0 : mg / 42 * 1.15 * Math.pow(2, -dtH / th); }
function totalC(doses, th, tMin) {
  return doses.reduce((s, d) => s + concentration(doseMg(d), th, (tMin - toMin(d.time)) / 60), 0);
}
function tClear(doses, th, thr) {
  if (!doses.length) return null;
  const last = Math.max(...doses.map(d => toMin(d.time)));
  for (let t = last + 30; t <= last + 1440; t += 2)
    if (totalC(doses, th, t) <= thr) return t;
  return null;
}
function lastCall(mg, th, thr, targetMin) {
  const c0 = mg / 42 * 1.15;
  if (c0 <= thr) return 0;
  return Math.max(0, targetMin - (th * Math.log2(c0 / thr) * 60 + 30));
}

// ==================== 双过程模型 ====================
const CIRC = [[0,45],[4,33],[6,45],[7,72],[9,88],[12,85],[14,78],[15.5,65],[17,80],[19,78],[21,68],[22.5,58],[24,45]];
function circadian(t) {
  t = ((t % 24) + 24) % 24;
  for (let i = 0; i < CIRC.length - 1; i++) {
    const [t0, v0] = CIRC[i], [t1, v1] = CIRC[i + 1];
    if (t >= t0 && t <= t1) return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
  }
  return 45;
}
function adenosine(t, wakeMin, napEndMin, napDurMin) {
  let awake = ((t - wakeMin) % 1440 + 1440) % 1440;
  let p = Math.min(90, awake / 60 * 4);
  if (napEndMin !== null && t > napEndMin) p = Math.max(0, p - napDurMin * 1.2);
  return p;
}

// ==================== 褪黑素模型 ====================
function melRaw(rel) {
  if (rel < -1 || rel >= 8) return 5;
  if (rel < 0) return 5 + (rel + 1) * 5;
  if (rel < 2) return 10 + rel * 25;
  if (rel < 4) return 60 + (rel - 2) * 20;
  return 100 - (rel - 4) * 22.5;
}

// 统一预测核心：今日 calc() 与历史校准共用
function computePrediction(doses, th, thr, napDelayMin) {
  const tC = tClear(doses, th, thr);
  const dlmo0 = 21 * 60 + dlmoOff;
  let delayMin = 0;
  doses.forEach(d => {
    const rel = ((toMin(d.time) - dlmo0) % 1440 + 1440) % 1440;
    const before = rel <= 16 * 60 ? rel - 1440 : rel;
    if (before >= -300 && before <= 120) delayMin += (doseMg(d) / 200) * 40;
  });
  delayMin = Math.min(delayMin, 180);
  const dlmoEff = dlmo0 + delayMin;
  const suppress = t => 1 - 0.3 * Math.min(1, totalC(doses, th, t) / thr);
  const melAt = t => {
    let rel = ((t - dlmoEff) % 1440 + 1440) % 1440;
    if (rel > 16 * 60) rel -= 1440;
    return melRaw(rel) * suppress(t);
  };
  let tMel = null;
  for (let t = 12 * 60; t <= 24 * 60; t += 2) if (melAt(t) >= 10) { tMel = t; break; }
  let tSleep = null;
  if (tC !== null && tMel !== null) tSleep = Math.max(tC, tMel) + (napDelayMin || 0);
  return { tC, tMel, tSleep, dlmo0, dlmoEff, delayMin, melAt };
}

// ==================== 摄入条目 UI ====================
function renderDoses() {
  const box = $("doseList");
  box.innerHTML = "";
  const list = allBevs();
  state.doses.forEach((d, i) => {
    let cur = list.find(b => b.k === d.bev);
    if (!cur) { cur = list[0]; d.bev = cur.k; }
    const curBrand = cur.brand || "通用";
    const curType = normType(cur);

    const brands = [...new Set(list.map(b => b.brand || "通用"))];
    const ALL_TYPES = ["美式", "拿铁", "浓缩", "速溶咖啡", "奶茶"];
    const hasTypes = ALL_TYPES.filter(t => list.some(b => (b.brand || "通用") === curBrand && normType(b) === t));
    const types = (DB_ITEMS.length || UBEVS.length) && hasTypes.length ? hasTypes : ["通用"];
    const prods = list.filter(b => (b.brand || "通用") === curBrand && normType(b) === curType);

    const opt = (v, label, sel) => `<option value="${v}" ${sel ? "selected" : ""}>${label}</option>`;
    const row = document.createElement("div");
    row.className = "dose-row";
    row.innerHTML = `
      <div class="fld f-brand"><label>品牌</label>
        <select data-i="${i}" class="d-brand">${brands.map(b => opt(b, b, b === curBrand)).join("")}</select></div>
      <div class="fld f-type"><label>类型</label>
        <select data-i="${i}" class="d-type">${types.map(t => opt(t, t, t === curType)).join("")}</select></div>
      <div class="fld f-prod"><label>产品</label>
        <select data-i="${i}" class="d-bev">${prods.map(b =>
          opt(b.k, b.drink
            ? `${b.drink}${b.spec ? "（" + b.spec + "）" : ""}·约${Math.round(bevMid(b))}mg`
            : `${b.label}（${b.mg}mg）`, b.k === d.bev)).join("")}</select></div>
      <div class="fld f-cups"><label>杯数</label>
        <input type="number" data-i="${i}" class="d-cups" value="${d.cups}" min="0.5" max="6" step="0.5"></div>
      <div class="fld f-time"><label>时间</label>
        <input type="time" data-i="${i}" class="d-time" value="${d.time}"></div>
      <button class="del f-del" data-i="${i}" title="删除">×</button>`;
    box.appendChild(row);
  });

  box.querySelectorAll(".d-brand").forEach(el => el.addEventListener("change", e => {
    const i = +e.target.dataset.i;
    const first = allBevs().find(b => (b.brand || "通用") === e.target.value);
    if (first) { state.doses[i].bev = first.k; save(); renderDoses(); calc(); }
  }));
  box.querySelectorAll(".d-type").forEach(el => el.addEventListener("change", e => {
    const i = +e.target.dataset.i;
    const curBrand = (allBevs().find(b => b.k === state.doses[i].bev) || allBevs()[0]).brand || "通用";
    const first = allBevs().find(b => (b.brand || "通用") === curBrand && normType(b) === e.target.value);
    if (first) { state.doses[i].bev = first.k; save(); renderDoses(); calc(); }
  }));
  box.querySelectorAll(".d-bev,.d-cups,.d-time").forEach(el => el.addEventListener("input", e => {
    const i = +e.target.dataset.i;
    if (e.target.classList.contains("d-bev")) state.doses[i].bev = e.target.value;
    if (e.target.classList.contains("d-cups")) state.doses[i].cups = +e.target.value;
    if (e.target.classList.contains("d-time")) state.doses[i].time = e.target.value;
    save(); calc();
  }));
  box.querySelectorAll(".del").forEach(b => b.addEventListener("click", e => {
    state.doses.splice(+e.target.dataset.i, 1); save(); renderDoses(); calc();
  }));
}

$("addDose").addEventListener("click", () => {
  const now = new Date();
  const hm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  state.doses.push({ bev: DB_ITEMS.length ? "b000" : "americano", cups: 1, time: hm, day: new Date().toDateString() });
  save(); renderDoses(); calc();
});

// ==================== 主计算 ====================
let lastResult = null;   // 供分享卡片 / 日历使用

function calc() {
  const { th, thr, base } = getParams();
  const doses = state.doses.filter(d => doseMg(d) > 0);
  const totalMg = doses.reduce((s, d) => s + doseMg(d), 0);

  // 小睡
  const napOn = $("napOn").checked;
  const napStart = toMin($("napT").value), napDur = +$("napD").value;
  const napEnd = napStart + napDur;
  let napDelayMin = 0;
  if (napOn && napEnd > 15 * 60) napDelayMin = Math.min(90, (napEnd - 900) / 60 * (napDur / 30) * 30);

  const pred = computePrediction(doses, th, thr, napDelayMin);
  const { tC, tMel, tSleep, dlmo0, dlmoEff, delayMin, melAt } = pred;

  // ---- 输出 ----
  $("bedtime").textContent = tSleep !== null
    ? toHM(tSleep) + (tSleep >= 1440 ? "（次日）" : "") : "24h 内条件未满足";
  let subs = [];
  if (tC !== null) subs.push("咖啡因 " + toHM(tC) + " 达标");
  if (tMel !== null) subs.push("褪黑素 " + toHM(tMel) + " 达标");
  if (napDelayMin > 0) subs.push("小睡 +" + Math.round(napDelayMin) + "min");
  $("bedtimeSub").textContent = subs.join(" · ") || "添加第一杯开始预测";
  $("stHalf").textContent = CALIB.offset
    ? `${th.toFixed(1)} h（基因 ${base.toFixed(1)} + 个人 ${CALIB.offset > 0 ? "+" : ""}${CALIB.offset.toFixed(1)}）`
    : th.toFixed(1) + " h";
  $("stClear").textContent = tC !== null ? toHM(tC) : "24h 内未达标";
  $("stDlmo").textContent = toHM(dlmoEff) + (delayMin > 0 ? `（推迟 ${Math.round(delayMin)}min）` : "（未受扰动）");
  $("stPer1").textContent = { "-60": "AA · 偏晨型（DLMO −1h）", "0": "AG · 标准", "60": "GG · 偏夜型（DLMO +1h）" }[String(dlmoOff)] || "未知（默认标准）";
  $("stCalib").textContent = CALIB.nights
    ? `t½ ${CALIB.offset > 0 ? "+" : ""}${CALIB.offset.toFixed(1)} h（已用 ${CALIB.nights} 晚反馈）`
    : "未校准（去「统计」页录入昨晚睡眠）";

  const badge = $("badge");
  if (delayMin >= 90 || (tSleep !== null && tSleep > 24 * 60)) {
    badge.textContent = "高风险：生物钟被明显推迟"; badge.className = "badge risk";
  } else if (tSleep === null || tSleep > 23 * 60) {
    badge.textContent = "中风险：晚间饮用"; badge.className = "badge warn";
  } else {
    badge.textContent = "低风险：节律基本未受扰"; badge.className = "badge ok";
  }

  // 宵禁反推
  const list = allBevs();
  const selBev = state.doses.length
    ? (list.find(b => b.k === state.doses[state.doses.length - 1].bev) || list[0])
    : (list.find(b => b.k === "americano") || list[0]);
  const selMg = bevMid(selBev);
  const lc = lastCall(selMg, th, thr, toMin($("targetBed").value));
  $("lastCall").textContent = toHM(lc);
  const lowMg = Math.min(...list.map(bevMid).filter(m => m > 0));
  $("lastCallNote").textContent =
    `按「${selBev.drink ? (selBev.brand || "") + "·" + selBev.drink : selBev.label}」1 杯（约${Math.round(selMg)}mg）计算。想喝更晚？换最低因选项（约${Math.round(lowMg)}mg）可把宵禁延后约 ` +
    Math.max(0, Math.round((th * Math.log2((selMg / 42 * 1.15) / thr) - th * Math.log2((lowMg / 42 * 1.15) / thr)) * 60)) +
    ` 分钟。`;

  lastResult = {
    tSleep, totalMg, cups: doses.reduce((s, d) => s + d.cups, 0), th, thr,
    badge: badge.textContent, lastCallMin: lc, targetBed: toMin($("targetBed").value), selMg
  };

  // 今日入历史（热力图/统计用）
  const k = todayKey();
  if (totalMg > 0 || HIST[k]) {
    HIST[k] = { mg: Math.round(totalMg), doses: state.doses.slice(), pred: tSleep, target: lastResult.targetBed };
    lsSet(LS.hist, HIST);
  }

  const wakeMin = toMin($("wakeT").value);
  const napEndMin = napOn ? napEnd : null;
  const alertness = t => {
    const a = circadian(t) + 28 * Math.min(1, totalC(doses, th, t) / thr) - 0.35 * adenosine(t * 60, wakeMin, napEndMin, napDur);
    return Math.max(5, Math.min(100, a));
  };
  drawCaf(thr, doses, tC, tSleep, napOn ? { s: napStart, e: napEnd, d: napDur } : null);
  drawMel(dlmo0, dlmoEff, melAt, tSleep);
  drawAlert(alertness, doses, napOn ? { s: napStart, e: napEnd, d: napDur } : null, tSleep);
}

// ==================== 图表 ====================
function drawCaf(thr, doses, tC, tSleep, nap) {
  const W = 560, H = 200, L = 40, R = 12, T = 12, B = 30;
  const th = getParams().th;
  let peak = 0;
  for (let t = 0; t <= 1440; t += 5) {
    const c = totalC(doses, th, t);
    if (c > peak) peak = c;
  }
  const cMax = Math.max(peak * 1.15, thr * 1.3, 1);
  const X = t => L + (W - L - R) * t / 1440;
  const Y = c => T + (H - T - B) * (1 - c / cMax);
  let s = "";
  for (let g = 0; g <= 1440; g += 240)
    s += `<line x1="${X(g)}" y1="${T}" x2="${X(g)}" y2="${H - B}" stroke="var(--border)"/>`;
  if (nap) {
    s += `<rect x="${X(nap.s)}" y="${T}" width="${X(Math.min(nap.e, 1440)) - X(nap.s)}" height="${H - B - T}" fill="var(--purple)" opacity="0.12" rx="4"/>
          <text x="${(X(nap.s) + X(Math.min(nap.e, 1440))) / 2}" y="${T + 12}" text-anchor="middle" font-size="10" fill="var(--sub)">小睡 ${nap.d}min</text>`;
  }
  doses.forEach(d => {
    const mg = doseMg(d), h = 12 + Math.min(mg, 400) / 400 * 30;
    s += `<rect x="${X(toMin(d.time)) - 3}" y="${H - B - h}" width="6" height="${h}" rx="2" fill="var(--orange)" opacity="0.8"/>
          <text x="${X(toMin(d.time))}" y="${H - B - h - 4}" text-anchor="middle" font-size="9" fill="var(--sub)">${mg}mg</text>`;
  });
  s += `<line x1="${L}" y1="${Y(thr)}" x2="${W - R}" y2="${Y(thr)}" stroke="var(--sub)" stroke-dasharray="4 3"/>
        <text x="${W - R}" y="${Y(thr) - 4}" text-anchor="end" font-size="10" fill="var(--sub)">阈值 ${thr.toFixed(1)} mg/L</text>`;
  let path = "";
  for (let i = 0; i <= 240; i++) {
    const t = 1440 * i / 240;
    path += (i ? "L" : "M") + X(t).toFixed(1) + " " + Y(totalC(doses, th, t)).toFixed(1) + " ";
  }
  s += `<path d="${path}" fill="none" stroke="var(--blue)" stroke-width="2.2"/>`;
  if (tC !== null && tC <= 1440)
    s += `<circle cx="${X(tC)}" cy="${Y(thr)}" r="4" fill="var(--blue)" opacity="0.4"/>`;
  if (tSleep !== null && tSleep <= 1440)
    s += `<circle cx="${X(tSleep)}" cy="${Y(thr)}" r="5" fill="var(--blue)"/>
          <text x="${X(tSleep)}" y="${Y(thr) + 16}" text-anchor="middle" font-size="11" fill="var(--blue)">${toHM(tSleep)}</text>`;
  for (let g = 0; g < 1440; g += 240)
    s += `<text x="${X(g)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--sub)">${g / 60}时</text>`;
  $("chartCaf").innerHTML = s;
}

function drawMel(dlmo0, dlmoEff, melAt, tSleep) {
  const W = 560, H = 190, L = 44, R = 12, T = 12, B = 28;
  const X = t => L + (W - L - R) * t / 1440;
  const Y = v => T + (H - T - B) * (1 - v / 100);
  let s = "";
  for (let g = 0; g <= 1440; g += 240)
    s += `<line x1="${X(g)}" y1="${T}" x2="${X(g)}" y2="${H - B}" stroke="var(--border)"/>`;
  if (dlmo0 !== dlmoEff)
    s += `<line x1="${X(dlmo0)}" y1="${T}" x2="${X(dlmo0)}" y2="${H - B}" stroke="var(--sub)" stroke-dasharray="3 3"/>
          <text x="${X(dlmo0)}" y="${H - B - 4}" text-anchor="middle" font-size="9" fill="var(--sub)">自然 ${toHM(dlmo0)}</text>`;
  s += `<line x1="${L}" y1="${Y(10)}" x2="${W - R}" y2="${Y(10)}" stroke="var(--sub)" stroke-dasharray="4 3"/>
        <text x="${W - R}" y="${Y(10) - 4}" text-anchor="end" font-size="10" fill="var(--sub)">DLMO 10 pg/mL</text>`;
  let dRaw = "", dEff = "";
  for (let i = 0; i <= 240; i++) {
    const t = 1440 * i / 240;
    let rel = ((t - dlmoEff) % 1440 + 1440) % 1440;
    if (rel > 960) rel -= 1440;
    dRaw += (i ? "L" : "M") + X(t).toFixed(1) + " " + Y(melRaw(rel)).toFixed(1) + " ";
    dEff += (i ? "L" : "M") + X(t).toFixed(1) + " " + Y(melAt(t)).toFixed(1) + " ";
  }
  s += `<path d="${dRaw}" fill="none" stroke="var(--sub)" stroke-width="1.4" stroke-dasharray="5 3" opacity="0.6"/>
        <path d="${dEff}" fill="none" stroke="var(--purple)" stroke-width="2.2"/>`;
  if (dlmoEff >= 0 && dlmoEff <= 1440)
    s += `<circle cx="${X(dlmoEff)}" cy="${Y(10)}" r="4" fill="var(--purple)"/>
          <text x="${X(dlmoEff)}" y="${Y(10) + 16}" text-anchor="middle" font-size="10" fill="var(--purple)">${toHM(dlmoEff)}</text>`;
  if (tSleep !== null && tSleep <= 1440)
    s += `<line x1="${X(tSleep)}" y1="${T}" x2="${X(tSleep)}" y2="${Y(10)}" stroke="var(--purple)" stroke-dasharray="4 3" opacity="0.5"/>`;
  for (let g = 0; g < 1440; g += 240)
    s += `<text x="${X(g)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--sub)">${g / 60}时</text>`;
  s += `<text x="${L - 5}" y="${T + 10}" text-anchor="end" font-size="10" fill="var(--sub)">100</text>
        <text x="${L - 5}" y="${H - B}" text-anchor="end" font-size="10" fill="var(--sub)">0</text>`;
  $("chartMel").innerHTML = s;
}

function drawAlert(alertness, doses, nap, tSleep) {
  const W = 560, H = 190, L = 40, R = 12, T = 12, B = 28;
  const X = t => L + (W - L - R) * t / 24;
  const Y = a => T + (H - T - B) * (1 - a / 100);
  let s = "";
  s += `<rect x="${L}" y="${Y(100)}" width="${W - L - R}" height="${Y(60) - Y(100)}" fill="var(--green)" opacity="0.08"/>
        <rect x="${L}" y="${Y(60)}" width="${W - L - R}" height="${Y(35) - Y(60)}" fill="var(--warn)" opacity="0.10"/>
        <rect x="${L}" y="${Y(35)}" width="${W - L - R}" height="${Y(5) - Y(35)}" fill="var(--sub)" opacity="0.15"/>`;
  for (let g = 0; g <= 24; g += 4)
    s += `<line x1="${X(g)}" y1="${T}" x2="${X(g)}" y2="${H - B}" stroke="var(--border)"/>`;
  s += `<line x1="${L}" y1="${Y(60)}" x2="${W - R}" y2="${Y(60)}" stroke="var(--sub)" stroke-dasharray="3 3" opacity="0.6"/>
        <text x="${W - R}" y="${Y(60) - 4}" text-anchor="end" font-size="9" fill="var(--sub)">60</text>
        <line x1="${L}" y1="${Y(35)}" x2="${W - R}" y2="${Y(35)}" stroke="var(--sub)" stroke-dasharray="3 3" opacity="0.6"/>
        <text x="${W - R}" y="${Y(35) - 4}" text-anchor="end" font-size="9" fill="var(--sub)">35 困倦</text>`;
  if (nap) {
    s += `<rect x="${X(nap.s / 60)}" y="${T}" width="${X(Math.min(nap.e, 1440) / 60) - X(nap.s / 60)}" height="${H - B - T}" fill="var(--purple)" opacity="0.15" rx="4"/>
          <text x="${(X(nap.s / 60) + X(Math.min(nap.e, 1440) / 60)) / 2}" y="${T + 11}" text-anchor="middle" font-size="9" fill="var(--sub)">小睡</text>`;
  }
  doses.forEach(d => {
    s += `<rect x="${X(toMin(d.time) / 60) - 2}" y="${H - B - 8}" width="4" height="8" rx="1.5" fill="var(--orange)" opacity="0.7"/>`;
  });
  let path = "", dipA = 101, dipT = 0, minA = 101, minT = 0;
  for (let i = 0; i <= 240; i++) {
    const t = 24 * i / 240, a = alertness(t);
    path += (i ? "L" : "M") + X(t).toFixed(1) + " " + Y(a).toFixed(1) + " ";
    if (t >= 13 && t <= 18 && a < dipA) { dipA = a; dipT = t; }
    if ((t >= 22 || t <= 6) && a < minA) { minA = a; minT = t; }
  }
  s += `<path d="${path}" fill="none" stroke="var(--green)" stroke-width="2.2"/>`;
  if (dipA < 101)
    s += `<circle cx="${X(dipT)}" cy="${Y(dipA)}" r="3.5" fill="var(--green)"/>
          <text x="${X(dipT)}" y="${Y(dipA) + 15}" text-anchor="middle" font-size="9" fill="var(--sub)">午后低谷 ${toHM(dipT * 60)}</text>`;
  if (minA < 101)
    s += `<circle cx="${X(minT)}" cy="${Y(minA)}" r="3.5" fill="var(--green)"/>
          <text x="${X(minT)}" y="${Y(minA) - 8}" text-anchor="middle" font-size="9" fill="var(--sub)">夜间最低 ${toHM(minT * 60)}</text>`;
  if (tSleep !== null && tSleep <= 1440)
    s += `<line x1="${X(tSleep / 60)}" y1="${T}" x2="${X(tSleep / 60)}" y2="${H - B}" stroke="var(--blue)" stroke-dasharray="4 3" opacity="0.6"/>
          <text x="${X(tSleep / 60)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="var(--blue)">${toHM(tSleep)} 可入睡</text>`;
  for (let g = 0; g < 24; g += 4)
    s += `<text x="${X(g)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--sub)">${g}时</text>`;
  s += `<text x="${L - 5}" y="${T + 10}" text-anchor="end" font-size="10" fill="var(--sub)">100</text>
        <text x="${L - 5}" y="${H - B}" text-anchor="end" font-size="10" fill="var(--sub)">0</text>`;
  $("chartAlert").innerHTML = s;
  $("stDip").textContent = toHM(dipT * 60) + "（清醒度 " + Math.round(dipA) + "）";
  $("stNight").textContent = toHM(minT * 60) + "（清醒度 " + Math.round(minA) + "）";
}

// ==================== 基因报告导入（23andMe / 微基因，纯本地解析） ====================
const GENO_LOCI = [
  { rsid: "rs762551",  gene: "CYP1A2",  allele: "A", key: "cyp",   map: { 2: "AA", 1: "AC", 0: "CC" },
    pheno: g => ({ AA: "快代谢 t½≈3.2h", AC: "中代谢 t½≈4.5h", CC: "慢代谢 t½≈7.5h" }[g]) },
  { rsid: "rs5751876", gene: "ADORA2A", allele: "T", key: "ador",  map: { 2: "TT", 1: "CT", 0: "CC" },
    pheno: g => ({ TT: "高敏感（阈值 1.3）", CT: "中等（阈值 1.0）", CC: "钝感（阈值 0.8）" }[g]) },
  { rsid: "rs4410790", gene: "AHR",     allele: "G", key: "ahr",   map: { 2: "GG", 1: "GT", 0: "TT" },
    pheno: g => ({ GG: "诱导强 · 清除偏快", GT: "标准", TT: "诱导弱 · 清除偏慢 10%" }[g]) },
  { rsid: "rs1481012", gene: "ABCG2",   allele: "A", key: "abcg2", map: { 2: "AA", 1: "AG", 0: "GG" },
    pheno: g => ({ AA: "外排快 · 清除偏快 5%", AG: "标准", GG: "外排慢 · 清除偏慢 5%" }[g]) },
  { rsid: "rs7221412", gene: "PER1",    allele: "A", key: "per1",  map: { 2: "AA", 1: "AG", 0: "GG" },
    pheno: g => ({ AA: "偏晨型 · DLMO 提前 1h", AG: "标准节律", GG: "偏夜型 · DLMO 推迟 1h" }[g]) }
];

function parseGeneText(text) {
  const byRs = Object.fromEntries(GENO_LOCI.map(l => [l.rsid, l]));
  const found = {}, missing = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith("#")) continue;
    const p = raw.trim().split(/\s+/);
    if (p.length < 4) continue;
    const locus = byRs[p[0]];
    if (!locus || found[locus.key]) continue;
    const gt = p[3].toUpperCase();
    if (gt.length < 2 || gt.includes("-") || gt.includes("N")) { missing.push(locus.gene + "（无检出）"); continue; }
    const count = Math.min(2, (gt.split("").filter(c => c === locus.allele).length));
    const g = locus.map[count];
    if (g) found[locus.key] = { g, rsid: locus.rsid, gene: locus.gene, pheno: locus.pheno(g) };
  }
  for (const l of GENO_LOCI) if (!found[l.key] && !missing.some(m => m.startsWith(l.gene))) missing.push(l.gene);
  return { found, missing };
}
function applyGeno(found) {
  if (found.cyp)   $("cyp").value = found.cyp.g;
  if (found.ador)  $("ador").value = found.ador.g;
  if (found.ahr)   $("ahr").value = found.ahr.g;
  if (found.abcg2) $("abcg2").value = found.abcg2.g;
  dlmoOff = found.per1 ? ({ AA: -60, AG: 0, GG: 60 }[found.per1.g] ?? 0) : 0;
}
function showGenoStatus(found, missing, fromCache) {
  const rows = Object.values(found)
    .map(v => `<div>✅ <b>${v.gene}</b> ${v.rsid} = <b>${v.g}</b> · ${v.pheno}</div>`).join("");
  const miss = missing.length
    ? `<div style="color:var(--warn)">⚠️ 未检出：${missing.join("、")}（保持默认档位）</div>` : "";
  $("geneStatus").innerHTML = (fromCache ? "🧬 已恢复上次导入的基因报告" : "🧬 导入成功（文件仅在本地解析，未上传）")
    + rows + miss;
}
$("geneFile").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  file.text().then(text => {
    const { found, missing } = parseGeneText(text);
    if (Object.keys(found).length === 0) {
      $("geneStatus").innerHTML = "⚠️ 未找到任何目标位点——请确认是 23andMe / 微基因 原始数据 txt";
      return;
    }
    applyGeno(found);
    lsSet(LS.geno, found);
    showGenoStatus(found, missing, false);
    calc();
  });
  e.target.value = "";
});
(function restoreGeno() {
  const saved = lsGet(LS.geno, null);
  if (saved && saved.cyp) { applyGeno(saved); showGenoStatus(saved, [], true); }
})();

// ==================== 选项卡 ====================
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
  ["today", "stats", "data"].forEach(t => { $("tab-" + t).hidden = t !== b.dataset.tab; });
  lsSet(LS.tab, b.dataset.tab);
  if (b.dataset.tab === "stats") renderStats();
  if (b.dataset.tab === "data") renderUbevs();
}));
(function restoreTab() {
  const t = lsGet(LS.tab, "today");
  if (t !== "today") {
    const btn = document.querySelector(`.tabs button[data-tab="${t}"]`);
    if (btn) btn.click();
  }
})();

// ==================== 历史：热力图 + 概览 ====================
let hmRange = 12;
function mgLevel(mg) {
  if (!mg || mg <= 0) return 0;
  if (mg < 50) return 1;
  if (mg < 150) return 2;
  if (mg < 300) return 3;
  return 4;
}
function renderHeatmap() {
  const hm = $("heatmap");
  hm.innerHTML = "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // 起始：n 周前那一周的周一
  const start = new Date(today);
  start.setDate(start.getDate() - (hmRange - 1) * 7 - ((start.getDay() + 6) % 7));
  const tKey = todayKey();
  let lastMonth = -1;
  for (let w = 0; w < hmRange; w++) {
    const col = document.createElement("div");
    col.className = "hm-col";
    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(start.getDate() + w * 7 + d);
      const cell = document.createElement("div");
      cell.className = "hm-cell";
      if (date > today) {
        cell.classList.add("future");
      } else {
        const k = dayKey(date);
        const rec = HIST[k];
        const lv = rec ? mgLevel(rec.mg) : 0;
        if (lv) cell.classList.add("l" + lv);
        if (k === tKey) cell.classList.add("today");
        const slp = SLEEP[k];
        let tip = `${k.slice(5)} · ` + (rec ? `${rec.mg}mg` : "无记录");
        if (rec && rec.pred !== null && rec.pred !== undefined) tip += ` · 预测入睡 ${toHM(rec.pred)}`;
        if (slp) tip += ` · 实际 ${slp.bed}睡 ${slp.wake}起`;
        cell.title = tip;
      }
      col.appendChild(cell);
    }
    hm.appendChild(col);
    lastMonth = start.getMonth();
  }
}
$("hmSeg").querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
  $("hmSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  hmRange = +b.dataset.range;
  renderHeatmap();
}));

function renderStats() {
  const keys = Object.keys(HIST).filter(k => HIST[k] && HIST[k].mg > 0);
  $("sumDays").textContent = keys.length + " 天";
  // 连续记录：从今天/昨天往前数
  let streak = 0;
  const cur = new Date(); cur.setHours(0, 0, 0, 0);
  if (!HIST[todayKey()]) cur.setDate(cur.getDate() - 1);
  while (HIST[dayKey(cur)] && HIST[dayKey(cur)].mg > 0) { streak++; cur.setDate(cur.getDate() - 1); }
  $("sumStreak").textContent = streak + " 天";
  $("sumMg").textContent = keys.length ? Math.round(keys.reduce((s, k) => s + HIST[k].mg, 0) / keys.length) + " mg/天" : "—";
  const preds = keys.map(k => HIST[k].pred).filter(v => v !== null && v !== undefined);
  $("sumPred").textContent = preds.length ? toHM(preds.reduce((a, b) => a + b, 0) / preds.length) : "—";
  const sk = Object.keys(SLEEP);
  const bedMins = sk.map(k => { let m = toMin(SLEEP[k].bed); return m < 720 ? m + 1440 : m; });
  $("sumActual").textContent = sk.length ? toHM(bedMins.reduce((a, b) => a + b, 0) / bedMins.length) + `（${sk.length} 晚）` : "—";
  $("sumWake").textContent = sk.length ? toHM(sk.reduce((s, k) => s + toMin(SLEEP[k].wake), 0) / sk.length) : "—";
  renderHeatmap();
}

// ==================== 睡眠反馈 → t½ 个人化校准 ====================
$("fbSubmit").addEventListener("click", () => {
  const dateStr = $("fbDate").value;
  const bedStr = $("fbBed").value, wakeStr = $("fbWake").value;
  const out = $("fbResult");
  if (!dateStr || !bedStr || !wakeStr) { out.textContent = "⚠️ 请填完整日期和睡/起时间。"; return; }

  SLEEP[dateStr] = { bed: bedStr, wake: wakeStr };
  lsSet(LS.sleep, SLEEP);

  const rec = HIST[dateStr];
  if (!rec || !rec.doses || !rec.doses.length) {
    out.innerHTML = `✅ 已记录 ${dateStr} 的睡眠。<br>⚠️ 那天没有咖啡因摄入记录，无法用于校准 t½（已保留睡眠数据）。`;
    renderStats(); return;
  }
  // 用基因基础值（不含个人修正）重算那晚预测
  const { thr } = getParams();
  const base = baseTh();
  const pred = computePrediction(rec.doses, base, thr, 0);
  if (pred.tSleep === null) {
    out.innerHTML = `✅ 已记录睡眠。<br>⚠️ 那天模型 24h 内未达入睡条件，跳过本次校准。`;
    renderStats(); return;
  }
  let actual = toMin(bedStr);
  if (actual < 12 * 60) actual += 1440;   // 凌晨入睡记到前一晚
  const residMin = actual - pred.tSleep;

  if (pred.tMel > pred.tC) {
    out.innerHTML = `✅ 已记录睡眠。那晚预测 ${toHM(pred.tSleep)} / 实际 ${bedStr}。<br>
      ℹ️ 那晚的限制条件是<b>褪黑素节律</b>而非咖啡因清除，残差 ${residMin >= 0 ? "+" : ""}${Math.round(residMin)}min 不计入 t½ 校准（避免污染代谢估计）。`;
    renderStats(); return;
  }
  // 数值微分：tClear 对 th 的斜率（分钟/小时）
  const t1 = tClear(rec.doses, base, thr), t2 = tClear(rec.doses, base + 0.5, thr);
  const slope = (t2 - t1) / 0.5;   // min per hour
  if (!slope || slope < 1) {
    out.innerHTML = `✅ 已记录睡眠。<br>⚠️ 灵敏度不足，跳过本次校准。`;
    renderStats(); return;
  }
  const dTh = clamp(residMin / slope, -1.5, 1.5);
  const before = CALIB.offset || 0;
  CALIB.offset = clamp(0.6 * before + 0.4 * dTh, -2, 2);
  CALIB.nights = (CALIB.nights || 0) + 1;
  CALIB.log = (CALIB.log || []).concat([{ date: dateStr, pred: Math.round(pred.tSleep), actual: Math.round(actual), dTh: +dTh.toFixed(2), offset: +CALIB.offset.toFixed(2) }]).slice(-30);
  lsSet(LS.calib, CALIB);

  out.innerHTML = `✅ ${dateStr}：预测入睡 ${toHM(pred.tSleep)} / 实际 ${bedStr}（残差 ${residMin >= 0 ? "+" : ""}${Math.round(residMin)}min）<br>
    → 当晚折算 t½ 偏移 ${dTh >= 0 ? "+" : ""}${dTh.toFixed(2)}h，滑动平均后个人修正 <b>${CALIB.offset >= 0 ? "+" : ""}${CALIB.offset.toFixed(2)}h</b>（共 ${CALIB.nights} 晚）。预测已更新。`;
  calc();
  renderStats();
});

// ==================== 自定义饮品 ====================
function renderUbevs() {
  const box = $("ubList");
  if (!UBEVS.length) { box.innerHTML = `<div class="note" style="margin-top:4px;">还没有自定义饮品。</div>`; return; }
  box.innerHTML = "";
  UBEVS.forEach(b => {
    const row = document.createElement("div");
    row.className = "ubev-row";
    row.innerHTML = `<span class="name">${b.drink}${b.spec ? "（" + b.spec + "）" : ""}</span>
      <span class="mg">${b.mg}mg · ${b.category}</span>
      <button class="del" data-k="${b.k}" title="删除">×</button>`;
    box.appendChild(row);
  });
  box.querySelectorAll(".del").forEach(el => el.addEventListener("click", () => {
    UBEVS = UBEVS.filter(b => b.k !== el.dataset.k);
    lsSet(LS.custom, UBEVS);
    // 如果今日剂量引用了被删的饮品，回落到第一个
    const list = allBevs();
    state.doses.forEach(d => { if (!list.find(b => b.k === d.bev)) d.bev = list[0].k; });
    save(); renderUbevs(); renderDoses(); calc();
  }));
}
$("ubAdd").addEventListener("click", () => {
  const name = $("ubName").value.trim();
  const mg = +$("ubMg").value;
  if (!name) { $("ubName").focus(); return; }
  if (!(mg >= 0 && mg <= 600)) { $("ubMg").focus(); return; }
  UBEVS.push({
    k: "u" + Date.now().toString(36),
    brand: "自定义", category: $("ubType").value,
    drink: name, spec: $("ubSpec").value.trim(), mg: Math.round(mg)
  });
  lsSet(LS.custom, UBEVS);
  $("ubName").value = ""; $("ubMg").value = ""; $("ubSpec").value = "";
  renderUbevs(); renderDoses(); calc();
});

// ==================== 导出 / 导入 ====================
$("expJson").addEventListener("click", () => {
  const backup = {
    app: "caffnap", version: "1.2", exportedAt: new Date().toISOString(),
    history: HIST, sleep: SLEEP, calib: CALIB, custom: UBEVS,
    geno: lsGet(LS.geno, null), today: state
  };
  download(`caffnap-backup-${todayKey()}.json`,
    new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
});
$("expCsv").addEventListener("click", () => {
  const rows = [["date", "total_mg", "predicted_bed", "actual_bed", "wake", "doses"]];
  Object.keys(HIST).sort().forEach(k => {
    const h = HIST[k], s = SLEEP[k] || {};
    const det = (h.doses || []).map(d => {
      const b = allBevs().find(x => x.k === d.bev);
      return `${d.time} ${b ? (b.drink || b.label) : d.bev} x${d.cups}`;
    }).join(" | ");
    rows.push([k, h.mg, h.pred != null ? toHM(h.pred) : "", s.bed || "", s.wake || "", det]);
  });
  const csv = "﻿" + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  download(`caffnap-history-${todayKey()}.csv`, new Blob([csv], { type: "text/csv" }));
});
$("impFile").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  file.text().then(text => {
    let data;
    try { data = JSON.parse(text); } catch (err) {
      $("impResult").textContent = "⚠️ 文件不是有效的 JSON。"; return;
    }
    if (!data || data.app !== "caffnap") {
      $("impResult").textContent = "⚠️ 不是 CaffNap 备份文件。"; return;
    }
    let added = 0, skipped = 0;
    Object.entries(data.history || {}).forEach(([k, v]) => {
      if (HIST[k]) skipped++; else { HIST[k] = v; added++; }
    });
    let sAdded = 0;
    Object.entries(data.sleep || {}).forEach(([k, v]) => {
      if (!SLEEP[k]) { SLEEP[k] = v; sAdded++; }
    });
    (data.custom || []).forEach(b => {
      if (b && b.k && !UBEVS.find(x => x.k === b.k) && !DB_ITEMS.find(x => x.k === b.k)) UBEVS.push(b);
    });
    if (data.calib && (data.calib.nights || 0) > (CALIB.nights || 0)) CALIB = data.calib;
    if (data.geno && !lsGet(LS.geno, null)) { lsSet(LS.geno, data.geno); applyGeno(data.geno); showGenoStatus(data.geno, [], true); }
    lsSet(LS.hist, HIST); lsSet(LS.sleep, SLEEP); lsSet(LS.custom, UBEVS); lsSet(LS.calib, CALIB);
    $("impResult").innerHTML = `✅ 导入完成：新增 ${added} 天摄入记录${skipped ? `（跳过 ${skipped} 天已存在）` : ""}、${sAdded} 晚睡眠记录、${(data.custom || []).length} 条自定义饮品（去重后）。`;
    renderDoses(); calc(); renderUbevs();
  });
  e.target.value = "";
});

// ==================== 分享吐槽卡片（Canvas → PNG） ====================
// 项目二维码：离线生成后内嵌（零依赖，file:// 可用），扫码跳转线上版
const QR_B64 = "iVBORw0KGgoAAAANSUhEUgAAAQgAAAEIAQMAAACZOPi8AAAABlBMVEUaGi7///9tKekOAAABDUlEQVR42u2ZSw4DMQxCUe9/Z7pIjJ1W1ez74pFG88kKEbCJ/FS6K9grtGo9rjf3V7/0VP+0QgVaI+HjKxGPxY4Qo9/ReCwsNj0uHo6E+EAJqx+n/IL1I/5yXFh/OUih0tMUcb80Q1SiWgpC5MdWUsd247tEfji3IOJ0rFB+bF093HZxBolHd2Eq480fYj+2u9PYLHqes4fLpvkITkw9Lc1Ip1qIMPt1RThKWWsTEft1d+oRpwlfiPPLwqHhGRqC5MdMPHp2kaD7Jc/75qm22Pn2w1dKV7j5x8jHFPcl5+tzotstCT0//aIMGI+Rj1WUCj9v8NAOUfMxHQeXExjB83VnapG488s9378rftYbMoogzGu5/bAAAAAASUVORK5CYII=";
const qrImg = new Image();
const qrReady = new Promise(res => { qrImg.onload = qrImg.onerror = () => res(); });
qrImg.src = "data:image/png;base64," + QR_B64;

$("shareCardBtn").addEventListener("click", () => {
  if (!lastResult || lastResult.tSleep === null) {
    alert("还没有有效预测——先添加一杯咖啡吧 ☕"); return;
  }
  qrReady.then(() => {
  const cv = $("shareCanvas"), ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  // 背景
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#1a1a2e"); g.addColorStop(1, "#2b1a3a");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // 装饰圆
  ctx.fillStyle = "rgba(212,105,30,0.15)";
  ctx.beginPath(); ctx.arc(W - 120, 150, 220, 0, 7); ctx.fill();
  ctx.fillStyle = "rgba(139,92,246,0.12)";
  ctx.beginPath(); ctx.arc(90, H - 180, 260, 0, 7); ctx.fill();

  const center = W / 2;
  ctx.textAlign = "center";
  // 品牌
  ctx.fillStyle = "#eceaf2";
  ctx.font = "700 52px -apple-system, 'PingFang SC', sans-serif";
  ctx.fillText("Caff", center - 62, 130);
  ctx.fillStyle = "#e08a4e";
  ctx.fillText("Nap", center + 62, 130);
  ctx.fillStyle = "#9aa0ab";
  ctx.font = "26px -apple-system, 'PingFang SC', sans-serif";
  ctx.fillText("咖啡因宵禁 & 入睡预测", center, 178);

  // 主文案
  ctx.fillStyle = "#9aa0ab"; ctx.font = "34px -apple-system, 'PingFang SC', sans-serif";
  ctx.fillText("今晚预计", center, 420);
  ctx.fillStyle = "#ef6a86"; ctx.font = "700 150px -apple-system, 'PingFang SC', sans-serif";
  const tS = lastResult.tSleep;
  ctx.fillText(toHM(tS), center, 570);
  ctx.fillStyle = "#eceaf2"; ctx.font = "40px -apple-system, 'PingFang SC', sans-serif";
  ctx.fillText("才能睡着" + (tS >= 1440 ? "（次日）" : ""), center, 650);

  // 数据行
  ctx.font = "28px -apple-system, 'PingFang SC', sans-serif";
  ctx.fillStyle = "#c9c6d4";
  const rows = [
    `今日咖啡因 ${Math.round(lastResult.totalMg)} mg · ${lastResult.cups} 杯`,
    `估算半衰期 ${lastResult.th.toFixed(1)} h · 目标入睡 ${toHM(lastResult.targetBed)}`,
    `宵禁时刻 ${toHM(lastResult.lastCallMin)}（最后一杯最晚）`
  ];
  rows.forEach((r, i) => ctx.fillText(r, center, 790 + i * 52));

  // 风险徽章
  const badgeMap = { "高风险": "#ef6a86", "中风险": "#e0a63e", "低风险": "#4cc38a" };
  const bColor = badgeMap[lastResult.badge.slice(0, 3)] || "#9aa0ab";
  ctx.font = "600 26px -apple-system, 'PingFang SC', sans-serif";
  const bw = ctx.measureText(lastResult.badge).width + 44;
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.strokeStyle = bColor; ctx.lineWidth = 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(center - bw / 2, 990, bw, 48, 24);
  else ctx.rect(center - bw / 2, 990, bw, 48);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = bColor;
  ctx.fillText(lastResult.badge, center, 1023);

  // 底部
  ctx.fillStyle = "#6b7280"; ctx.font = "22px -apple-system, 'PingFang SC', sans-serif";
  ctx.fillText(`${todayKey()} · 数据仅存本机 · 不构成医疗建议`, center - 60, H - 46);
  // 右下角二维码（扫码跳转线上版）
  if (qrImg.complete && qrImg.naturalWidth > 0) {
    const qx = W - 176, qy = H - 206, qs = 150;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(qx, qy, qs, qs, 12); else ctx.rect(qx, qy, qs, qs);
    ctx.fill();
    ctx.drawImage(qrImg, qx + 10, qy + 10, qs - 20, qs - 20);
    ctx.fillStyle = "#9aa0ab"; ctx.font = "18px -apple-system, 'PingFang SC', sans-serif";
    ctx.fillText("扫码体验", qx + qs / 2, qy + qs + 24);
  }

  cv.toBlob(blob => {
    const file = new File([blob], "caffnap.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: "CaffNap 入睡预测" }).catch(() => {});
    } else {
      download(`caffnap-${todayKey()}.png`, blob);
    }
  }, "image/png");
  });
});

// ==================== 宵禁日历事件（.ics，宵禁前 30 分钟提醒） ====================
$("icsBtn").addEventListener("click", () => {
  if (!lastResult) return;
  const lcMin = lastResult.lastCallMin;
  const now = new Date();
  const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  dt.setMinutes(lcMin);
  if (dt <= now) dt.setDate(dt.getDate() + 1);   // 今天已过 → 明天
  const end = new Date(dt.getTime() + 30 * 60000);
  const fmt = d => {
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
  };
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CaffNap//Curfew//CN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:caffnap-${fmt(dt)}@caffnap`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${fmt(dt)}`,
    `DTEND:${fmt(end)}`,
    "SUMMARY:☕ 咖啡因宵禁 · 最后一杯",
    `DESCRIPTION:想在 ${toHM(lastResult.targetBed)} 入睡，这是最后一杯的最晚时间（约 ${Math.round(lastResult.selMg)}mg）。由 CaffNap 生成。`,
    "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY",
    "DESCRIPTION:☕ 咖啡因宵禁还有 30 分钟，想喝就现在",
    "END:VALARM", "END:VEVENT", "END:VCALENDAR"
  ].join("\r\n");
  download("caffnap-curfew.ics", new Blob([ics], { type: "text/calendar" }));
});

// ==================== 事件 & 初始化 ====================
["cyp", "ador", "ahr", "abcg2", "smoke", "oc"].forEach(id => {
  $(id).addEventListener("input", () => { lsSet(LS.day, state); calc(); });
});
["napOn", "napT", "napD", "wakeT", "targetBed"].forEach(id => {
  // 恢复持久化的小睡/起床/目标设置
  if (state[id] !== undefined && state[id] !== null) {
    if (id === "napOn") $(id).checked = !!state[id]; else $(id).value = state[id];
  }
  $(id).addEventListener("input", () => {
    if (id === "napOn") state[id] = $(id).checked; else state[id] = $(id).value;
    save(); calc();
  });
});

// 起床时间默认取睡眠反馈的平均值（≥3 晚时）
(function wakeDefault() {
  const sk = Object.keys(SLEEP);
  if (sk.length >= 3 && !lsGet(LS.day, {}).wakeT) {
    const avg = sk.reduce((s, k) => s + toMin(SLEEP[k].wake), 0) / sk.length;
    $("wakeT").value = toHM(avg); state.wakeT = $("wakeT").value;
  }
})();

// 睡眠反馈默认日期 = 昨天
(function fbDefault() {
  const y = new Date(); y.setDate(y.getDate() - 1);
  $("fbDate").value = dayKey(y);
  $("fbDate").max = todayKey();
})();

// 默认演示数据（首次打开）
if (state.doses.length === 0 && !localStorage.getItem(LS.day)) {
  const demoBev = DB_ITEMS.length ? "b000" : "americano";
  state.doses = [
    { bev: demoBev, cups: 1, time: "08:30", day: new Date().toDateString() },
    { bev: demoBev, cups: 1, time: "14:00", day: new Date().toDateString() }
  ];
}
renderDoses();
calc();
renderUbevs();

// 数据库状态提示
(function dbBadge() {
  const el = $("doseList");
  if (!DB_ITEMS.length && el) {
    const tip = document.createElement("div");
    tip.style.cssText = "font-size:12px;color:var(--warn);margin-bottom:8px";
    tip.textContent = "⚠️ 品牌数据库（db.js）未加载，当前使用通用估算值。请确认 db.js 与 index.html 同目录。";
    el.parentNode.insertBefore(tip, el);
  }
})();
