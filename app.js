(function () {
'use strict';
var CFG = window.LP_CONFIG, SBI = window.SBI;
var $ = function (id) { return document.getElementById(id); };
var STORE = 'lp.v1';
var MON = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
var MONN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function p2(n) { return (n < 10 ? '0' : '') + n; }
function leap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function todayIso() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
function addYears(iso, n) {
  var y = +iso.slice(0, 4) + n, m = iso.slice(5, 7), d = iso.slice(8, 10);
  if (m === '02' && d === '29' && !leap(y)) d = '28';
  return y + '-' + m + '-' + d;
}
function addDays(iso, n) { var t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function fmtD(iso) { return MONN[+iso.slice(5, 7) - 1] + ' ' + (+iso.slice(8, 10)) + ', ' + iso.slice(0, 4); }
function fmtM(iso) { return MONN[+iso.slice(5, 7) - 1] + ' ' + iso.slice(2, 4); }
function inr(n) { return (n < 0 ? '-' : '') + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN'); }
function lakh(n) { return '₹' + (n / 1e5).toFixed(2).replace(/\.?0+$/, '') + ' lakh'; }
function isLT(acq, asof) { return asof >= addYears(acq, 2); }

var RD = SBI.d, RR = SBI.r;
function rateOn(iso) {
  var lo = 0, hi = RD.length - 1, ans = 0;
  while (lo <= hi) { var m = (lo + hi) >> 1; if (RD[m] <= iso) { ans = m; lo = m + 1; } else hi = m - 1; }
  return RR[ans];
}

function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  var rows = [], row = [], cur = '', q = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function pDate(s) {
  if (!s) return null;
  var p = s.trim().split(/[-\/]/);
  if (p.length !== 3) return null;
  var mi = MON.indexOf(p[0].slice(0, 3).toLowerCase());
  if (mi >= 0) return p[2] + '-' + p2(mi + 1) + '-' + p2(+p[1]);
  if (/^\d{4}$/.test(p[0])) return p[0] + '-' + p2(+p[1]) + '-' + p2(+p[2]);
  return null;
}
function num(s) { return parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); }
function clean(s) { return String(s || '').replace(/<[^>]*>/g, '').trim().toLowerCase(); }

function parseLotsText(text) {
  var rows = parseCSV(text), hi = -1, i;
  for (i = 0; i < rows.length; i++) {
    if (rows[i].some(function (c) { return clean(c) === 'date acquired'; })) { hi = i; break; }
  }
  if (hi < 0) throw new Error('Could not find a Date acquired column.');
  var h = {}, hdr = rows[hi].map(clean), sold = -1;
  hdr.forEach(function (n, k) { if (!(n in h)) h[n] = k; if (n.indexOf('sold') >= 0 && sold < 0) sold = k; });
  var cur = null;
  rows.forEach(function (r) { var m = /displayed in (\w+)/i.exec(r[0] || ''); if (m) cur = m[1].toUpperCase(); });
  if (h['quantity'] == null || h['cost basis'] == null) throw new Error('Missing Quantity or Cost basis column.');
  var out = [];
  for (i = hi + 1; i < rows.length; i++) {
    var r = rows[i], d = pDate(r[h['date acquired']]), q = num(r[h['quantity']]), c = num(r[h['cost basis']]);
    if (!d || !(q > 0) || !isFinite(c)) continue;
    if (sold >= 0) {
      var sd = pDate(r[sold]), pr = num(r[h['proceeds']]);
      if (sd && isFinite(pr)) out.push({ acq: d, sold: sd, qty: q, proceeds: pr, cost: c });
    } else out.push({ date: d, qty: q, cost: c });
  }
  return { kind: sold >= 0 ? 'closed' : 'open', currency: cur, rows: out };
}

function plan(open, o) {
  var G = o.price * o.fx;
  var L = open.map(function (l, i) {
    var gainU = G - (l.cost / l.qty) * rateOn(l.date), lt = isLT(l.date, o.asof);
    var taxU = Math.max(gainU, 0) * (lt ? o.lt : o.st);
    return { i: i, date: l.date, qty: l.qty, lt: lt, gainU: gainU, taxU: taxU, take: 0, ok: o.mode === 'house' ? lt : true };
  });
  var pool = L.filter(function (x) { return x.ok; });
  if (o.mode === 'house') pool.sort(function (a, b) { return b.gainU - a.gainU || a.i - b.i; });
  else pool.sort(function (a, b) { return a.taxU - b.taxU || a.i - b.i; });
  var got = 0, units = 0, tax = 0, gain = 0, st = 0, ltu = 0;
  pool.forEach(function (x) {
    var v = o.mode === 'house' ? G : G - x.taxU, need = o.target - got;
    if (need <= 1e-9) return;
    var k = Math.min(x.qty, need / v);
    x.take = k; got += k * v; units += k; tax += k * x.taxU; gain += k * x.gainU;
    if (x.lt) ltu += k; else st += k;
  });
  var gross = units * G;
  return { G: G, lots: L, pool: pool, units: units, gross: gross, tax: tax, gain: gain, cash: gross - tax, st: st, lt: ltu, short: got + 1 < o.target, got: got };
}

function waitInsight(open, o, base) {
  if (o.mode !== 'expense' || !base) return null;
  var lim = addDays(o.asof, 75), ds = {};
  open.forEach(function (l) { var d = addYears(l.date, 2); if (d > o.asof && d <= lim) ds[d] = 1; });
  var best = null;
  Object.keys(ds).sort().forEach(function (d) {
    var o2 = {}; for (var k in o) o2[k] = o[k]; o2.asof = d;
    var p = plan(open, o2);
    if (!p.short && p.tax < base.tax - 1 && (!best || p.tax < best.p.tax - 1)) best = { d: d, p: p };
  });
  return best;
}

function realized(closed, o) {
  var d = o.asof, fy = (+d.slice(5, 7) >= 4 ? d.slice(0, 4) : String(+d.slice(0, 4) - 1)) + '-04-01';
  var lt = 0, st = 0, n = 0;
  closed.forEach(function (c) {
    if (c.sold < fy || c.sold > d) return;
    var g = c.proceeds * rateOn(c.sold) - c.cost * rateOn(c.acq);
    if (isLT(c.acq, c.sold)) lt += g; else st += g;
    n++;
  });
  var stTax = Math.max(st, 0) * o.st, ltNet = Math.max(lt + Math.min(st, 0), 0), ltTax = ltNet * o.lt;
  return { fy: fy, lt: lt, st: st, n: n, tax: stTax + ltTax, taxable: Math.max(st, 0) + ltNet };
}

window.LPCore = { parseCSV: parseCSV, parseLotsText: parseLotsText, plan: plan, rateOn: rateOn, isLT: isLT, realized: realized, waitInsight: waitInsight };

var DEF = { price: '', fx: '', asof: '', slab: 30, sur: 10, inc: '', mode: 'expense', target: 8 };
var state = { open: [], closed: [], openAt: null, closedAt: null, s: {} };
var key = null, saveT = null;

function enc(s) { return new TextEncoder().encode(s); }
function hex2(h) { var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
function hex(a) { return Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }
function b64(a) { var s = ''; a = new Uint8Array(a); for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
function unb64(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }

async function derive(pin) {
  var k = await crypto.subtle.importKey('raw', enc(pin), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hex2(CFG.salt), iterations: CFG.iter }, k, 512));
}
function save() {
  if (!key) return;
  clearTimeout(saveT);
  saveT = setTimeout(async function () {
    try {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc(JSON.stringify(state)));
      localStorage.setItem(STORE, b64(iv) + '.' + b64(ct));
    } catch (e) {}
  }, 200);
}
async function load() {
  try {
    var v = localStorage.getItem(STORE);
    if (!v) return;
    var p = v.split('.'), pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(p[0]) }, key, unb64(p[1]));
    var s = JSON.parse(new TextDecoder().decode(pt));
    state.open = s.open || []; state.closed = s.closed || []; state.openAt = s.openAt || null; state.closedAt = s.closedAt || null; state.s = s.s || {};
  } catch (e) {}
}

function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
function S(k) { var v = state.s[k]; return v == null || v === '' ? DEF[k] : v; }
function setS(k, v) { state.s[k] = v; save(); }
function rates() {
  var slab = +S('slab') / 100, sur = +S('sur') / 100;
  return { st: slab * (1 + sur) * 1.04, lt: 0.125 * (1 + Math.min(sur, 0.15)) * 1.04 };
}

function render() {
  var r = rates(), mode = S('mode'), tgtL = +S('target'), price = +S('price'), fx = +S('fx') || RR[RR.length - 1], asof = S('asof') || todayIso();
  $('rst').textContent = (r.st * 100).toFixed(2) + '%'; $('rlt').textContent = (r.lt * 100).toFixed(2) + '%';
  $('tv').textContent = lakh(tgtL * 1e5); $('target').value = tgtL;
  $('pvv').textContent = price > 0 ? '$' + price.toFixed(2) : '-';
  if (price > 0) $('pslide').value = Math.min(400, Math.max(150, Math.round(price)));
  $('m-exp').className = mode === 'expense' ? 'on' : ''; $('m-exp').setAttribute('aria-checked', mode === 'expense');
  $('m-house').className = mode === 'house' ? 'on' : ''; $('m-house').setAttribute('aria-checked', mode === 'house');
  $('modehelp').textContent = mode === 'house'
    ? 'Amount is the gross sale value invested in the house. Only long-term lots are used, biggest gain first. Tax shown is what you would owe if the exemption does not apply.'
    : 'Amount is the cash you want in hand after tax. Lots with the least tax per unit are sold first.';
  var st = [];
  st.push(state.open.length ? 'Open lots: ' + state.open.length + ' lots, ' + state.open.reduce(function (a, l) { return a + l.qty; }, 0).toFixed(2) + ' units' + (state.openAt ? ' (imported ' + fmtD(state.openAt) + ')' : '') : 'Open lots: none imported');
  st.push(state.closed.length ? 'Closed lots: ' + state.closed.length + ' rows' + (state.closedAt ? ' (imported ' + fmtD(state.closedAt) + ')' : '') : 'Closed lots: none imported');
  $('status').textContent = st.join('  |  ');

  var tb = $('sell').tBodies[0], bars = $('bars'), notes = $('notes');
  tb.textContent = ''; bars.textContent = ''; notes.textContent = '';
  var ready = state.open.length && price > 0;
  ['v1', 'v2', 'v3', 'v4'].forEach(function (id) { $(id).textContent = '-'; });
  $('warn').textContent = ''; $('bs').style.width = '0'; $('bl').style.width = '0'; $('mixtxt').textContent = '';
  if (!ready) {
    $('warn').textContent = state.open.length ? 'Enter the AMZN price to see the plan.' : 'Import your open lots CSV to see the plan.';
    return;
  }
  var o = { price: price, fx: fx, asof: asof, mode: mode, target: tgtL * 1e5, st: r.st, lt: r.lt };
  var p = plan(state.open, o);
  $('l1').textContent = 'Units to sell'; $('l2').textContent = 'Gross sale';
  if (mode === 'house') { $('l3').textContent = 'Tax if no exemption'; $('l4').textContent = 'Tax if exemption holds'; }
  else { $('l3').textContent = 'Tax'; $('l4').textContent = 'Cash after tax'; }
  $('v1').textContent = p.units.toFixed(2); $('v2').textContent = inr(p.gross); $('v3').textContent = inr(p.tax);
  $('v4').textContent = mode === 'house' ? inr(0) : inr(p.cash);
  if (p.short) $('warn').textContent = 'Eligible lots raise only ' + lakh(p.got) + (mode === 'house' ? ' gross' : ' after tax') + ' at this price and date.';
  var tot = p.st + p.lt;
  if (tot > 0) { $('bs').style.width = (p.st / tot * 100) + '%'; $('bl').style.width = (p.lt / tot * 100) + '%'; }
  $('mixtxt').textContent = p.st.toFixed(1) + ' short-term units, ' + p.lt.toFixed(1) + ' long-term units';

  p.pool.filter(function (x) { return x.take > 0.0005; }).forEach(function (x) {
    var tr = el('tr');
    [fmtM(x.date), x.lt ? 'LT' : 'ST', x.take.toFixed(3), inr(x.take * p.G), inr(x.take * x.gainU), inr(x.take * x.taxU)].forEach(function (t) { tr.appendChild(el('td', null, t)); });
    tb.appendChild(tr);
  });
  var tr = el('tr'); tr.style.fontWeight = '500';
  ['Total', '', p.units.toFixed(3), inr(p.gross), inr(p.gain), inr(p.tax)].forEach(function (t) { tr.appendChild(el('td', null, t)); });
  tb.appendChild(tr);

  var maxT = Math.max.apply(null, p.lots.map(function (x) { return x.taxU; }).concat([1]));
  var ord = p.lots.slice().sort(function (a, b) { return (b.ok - a.ok) || (b.take > 0.0005) - (a.take > 0.0005) || a.taxU - b.taxU || a.i - b.i; });
  ord.forEach(function (x) {
    var b = el('div', 'bar' + (x.take > 0.0005 ? '' : ' off')), t = el('div', 't'), l = el('span'), rt = el('span');
    var bold = el('b', null, fmtM(x.date) + ' ' + (x.lt ? 'LT' : 'ST')); l.appendChild(bold); l.appendChild(document.createTextNode(' ' + x.qty.toFixed(1) + ' units' + (x.ok ? '' : ' (not eligible)')));
    rt.textContent = (x.take > 0.0005 ? 'sell ' + x.take.toFixed(1) + '  ' : '') + inr(x.taxU) + '/unit';
    t.appendChild(l); t.appendChild(rt);
    var trk = el('div', 'trk'), fl = el('div', 'fl'); fl.style.width = (x.taxU / maxT * 100) + '%'; fl.style.background = x.lt ? 'var(--lt)' : 'var(--st)';
    trk.appendChild(fl); b.appendChild(t); b.appendChild(trk); bars.appendChild(b);
  });

  function note(t) { notes.appendChild(el('div', 'note', t)); }
  var zero = p.pool.filter(function (x) { return x.take > 0.0005 && x.taxU === 0; }).length;
  if (zero) note(zero + ' of the lots sold are at or below cost, so they pay no tax.');
  var w = waitInsight(state.open, o, p);
  if (w) note('If you can wait until ' + fmtD(w.d) + ', more lots turn long-term: tax drops to ' + inr(w.p.tax) + ' (saves ' + inr(p.tax - w.p.tax) + ') at the same price.');
  var ra = state.closed.length ? realized(state.closed, o) : null;
  if (ra) {
    note('Realized since ' + fmtD(ra.fy) + ': long-term ' + inr(ra.lt) + ', short-term ' + inr(ra.st) + ' (' + ra.n + ' rows). Estimated tax on these is ' + inr(ra.tax) + '. With this sale the year total is about ' + inr(ra.tax + p.tax) + '; keep advance tax in line (Jun 15, Sep 15, Dec 15, Mar 15).');
  }
  var inc = +S('inc');
  if (inc > 0) {
    var gains = (ra ? ra.taxable : 0) + (mode === 'house' ? 0 : Math.max(p.gain, 0)), tot2 = inc + gains;
    note('Income with these gains is about ' + inr(tot2) + (tot2 < 1e7 ? ', ' + inr(1e7 - tot2) + ' below the ₹1 crore surcharge line.' : ', above the ₹1 crore line where the surcharge rises.'));
  }
}

function bind() {
  function num_(id, k) { $(id).addEventListener('input', function () { setS(k, this.value); render(); }); }
  num_('price', 'price'); num_('fx', 'fx'); num_('asof', 'asof'); num_('inc', 'inc');
  ['slab', 'sur'].forEach(function (k) { $(k).addEventListener('change', function () { setS(k, +this.value); render(); }); });
  $('target').addEventListener('input', function () { setS('target', +this.value); render(); });
  $('pslide').addEventListener('input', function () { setS('price', this.value); $('price').value = this.value; render(); });
  $('m-exp').addEventListener('click', function () { setS('mode', 'expense'); render(); });
  $('m-house').addEventListener('click', function () { setS('mode', 'house'); render(); });
  var tm = null, btn = $('play');
  function stop() { clearInterval(tm); tm = null; btn.textContent = 'Play'; }
  btn.addEventListener('click', function () {
    if (tm) { stop(); return; }
    var sl = $('pslide'); if (+sl.value >= +sl.max) sl.value = sl.min;
    btn.textContent = 'Pause';
    tm = setInterval(function () {
      var v = +sl.value + 1; if (v > +sl.max) { stop(); return; }
      sl.value = v; setS('price', String(v)); $('price').value = v; render();
    }, 110);
  });
  $('importbtn').addEventListener('click', function () { $('files').click(); });
  $('files').addEventListener('change', async function () {
    var msg = $('importmsg'), got = [], files = Array.prototype.slice.call(this.files); msg.textContent = '';
    for (var i = 0; i < files.length; i++) {
      try {
        var res = parseLotsText(await files[i].text());
        if (res.currency && res.currency !== 'USD') throw new Error('is the ' + res.currency + ' export. Use the USD export.');
        if (!res.rows.length) throw new Error('has no lot rows.');
        if (res.kind === 'open') { state.open = res.rows; state.openAt = todayIso(); }
        else { state.closed = res.rows; state.closedAt = todayIso(); }
        got.push(files[i].name + ': ' + res.kind + ' lots (' + res.rows.length + ')');
      } catch (e) { msg.textContent = (msg.textContent ? msg.textContent + ' ' : '') + files[i].name + ' ' + (e.message || 'could not be read.'); }
    }
    this.value = ''; save(); render();
    if (got.length && !msg.textContent) { msg.className = 'small muted'; msg.textContent = 'Imported ' + got.join('; '); } else msg.className = 'small err';
  });
  $('clearbtn').addEventListener('click', function () {
    if (!confirm('Clear all imported lots and saved inputs on this device?')) return;
    state.open = []; state.closed = []; state.openAt = state.closedAt = null; state.s = {};
    try { localStorage.removeItem(STORE); } catch (e) {}
    fillInputs(); render();
  });
  $('lockbtn').addEventListener('click', function () { location.reload(); });
}
function fillInputs() {
  $('price').value = S('price'); $('fx').value = S('fx') || RR[RR.length - 1]; $('asof').value = S('asof') || todayIso();
  $('slab').value = S('slab'); $('sur').value = S('sur'); $('inc').value = S('inc');
}

var fails = 0, lockedUntil = 0;
async function unlock() {
  var msg = $('lockmsg'), pin = $('pin').value.trim();
  if (Date.now() < lockedUntil) { msg.textContent = 'Too many tries. Wait a few seconds.'; return; }
  if (!pin) { msg.textContent = 'Enter your PIN.'; return; }
  $('unlock').disabled = true; msg.textContent = '';
  try {
    var bits = await derive(pin);
    if (hex(bits.slice(0, 32)) !== CFG.verifier) {
      fails++; if (fails >= 5) { lockedUntil = Date.now() + 30000; fails = 0; }
      msg.textContent = 'Wrong PIN.'; $('pin').value = ''; return;
    }
    key = await crypto.subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    await load(); $('pin').value = '';
    $('lock').hidden = true; $('app').hidden = false;
    fillInputs(); bind(); render();
  } catch (e) { msg.textContent = 'This browser cannot unlock the app. Open it over https.'; }
  finally { $('unlock').disabled = false; }
}
$('unlock').addEventListener('click', unlock);
$('pin').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });
})();
