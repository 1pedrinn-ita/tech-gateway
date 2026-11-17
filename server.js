// Ryvo — motor de pagamentos Pix (protótipo) + painel CEO/seller + checkout hospedado. Sem dependências.
// Uso: node server.js  →  http://localhost:3000
// Dados ficam em data/db.json. Senha inicial do CEO: data/ADMIN_LOGIN.txt (ou config.json → admin).
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const ROOT = __dirname, PORT = +process.env.PORT || 3000, HOST = process.env.HOST || '127.0.0.1';
const DATA = path.join(ROOT, 'data'), DBF = path.join(DATA, 'db.json');
const CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (e) { return {}; } })();
const PUBLIC_URL = process.env.PUBLIC_URL || CFG.public_url || `http://localhost:${PORT}`;
const SANDBOX = CFG.sandbox !== false; // permite "simular pagamento" até a liquidação real estar ligada
const TTC = {
  app_id: process.env.TIKTOK_APP_ID || (CFG.tiktok || {}).app_id || '',
  secret: process.env.TIKTOK_SECRET || (CFG.tiktok || {}).secret || '',
  redirect_uri: process.env.TIKTOK_REDIRECT_URI || (CFG.tiktok || {}).redirect_uri || `${PUBLIC_URL}/api/tiktok/callback`,
};
const TT = 'https://business-api.tiktok.com/open_api/v1.3', GRAPH = 'https://graph.facebook.com/v21.0';
const MERCHANT = 'RYVO GROUP', CITY = 'SAO PAULO', USD_BRL = 5.40, SPREAD = .008, DAY = 864e5;

/* ================= utilidades ================= */
const RS = n => Math.round((n + Number.EPSILON) * 100) / 100;
const rnd = a => a[Math.floor(Math.random() * a.length)];
const hex = n => crypto.randomBytes(n).toString('hex');
const sha = v => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const hashPw = (pw, salt = hex(16)) => salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
const checkPw = (pw, h) => { if (!h) return false; const [s, k] = h.split(':'); const a = Buffer.from(k, 'hex'), b = crypto.scryptSync(String(pw), s, 32); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const E = (status, code, message) => Object.assign(new Error(message), { status, code });
const iso = t => t ? new Date(t).toISOString() : null;
const mask = k => { k = String(k); return k.length > 6 ? k.slice(0, 3) + '•••' + k.slice(-3) : k; };
const brl = v => 'R$ ' + v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

/* ---- validações ---- */
const cpfOk = d => { if (!/^\d{11}$/.test(d) || /^(\d)\1+$/.test(d)) return false; const v = n => { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); return s * 10 % 11 % 10 === +d[n]; }; return v(9) && v(10); };
const cnpjOk = d => { if (!/^\d{14}$/.test(d) || /^(\d)\1+$/.test(d)) return false; const v = n => { const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = w.reduce((t, x, i) => t + x * d[i], 0) % 11; return (s < 2 ? 0 : 11 - s) === +d[n]; }; return v(12) && v(13); };
function pixT(k) {
  k = String(k || '').trim(); const d = k.replace(/\D/g, '');
  if (/^\S+@\S+\.\S{2,}$/.test(k)) return ['email', 'E-mail', k.toLowerCase()];
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return ['evp', 'Chave aleatória', k.toLowerCase()];
  if (/^[\d.\-\/\s()+]+$/.test(k)) {
    if (d.length === 14 && cnpjOk(d)) return ['cnpj', 'CNPJ', d];
    if (d.length === 11 && cpfOk(d) && !k.startsWith('+')) return ['cpf', 'CPF', d];
    const t = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
    if (/^[1-9]{2}9\d{8}$/.test(t)) return ['tel', 'Celular', '+55' + t];
  }
  return null;
}
function ibanOk(s) { s = String(s).replace(/\s/g, '').toUpperCase(); if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false; const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => c.charCodeAt(0) - 55); let m = 0; for (const ch of r) m = (m * 10 + +ch) % 97; return m === 1; }
const abaOk = s => { if (!/^\d{9}$/.test(s)) return false; const d = [...s].map(Number); return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0; };
const emailOk = s => /^\S+@\S+\.\S{2,}$/.test(String(s).trim());
function genCPF() { const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)); for (const n of [9, 10]) { let s = 0; for (let i = 0; i < n; i++) s += d[i] * (n + 1 - i); d.push(s * 10 % 11 % 10); } return d.join(''); }

/* ---- Pix BR Code (EMV) ---- */
const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
function crc16(s) { let c = 0xFFFF; for (const b of Buffer.from(s, 'utf8')) { c ^= b << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, '0'); }
function brcode(txid, a) {
  const p = tlv('00', '01') + tlv('01', '12') + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('25', 'pix.bluvia.com/qr/v2/' + txid)) + tlv('52', '0000') + tlv('53', '986') + tlv('54', a.toFixed(2)) + tlv('58', 'BR') + tlv('59', MERCHANT.slice(0, 25)) + tlv('60', CITY.slice(0, 15)) + tlv('62', tlv('05', '***')) + '6304';
  return p + crc16(p);
}
function classify(tr = {}) {
  const s = String(tr.utm_source || tr.src || '').toLowerCase(), m = String(tr.utm_medium || '').toLowerCase();
  if (tr.ttclid || /tiktok/.test(s)) return 'tiktok';
  if (tr.fbclid || /facebook|instagram|^fb$|^ig$|meta/.test(s)) return /organic|bio|org/.test(m) && !tr.fbclid ? 'organico' : 'meta';
  if (tr.gclid || tr.gbraid || tr.wbraid || /google|youtube|yt/.test(s)) return /organic|org/.test(m) ? 'organico' : 'google';
  if (/kwai/.test(s)) return 'kwai';
  return 'organico';
}

/* ================= banco de dados ================= */
let db, dirty = false;
const touch = () => { db.rev++; dirty = true; };
function persist() { if (!dirty) return; dirty = false; fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(DBF + '.tmp', JSON.stringify(db)); fs.renameSync(DBF + '.tmp', DBF); }
setInterval(persist, 1500);
process.on('SIGINT', () => { persist(); process.exit(0); });

const emit = e => { e.id = ++db.evs; e.ts = e.ts || Date.now(); db.ev.push(e); if (db.ev.length > 400) db.ev.splice(0, db.ev.length - 400); touch(); };
const seller = id => db.sellers.find(s => s.id === id);
const subOf = (s, uid) => s && s.subs.find(u => u.id === uid);
const acqOf = id => db.acq.find(a => a.id === id);
const fee = (s, a) => RS(a * s.fee.p + s.fee.f);
const routeAcq = s => { const a = acqOf(s.acq); return a && a.st === 'Ativo' ? a : db.acq.find(x => x.st === 'Ativo') || db.acq[0]; };
const lost = x => x.dp && x.dp.st === 'Perdida';
// saldo por subconta: comissão dos Pix pagos − valor devolvido em disputas perdidas − saques não recusados
// + comissões de gerente transferidas para esta subconta
const subBal = (sid, uid) => RS(db.sales.reduce((t, x) => x.s === sid && x.u === uid && x.st === 'Pago' ? t + x.a - x.f - (lost(x) ? x.a : 0) : t, 0) - db.po.reduce((t, p) => p.s === sid && p.u === uid && p.st !== 'Recusado' ? t + p.a : t, 0) + (db.mt || []).reduce((t, m) => m.s === sid && m.u === uid ? t + m.a : t, 0));
/* ---- gerentes: comissão = % do lucro Ryvo (taxa − custo do TPV) das vendas da rede ---- */
const profit = x => x.f - x.a * x.c;
const isMgr = s => !!(s && s.mgr);
function cmFor(s, x) {
  const o = {}, p = profit(x); if (p <= 0) return o;
  const m1 = seller(s.ref); if (isMgr(m1) && m1.mgr.share) o[m1.id] = RS(p * m1.mgr.share);
  const m2 = m1 && seller(m1.ref); if (isMgr(m1) && isMgr(m2) && m2.id !== s.id && m2.mgr.share2) o[m2.id] = RS((o[m2.id] || 0) + p * m2.mgr.share2);
  return o;
}
const mgrEarn = mid => RS(db.sales.reduce((t, x) => x.st === 'Pago' && x.cm && x.cm[mid] ? t + x.cm[mid] : t, 0));
const mgrOut = mid => RS((db.mt || []).reduce((t, m) => m.m === mid ? t + m.a : t, 0));
const mgrBal = mid => RS(mgrEarn(mid) - mgrOut(mid));
function network(m) {
  const direct = db.sellers.filter(s => s.ref === m.id && s.id !== m.id);
  const ind = direct.filter(isMgr).flatMap(d => db.sellers.filter(s => s.ref === d.id && s.id !== m.id).map(s => ({ s, lvl: 2, via: d.id })));
  return [...direct.map(s => ({ s, lvl: 1, via: null })), ...ind];
}
const balance = sid => RS((seller(sid) || { subs: [] }).subs.reduce((t, u) => t + subBal(sid, u.id), 0));
const nextId = p => p + (++db.seq).toString(36) + hex(3);

const PROD = [['Curso Pro', 97, 'Infoproduto'], ['Kit Fit 3x', 147, 'Físico'], ['Mentoria VIP', 497, 'Infoproduto'], ['Ebook Receitas', 27, 'Infoproduto'], ['Clube Premium', 49.9, 'Assinatura'], ['Desafio 21D', 67, 'Infoproduto'], ['Combo Skin', 189, 'Físico'], ['Planilha Pro', 37, 'Infoproduto']];
const FN = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Larissa', 'Marcos', 'Natália', 'Otávio', 'Paula', 'Rafael', 'Sabrina', 'Thiago', 'Vanessa', 'Lucas', 'Beatriz', 'Caio', 'Débora', 'Igor'];
const LN = ['Souza', 'Lima', 'Mendes', 'Rocha', 'Alves', 'Costa', 'Nunes', 'Dias', 'Martins', 'Pereira', 'Gomes', 'Ribeiro', 'Castro', 'Freitas', 'Barros', 'Teixeira', 'Lopes', 'Moura', 'Prado', 'Farias'];
const buyer = () => { const n = rnd(FN) + ' ' + rnd(LN); return { cl: n, em: slug(n) + Math.floor(Math.random() * 90 + 10) + '@gmail.com', doc: genCPF() }; };
const CKW = ['Link de pagamento', 'Link de pagamento', 'Checkout transparente (API)', 'Página de vendas'];
const CPN = { tiktok: ['UGC 01', 'Spark Ads', 'TopFeed'], meta: ['Lookalike', 'Remarketing', 'Advantage+'], google: ['Search marca', 'PMax'], kwai: ['Kwai topo'], organico: ['Instagram bio', 'YouTube', 'Direto'] };
const SRCW = ['tiktok', 'tiktok', 'tiktok', 'meta', 'meta', 'google', 'kwai', 'organico', 'organico'];
const TRK0 = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'sck'];
const RULES = ['Lista negra', 'E-mail descartável', 'Muitos Pix por CPF (1h)', 'Valor acima do limite'];
const DISP = ['mailinator.com', 'tempmail.com', '10minutemail.com', 'guerrillamail.com', 'yopmail.com', 'trashmail.com'];
const DPM = ['Não reconheço a transação (MED)', 'Produto não entregue', 'Golpe / fraude (MED)', 'Cobrança duplicada'];
function trFor(src, cp) {
  const c = cp.toLowerCase().replace(/\s+/g, '-');
  return { tiktok: { utm_source: 'tiktok', utm_medium: 'paid', utm_campaign: c, ttclid: hex(6) }, meta: { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: c, fbclid: hex(6) }, google: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: c, gclid: hex(6) }, kwai: { utm_source: 'kwai', utm_medium: 'paid', utm_campaign: c }, organico: { utm_source: cp === 'YouTube' ? 'youtube' : cp === 'Direto' ? 'direto' : 'instagram', utm_medium: 'organic', utm_campaign: c } }[src];
}
const mkProd = ([n, p, t]) => ({ id: nextId('prd_'), n, p, t: t || 'Infoproduto', st: 'Ativo' });
const mkSub = (n, prods = []) => ({ id: nextId('sub_'), n, ads: {}, trk: { params: [...TRK0] }, wh: '', whsec: 'whsec_' + hex(16), whlog: [], prods: prods.map(mkProd), af: { vel: true, disp: true, max: 5000, bl: [] } });

function mkSale(s, u, a, pr, ts, tr, extra = {}) {
  const ac = routeAcq(s);
  // custo do adquirente gravado na transação; `drift` modela o fornecedor cobrando acima do contratado (conciliação)
  const c = RS(ac.cost + (ac.drift && Math.random() < ac.drift ? .004 : 0));
  return { id: nextId('px_'), tx: hex(13), s: s.id, u: u.id, ts, a: RS(a), f: fee(s, a), c, acq: ac.id, st: 'Pendente', pr, src: classify(tr), cp: tr.utm_campaign || '', tr, ...extra };
}
function mkDispute(x, st) { x.dp = { id: 'MED-' + (++db.seq), st: st || 'Aberta', mo: rnd(DPM), ts: Math.min(Date.now(), (x.pt || x.ts) + 2 * DAY * Math.random()) }; }

const SEEDPW = [];
function seed() {
  db = { v: 6, rev: 1, seq: 1000, evs: 0, ev: [], sess: {}, oauth: {}, cfg: { live: true }, admin: { email: 'ceo@bluvia.local', pw: '', sid: '' }, sellers: [], sales: [], po: [], mt: [],
    acq: [{ id: 'core', n: 'Ryvo Core (próprio)', cost: .02, st: 'Ativo' }, { id: 'acq_b', n: 'Adquirente B', cost: .02, st: 'Ativo', drift: .25 }, { id: 'acq_c', n: 'Adquirente C', cost: .02, st: 'Standby' }] };
  // [chave, nome, e-mail, taxa %, taxa fixa, adquirente, subcontas, pix/dia, tendência do mês, saque automático, indicado por, perfil de gerente, login de teste]
  const SD = [
    ['ceo', 'Conta do CEO', 'ceo@bluvia.local', .0399, .99, 'core', [['Operação própria', [0, 3]]], 3, 1.1, true, null, { share: 0, share2: 0 }, false],
    ['lucas', 'Lucas Gerente', 'lucas@bluvia.local', .0449, .99, 'core', [['Operação do Lucas', [5]]], 2, 1.3, true, 'ceo', { share: .22, share2: .05 }, true],
    ['rocco', 'Rocco Digital', 'rocco@bluvia.local', .0499, 1.00, 'core', [['Operação principal', [0, 4]], ['Drop Brasil', [1, 6]], ['Low ticket', [3, 7]]], 16, 1.22, true, 'lucas', null, true],
    ['fit', 'Fit Labs', 'contato@fitlabs.local', .0399, .99, 'core', [['Kit Fit', [1]], ['Suplementos', [6, 5]]], 12, .74, true, 'lucas', null, false],
    ['alpha', 'Mentoria Alpha', 'time@alpha.local', .0599, 1.49, 'acq_b', [['Mentoria VIP', [2, 0]]], 5, 1.05, false, 'ceo', null, false],
    ['drop', 'Drop Prime', 'ops@dropprime.local', .0449, .99, 'acq_b', [['Loja principal', [1, 6]], ['Teste criativos', [7]]], 10, 1.48, true, 'lucas', { share: .15, share2: 0 }, false],
    ['clube', 'Clube Max', 'fin@clubemax.local', .0349, .79, 'core', [['Assinaturas', [4, 5]]], 8, .93, false, 'ceo', null, false],
    ['nova', 'Studio Nova', 'oi@studionova.local', .0499, 1.00, 'core', [['Lançamento', [0, 5]]], 4, 0, true, 'lucas', null, false],
    ['pixel', 'Pixel Store', 'vendas@pixelstore.local', .0499, 1.00, 'acq_b', [['Loja Pixel', [7, 3]]], 6, 1.6, true, 'drop', null, false],
  ];
  const now = Date.now(), m0 = new Date(now); m0.setDate(1); m0.setHours(0, 0, 0, 0);
  const p0 = new Date(m0); p0.setMonth(p0.getMonth() - 1);
  const K = {};
  for (const [key, n, email, p, f, acq, subs, b, t, auto, ref, mgr, login] of SD) {
    const cpf = genCPF(), s = { id: nextId('sel_'), n, email, pw: '', st: t === 0 ? 'Bloqueado' : 'Ativo', fee: { p, f }, acq, auto, ts: p0.getTime() - 40 * DAY, subs: subs.map(([sn, pi]) => mkSub(sn, pi.map(i => PROD[i]))), keys: [], dest: [{ label: 'Nubank · Pix ' + mask(cpf), reg: 'br', bank: 'Nubank', k: cpf }], ref: null, mgr: mgr ? { ...mgr, code: slug(n).replace(/\./g, '') + hex(2) } : null, _k: key, _r: ref, _b: b, _t: t };
    if (login) { const pw = 'teste-' + hex(4); s.pw = hashPw(pw); SEEDPW.push([mgr ? 'Gerente + seller' : 'Seller', email, pw]); }
    K[key] = s; db.sellers.push(s);
  }
  for (const s of db.sellers) { s.ref = s._r ? K[s._r].id : null; }
  db.admin.sid = K.ceo.id;
  for (const s of db.sellers) {
    const b = s._b, t = s._t, pool = Array.from({ length: Math.round(b * 30) }, buyer);
    for (let d = p0.getTime(); d < now; d += DAY) {
      const base = b * (d >= m0.getTime() ? t : 1) * (.85 + .3 * Math.sin(d / DAY / 2.7 + b)), cnt = Math.round(base * (.55 + Math.random() * .9));
      for (let i = 0; i < cnt; i++) {
        const h = Math.random() < .5 ? 18 + Math.random() * 5 : 8 + Math.random() * 10, ts = d + h * 36e5 + Math.random() * 36e5;
        if (ts > now - 6e4) continue;
        const u = rnd(s.subs), pr = rnd(u.prods), src = rnd(SRCW), by = rnd(pool);
        const x = mkSale(s, u, pr.p, pr.n, ts, trFor(src, rnd(CPN[src])), { pid: pr.id, ck: rnd(CKW), ...by });
        const r = Math.random();
        if (r < .04) { x.st = 'Bloqueado'; x.rule = rnd(RULES); }
        else if (r < .79) { x.st = 'Pago'; x.pt = Math.min(now - 3e4, ts + 3e4 + Math.random() * 6e5); x.cm = cmFor(s, x); if (Math.random() < .012) mkDispute(x, rnd(['Aberta', 'Ganha', 'Perdida', 'Perdida'])); }
        else x.st = 'Expirado';
        db.sales.push(x);
      }
    }
  }
  db.sales.sort((a, b) => a.ts - b.ts);
  // saques históricos por subconta: a cada 4–7 dias saca 70–90% do saldo
  for (const s of db.sellers) for (const u of s.subs) {
    let bal = 0, next = p0.getTime() + (4 + Math.random() * 3) * DAY;
    for (const x of db.sales) {
      if (x.u !== u.id || x.st !== 'Pago') continue;
      while (x.pt > next) {
        if (bal > 50) { const a = RS(bal * (.7 + Math.random() * .2)); db.po.push({ id: nextId('sq_'), s: s.id, u: u.id, a, ts: next, dt: next + 6e5, st: 'Concluído', by: 'seller', x: s.dest[0].label, rc: brl(a), dest: s.dest[0] }); bal = RS(bal - a); }
        next += (4 + Math.random() * 3) * DAY;
      }
      bal = RS(bal + x.a - x.f - (lost(x) ? x.a : 0));
    }
  }
  // gerentes já transferiram parte das comissões para a conta de seller
  for (const s of db.sellers) if (s.mgr && s.mgr.share) { const e = mgrEarn(s.id); if (e > 100) db.mt.push({ id: nextId('tr_'), m: s.id, s: s.id, u: s.subs[0].id, a: RS(e * .6), ts: now - 5 * DAY }); }
  db.po.sort((a, b) => b.ts - a.ts);
  for (const s of db.sellers) { delete s._k; delete s._r; delete s._b; delete s._t; }
  db.cfg.rate = Math.max(1, Math.round(db.sales.filter(x => x.ts > now - 14 * DAY).length / 14));
  dirty = true;
}
function load() { try { const d = JSON.parse(fs.readFileSync(DBF, 'utf8')); if (d.v === 6) return d; } catch (e) {} return null; }
db = load(); if (!db) seed();
if (!db.admin.pw) {
  const pw = (CFG.admin && CFG.admin.password) || hex(6);
  if (CFG.admin && CFG.admin.email) db.admin.email = CFG.admin.email;
  db.admin.pw = hashPw(pw); dirty = true;
  const L = [['CEO (CEO + Gerente + Seller)', db.admin.email, CFG.admin && CFG.admin.password ? '(a do config.json)' : pw], ...SEEDPW];
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'LOGINS.txt'), 'Logins de teste (ambiente local)\n\n' + L.map(([r, e, p]) => `${r}\n  E-mail: ${e}\n  Senha: ${p}\n`).join('\n') + '\nPara trocar a senha do CEO: admin.email/admin.password no config.json e apague data/db.json.\n');
  for (const f of ['ADMIN_LOGIN.txt', 'SELLER_LOGIN.txt']) try { fs.unlinkSync(path.join(DATA, f)); } catch (e) {}
}
if (!db.admin.apiKey) { db.admin.apiKey = 'nv_admin_' + hex(24); dirty = true; try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(path.join(DATA, 'LOGINS.txt'), `\nChave da API admin (alterar taxa de seller / ler desvios):\n  ${db.admin.apiKey}\n`); } catch (e) {} }
if (!db.feeLog) { db.feeLog = []; dirty = true; }
// Conciliação: Adquirente B passa a cobrar acima do contratado em parte das vendas (drift) — dados de simulação.
if (!db.cfg.recon) { db.cfg.recon = 1; const b = acqOf('acq_b'); if (b) b.drift = .25; dirty = true; }

/* ================= motor Pix ================= */
function fraud(u, a, payer) {
  const af = u.af || {}, doc = String(payer.doc || '').replace(/\D/g, ''), em = String(payer.email || '').trim().toLowerCase();
  if ((af.bl || []).some(b => b && (b === doc || b === em))) return RULES[0];
  if (af.disp && em && DISP.some(d => em.endsWith('@' + d))) return RULES[1];
  if (af.vel && doc && db.sales.filter(x => x.doc === doc && x.ts > Date.now() - 36e5).length >= 3) return RULES[2];
  if (af.max && a > af.max) return RULES[3];
  return null;
}
function createCharge(s, u, { amount, description, external_id, tracking, expires_in, sim, payer, pid, ck }) {
  if (s.st !== 'Ativo') throw E(403, 'seller_blocked', 'Conta bloqueada para novas cobranças.');
  const a = RS(amount);
  if (!(a >= 1 && a <= 100000)) throw E(422, 'invalid_amount', 'amount deve estar entre 100 e 10000000 centavos.');
  const tr = {}; if (tracking && typeof tracking === 'object') for (const [k, v] of Object.entries(tracking).slice(0, 20)) if (/^[\w-]{1,40}$/.test(k)) tr[k] = String(v).slice(0, 200);
  const py = payer && typeof payer === 'object' ? { cl: String(payer.name || '').slice(0, 80), em: String(payer.email || '').slice(0, 120).toLowerCase(), doc: String(payer.document || payer.doc || '').replace(/\D/g, '').slice(0, 14) } : {};
  const x = mkSale(s, u, a, String(description || 'Cobrança Pix').slice(0, 120), Date.now(), tr, { ext: external_id ? String(external_id).slice(0, 80) : undefined, exp: Date.now() + Math.min(Math.max(+expires_in || 3600, 60), 86400) * 1000, pid, ck: ck || 'Checkout transparente (API)', ...py });
  const rule = fraud(u, a, { doc: py.doc, email: py.em });
  if (rule) { x.st = 'Bloqueado'; x.rule = rule; db.sales.push(x); emit({ k: 'blocked', s: s.id, u: u.id, a: x.a, sale: x.id, rule }); throw E(422, 'blocked_by_antifraud', 'Pagamento bloqueado pelo antifraude: ' + rule + '.'); }
  x.bc = brcode(x.tx, a);
  if (sim) { x.sim = 1; x.exp = Date.now() + 60e3; if (Math.random() < .8) x.pf = Date.now() + 4e3 + Math.random() * 16e3; }
  db.sales.push(x); emit({ k: 'gen', s: s.id, u: u.id, a: x.a, sale: x.id }); return x;
}
function payCharge(x) {
  if (x.st !== 'Pendente') throw E(409, 'not_pending', 'A cobrança não está pendente.');
  x.st = 'Pago'; x.pt = Date.now(); delete x.pf;
  const s = seller(x.s), u = subOf(s, x.u);
  x.cm = cmFor(s, x);
  emit({ k: 'paid', s: s.id, u: u.id, a: x.a, net: RS(x.a - x.f), sale: x.id, cm: x.cm });
  hook(u, 'charge.paid', chargeOut(x)); adsFire(u, x);
  if (x.sim && Math.random() < .015) { mkDispute(x); x.dp.ts = Date.now() + 15e3; x.dp.pend = 1; }
}
setInterval(() => {
  const n = Date.now();
  for (const x of db.sales) {
    if (!x.dp) continue;
    if (x.dp.pend && n >= x.dp.ts) { delete x.dp.pend; emit({ k: 'dp_new', s: x.s, u: x.u, a: x.a, sale: x.id }); }
    if (x.dp.st === 'Em defesa' && n - x.dp.dt > 25e3) { x.dp.st = Math.random() < .6 ? 'Ganha' : 'Perdida'; emit({ k: 'dp_res', s: x.s, u: x.u, a: x.a, sale: x.id, st: x.dp.st }); }
  }
  for (let i = db.sales.length - 1; i >= 0 && db.sales[i].ts > n - 3 * DAY; i--) {
    const x = db.sales[i];
    if (x.st !== 'Pendente') continue;
    if (x.pf && n >= x.pf) payCharge(x);
    else if (x.exp && n >= x.exp) { x.st = 'Expirado'; touch(); hook(subOf(seller(x.s), x.u), 'charge.expired', chargeOut(x)); }
  }
  for (const p of db.po) if (p.st === 'Processando' && n - (p.pa || p.ts) > 6000) { p.st = 'Concluído'; p.dt = n; emit({ k: 'po_done', s: p.s, u: p.u, a: p.a, po: p.id }); hook(subOf(seller(p.s), p.u), 'payout.paid', payoutOut(p)); }
  // ritmo real: mesma média diária de Pix gerados dos últimos 14 dias da base (≈1 Pix a cada ~25 min)
  if (db.cfg.live && Math.random() < (db.cfg.rate || 50) / (DAY / 2500)) {
    const act = db.sellers.filter(s => s.st === 'Ativo'); if (act.length) {
      const s = rnd(act), u = rnd(s.subs), prs = u.prods.filter(p => p.st === 'Ativo'), src = rnd(SRCW);
      if (prs.length) { const pr = rnd(prs), by = buyer(); try { createCharge(s, u, { amount: pr.p, description: pr.n, pid: pr.id, ck: rnd(CKW), tracking: trFor(src, rnd(CPN[src])), payer: { name: by.cl, email: by.em, document: by.doc }, sim: true }); } catch (e) {} }
    }
  }
}, 2500);

function requestPayout(s, u, a, dest, by) {
  a = RS(+a);
  if (!u) throw E(422, 'invalid', 'Escolha a subconta de onde sai o saque.');
  if (!(a >= 1)) throw E(422, 'invalid_amount', 'Informe um valor de pelo menos R$ 1,00.');
  const bal = subBal(s.id, u.id); if (a > bal + 1e-9) throw E(422, 'insufficient_balance', `Saldo insuficiente em ${u.n}. Disponível: ${brl(bal)}.`);
  const d = dest || {}; let label, rc;
  if (d.reg === 'br') { const t = pixT(d.k); if (!t) throw E(422, 'invalid_pix_key', 'Chave Pix inválida.'); label = `${d.bank || 'Pix'} · Pix ${mask(t[2])}`; rc = brl(a); d.k = t[2]; }
  else if (d.bank === 'Wise') { if (d.wt === 'iban' ? !ibanOk(d.k) : !emailOk(d.k)) throw E(422, 'invalid_destination', d.wt === 'iban' ? 'IBAN inválido.' : 'E-mail Wise inválido.'); const usd = a / USD_BRL * (1 - SPREAD); label = `Wise · ${mask(String(d.k).replace(/\s/g, ''))}`; rc = d.wt === 'iban' ? '€ ' + (usd * .92).toFixed(2) : 'US$ ' + usd.toFixed(2); }
  else if (d.bank === 'Inter Global') { if (!abaOk(String(d.rt || '').trim()) || !/^\d{6,17}$/.test(String(d.ac || '').trim())) throw E(422, 'invalid_destination', 'Routing ou conta inválidos.'); label = `Inter Global · conta ${mask(String(d.ac).trim())}`; rc = 'US$ ' + (a / USD_BRL * (1 - SPREAD)).toFixed(2); }
  else throw E(422, 'invalid_destination', 'Destino do saque inválido.');
  const st = by === 'admin' || s.auto ? 'Processando' : 'Em análise';
  const p = { id: nextId('sq_'), s: s.id, u: u.id, a, ts: Date.now(), st, by, x: label, rc, dest: { reg: d.reg, bank: d.bank, wt: d.wt, k: d.k, rt: d.rt, ac: d.ac }, pa: st === 'Processando' ? Date.now() : undefined };
  db.po.unshift(p);
  if (!s.dest.some(x => x.label === label)) { s.dest.unshift({ label, ...p.dest }); s.dest = s.dest.slice(0, 5); }
  emit({ k: 'po_req', s: s.id, u: u.id, a, po: p.id, st });
  return p;
}

/* ================= webhooks ================= */
async function hook(u, event, data) {
  if (!u || !u.wh) return;
  const body = JSON.stringify({ id: 'evt_' + hex(8), event, created_at: iso(Date.now()), data }), sig = crypto.createHmac('sha256', u.whsec).update(body).digest('hex');
  let r; try { const x = await fetch(u.wh, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bluvia-Event': event, 'X-Bluvia-Signature': 'sha256=' + sig }, body, signal: AbortSignal.timeout(8000) }); r = { ok: x.ok, code: x.status }; }
  catch (e) { r = { ok: false, code: 0, err: e.message }; }
  u.whlog = [{ ts: Date.now(), event, ...r }, ...(u.whlog || [])].slice(0, 20); touch();
}

/* ================= anúncios: TikTok + Meta (reais) ================= */
async function tt(method, ep, token, q, body) {
  const u = new URL(TT + ep);
  if (q) for (const [k, v] of Object.entries(q)) if (v !== undefined) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const r = await fetch(u, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'Access-Token': token } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!j) throw E(502, 'tiktok', 'TikTok respondeu HTTP ' + r.status);
  if (j.code !== 0) throw E(400, 'tiktok', `TikTok: ${j.message} (código ${j.code})`);
  return j;
}
const ymd = d => d.toISOString().slice(0, 10), num = v => +v || 0;
const adLog = (c, ok, t) => { c.log = [{ ts: Date.now(), ok, t }, ...(c.log || [])].slice(0, 30); touch(); };
async function ttSync(u) {
  const c = u.ads.tiktok; if (!c || c.mode !== 'live') return;
  c.busy = 1; c.err = ''; touch();
  try {
    let ids = c.advIds || [];
    if (c.via === 'oauth' && TTC.app_id) { const j = await tt('GET', '/oauth2/advertiser/get/', c.tok, { app_id: TTC.app_id, secret: TTC.secret }); ids = (j.data.list || []).map(x => String(x.advertiser_id)); }
    if (!ids.length) throw new Error('Nenhuma conta de anúncios autorizada.');
    const ai = await tt('GET', '/advertiser/info/', c.tok, { advertiser_ids: ids.slice(0, 100) });
    c.advs = (ai.data.list || []).map(x => ({ id: String(x.advertiser_id), name: x.name || String(x.advertiser_id), currency: x.currency || 'USD' }));
    if (!c.adv || !c.advs.some(x => x.id === c.adv.id)) c.adv = c.advs[0];
    try { const p = await tt('GET', '/pixel/list/', c.tok, { advertiser_id: c.adv.id, page_size: '20' }); c.pxs = (p.data.pixels || []).map(x => ({ code: x.pixel_code, name: x.pixel_name || x.pixel_code })); if (!c.pxs.some(x => x.code === c.px)) c.px = c.pxs[0] ? c.pxs[0].code : ''; }
    catch (e) { c.pxs = []; c.err = 'Pixels: ' + e.message; }
    const end = new Date(), start = new Date(Date.now() - 29 * DAY);
    const [cp, rp] = await Promise.all([
      tt('GET', '/campaign/get/', c.tok, { advertiser_id: c.adv.id, page_size: '100' }),
      tt('GET', '/report/integrated/get/', c.tok, { advertiser_id: c.adv.id, report_type: 'BASIC', data_level: 'AUCTION_CAMPAIGN', dimensions: ['campaign_id'], metrics: ['campaign_name', 'spend', 'impressions', 'clicks', 'conversion'], start_date: ymd(start), end_date: ymd(end), page_size: '200' }),
    ]);
    const m = {}; for (const r of rp.data.list || []) m[r.dimensions.campaign_id] = r.metrics;
    c.rep = { ts: Date.now(), list: (cp.data.list || []).map(x => { const r = m[x.campaign_id] || {}; return { id: String(x.campaign_id), name: x.campaign_name, status: x.operation_status === 'ENABLE' ? 'Ativo' : 'Pausado', spend: num(r.spend), imp: num(r.impressions), clk: num(r.clicks), conv: num(r.conversion) }; }) };
  } catch (e) { c.err = e.message; }
  c.busy = 0; touch();
}
async function ttEvent(u, x, test) {
  const c = u.ads.tiktok, t = `CompletePayment ${x.id} · ${brl(x.a)}`;
  if (c.mode !== 'live') return adLog(c, true, t + ' — simulado (demonstração)');
  if (!c.px) return adLog(c, false, t + ' — nenhum Pixel selecionado');
  try {
    const user = { external_id: sha(x.id), ...(x.em ? { email: sha(x.em) } : {}), ...(x.tr && x.tr.ttclid ? { ttclid: x.tr.ttclid } : {}) };
    const body = { event_source: 'web', event_source_id: c.px, data: [{ event: 'CompletePayment', event_time: Math.floor((x.pt || Date.now()) / 1000), event_id: x.id + (test ? '-t' + Date.now() : ''), user, properties: { currency: 'BRL', value: x.a, content_type: 'product', contents: [{ content_id: x.pid || x.pr, content_name: x.pr, price: x.a, quantity: 1 }] }, page: { url: PUBLIC_URL } }] };
    if (c.tc) body.test_event_code = c.tc;
    const j = await tt('POST', '/event/track/', c.tok, null, body); adLog(c, true, t + ' — aceito' + (c.tc ? ' (teste)' : '') + ' · req ' + String(j.request_id || '').slice(0, 10));
  } catch (e) { adLog(c, false, t + ' — ' + e.message); }
}
async function metaEvent(u, x, test) {
  const c = u.ads.meta, t = `Purchase ${x.id} · ${brl(x.a)}`;
  if (!c.tok) return adLog(c, true, t + ' — simulado (sem token CAPI)');
  try {
    const ud = { external_id: [sha(x.id)], ...(x.em ? { em: [sha(x.em)] } : {}), ...(x.tr && x.tr.fbclid ? { fbc: `fb.1.${x.ts}.${x.tr.fbclid}` } : {}) };
    const body = { data: [{ event_name: 'Purchase', event_time: Math.floor((x.pt || Date.now()) / 1000), event_id: x.id + (test ? '-t' + Date.now() : ''), action_source: 'website', event_source_url: PUBLIC_URL, user_data: ud, custom_data: { currency: 'BRL', value: x.a, content_name: x.pr } }], ...(c.tc ? { test_event_code: c.tc } : {}) };
    const r = await fetch(`${GRAPH}/${c.px}/events?access_token=${encodeURIComponent(c.tok)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error('Meta: ' + j.error.message);
    adLog(c, true, t + ` — recebido (${j.events_received || 0})` + (c.tc ? ' (teste)' : ''));
  } catch (e) { adLog(c, false, t + ' — ' + e.message); }
}
function adsFire(u, x) {
  const a = u.ads || {};
  if (a.tiktok && a.tiktok.send) ttEvent(u, x);
  if (a.meta && a.meta.send) metaEvent(u, x);
  for (const k of ['google', 'kwai']) if (a[k] && a[k].send) adLog(a[k], true, `Conversão ${x.id} · ${brl(x.a)} — simulado (demonstração)`);
}

/* ================= saídas ================= */
const ST_EN = { Pendente: 'pending', Pago: 'paid', Expirado: 'expired', Bloqueado: 'blocked' };
const PO_EN = { 'Em análise': 'under_review', Processando: 'processing', 'Concluído': 'paid', Recusado: 'rejected' };
function chargeOut(x) { const u = subOf(seller(x.s), x.u) || {}; return { id: x.id, txid: x.tx, status: ST_EN[x.st], amount: Math.round(x.a * 100), fee: Math.round(x.f * 100), net: Math.round((x.a - x.f) * 100), description: x.pr, external_id: x.ext || null, subaccount: { id: x.u, name: u.n }, brcode: x.bc || brcode(x.tx, x.a), expires_at: iso(x.exp), paid_at: iso(x.pt), created_at: iso(x.ts), tracking: x.tr || {} }; }
function payoutOut(p) { return { id: p.id, status: PO_EN[p.st], amount: Math.round(p.a * 100), destination: p.x, created_at: iso(p.ts), paid_at: iso(p.dt) }; }
const pubAds = a => { const o = {}; for (const k in a || {}) { const { tok, ...r } = a[k]; o[k] = { ...r, hasTok: !!tok }; } return o; };
const pubSub = (s, u, full) => ({ id: u.id, n: u.n, bal: subBal(s.id, u.id), prods: u.prods, af: full ? u.af : undefined, wh: full ? u.wh : undefined, whsec: full ? u.whsec : undefined, whlog: full ? u.whlog : undefined, trk: u.trk, ads: pubAds(u.ads) });
const pubSeller = (s, full) => ({ id: s.id, n: s.n, email: s.email, st: s.st, fee: s.fee, acq: s.acq, auto: s.auto, ts: s.ts, hasPw: !!s.pw, bal: balance(s.id), subs: s.subs.map(u => pubSub(s, u, full)), keys: full ? s.keys.filter(k => !k.rv).map(k => ({ id: k.id, cid: k.cid, u: k.u, ts: k.ts, last: k.last || 0 })) : undefined, dest: s.dest });
const pubSale = (x, adm) => { const o = { id: x.id, s: x.s, u: x.u, ts: x.ts, a: x.a, f: x.f, st: x.st, pt: x.pt, src: x.src, cp: x.cp, pr: x.pr, pid: x.pid, ck: x.ck, cl: x.cl, em: x.em, rule: x.rule, dp: x.dp && !x.dp.pend ? x.dp : undefined }; if (adm) { o.c = x.c; o.acq = x.acq; o.cm = x.cm; delete o.em; delete o.cl; } else o.doc = x.doc ? x.doc.slice(0, 3) + '.***.***-' + x.doc.slice(-2) : undefined; return o; };

/* ================= sessões ================= */
const cookie = req => { const m = (req.headers.cookie || '').match(/(?:^|;\s*)bv_s=([a-f0-9]+)/); return m ? m[1] : ''; };
function session(req) { const t = cookie(req), s = t && db.sess[t]; if (!s || s.exp < Date.now()) return null; return { t, ...s }; }
// modos que cada login pode usar: CEO → CEO/Gerente/Seller · gerente → Gerente/Seller · seller → Seller
function modesOf(sess) {
  if (sess.role === 'admin') return isMgr(seller(sess.as || db.admin.sid)) ? ['ceo', 'gerente', 'seller'] : ['ceo', 'seller'];
  return isMgr(seller(sess.id)) ? ['gerente', 'seller'] : ['seller'];
}
function ctx(req) {
  const s = session(req); if (!s) throw E(401, 'auth', 'Faça login.');
  const isAdmin = s.role === 'admin', sel = seller(isAdmin ? (s.as || db.admin.sid) : s.id);
  if (!sel) throw E(401, 'auth', 'Conta não encontrada.');
  const modes = modesOf(s), mode = modes.includes(s.mode) ? s.mode : modes[0];
  return { s, isAdmin, sel, modes, mode, imp: isAdmin && !!s.as };
}
const pubMgr = s => s.mgr ? { share: s.mgr.share, share2: s.mgr.share2, code: s.mgr.code, bal: mgrBal(s.id), earn: mgrEarn(s.id), out: mgrOut(s.id) } : null;
function mgrState(m) {
  const net = network(m), ids = new Set(net.map(n => n.s.id)), since = Date.now() - 62 * DAY, M0 = new Date(); M0.setDate(1); M0.setHours(0, 0, 0, 0);
  const rank = db.sellers.filter(s => isMgr(s) && s.mgr.share).map(g => { const ns = new Set(network(g).map(n => n.s.id)); return { id: g.id, n: g.n, tpv: RS(db.sales.reduce((t, x) => x.st === 'Pago' && x.pt >= +M0 && ns.has(x.s) ? t + x.a : t, 0)) }; }).sort((a, b) => b.tpv - a.tpv);
  return { mgr: { id: m.id, n: m.n, email: m.email, ...pubMgr(m), subs: m.subs.map(u => ({ id: u.id, n: u.n, bal: subBal(m.id, u.id) })) },
    net: net.map(({ s, lvl, via }) => ({ id: s.id, n: s.n, email: s.email, st: s.st, ts: s.ts, lvl, via, mgr: isMgr(s) })),
    sales: db.sales.filter(x => ids.has(x.s) && x.ts > since).map(x => ({ id: x.id, s: x.s, ts: x.ts, a: x.a, st: x.st, pt: x.pt, cm: (x.cm && x.cm[m.id]) || 0 })),
    mt: (db.mt || []).filter(t => t.m === m.id), rank };
}
function state(c) {
  const lastEv = db.ev.length ? db.ev[db.ev.length - 1].id : 0, srv = { tiktokApp: !!(TTC.app_id && TTC.secret), redirect: TTC.redirect_uri, base: PUBLIC_URL, sandbox: SANDBOX };
  const base = { rev: db.rev, lastEv, srv, live: db.cfg.live, modes: c.modes, mode: c.mode, imp: c.imp, isCeo: c.isAdmin };
  if (c.mode === 'ceo') return { ...base, role: 'admin', me: { email: db.admin.email, sid: db.admin.sid }, cfg: db.cfg, acq: db.acq, sellers: db.sellers.map(s => ({ ...pubSeller(s, false), nkeys: s.keys.filter(k => !k.rv).length, ref: s.ref, mgr: pubMgr(s) })), sales: db.sales.map(x => pubSale(x, true)), po: db.po, mt: db.mt || [], deviations: { sellers: sellerDeviations(), supplier: supplierDeviations() }, feeLog: (db.feeLog || []).slice(-40).reverse().map(f => ({ ...f, sn: (seller(f.s) || {}).n })), apiKey: db.admin.apiKey };
  if (c.mode === 'gerente') return { ...base, role: 'gerente', ...mgrState(c.sel) };
  return { ...base, role: 'seller', seller: pubSeller(c.sel, true), sales: db.sales.filter(x => x.s === c.sel.id).map(x => pubSale(x, false)), po: db.po.filter(p => p.s === c.sel.id) };
}

/* ================= desvios, lucro e auditoria de taxa ================= */
function logFee(s, from, via) {
  if (from.p === s.fee.p && from.f === s.fee.f) return;
  if (!db.feeLog) db.feeLog = [];
  db.feeLog.push({ s: s.id, ts: Date.now(), from: { p: RS(from.p * 100), f: from.f }, to: { p: RS(s.fee.p * 100), f: s.fee.f }, via });
  if (db.feeLog.length > 200) db.feeLog.splice(0, db.feeLog.length - 200);
  emit({ k: 'fee', s: s.id });
}
function MREF() { const n = Date.now(), m = new Date(); m.setDate(1); m.setHours(0, 0, 0, 0); const p = new Date(m); p.setMonth(p.getMonth() - 1); return { n, m0: +m, p0: +p, pe: +p + (n - +m) }; }
function sellerDeviations() {
  const { n, m0, p0, pe } = MREF(), t0 = n - (n % DAY);
  return db.sellers.map(s => {
    const a = db.sales.filter(x => x.s === s.id);
    const cur = a.filter(x => x.st === 'Pago' && x.pt >= m0), prev = a.filter(x => x.st === 'Pago' && x.pt >= p0 && x.pt < pe);
    const tpv = RS(cur.reduce((t, x) => t + x.a, 0)), ptpv = RS(prev.reduce((t, x) => t + x.a, 0));
    const genC = a.filter(x => x.ts >= m0 && (x.st === 'Pago' || x.st === 'Expirado')), genP = a.filter(x => x.ts >= p0 && x.ts < pe && (x.st === 'Pago' || x.st === 'Expirado'));
    const cv = genC.length ? cur.length / genC.length : null, pcv = genP.length ? prev.length / genP.length : null;
    const dTpv = ptpv ? tpv / ptpv - 1 : (tpv ? 1 : 0), dCv = (cv != null && pcv) ? cv - pcv : null;
    const prof = RS(cur.reduce((t, x) => t + (x.f - x.a * x.c), 0)), hoje = a.filter(x => x.st === 'Pago' && x.pt >= t0).length;
    let sev = 'ok', msg = '';
    if (s.st === 'Ativo' && ptpv > 200 && dTpv <= -.4) { sev = 'alta'; msg = `TPV caiu ${Math.round(-dTpv * 100)}% vs mês anterior`; }
    else if (dCv != null && dCv <= -.08) { sev = 'media'; msg = `Conversão caiu ${(-dCv * 100).toFixed(1).replace('.', ',')} p.p.`; }
    else if (s.st === 'Ativo' && !hoje && ptpv > 200) { sev = 'media'; msg = 'Sem vendas hoje'; }
    else if (s.st === 'Ativo' && ptpv > 200 && dTpv >= .5) { sev = 'boa'; msg = `TPV subiu ${Math.round(dTpv * 100)}%`; }
    return { id: s.id, n: s.n, st: s.st, fee: { p: RS(s.fee.p * 100), f: s.fee.f }, tpv, ptpv, dTpv, cv, pcv, dCv, prof, margin: tpv ? prof / tpv : 0, hoje, sev, msg };
  });
}
function supplierDeviations() {
  const from = Date.now() - 30 * DAY;
  const all = db.sales.filter(x => x.ts >= from && (x.st === 'Pago' || x.st === 'Expirado' || x.st === 'Bloqueado'));
  const ovAppr = all.length ? all.filter(x => x.st === 'Pago').length / all.length : 1;
  return db.acq.map(ac => {
    const paid = db.sales.filter(x => x.acq === ac.id && x.st === 'Pago' && x.pt >= from);
    const gen = all.filter(x => x.acq === ac.id);
    const over = paid.filter(x => x.c > ac.cost + 1e-9), excess = RS(over.reduce((t, x) => t + x.a * (x.c - ac.cost), 0));
    const appliedAvg = paid.length ? paid.reduce((t, x) => t + x.c, 0) / paid.length : ac.cost;
    const approval = gen.length ? paid.length / gen.length : null, flags = [];
    if (over.length) flags.push({ t: 'custo', sev: 'alta', msg: `Custo acima do contratado em ${over.length} transações: média ${(appliedAvg * 100).toFixed(2).replace('.', ',')}% vs ${(ac.cost * 100).toFixed(2).replace('.', ',')}% contratado`, impact: excess });
    if (approval != null && gen.length >= 40 && approval < ovAppr * .8) flags.push({ t: 'aprovacao', sev: 'media', msg: `Aprovação de ${(approval * 100).toFixed(1).replace('.', ',')}% abaixo da média da plataforma (${(ovAppr * 100).toFixed(1).replace('.', ',')}%)`, impact: 0 });
    return { id: ac.id, n: ac.n, st: ac.st, cost: RS(ac.cost * 100) / 100, appliedAvg, tpv: RS(paid.reduce((t, x) => t + x.a, 0)), over: over.length, excess, approval, flags };
  }).filter(x => x.tpv > 0 || x.flags.length);
}

/* ================= ações do painel ================= */
const need = (c, role) => { if (role === 'admin' && !c.isAdmin) throw E(403, 'forbidden', 'Apenas o CEO.'); if (role === 'seller' && !c.sel) throw E(403, 'forbidden', 'Entre na conta de um seller.'); };
const SUB = (c, id) => { const u = subOf(c.sel, id); if (!u) throw E(404, 'not_found', 'Subconta não encontrada.'); return u; };
const strN = (v, max = 60, min = 1) => { v = String(v || '').trim(); if (v.length < min) throw E(422, 'invalid', min > 1 ? `Nome com pelo menos ${min} caracteres.` : 'Nome obrigatório.'); return v.slice(0, max); };
function setRef(s, ref) {
  if (!ref) { s.ref = null; return; }
  const m = seller(ref); if (!isMgr(m)) throw E(422, 'invalid', 'O responsável precisa ser um gerente.');
  for (let x = m, i = 0; x && i < 20; x = seller(x.ref), i++) if (x.id === s.id) throw E(422, 'invalid', 'Isso criaria um ciclo na hierarquia.');
  s.ref = m.id;
}
const mySale = (c, id) => { const x = db.sales.find(x => x.id === id && x.s === c.sel.id); if (!x) throw E(404, 'not_found', 'Venda não encontrada.'); return x; };
const A = {
  // ---------- CEO ----------
  live: (c, b) => { need(c, 'admin'); db.cfg.live = !!b.on; touch(); },
  impersonate: (c, b) => { need(c, 'admin'); const s = seller(b.id); if (!s) throw E(404, 'not_found', 'Seller não encontrado.'); const se = db.sess[c.s.t]; se.as = s.id === db.admin.sid ? undefined : s.id; se.mode = b.mode === 'gerente' && isMgr(s) ? 'gerente' : 'seller'; touch(); },
  unimpersonate: c => { if (!c.isAdmin) throw E(403, 'forbidden', '-'); const se = db.sess[c.s.t]; delete se.as; se.mode = 'ceo'; touch(); },
  setMode: (c, b) => { if (!c.modes.includes(b.mode)) throw E(403, 'forbidden', 'Seu acesso não inclui esse modo.'); const se = db.sess[c.s.t]; se.mode = b.mode; if (b.mode === 'ceo') delete se.as; touch(); },
  mgrTransfer: (c, b) => {
    const m = c.sel; if (!isMgr(m)) throw E(403, 'forbidden', 'Apenas gerentes.');
    const u = subOf(m, b.u); if (!u) throw E(404, 'not_found', 'Escolha a subconta de destino.');
    const a = RS(+b.a), bal = mgrBal(m.id); if (!(a >= 1)) throw E(422, 'invalid', 'Informe pelo menos R$ 1,00.'); if (a > bal + 1e-9) throw E(422, 'insufficient_balance', 'Saldo de comissões insuficiente. Disponível: ' + brl(bal) + '.');
    db.mt.unshift({ id: nextId('tr_'), m: m.id, s: m.id, u: u.id, a, ts: Date.now() }); emit({ k: 'mt', s: m.id, u: u.id, a }); return { bal: mgrBal(m.id) };
  },
  sellerCreate: (c, b) => {
    need(c, 'admin'); const n = strN(b.n), email = String(b.email || '').trim().toLowerCase();
    if (!emailOk(email)) throw E(422, 'invalid', 'E-mail inválido.'); if (db.sellers.some(s => s.email === email)) throw E(422, 'invalid', 'E-mail já cadastrado.');
    if (b.pw && String(b.pw).length < 8) throw E(422, 'invalid', 'Senha com pelo menos 8 caracteres.');
    const s = { id: nextId('sel_'), n, email, pw: b.pw ? hashPw(b.pw) : '', st: 'Ativo', fee: { p: Math.max(0, +b.p || 4.99) / 100, f: Math.max(0, +b.f || 0) }, acq: acqOf(b.acq) ? b.acq : 'core', auto: !!b.auto, ts: Date.now(), subs: [mkSub(n)], keys: [], dest: [] };
    db.sellers.push(s); if (b.ref) setRef(s, b.ref); touch(); return { id: s.id };
  },
  sellerUpdate: (c, b) => {
    need(c, 'admin'); const s = seller(b.id); if (!s) throw E(404, 'not_found', 'Seller não encontrado.');
    const fee0 = { p: s.fee.p, f: s.fee.f };
    if (b.n !== undefined) s.n = strN(b.n);
    if (b.p !== undefined) { const p = +b.p; if (!(p >= 0 && p <= 30)) throw E(422, 'invalid', 'Taxa % entre 0 e 30.'); s.fee.p = p / 100; }
    if (b.f !== undefined) { const f = +b.f; if (!(f >= 0 && f <= 50)) throw E(422, 'invalid', 'Taxa fixa entre 0 e 50.'); s.fee.f = RS(f); }
    if (b.acq !== undefined) { if (!acqOf(b.acq)) throw E(422, 'invalid', 'Adquirente inválido.'); s.acq = b.acq; }
    if (b.st !== undefined) { if (!['Ativo', 'Bloqueado'].includes(b.st)) throw E(422, 'invalid', 'Status inválido.'); s.st = b.st; }
    if (b.auto !== undefined) s.auto = !!b.auto;
    if (b.pw) { if (String(b.pw).length < 8) throw E(422, 'invalid', 'Senha com pelo menos 8 caracteres.'); s.pw = hashPw(b.pw); }
    if (b.ref !== undefined) setRef(s, b.ref);
    if (b.isMgr !== undefined) {
      if (!b.isMgr) s.mgr = null;
      else { const sh = +b.share, s2 = +b.share2; if (!(sh >= 0 && sh <= 100) || !(s2 >= 0 && s2 <= 100) || sh + s2 > 100) throw E(422, 'invalid', 'Fatias entre 0% e 100% (somadas até 100%).'); s.mgr = { share: sh / 100, share2: s2 / 100, code: (s.mgr && s.mgr.code) || slug(s.n).replace(/\./g, '').slice(0, 20) + hex(2) }; }
    }
    logFee(s, fee0, b.via || 'painel');
    touch();
  },
  acqSave: (c, b) => {
    need(c, 'admin'); const cost = +b.cost; if (!(cost >= 0 && cost <= 20)) throw E(422, 'invalid', 'Custo entre 0% e 20%.');
    if (!['Ativo', 'Standby', 'Inativo'].includes(b.st || 'Ativo')) throw E(422, 'invalid', 'Status inválido.');
    const snap = JSON.stringify(db.acq);
    if (b.id) { const a = acqOf(b.id); if (!a) throw E(404, 'not_found', 'Adquirente não encontrado.'); a.n = strN(b.n); a.cost = cost / 100; a.st = b.st || a.st; }
    else db.acq.push({ id: nextId('acq_'), n: strN(b.n), cost: cost / 100, st: b.st || 'Ativo' });
    if (!db.acq.some(a => a.st === 'Ativo')) { db.acq = JSON.parse(snap); throw E(422, 'invalid', 'Mantenha pelo menos um adquirente ativo.'); }
    touch();
  },
  poApprove: (c, b) => { need(c, 'admin'); const p = db.po.find(x => x.id === b.id); if (!p || p.st !== 'Em análise') throw E(409, 'invalid', 'Saque não está em análise.'); p.st = 'Processando'; p.pa = Date.now(); emit({ k: 'po_ok', s: p.s, u: p.u, a: p.a, po: p.id }); },
  poReject: (c, b) => { need(c, 'admin'); const p = db.po.find(x => x.id === b.id); if (!p || p.st !== 'Em análise') throw E(409, 'invalid', 'Saque não está em análise.'); p.st = 'Recusado'; p.dt = Date.now(); emit({ k: 'po_rej', s: p.s, u: p.u, a: p.a, po: p.id }); },
  poSend: (c, b) => { need(c, 'admin'); const s = seller(b.s); if (!s) throw E(404, 'not_found', 'Seller não encontrado.'); return { id: requestPayout(s, subOf(s, b.u), b.a, b.dest, 'admin').id }; },
  // ---------- seller: subcontas ----------
  subCreate: (c, b) => { need(c, 'seller'); if (c.sel.subs.length >= 20) throw E(422, 'invalid', 'Limite de 20 subcontas.'); const u = mkSub(strN(b.n, 60, 3)); c.sel.subs.push(u); touch(); return { id: u.id }; },
  subRename: (c, b) => { need(c, 'seller'); SUB(c, b.id).n = strN(b.n, 60, 3); touch(); },
  subDelete: (c, b) => { need(c, 'seller'); SUB(c, b.id); if (db.sales.some(x => x.u === b.id)) throw E(422, 'invalid', 'Subconta com vendas não pode ser excluída.'); if (c.sel.subs.length < 2) throw E(422, 'invalid', 'Mantenha pelo menos uma subconta.'); c.sel.subs = c.sel.subs.filter(u => u.id !== b.id); c.sel.keys.forEach(k => { if (k.u === b.id) k.rv = 1; }); touch(); },
  payout: (c, b) => { need(c, 'seller'); return { id: requestPayout(c.sel, SUB(c, b.u), b.a, b.dest, c.isAdmin ? 'admin' : 'seller').id }; },
  // produtos
  prodSave: (c, b) => {
    need(c, 'seller'); const u = SUB(c, b.u), n = strN(b.n, 80), p = RS(+b.p), t = ['Infoproduto', 'Físico', 'Assinatura'].includes(b.t) ? b.t : 'Infoproduto';
    if (!(p >= 1 && p <= 100000)) throw E(422, 'invalid', 'Preço entre R$ 1,00 e R$ 100.000,00.');
    if (b.id) { const x = u.prods.find(x => x.id === b.id); if (!x) throw E(404, 'not_found', 'Produto não encontrado.'); Object.assign(x, { n, p, t }); if (b.st) x.st = b.st === 'Pausado' ? 'Pausado' : 'Ativo'; }
    else { if (u.prods.some(x => x.n === n)) throw E(422, 'invalid', 'Já existe um produto com esse nome.'); u.prods.push(mkProd([n, p, t])); }
    touch();
  },
  prodToggle: (c, b) => { need(c, 'seller'); const x = SUB(c, b.u).prods.find(x => x.id === b.id); if (!x) throw E(404, 'not_found', 'Produto não encontrado.'); x.st = x.st === 'Ativo' ? 'Pausado' : 'Ativo'; touch(); },
  prodDelete: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u); if (db.sales.some(x => x.pid === b.id)) throw E(422, 'invalid', 'Produto com vendas não pode ser excluído — pause ele.'); u.prods = u.prods.filter(x => x.id !== b.id); touch(); },
  // antifraude
  afSave: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u), max = +b.max; if (!(max >= 0 && max <= 100000)) throw E(422, 'invalid', 'Limite entre 0 e 100.000 (0 = sem limite).'); u.af = { ...u.af, vel: !!b.vel, disp: !!b.disp, max }; touch(); },
  blAdd: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u), v = String(b.v || '').trim().toLowerCase(), d = v.replace(/\D/g, ''); let k; if (emailOk(v)) k = v; else if (cpfOk(d) || cnpjOk(d)) k = d; else throw E(422, 'invalid', 'Informe um CPF, CNPJ ou e-mail válido.'); if (!u.af.bl.includes(k)) u.af.bl.unshift(k); touch(); },
  blDel: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u); u.af.bl = u.af.bl.filter(x => x !== b.v); touch(); },
  // disputas (MED)
  dpDefend: (c, b) => { need(c, 'seller'); const x = mySale(c, b.id); if (!x.dp || x.dp.st !== 'Aberta') throw E(409, 'invalid', 'Disputa não está aberta.'); const t = String(b.txt || '').trim(); if (t.length < 10) throw E(422, 'invalid', 'Explique a defesa em pelo menos 10 caracteres.'); x.dp.st = 'Em defesa'; x.dp.def = t.slice(0, 1000); x.dp.dt = Date.now(); touch(); },
  dpAccept: (c, b) => { need(c, 'seller'); const x = mySale(c, b.id); if (!x.dp || x.dp.st !== 'Aberta') throw E(409, 'invalid', 'Disputa não está aberta.'); x.dp.st = 'Perdida'; x.dp.acc = 1; touch(); },
  // API / webhook / tracking
  keyCreate: (c, b) => { need(c, 'seller'); SUB(c, b.u); const cid = 'bv_live_' + hex(8), secret = 'sk_' + hex(24); c.sel.keys.push({ id: nextId('key_'), cid, h: sha(secret), u: b.u, ts: Date.now() }); touch(); return { cid, secret }; },
  keyRevoke: (c, b) => { need(c, 'seller'); const k = c.sel.keys.find(k => k.id === b.id); if (!k) throw E(404, 'not_found', 'Chave não encontrada.'); k.rv = 1; for (const [t, v] of TOK) if (v.kid === k.id) TOK.delete(t); touch(); },
  webhook: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u), url = String(b.url || '').trim(); if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw E(422, 'invalid', 'URL deve começar com http:// ou https://'); u.wh = url; touch(); },
  webhookTest: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u); if (!u.wh) throw E(422, 'invalid', 'Cadastre a URL primeiro.'); hook(u, 'ping', { subaccount: u.id }); },
  whRotate: (c, b) => { need(c, 'seller'); SUB(c, b.u).whsec = 'whsec_' + hex(16); touch(); },
  trkParams: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u), ps = [...new Set((b.params || []).map(p => String(p).trim()).filter(p => /^[\w-]{1,40}$/.test(p)))].slice(0, 20); u.trk = { params: ps.length ? ps : [...TRK0] }; touch(); },
  pixTest: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u); const x = createCharge(c.sel, u, { amount: +b.a, description: b.d || 'Pix de teste', tracking: b.tr, expires_in: 900 }); return { charge: chargeOut(x) }; },
  pixPay: (c, b) => { if (!SANDBOX) throw E(403, 'forbidden', 'Simulação desligada.'); need(c, 'seller'); payCharge(mySale(c, b.id)); },
  // anúncios
  ttDemo: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u), adv = String(b.adv || '').trim(), px = String(b.px || '').trim().toUpperCase(); if (!/^\d{10,19}$/.test(adv)) throw E(422, 'invalid', 'ID do anunciante: 10 a 19 números.'); if (!/^[A-Z0-9]{10,25}$/.test(px)) throw E(422, 'invalid', 'Código do Pixel inválido.'); u.ads.tiktok = { mode: 'demo', adv: { id: adv, name: 'Conta ' + adv.slice(-4), currency: 'BRL' }, px, send: true, log: [] }; touch(); },
  ttManual: async (c, b) => {
    need(c, 'seller'); const u = SUB(c, b.u), tok = String(b.tok || '').trim(), adv = String(b.adv || '').trim();
    if (tok.length < 20) throw E(422, 'invalid', 'Cole o access token completo.'); if (!/^\d{8,20}$/.test(adv)) throw E(422, 'invalid', 'ID do anunciante: só números.');
    await tt('GET', '/advertiser/info/', tok, { advertiser_ids: [adv] });
    u.ads.tiktok = { mode: 'live', via: 'token', tok, advIds: [adv], advs: [], pxs: [], px: '', tc: '', send: true, log: [] }; touch(); ttSync(u);
  },
  ttAuthUrl: (c, b) => { need(c, 'seller'); SUB(c, b.u); if (!TTC.app_id || !TTC.secret) throw E(422, 'invalid', 'Configure app_id e secret do TikTok no config.json.'); const st = hex(12); db.oauth[st] = { s: c.sel.id, u: b.u, ts: Date.now() }; touch(); const q = new URL('https://business-api.tiktok.com/portal/auth'); q.searchParams.set('app_id', TTC.app_id); q.searchParams.set('state', st); q.searchParams.set('redirect_uri', TTC.redirect_uri); return { url: q.toString() }; },
  ttSync: async (c, b) => { need(c, 'seller'); await ttSync(SUB(c, b.u)); },
  ttSet: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u), t = u.ads.tiktok; if (!t) throw E(404, 'not_found', 'TikTok não conectado.'); if (b.k === 'adv') { t.adv = (t.advs || []).find(x => x.id === b.v) || t.adv; t.px = ''; t.rep = null; touch(); return ttSync(u); } if (['px', 'tc'].includes(b.k)) t[b.k] = String(b.v || '').trim().slice(0, 40); if (b.k === 'send') t.send = !!b.v; touch(); },
  ttTest: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u); if (!u.ads.tiktok) throw E(404, 'not_found', 'TikTok não conectado.'); ttEvent(u, { id: 'px_teste', a: 1, pr: 'Evento de teste', ts: Date.now(), tr: {} }, true); },
  metaSet: async (c, b) => {
    need(c, 'seller'); const u = SUB(c, b.u), px = String(b.px || '').trim(), tok = String(b.tok || '').trim();
    if (!/^\d{10,20}$/.test(px)) throw E(422, 'invalid', 'ID do Pixel/Dataset: 10 a 20 números.');
    if (tok) { const r = await fetch(`${GRAPH}/${px}?fields=name&access_token=${encodeURIComponent(tok)}`, { signal: AbortSignal.timeout(15000) }); const j = await r.json().catch(() => ({})); if (j.error) throw E(422, 'meta', 'Meta: ' + j.error.message); u.ads.meta = { mode: 'live', px, name: j.name || px, tok, tc: String(b.tc || '').trim(), send: true, log: [] }; }
    else u.ads.meta = { mode: 'demo', px, name: 'Pixel ' + px.slice(-4), send: true, log: [] };
    touch();
  },
  metaSetTc: (c, b) => { need(c, 'seller'); const m = SUB(c, b.u).ads.meta; if (!m) throw E(404, 'not_found', 'Meta não conectado.'); if (b.k === 'tc') m.tc = String(b.v || '').trim().slice(0, 40); if (b.k === 'send') m.send = !!b.v; touch(); },
  metaTest: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u); if (!u.ads.meta) throw E(404, 'not_found', 'Meta não conectado.'); metaEvent(u, { id: 'px_teste', a: 1, pr: 'Evento de teste', ts: Date.now(), tr: {} }, true); },
  adDemo: (c, b) => { need(c, 'seller'); const u = SUB(c, b.u), k = b.k; const R = { google: [/^\d{3}-\d{3}-\d{4}$/, /^AW-\d{6,12}$/i, 'ID do cliente (000-000-0000) e ID de conversão (AW-...)'], kwai: [/^\d{6,20}$/, /^[\w-]{6,40}$/, 'ID da conta e ID do Pixel Kwai'] }[k]; if (!R) throw E(422, 'invalid', '-'); if (!R[0].test(String(b.a || '').trim()) || !R[1].test(String(b.b || '').trim())) throw E(422, 'invalid', 'Informe ' + R[2] + '.'); u.ads[k] = { mode: 'demo', a: String(b.a).trim(), b: String(b.b).trim(), send: true, log: [] }; touch(); },
  adOff: (c, b) => { need(c, 'seller'); delete SUB(c, b.u).ads[b.k]; touch(); },
};

/* ================= API Pix pública (/v1) ================= */
const TOK = new Map(), IDEM = new Map();
function apiAuth(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/);
  const t = m && TOK.get(m[1]);
  if (!t || t.exp < Date.now()) throw E(401, 'invalid_token', 'Token ausente, inválido ou expirado. Gere um novo em POST /v1/oauth/token.');
  const s = seller(t.s), u = subOf(s, t.u); if (!u) throw E(401, 'invalid_token', 'Credencial revogada.');
  return { s, u };
}
const V1 = [
  ['POST', /^\/v1\/oauth\/token$/, async (req, b) => {
    let id = b.client_id, sec = b.client_secret; const m = (req.headers.authorization || '').match(/^Basic\s+(\S+)$/);
    if (m) [id, sec] = Buffer.from(m[1], 'base64').toString().split(':');
    if ((b.grant_type || 'client_credentials') !== 'client_credentials') throw E(400, 'unsupported_grant_type', 'Use grant_type=client_credentials.');
    let k, s; for (const x of db.sellers) { const f = x.keys.find(k => k.cid === id && !k.rv); if (f) { k = f; s = x; break; } }
    if (!k || k.h !== sha(sec || '')) throw E(401, 'invalid_client', 'client_id ou client_secret inválidos.');
    const at = 'at_' + hex(24); TOK.set(at, { kid: k.id, s: s.id, u: k.u, exp: Date.now() + 3600e3 }); k.last = Date.now(); touch();
    return { access_token: at, token_type: 'Bearer', expires_in: 3600, scope: 'charges payouts balance' };
  }],
  ['POST', /^\/v1\/pix\/charges$/, async (req, b) => {
    const { s, u } = apiAuth(req), ik = req.headers['idempotency-key'];
    if (ik && IDEM.has(s.id + ik)) return chargeOut(db.sales.find(x => x.id === IDEM.get(s.id + ik)));
    if (!Number.isInteger(b.amount)) throw E(422, 'invalid_amount', 'amount deve ser inteiro em centavos (ex.: 9700 = R$ 97,00).');
    const x = createCharge(s, u, { amount: b.amount / 100, description: b.description, external_id: b.external_id, tracking: b.tracking, expires_in: b.expires_in, payer: b.payer });
    if (ik) IDEM.set(s.id + ik, x.id);
    return [201, chargeOut(x)];
  }],
  ['GET', /^\/v1\/pix\/charges$/, async (req, b, q) => { const { s, u } = apiAuth(req); const st = q.get('status'), lim = Math.min(+q.get('limit') || 20, 100); return { data: db.sales.filter(x => x.s === s.id && x.u === u.id && (!st || ST_EN[x.st] === st)).slice(-lim).reverse().map(chargeOut) }; }],
  ['GET', /^\/v1\/pix\/charges\/([\w]+)$/, async (req, b, q, m) => { const { s } = apiAuth(req); const x = db.sales.find(x => x.id === m[1] && x.s === s.id); if (!x) throw E(404, 'not_found', 'Cobrança não encontrada.'); return chargeOut(x); }],
  ['POST', /^\/v1\/pix\/charges\/([\w]+)\/simulate-payment$/, async (req, b, q, m) => { if (!SANDBOX) throw E(403, 'forbidden', 'Simulação desligada.'); const { s } = apiAuth(req); const x = db.sales.find(x => x.id === m[1] && x.s === s.id); if (!x) throw E(404, 'not_found', 'Cobrança não encontrada.'); payCharge(x); return chargeOut(x); }],
  ['GET', /^\/v1\/balance$/, async req => { const { s, u } = apiAuth(req); return { available: Math.round(subBal(s.id, u.id) * 100), currency: 'BRL', subaccount: { id: u.id, name: u.n } }; }],
  ['POST', /^\/v1\/payouts$/, async (req, b) => { const { s, u } = apiAuth(req); if (!Number.isInteger(b.amount)) throw E(422, 'invalid_amount', 'amount deve ser inteiro em centavos.'); const t = pixT(b.pix_key); if (!t) throw E(422, 'invalid_pix_key', 'pix_key inválida.'); return [201, payoutOut(requestPayout(s, u, b.amount / 100, { reg: 'br', bank: 'Pix', k: t[2] }, 'seller'))]; }],
  ['GET', /^\/v1\/payouts\/([\w]+)$/, async (req, b, q, m) => { const { s } = apiAuth(req); const p = db.po.find(p => p.id === m[1] && p.s === s.id); if (!p) throw E(404, 'not_found', 'Saque não encontrado.'); return payoutOut(p); }],
];

/* ================= API admin (CEO) — alterar taxa de seller e ler desvios ================= */
function adminApiAuth(req) { const m = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/); if (!m || m[1] !== db.admin.apiKey) throw E(401, 'invalid_token', 'Chave de API admin ausente ou inválida.'); }
const feeOut = s => ({ id: s.id, name: s.n, status: s.st, fee: { percent: RS(s.fee.p * 100), fixed: s.fee.f }, acquirer: s.acq });
const AV1 = [
  ['GET', /^\/admin\/v1\/sellers$/, async req => { adminApiAuth(req); const { m0 } = MREF(); return { data: db.sellers.map(s => { const cur = db.sales.filter(x => x.s === s.id && x.st === 'Pago' && x.pt >= m0); return { ...feeOut(s), tpv_month: Math.round(cur.reduce((t, x) => t + x.a, 0) * 100), profit_month: Math.round(cur.reduce((t, x) => t + (x.f - x.a * x.c), 0) * 100) }; }) }; }],
  ['GET', /^\/admin\/v1\/sellers\/([\w]+)$/, async (req, b, q, m) => { adminApiAuth(req); const s = seller(m[1]); if (!s) throw E(404, 'not_found', 'Seller não encontrado.'); return feeOut(s); }],
  ['PATCH', /^\/admin\/v1\/sellers\/([\w]+)\/fee$/, async (req, b, q, m) => {
    adminApiAuth(req); const s = seller(m[1]); if (!s) throw E(404, 'not_found', 'Seller não encontrado.');
    const p = +b.percent, f = b.fixed == null ? s.fee.f : +b.fixed;
    if (!(p >= 0 && p <= 30)) throw E(422, 'invalid_fee', 'percent deve estar entre 0 e 30.');
    if (!(f >= 0 && f <= 50)) throw E(422, 'invalid_fee', 'fixed deve estar entre 0 e 50 (reais).');
    const from = { p: s.fee.p, f: s.fee.f }; s.fee = { p: p / 100, f: RS(f) }; logFee(s, from, 'api'); touch();
    return feeOut(s);
  }],
  ['GET', /^\/admin\/v1\/deviations$/, async req => { adminApiAuth(req); return { generated_at: iso(Date.now()), sellers: sellerDeviations(), supplier: supplierDeviations() }; }],
];

/* ================= checkout hospedado (links de pagamento) ================= */
function findProd(pid) { for (const s of db.sellers) for (const u of s.subs) { const p = u.prods.find(x => x.id === pid); if (p) return { s, u, p }; } return null; }
function payPage(f) {
  const ok = f && f.p.st === 'Ativo' && f.s.st === 'Ativo';
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? escH(f.p.n) + ' – ' : ''}Pagamento Pix</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet"><script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:radial-gradient(800px 500px at 80% -10%,rgba(139,124,246,.32),transparent 60%),#0B0B14;color:#F4F2FF;font:15px/1.5 "Outfit","Space Grotesk",system-ui,sans-serif}
.c{width:min(420px,100%);background:#12121F;border:1px solid #2A2A44;border-radius:20px;padding:26px;box-shadow:0 30px 80px rgba(0,0,0,.45);animation:r .5s cubic-bezier(.2,.8,.2,1)}@keyframes r{from{transform:translateY(14px);opacity:0}}
.lk{display:flex;align-items:center;gap:9px;margin-bottom:18px}.lk b{font-family:"Outfit",sans-serif;font-weight:600;font-size:19px;letter-spacing:-.025em}
h1{font-size:20px;margin:0}.m{color:#9C99B8;font-size:13px}.v{font-size:30px;font-weight:700;margin:8px 0 16px;font-family:"Space Grotesk",sans-serif}input{width:100%;background:#1A1A2C;border:1px solid #2A2A44;color:#F4F2FF;border-radius:10px;padding:11px 12px;font:inherit;margin-bottom:10px;outline:none}input:focus{border-color:#8B7CF6}
button{width:100%;border:0;border-radius:10px;padding:13px;font:600 15px "Space Grotesk",system-ui,sans-serif;background:linear-gradient(135deg,#7B7FF5,#C9A2F2);color:#fff;cursor:pointer}button.o{background:none;border:1px solid #2A2A44;color:#F4F2FF;margin-top:8px}.e{color:#F2546B;font-size:13px;min-height:1.2em}
.q{background:#fff;border-radius:14px;padding:10px;display:block;width:220px;margin:14px auto;line-height:0}.q svg{width:200px;height:200px}.b{font:12px monospace;word-break:break-all;background:#1A1A2C;border-radius:9px;padding:10px;margin:8px 0}
.ok{text-align:center}.ok svg{filter:drop-shadow(0 0 14px #3DD9A4)}.st{display:flex;align-items:center;gap:8px;justify-content:center;color:#F5B947;font-size:13px;margin:8px 0}.st i{width:8px;height:8px;border-radius:50%;background:#F5B947;animation:p 1.4s infinite}@keyframes p{50%{opacity:.3}}
.sec{display:flex;gap:6px;align-items:center;justify-content:center;color:#9C99B8;font-size:12px;margin-top:14px}</style></head><body><div class="c" id="c">
<div class="lk"><svg viewBox="0 0 48 48" width="28" height="28"><defs><linearGradient id="g" x1="4" y1="40" x2="44" y2="8" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7B7FF5"/><stop offset=".55" stop-color="#B8A6F4"/><stop offset="1" stop-color="#F4C6EE"/></linearGradient></defs><path d="M5 9h11l11 15-11 15H5l11-15z" fill="url(#g)"/><path d="M21 9h11l11 15-11 15H21l11-15z" fill="url(#g)"/></svg><b>Ryvo</b></div>
${ok ? `<div class="m">${escH(f.u.n)}</div><h1>${escH(f.p.n)}</h1><div class="v">${brl(f.p.p)}</div>
<form id="f"><input name="name" placeholder="Nome completo" required minlength="3" autocomplete="name"><input name="email" type="email" placeholder="E-mail" required autocomplete="email"><input name="document" placeholder="CPF" required inputmode="numeric"><div class="e" id="e"></div><button>Gerar Pix</button></form>
<div class="sec">🔒 Pagamento processado pela Ryvo</div>` : '<h1>Link indisponível</h1><p class="m">Este produto não está mais à venda.</p>'}
</div><script>
const P='${ok ? f.p.id : ''}',SB=${SANDBOX},esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const cpfOk=d=>{if(!/^\\d{11}$/.test(d)||/^(\\d)\\1+$/.test(d))return false;const v=n=>{let s=0;for(let i=0;i<n;i++)s+=+d[i]*(n+1-i);return s*10%11%10==+d[n]};return v(9)&&v(10)};
const f=document.getElementById('f');if(f)f.onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(f));d.document=d.document.replace(/\\D/g,'');if(!cpfOk(d.document))return document.getElementById('e').textContent='CPF inválido.';
 const tr=Object.fromEntries(new URLSearchParams(location.search));const b=f.querySelector('button');b.disabled=true;b.textContent='Gerando...';
 const r=await fetch('/pay/'+P+'/charge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payer:d,tracking:tr})});const j=await r.json();
 if(!r.ok){b.disabled=false;b.textContent='Gerar Pix';return document.getElementById('e').textContent=j.error}show(j)};
function show(j){let q='';try{const x=qrcode(0,'M');x.addData(j.brcode);x.make();q='<div class="q">'+x.createSvgTag({cellSize:4,margin:2,scalable:true})+'</div>'}catch(e){}
 document.getElementById('c').innerHTML='<div class="m">Escaneie no app do seu banco</div><h1>'+esc(j.description)+'</h1><div class="v">'+esc(j.amount_fmt)+'</div>'+q+'<div class="st"><i></i> Aguardando pagamento</div><div class="m">Pix copia e cola</div><div class="b">'+esc(j.brcode)+'</div><button onclick="navigator.clipboard.writeText(\\''+j.brcode+'\\');this.textContent=\\'Copiado!\\'">Copiar código Pix</button>'+(SB?'<button class="o" onclick="fetch(\\'/pay/c/'+j.id+'/simulate\\',{method:\\'POST\\'})">Simular pagamento (ambiente de testes)</button>':'');
 const t=setInterval(async()=>{const s=await (await fetch('/pay/c/'+j.id)).json();if(s.status=='paid'){clearInterval(t);document.getElementById('c').innerHTML='<div class="ok"><svg viewBox="0 0 52 52" width="84" height="84"><circle cx="26" cy="26" r="24" fill="none" stroke="#34D399" stroke-width="3"/><path d="M14 27l8 8 16-17" fill="none" stroke="#34D399" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><h1>Pagamento confirmado!</h1><p class="m">Você vai receber o acesso no e-mail informado.</p></div>'}else if(s.status=='expired'){clearInterval(t);document.querySelector('.st').innerHTML='Pix expirado — recarregue a página'}},2500)}
</script></body></html>`;
}

function signupPage(g) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Criar conta – Ryvo</title><link rel="icon" href="/assets/ryvo-mark.svg">
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:radial-gradient(800px 500px at 80% -10%,rgba(139,124,246,.32),transparent 60%),#0B0B14;color:#F4F2FF;font:15px/1.5 "Outfit","Space Grotesk",system-ui,sans-serif}
.c{width:min(420px,100%);background:#12121F;border:1px solid #2A2A44;border-radius:20px;padding:28px;box-shadow:0 30px 80px rgba(0,0,0,.45);animation:r .5s cubic-bezier(.2,.8,.2,1)}@keyframes r{from{transform:translateY(14px);opacity:0}}
.lk{display:flex;align-items:center;gap:9px;margin-bottom:18px}.lk b{font-family:"Outfit",sans-serif;font-weight:600;font-size:20px;letter-spacing:-.025em}h1{font-size:21px;margin:0}.m{color:#9C99B8;font-size:13.5px;margin:4px 0 16px}.g{display:inline-flex;gap:8px;align-items:center;background:#1A1A2C;border-radius:20px;padding:4px 12px 4px 4px;font-size:13px;margin-bottom:14px}.g i{width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#7B7FF5,#C9A2F2);display:grid;place-items:center;font-style:normal;font-weight:700;font-size:12px}
input{width:100%;background:#1A1A2C;border:1px solid #2A2A44;color:#F4F2FF;border-radius:10px;padding:11px 12px;font:inherit;margin-bottom:10px;outline:none}input:focus{border-color:#8B7CF6}
button{width:100%;border:0;border-radius:10px;padding:13px;font:600 15px "Space Grotesk",sans-serif;background:linear-gradient(135deg,#7B7FF5,#C9A2F2);color:#fff;cursor:pointer}.e{color:#F2546B;font-size:13px;min-height:1.2em;margin-top:6px}</style></head><body><div class="c">
<div class="lk"><svg viewBox="0 0 48 48" width="30" height="30"><defs><linearGradient id="g" x1="4" y1="40" x2="44" y2="8" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7B7FF5"/><stop offset=".55" stop-color="#B8A6F4"/><stop offset="1" stop-color="#F4C6EE"/></linearGradient></defs><path d="M5 9h11l11 15-11 15H5l11-15z" fill="url(#g)"/><path d="M21 9h11l11 15-11 15H21l11-15z" fill="url(#g)"/></svg><b>Ryvo</b></div>${g ? `<div class="g"><i>${escH(g.n[0])}</i>Convite de ${escH(g.n)}</div><h1>Crie sua conta de seller</h1><p class="m">Receba por Pix com o motor de pagamentos da Ryvo.</p>
<form id="f"><input name="n" placeholder="Nome da empresa ou seu nome" required minlength="3" maxlength="60"><input name="email" type="email" placeholder="E-mail" required autocomplete="email"><input name="pw" type="password" placeholder="Senha (mín. 8 caracteres)" required minlength="8" autocomplete="new-password"><button>Criar conta</button><div class="e" id="e"></div></form>` : '<h1>Link de convite inválido</h1><p class="m">Peça um novo link ao seu gerente.</p>'}
</div><script>const f=document.getElementById('f');if(f)f.onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(f));d.code='${g ? g.mgr.code : ''}';const r=await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});const j=await r.json();if(!r.ok)return document.getElementById('e').textContent=j.error;location.href='/#home'}</script></body></html>`;
}

/* ================= HTTP ================= */
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.css': 'text/css' };
const send = (res, code, obj, h = {}) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...h }).end(JSON.stringify(obj));
const readBody = req => new Promise((ok, no) => { let s = ''; req.on('data', c => { s += c; if (s.length > 2e5) { no(E(413, 'too_large', 'Corpo muito grande')); req.destroy(); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(E(400, 'invalid_json', 'JSON inválido')); } }); });
const LOGIN_TRY = new Map(), PAY_TRY = new Map();

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  try {
    if (p.startsWith('/v1/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') return res.writeHead(204, { 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET, POST' }).end();
      for (const [m, re, h] of V1) { const mm = p.match(re); if (mm && m === req.method) { const b = req.method === 'POST' ? await readBody(req) : {}; let out = await h(req, b, u.searchParams, mm); let code = 200; if (Array.isArray(out)) [code, out] = out; return send(res, code, out); } }
      throw E(404, 'not_found', 'Rota não encontrada.');
    }
    if (p.startsWith('/admin/v1/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') return res.writeHead(204, { 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, PATCH' }).end();
      for (const [m, re, h] of AV1) { const mm = p.match(re); if (mm && m === req.method) { const b = (req.method === 'POST' || req.method === 'PATCH') ? await readBody(req) : {}; let out = await h(req, b, u.searchParams, mm); let code = 200; if (Array.isArray(out)) [code, out] = out; return send(res, code, out); } }
      throw E(404, 'not_found', 'Rota admin não encontrada.');
    }
    // ---- checkout hospedado ----
    let m;
    if ((m = p.match(/^\/pay\/(prd_[\w]+)$/)) && req.method === 'GET') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(payPage(findProd(m[1])));
    if ((m = p.match(/^\/pay\/(prd_[\w]+)\/charge$/)) && req.method === 'POST') {
      const ip = req.socket.remoteAddress, t = PAY_TRY.get(ip) || []; const recent = t.filter(x => x > Date.now() - 6e4); if (recent.length >= 10) throw E(429, 'rate', 'Muitas tentativas. Aguarde um minuto.'); PAY_TRY.set(ip, [...recent, Date.now()]);
      const f = findProd(m[1]); if (!f || f.p.st !== 'Ativo') throw E(404, 'not_found', 'Produto indisponível.');
      const b = await readBody(req), py = b.payer || {};
      if (String(py.name || '').trim().length < 3 || !emailOk(py.email || '') || !cpfOk(String(py.document || '').replace(/\D/g, ''))) throw E(422, 'invalid', 'Preencha nome, e-mail e CPF válidos.');
      const x = createCharge(f.s, f.u, { amount: f.p.p, description: f.p.n, pid: f.p.id, ck: 'Link de pagamento', tracking: b.tracking, payer: py, expires_in: 1800 });
      return send(res, 201, { id: x.id, brcode: x.bc, description: x.pr, amount_fmt: brl(x.a) });
    }
    if ((m = p.match(/^\/pay\/c\/(px_[\w]+)$/))) { const x = db.sales.find(x => x.id === m[1] && x.ck === 'Link de pagamento'); if (!x) throw E(404, 'not_found', 'Cobrança não encontrada.'); return send(res, 200, { status: ST_EN[x.st] }); }
    if ((m = p.match(/^\/pay\/c\/(px_[\w]+)\/simulate$/)) && req.method === 'POST') { if (!SANDBOX) throw E(403, 'forbidden', 'Simulação desligada.'); const x = db.sales.find(x => x.id === m[1] && x.ck === 'Link de pagamento'); if (!x) throw E(404, 'not_found', 'Cobrança não encontrada.'); payCharge(x); return send(res, 200, { ok: true }); }
    // ---- cadastro por link de indicação do gerente ----
    if ((m = p.match(/^\/cadastro\/([\w-]+)$/)) && req.method === 'GET') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(signupPage(db.sellers.find(s => isMgr(s) && s.mgr.code === m[1])));
    if (p === '/api/signup' && req.method === 'POST') {
      const ip = req.socket.remoteAddress, t = (PAY_TRY.get('su' + ip) || []).filter(x => x > Date.now() - 36e5); if (t.length >= 5) throw E(429, 'rate', 'Muitos cadastros deste endereço. Tente mais tarde.'); PAY_TRY.set('su' + ip, [...t, Date.now()]);
      const b = await readBody(req), g = db.sellers.find(s => isMgr(s) && s.mgr.code === String(b.code || ''));
      if (!g) throw E(404, 'not_found', 'Link de indicação inválido.');
      const n = String(b.n || '').trim(), email = String(b.email || '').trim().toLowerCase();
      if (n.length < 3 || n.length > 60) throw E(422, 'invalid', 'Nome entre 3 e 60 caracteres.');
      if (!emailOk(email)) throw E(422, 'invalid', 'E-mail inválido.');
      if (String(b.pw || '').length < 8) throw E(422, 'invalid', 'Senha com pelo menos 8 caracteres.');
      if (email === db.admin.email || db.sellers.some(s => s.email === email)) throw E(422, 'invalid', 'Esse e-mail já tem conta.');
      const s = { id: nextId('sel_'), n, email, pw: hashPw(b.pw), st: 'Ativo', fee: { p: .0499, f: 1 }, acq: 'core', auto: false, ts: Date.now(), subs: [mkSub('Operação principal')], keys: [], dest: [], ref: g.id, mgr: null };
      db.sellers.push(s); emit({ k: 'signup', s: s.id });
      const tok = hex(24); db.sess[tok] = { role: 'seller', id: s.id, exp: Date.now() + 7 * DAY }; touch();
      return send(res, 201, { ok: true }, { 'Set-Cookie': `bv_s=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}` });
    }
    // ---- painel ----
    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress, t = LOGIN_TRY.get(ip) || { n: 0, ts: 0 }; if (t.n >= 8 && Date.now() - t.ts < 6e4) throw E(429, 'rate', 'Muitas tentativas. Aguarde 1 minuto.');
      const b = await readBody(req), email = String(b.email || '').trim().toLowerCase(); let role, id;
      if (email === db.admin.email && checkPw(b.password, db.admin.pw)) role = 'admin';
      else { const s = db.sellers.find(s => s.email === email); if (s && s.pw && checkPw(b.password, s.pw)) { if (s.st === 'Bloqueado') throw E(403, 'blocked', 'Conta bloqueada. Fale com o suporte.'); role = 'seller'; id = s.id; } }
      if (!role) { LOGIN_TRY.set(ip, { n: t.n + 1, ts: Date.now() }); throw E(401, 'auth', 'E-mail ou senha incorretos.'); }
      LOGIN_TRY.delete(ip); const tok = hex(24); db.sess[tok] = { role, id, exp: Date.now() + 7 * DAY }; touch();
      return send(res, 200, { ok: true }, { 'Set-Cookie': `bv_s=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}` });
    }
    if (p === '/api/logout') { const t = cookie(req); delete db.sess[t]; touch(); return send(res, 200, { ok: true }, { 'Set-Cookie': 'bv_s=; Path=/; Max-Age=0' }); }
    if (p === '/api/state') { const s = session(req); if (!s) return send(res, 200, { auth: false }); return send(res, 200, state(ctx(req))); }
    if (p === '/api/poll') {
      const c = ctx(req), since = +u.searchParams.get('ev') || 0, sid = c.sel.id;
      const ids = c.mode === 'gerente' ? new Set(network(c.sel).map(n => n.s.id)) : null;
      const ok = e => c.mode === 'ceo' || (c.mode === 'gerente' ? (ids.has(e.s) && (e.k === 'paid' || e.k === 'signup')) || (e.s === sid && e.k === 'mt') : e.s === sid);
      return send(res, 200, { mode: c.mode, rev: db.rev, ev: db.ev.filter(e => e.id > since && ok(e)).slice(-30).map(e => ({ ...e, cm: undefined, cmMe: e.cm ? e.cm[sid] || 0 : 0, sn: (seller(e.s) || {}).n, un: e.u ? (subOf(seller(e.s), e.u) || {}).n : '' })) });
    }
    if (p === '/api/act' && req.method === 'POST') {
      const c = ctx(req), b = await readBody(req), h = Object.hasOwn(A, b.act) && A[b.act]; if (!h) throw E(404, 'not_found', 'Ação desconhecida.');
      const out = await h(c, b); return send(res, 200, { ok: true, ...(out || {}) });
    }
    if (p === '/api/tiktok/callback') {
      const st = u.searchParams.get('state'), o = db.oauth[st], code = u.searchParams.get('auth_code') || u.searchParams.get('code');
      try {
        if (!o) throw new Error('state inválido ou expirado.'); delete db.oauth[st];
        const sub = subOf(seller(o.s), o.u); if (!sub || !code) throw new Error('Retorno do TikTok incompleto.');
        const j = await tt('POST', '/oauth2/access_token/', null, null, { app_id: TTC.app_id, secret: TTC.secret, auth_code: code });
        sub.ads.tiktok = { mode: 'live', via: 'oauth', tok: j.data.access_token, advIds: (j.data.advertiser_ids || []).map(String), advs: [], pxs: [], px: '', tc: '', send: true, log: [] }; touch(); ttSync(sub);
        res.writeHead(302, { Location: '/#track?tt=ok' }).end();
      } catch (e) { res.writeHead(302, { Location: '/#track?tterr=' + encodeURIComponent(e.message) }).end(); }
      return;
    }
    const f = p === '/' ? '/index.html' : decodeURIComponent(p);
    if (!(f === '/index.html' || /^\/assets\/[\w.-]+$/.test(f))) return res.writeHead(404).end('Not found');
    fs.readFile(path.join(ROOT, f), (err, data) => err ? res.writeHead(404).end('Not found') : res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }).end(data));
  } catch (e) {
    const st = e.status || 500; if (st === 500) console.error(e);
    if (p.startsWith('/v1/') || p.startsWith('/admin/v1/')) return send(res, st, { error: { code: e.code || 'internal', message: st === 500 ? 'Erro interno.' : e.message } });
    send(res, st, { error: st === 500 ? 'Erro interno: ' + e.message : e.message });
  }
}).listen(PORT, HOST, () => {
  console.log(`Ryvo rodando em ${PUBLIC_URL}`);
  console.log(`Login do CEO: ${db.admin.email} (senha em data/ADMIN_LOGIN.txt ou config.json)`);
});
