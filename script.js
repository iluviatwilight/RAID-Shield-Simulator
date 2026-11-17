/* RAID-Shield — simulasi RAID 0 / 1 / 5 / 10 sebagai game bertahan 30 hari */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const TARGET_DAY = 30;
const START_MONEY = 1500;
const REPLACE_COST = 100;
const REBUILD_MS = 3000;
const WIN_BONUS = 500;

// eff = % kapasitas tersedia, income = uang per hari, tol = jumlah disk rusak yang masih ditoleransi
const RAIDS = {
  0:  { name: 'RAID 0',  eff: 100, income: 40, tol: 0 },
  1:  { name: 'RAID 1',  eff: 25,  income: 0,  tol: 2 },
  5:  { name: 'RAID 5',  eff: 75,  income: 20, tol: 1 },
  10: { name: 'RAID 10', eff: 50,  income: 0,  tol: 2 },
};

let st;               // state game
let dayMs = 2500;     // kecepatan hari (bisa diubah di Pengaturan)
let lastTick = 0;
let loopId = null;
let logLines = [];

/* ================= STATE ================= */
function newState() {
  return {
    raid: null, data: '', phase: 'idle',   // idle | processing | running | over
    paused: false, day: 1, money: START_MONEY, dayAcc: 0,
    disks: Array.from({ length: 4 }, () => ({ state: 'ok', cells: Array(12).fill(null), prog: 0 })),
    layout: null,
  };
}

/* ================= LAYOUT DATA PER TIPE RAID ================= */
function buildLayout(raid, str) {
  const L = Array.from({ length: 4 }, () => Array(12).fill(null));
  [...str].forEach((ch, i) => {
    if (raid === 0) {
      L[i % 4][Math.floor(i / 4)] = { ch, t: 'data' };
    } else if (raid === 1) {
      for (let d = 0; d < 4; d++) L[d][i] = { ch, t: d === 0 ? 'data' : 'mir' };
    } else if (raid === 5) {
      const s = Math.floor(i / 3), k = i % 3, p = (3 - s) % 4;
      const dd = [0, 1, 2, 3].filter((d) => d !== p);
      L[dd[k]][s] = { ch, t: 'data' };
      L[p][s] = { ch: 'P', t: 'par' };
    } else if (raid === 10) {
      const pair = i % 2, row = Math.floor(i / 2);
      L[pair * 2][row] = { ch, t: 'data' };
      L[pair * 2 + 1][row] = { ch, t: 'mir' };
    }
  });
  return L;
}

function diskLabel(d) {
  if (!st.raid || st.phase === 'idle') return 'KOSONG';
  if (st.raid === 0) return 'STRIPE';
  if (st.raid === 5) return 'DATA + P';
  if (st.raid === 1) return d === 0 ? 'DATA' : 'MIRROR ' + d;
  return ['STRIPE 1', 'MIRROR 1', 'STRIPE 2', 'MIRROR 2'][d];
}

/* ================= TERMINAL ================= */
function log(text, cls = 'ok', reset = false) {
  if (reset) logLines = [];
  logLines.push({ text, cls });
  logLines = logLines.slice(-6);
  const el = $('#terminal');
  el.innerHTML = logLines.map((l) => `<div class="${l.cls}">&gt; ${esc(l.text)}</div>`).join('') +
    '<div class="prompt">&gt; <span class="cursor">█</span></div>';
}
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/* ================= RENDER ================= */
function badCount() { return st.disks.filter((d) => d.state !== 'ok').length; }

function render() {
  // header
  const bad = badCount();
  const lost = st.phase === 'over' && st.lostReason;
  $('#statusText').textContent = 'STATUS: ' + (lost ? 'DATA LOST' : bad ? 'DEGRADED' : 'OPTIMAL');
  $('#statusDot').className = 'dot ' + (lost ? 'lost' : bad ? 'degraded' : '');
  $('#dayText').textContent = `HARI ${st.day}/${TARGET_DAY}`;
  $('#dayBar').style.width = (st.day / TARGET_DAY) * 100 + '%';
  $('#moneyText').textContent = 'POIN $' + st.money;
  $('#moneyText').closest('.chip').classList.toggle('low', st.money < REPLACE_COST);
  $('#btnPause').textContent = st.paused ? '▶ RESUME' : '❚❚ PAUSE';
  $('#busData').textContent = st.data ? st.data : '- - - -';

  // panel kontrol
  const locked = st.phase !== 'idle';
  $('#dataInput').disabled = locked;
  $$('.raid-btn').forEach((b) => {
    b.classList.toggle('sel', +b.dataset.raid === st.raid);
    b.disabled = locked;
  });
  $('#counter').textContent = `${$('#dataInput').value.length}/12`;
  $('#btnStore').disabled = !(st.phase === 'idle' && st.raid !== null && st.data.length > 0);
  const canRebuild = st.phase === 'running' && st.raid !== 0 &&
    st.disks.some((d) => d.state === 'replaced') && !st.disks.some((d) => d.state === 'rebuilding');
  $('#btnRebuild').disabled = !canRebuild;
  $('#actionNote').textContent =
    st.raid === 0 && st.phase === 'running' ? 'RAID 0 tidak bisa di-rebuild.' :
    st.disks.some((d) => d.state === 'failed') ? 'Beli disk pengganti ($100) dulu, lalu rebuild.' :
    'Rebuild aktif setelah disk rusak dan diganti.';

  // disk
  $('#disks').innerHTML = st.disks.map((d, i) => diskHTML(d, i)).join('');
  $$('.buy').forEach((b) => b.addEventListener('click', () => buyReplacement(+b.dataset.d)));

  // hint
  const hint = $('#vizHint');
  const pendingWin = st.phase === 'running' && st.day >= TARGET_DAY && bad > 0;
  hint.hidden = false;
  if (pendingWin) hint.textContent = 'Selesaikan rebuild dulu untuk menang!';
  else if (st.phase === 'idle' && st.raid === null) hint.textContent = 'Pilih arsitektur RAID di panel kiri untuk memulai';
  else if (st.phase === 'idle') hint.textContent = 'Tekan "Proses Penyimpanan" untuk menyalakan server';
  else hint.hidden = true;
  $('#vizTag').hidden = st.phase === 'idle';

  // efisiensi
  const r = st.raid !== null ? RAIDS[st.raid] : null;
  const eff = r ? r.eff : 100;
  $('#donut').style.background = `conic-gradient(var(--green) 0 ${eff}%, var(--orange) 0)`;
  $('#donutText').textContent = (r ? eff : '00') + '%';
  $('#legCap').textContent = (r ? eff : 100) + '%';
  $('#legRed').textContent = (r ? 100 - eff : 0) + '%';
  $('#effTag').textContent = r ? `${r.name} · +$${r.income}/hari` : 'PILIH RAID';
}

function diskHTML(d, i) {
  const cls = d.state === 'ok' ? '' : d.state;
  const showCells = st.phase !== 'idle' && st.phase !== 'processing';
  let cells = '';
  for (let c = 0; c < 12; c++) {
    const x = showCells ? d.cells[c] : null;
    if (x) {
      const color = x.t === 'par' ? 'par' : 'c' + (x.ch.charCodeAt(0) % 4);
      cells += `<div class="cell on ${color} ${x.t === 'mir' ? 'mir' : ''}">${esc(x.ch)}${x.t === 'par' ? '<span class="ptag">PAR</span>' : ''}</div>`;
    } else cells += '<div class="cell"></div>';
  }
  let extra = '', tag = '';
  if (d.state === 'failed') {
    tag = '<div class="stag degraded">DEGRADED</div>';
    extra = `<div class="fail-popup"><div class="fail-popup-bar"><i></i><i></i><i></i>SYSTEM FAILURE</div><div class="fail-popup-body"><span class="fail-popup-warn">!</span>Disk ${i + 1} tidak merespons</div></div>`;
    extra += `<button class="buy" data-d="${i}">Beli Pengganti ($${REPLACE_COST})</button>`;
  } else if (d.state === 'replaced') {
    extra = '<div class="msg">Disk baru terpasang<br>siap di-rebuild</div>';
  } else if (d.state === 'rebuilding') {
    tag = '<div class="stag rebuild">REBUILDING...</div>';
    extra = `<div class="prog"><b style="width:${Math.round(d.prog * 100)}%"></b></div>`;
  } else if (i === 0 && st.phase === 'running' && badCount() === 0) {
    tag = '<div class="stag optimal">OPTIMAL</div>';
  }
  return `<div class="disk ${cls}">${tag}
    <div class="dhead"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>Disk ${i + 1}<span class="led"></span></div>
    <div class="dlabel">${diskLabel(i)}</div>
    <div class="cells">${cells}</div>${extra}</div>`;
}

/* ================= AKSI PEMAIN ================= */
function selectRaid(r) {
  if (st.phase !== 'idle') return;
  st.raid = r;
  log(`${RAIDS[r].name} dipilih (${RAIDS[r].eff}% kapasitas tersedia)`, 'ok', true);
  render();
}

function storeData() {
  const str = $('#dataInput').value.toUpperCase().replace(/\s+/g, '');
  if (!str || st.raid === null || st.phase !== 'idle') return;
  st.data = str;
  st.phase = 'processing';
  st.layout = buildLayout(st.raid, str);
  log(`Memproses "${str}" dengan ${RAIDS[st.raid].name}...`, 'ok', true);
  render();
  $('#busLines').classList.add('active');
  $$('.bus-branch').forEach((b) => b.classList.add('lit'));
  setTimeout(() => log('Membagi data ke 4 disk via data bus'), 450);
  setTimeout(() => {
    st.disks.forEach((d, i) => { d.cells = st.layout[i].slice(); });
    $('#busLines').classList.remove('active');
    $$('.bus-branch').forEach((b) => b.classList.remove('lit'));
    flash('fresh', 700);
    st.phase = 'running';
    st.paused = false;
    st.dayAcc = 0;
    log('Data berhasil disimpan. Server online, hari berjalan!');
    render();
  }, 1000);
}

function flash(cls, ms) {
  const el = $('#disks');
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

function buyReplacement(i) {
  const d = st.disks[i];
  if (st.phase !== 'running' || d.state !== 'failed') return;
  if (st.money < REPLACE_COST) return gameOver('Modal habis, tidak bisa beli disk pengganti');
  st.money -= REPLACE_COST;
  d.state = 'replaced';
  d.cells = Array(12).fill(null);
  log(`Disk pengganti untuk Disk ${i + 1} dipasang ($${REPLACE_COST}). Klik "Jalankan Rebuild Data"`, 'warn');
  render();
}

function startRebuild() {
  if (st.phase !== 'running') return;
  const targets = st.disks.map((d, i) => ({ d, i })).filter((x) => x.d.state === 'replaced');
  if (!targets.length) return;
  targets.forEach(({ d, i }) => {
    d.state = 'rebuilding'; d.prog = 0;
    log(rebuildLog(i), 'ok');
  });
  render();
}

function rebuildLog(i) {
  const L = st.layout;
  if (st.raid === 5) {
    const row = L[i].findIndex((c) => c && c.t === 'data');
    if (row >= 0) {
      const others = [0, 1, 2, 3].filter((d) => d !== i).map((d) => L[d][row]).filter(Boolean);
      const parts = others.map((c, n) => c.t === 'par' ? 'Parity [P]' : `Data Blok ${n + 1} [${c.ch}]`);
      return `${parts.join(' ⊕ ')} = Recovering Data [${L[i][row].ch}]`;
    }
    return 'Menghitung ulang parity dari disk yang selamat...';
  }
  return `Menyalin data dari disk mirror yang sehat ke Disk ${i + 1}...`;
}

function togglePause() {
  if (st.phase !== 'running') return;
  st.paused = !st.paused;
  log(st.paused ? 'Server di-pause.' : 'Server dilanjutkan.', 'warn');
  render();
}

/* ================= LOOP GAME ================= */
function loop(now) {
  const dt = Math.min(now - lastTick, 250);
  lastTick = now;
  if (st && st.phase === 'running' && !st.paused) {
    let dirty = false;
    // progres rebuild
    st.disks.forEach((d, i) => {
      if (d.state !== 'rebuilding') return;
      d.prog += dt / REBUILD_MS; dirty = true;
      if (d.prog >= 1) {
        d.state = 'ok'; d.prog = 0; d.cells = st.layout[i].slice();
        log(`Rebuild Disk ${i + 1} selesai. Data pulih.`);
        evaluate();
      }
    });
    // pergantian hari
    if (st.phase === 'running' && st.day < TARGET_DAY) {
      st.dayAcc += dt;
      if (st.dayAcc >= dayMs) { st.dayAcc = 0; nextDay(); dirty = true; }
    }
    if (dirty && st.phase === 'running') updateLive();
  }
  loopId = requestAnimationFrame(loop);
}

// update ringan tiap frame saat rebuild (tanpa re-render penuh jika hanya progress bar)
function updateLive() {
  const bars = $$('.disk .prog b');
  if (bars.length && !st._fullRender) {
    let k = 0;
    st.disks.forEach((d) => { if (d.state === 'rebuilding') { if (bars[k]) bars[k].style.width = Math.round(d.prog * 100) + '%'; k++; } });
  }
  // render penuh hanya bila hari berganti / status berubah
  if (st._needRender) { st._needRender = false; render(); }
}

function nextDay() {
  st.day++;
  st.money += RAIDS[st.raid].income;
  st._needRender = true;
  log(`Hari ${st.day}: server menghasilkan +$${RAIDS[st.raid].income}`);
  if (st.day < TARGET_DAY) {
    const rebuilding = st.disks.some((d) => d.state === 'rebuilding');
    const chance = (0.10 + st.day * 0.012) * (rebuilding ? 1.5 : 1);
    const healthy = st.disks.map((d, i) => i).filter((i) => st.disks[i].state === 'ok');
    if (healthy.length && Math.random() < chance) {
      const i = healthy[Math.floor(Math.random() * healthy.length)];
      st.disks[i].state = 'failed';
      st.disks[i].cells = Array(12).fill(null);
      flash('shake', 500);
      log(`!! ERROR: Disk ${i + 1} terbakar / tidak merespons`, 'err');
      if (st.raid !== 0 && badCount() <= RAIDS[st.raid].tol)
        log(`Mode DEGRADED: ${RAIDS[st.raid].name} tetap berjalan. Beli pengganti untuk Disk ${i + 1}`, 'warn');
    }
  }
  evaluate();
  render();
}

/* ================= KONDISI MENANG / KALAH ================= */
function evaluate() {
  if (st.phase !== 'running') return;
  const bad = badCount();
  const tol = RAIDS[st.raid].tol;
  if (bad > tol) {
    const reasons = {
      0: 'RAID 0: 1 disk rusak = data hilang',
      5: '2 disk RAID 5 rusak bersamaan',
      1: '3 disk RAID 1 rusak bersamaan',
      10: '3 disk RAID 10 rusak bersamaan',
    };
    return gameOver(reasons[st.raid], true);
  }
  if (st.disks.some((d) => d.state === 'failed') && st.money < REPLACE_COST)
    return gameOver('Modal habis, tidak bisa beli disk pengganti');
  if (st.day >= TARGET_DAY && bad === 0) return win();
  st._needRender = true;
}

function gameOver(reason, dataLost = true) {
  st.phase = 'over';
  st.lostReason = reason;
  log('!! GAME OVER: ' + reason + '.', 'err');
  render();
  $('#overReason').textContent = reason;
  $('#overDay').textContent = 'Hari ' + st.day;
  $('#overPts').textContent = '$' + st.money;
  $('#overRaid').textContent = RAIDS[st.raid].name.replace('RAID ', 'RAID ');
  setTimeout(() => { $('#ovOver').hidden = false; }, 500);
}

function win() {
  st.phase = 'over';
  log('Hari ke-30 tercapai. Server selamat!');
  render();
  const total = st.money + WIN_BONUS;
  $('#winRaidLbl').textContent = `Poin Akhir (${RAIDS[st.raid].name})`;
  $('#winPts').textContent = '$' + st.money;
  $('#winBonus').textContent = '+$' + WIN_BONUS;
  $('#winTotal').textContent = '$' + total;
  const stars = total >= 2400 ? 3 : total >= 2000 ? 2 : 1;
  $('#stars').innerHTML = [1, 2, 3].map((n) => `<span class="${n <= stars ? '' : 'off'}">★</span>`).join('');
  setTimeout(() => { $('#ovWin').hidden = false; confetti(); }, 500);
}

function confetti() {
  const colors = ['#ffe44d', '#f5a7c6', '#b8a7f5', '#3f4fe0', '#e8813a', '#8bb85a'];
  const box = $('#confetti');
  for (let i = 0; i < 45; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    s.style.left = Math.random() * 100 + '%';
    s.style.background = colors[i % colors.length];
    s.style.border = '2px solid #111';
    s.style.animationDuration = 2 + Math.random() * 2.5 + 's';
    s.style.animationDelay = Math.random() * 1.2 + 's';
    box.appendChild(s);
  }
  setTimeout(() => (box.innerHTML = ''), 6000);
}

/* ================= NAVIGASI / UI ================= */
function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  window.scrollTo(0, 0);
}

function resetGame() {
  st = newState();
  $('#dataInput').value = '';
  ['#ovOver', '#ovWin'].forEach((s) => ($(s).hidden = true));
  $('#confetti').innerHTML = '';
  log('raid-shield:~$ menunggu perintah...', 'ok', true);
  render();
}

function store(k, v) { try { localStorage.setItem('raidshield.' + k, v); } catch (e) {} }
function load(k) { try { return localStorage.getItem('raidshield.' + k); } catch (e) { return null; } }
function setDark(on) { document.body.classList.toggle('dark', on); store('dark', on ? '1' : '0'); }
function toggleDark() { setDark(!document.body.classList.contains('dark')); }

let resumeAfterHelp = false;
function openHelp() {
  if (st.phase === 'running' && !st.paused) { togglePause(); resumeAfterHelp = true; }
  $('#ovHelp').hidden = false;
}
function closeHelp() {
  $('#ovHelp').hidden = true;
  if (resumeAfterHelp) { resumeAfterHelp = false; if (st.paused) togglePause(); }
}
function setSpeed(ms) {
  dayMs = ms; store('speed', ms);
  $$('#speedRow .btn').forEach((x) => x.classList.toggle('active', +x.dataset.ms === ms));
}

function init() {
  st = newState();
  if (load('dark') === '1') setDark(true);
  if (load('speed')) setSpeed(+load('speed'));
  resetGame();

  $('#btnStart').onclick = () => { resetGame(); showScreen('gameScreen'); };
  $('#btnHowStart').onclick = openHelp;
  $('#btnHelp').onclick = openHelp;
  $('#btnHelpOk').onclick = closeHelp;
  $('#btnSettings').onclick = () => ($('#ovSettings').hidden = false);
  $('#btnSetOk').onclick = () => ($('#ovSettings').hidden = true);
  $('#btnDark').onclick = toggleDark;
  $('#btnDark2').onclick = toggleDark;
  $('#btnPause').onclick = togglePause;
  $('#btnStore').onclick = storeData;
  $('#btnRebuild').onclick = startRebuild;
  $$('.raid-btn').forEach((b) => (b.onclick = () => selectRaid(+b.dataset.raid)));

  $('#dataInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/\s/g, '');
    st.data = '';
    render();
  });
  $('#dataInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') storeData(); });

  $$('#speedRow .btn').forEach((b) => (b.onclick = () => setSpeed(+b.dataset.ms)));

  $('#btnRetry').onclick = () => { resetGame(); };
  $('#btnAgain').onclick = () => { resetGame(); };
  $('#btnMenu1').onclick = $('#btnMenu2').onclick = () => { resetGame(); showScreen('startScreen'); };

  // tutup modal bila klik area gelap
  $('#ovHelp').addEventListener('click', (e) => { if (e.target === $('#ovHelp')) closeHelp(); });
  $('#ovSettings').addEventListener('click', (e) => { if (e.target === $('#ovSettings')) $('#ovSettings').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#ovHelp').hidden) closeHelp();
    else if (!$('#ovSettings').hidden) $('#ovSettings').hidden = true;
  });

  lastTick = performance.now();
  loopId = requestAnimationFrame(loop);
}

document.addEventListener('DOMContentLoaded', init);
