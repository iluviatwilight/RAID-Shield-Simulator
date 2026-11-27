'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const TARGET_DAY = 30;
const START_MONEY = 1500;
const REPLACE_COST = 100;
const REBUILD_MS = 3000;
const WIN_BONUS = 500;
const BACKUP_COST = 150, RESTORE_FEE = 200;

const RAIDS = {
  0:  { name: 'RAID 0',  eff: 100, income: 60, info: 'Striping: data dipecah rata ke 4 disk. Tercepat dan kapasitas penuh, tetapi tanpa redundansi: 1 disk rusak = semua data hilang.' },
  1:  { name: 'RAID 1',  eff: 25,  income: 15, info: 'Mirroring: data disalin identik ke 4 disk. Paling aman (tahan 3 disk rusak), tetapi hanya 25% kapasitas yang terpakai.' },
  5:  { name: 'RAID 5',  eff: 75,  income: 45, info: 'Striping + parity XOR terdistribusi. Tahan 1 disk rusak: isi disk yang hilang dihitung ulang dari disk lain \u2295 parity.' },
  10: { name: 'RAID 10', eff: 50,  income: 30, info: 'Mirror lalu stripe (2 pasang). Tahan 1 disk rusak per pasangan; jika kedua disk dalam satu pasangan rusak, data hilang.' },
};
let randomOn = true;  

let st;               
let dayMs = 2500;     
let lastTick = 0;
let loopId = null;
let logLines = [];

function newState() {
  return {
    raid: null, data: '', phase: 'idle',  
    paused: false, day: 1, money: START_MONEY, dayAcc: 0, heat: 0, backup: false,
    disks: Array.from({ length: 4 }, () => ({ state: 'ok', cells: Array(12).fill(null), prog: 0 })),
    layout: null,
  };
}

function buildLayout(raid, str) {
  const L = Array.from({ length: 4 }, () => Array(12).fill(null));
  L.route = []; 
  [...str].forEach((ch, i) => {
    if (raid === 0) {
      L[i % 4][Math.floor(i / 4)] = { ch, t: 'data' };
      L.route.push([i % 4]);
    } else if (raid === 1) {
      for (let d = 0; d < 4; d++) L[d][i] = { ch, t: d === 0 ? 'data' : 'mir' };
      L.route.push([0, 1, 2, 3]);
    } else if (raid === 5) {
      const s = Math.floor(i / 3), k = i % 3, p = (3 - s) % 4;
      const dd = [0, 1, 2, 3].filter((d) => d !== p);
      L[dd[k]][s] = { ch, t: 'data' };
      L.route.push([dd[k]]);
    } else {
      const pair = i % 2, row = Math.floor(i / 2);
      L[pair * 2][row] = { ch, t: 'data' };
      L[pair * 2 + 1][row] = { ch, t: 'mir' };
      L.route.push([pair * 2, pair * 2 + 1]);
    }
  });
  if (raid === 5) {  
    for (let s = 0; s < 4; s++) {
      const p = (3 - s) % 4; let x = 0, any = false;
      for (let d = 0; d < 4; d++) if (d !== p && L[d][s]) { x ^= L[d][s].ch.charCodeAt(0); any = true; }
      if (any) L[p][s] = { ch: 'P', t: 'par', val: x, v: x.toString(16).toUpperCase().padStart(2, '0') };
    }
  }
  return L;
}

function diskLabel(d) {
  if (!st.raid || st.phase === 'idle') return 'KOSONG';
  if (st.raid === 0) return 'STRIPE';
  if (st.raid === 5) return 'DATA + P';
  if (st.raid === 1) return d === 0 ? 'DATA' : 'MIRROR ' + d;
  return ['STRIPE 1', 'MIRROR 1', 'STRIPE 2', 'MIRROR 2'][d];
}

function log(text, cls = 'ok', reset = false) {
  if (reset) logLines = [];
  logLines.push({ text, cls });
  logLines = logLines.slice(-6);
  const el = $('#terminal');
  el.innerHTML = logLines.map((l) => `<div class="${l.cls}">&gt; ${esc(l.text)}</div>`).join('') +
    '<div class="prompt">&gt; <span class="cursor">█</span></div>';
}
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function badCount() { return st.disks.filter((d) => d.state !== 'ok').length; }

function render() {
  const bad = badCount();
  const lost = st.phase === 'over' && st.lostReason;
  $('#statusText').textContent = 'STATUS: ' + (lost ? 'DATA LOST' : bad ? 'DEGRADED' : st.heat > 0 ? 'OVERHEAT' : 'OPTIMAL');
  $('#statusDot').className = 'dot ' + (lost ? 'lost' : bad || st.heat > 0 ? 'degraded' : '');
  $('#dayText').textContent = `HARI ${st.day}/${TARGET_DAY}`;
  $('#dayBar').style.width = (st.day / TARGET_DAY) * 100 + '%';
  $('#moneyText').textContent = 'POIN $' + st.money;
  $('#moneyText').closest('.chip').classList.toggle('low', st.money < REPLACE_COST);
  $('#btnPause').textContent = st.paused ? '▶ RESUME' : '❚❚ PAUSE';
  $('#busData').textContent = st.data ? st.data : '- - - -';

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
  $('#btnFail').disabled = !(st.phase === 'running' && st.disks.some((d) => d.state === 'ok'));
  $('#btnBackup').disabled = !(st.phase === 'running' && !st.backup && st.money >= BACKUP_COST);
  $('#btnBackup').textContent = st.backup ? '\u{1F4BE} Backup Tersimpan \u2713' : `\u{1F4BE} Buat Backup ($${BACKUP_COST})`;
  $('#actionNote').textContent =
    st.raid === 0 && st.phase === 'running' ? 'RAID 0 tidak bisa di-rebuild.' :
    st.disks.some((d) => d.state === 'failed') ? 'Beli disk pengganti ($100) dulu, lalu rebuild.' :
    'Rebuild aktif setelah disk rusak dan diganti.';

  $('#disks').innerHTML = st.disks.map((d, i) => diskHTML(d, i)).join('');
  $('#disks').classList.toggle('demo', !randomOn && st.phase === 'running');
  $('#disks').classList.toggle('run', st.phase === 'running' && !st.paused);
  $$('.buy').forEach((b) => b.addEventListener('click', () => buyReplacement(+b.dataset.d)));

  const hint = $('#vizHint');
  const pendingWin = st.phase === 'running' && st.day >= TARGET_DAY && bad > 0;
  hint.hidden = false;
  if (pendingWin) hint.textContent = 'Selesaikan rebuild dulu untuk menang!';
  else if (st.phase === 'idle' && st.raid === null) hint.textContent = 'Pilih arsitektur RAID di panel kiri untuk memulai';
  else if (st.phase === 'idle') hint.textContent = 'Tekan "Proses Penyimpanan" untuk menyalakan server';
  else hint.hidden = true;
  $('#vizTag').hidden = st.phase === 'idle';

  const r = st.raid !== null ? RAIDS[st.raid] : null;
  const eff = r ? r.eff : 100;
  $('#donut').style.background = `conic-gradient(var(--green) 0 ${eff}%, var(--orange) 0)`;
  $('#donutText').textContent = (r ? eff : '00') + '%';
  $('#legCap').textContent = (r ? eff : 100) + '%';
  $('#legRed').textContent = (r ? 100 - eff : 0) + '%';
  $('#raidInfo').textContent = r ? r.info : 'Pilih tipe RAID untuk melihat penjelasan konsepnya.';
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
      cells += `<div class="cell on ${color} ${x.t === 'mir' ? 'mir' : ''}">${x.t === 'par' ? x.v : esc(x.ch)}${x.t === 'par' ? '<span class="ptag">PAR</span>' : ''}</div>`;
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
  sendPackets(str);
  const T = 700 + str.length * 110;
  if (st.raid === 5) setTimeout(() => log('Menghitung parity XOR tiap stripe...'), T - 350);
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
  }, T);
}

function sendPackets(str) {
  const wrap = $('.bus-wrap');
  [...str].forEach((ch, i) => setTimeout(() => {
    if (!st.layout || !st.layout.route[i]) return;
    st.layout.route[i].forEach((d) => {
      const p = document.createElement('div');
      p.className = 'bus-packet c' + (ch.charCodeAt(0) % 4);
      p.textContent = ch; p.style.left = '50%'; p.style.top = '20px';
      wrap.appendChild(p);
      requestAnimationFrame(() => requestAnimationFrame(() => { p.style.left = (12.5 + d * 25) + '%'; p.style.top = '84px'; }));
      setTimeout(() => p.remove(), 700);
    });
  }, 250 + i * 110));
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
  floatText('-$' + REPLACE_COST, $('#moneyText'), '#e04b3a');
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
    const row = L[i].findIndex((c) => c);
    if (row >= 0) {
      const mine = L[i][row];
      const others = [0, 1, 2, 3].filter((d) => d !== i).map((d) => L[d][row]).filter(Boolean);
      const hex = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');
      const code = (c) => (c.t === 'par' ? c.val : c.ch.charCodeAt(0));
      const calc = others.map((c) => (c.t === 'par' ? `P(${hex(c.val)})` : `${c.ch}(${hex(code(c))})`)).join(' \u2295 ');
      const res = others.reduce((a, c) => a ^ code(c), 0);
      return mine.t === 'par' ? `${calc} = ${hex(res)} \u2192 parity dihitung ulang`
                              : `${calc} = ${hex(res)} \u2192 data "${mine.ch}" pulih`;
    }
    return 'Menghitung ulang parity dari disk yang selamat...';
  }
  const src = st.raid === 10 ? i ^ 1 : st.disks.findIndex((d, n) => n !== i && d.state === 'ok');
  return `Menyalin data dari Disk ${src + 1} (mirror sehat) ke Disk ${i + 1}...`;
}

function togglePause() {
  if (st.phase !== 'running') return;
  st.paused = !st.paused;
  log(st.paused ? 'Server di-pause.' : 'Server dilanjutkan.', 'warn');
  render();
}

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
        log(`Rebuild Disk ${i + 1} selesai. Data pulih.`); sfx.ok(); burst($$('#disks .disk')[i], '\u2728', 8);
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
  if (st._needRender) { st._needRender = false; render(); }
}

function nextDay() {
  st.day++;
  st.money += RAIDS[st.raid].income;
  floatText('+$' + RAIDS[st.raid].income, $('#moneyText'));
  st._needRender = true;
  log(`Hari ${st.day}: server menghasilkan +$${RAIDS[st.raid].income}`);
  if (st.heat > 0) st.heat--;
  if (st.day < TARGET_DAY) randomEvent();
  if (st.day < TARGET_DAY && randomOn) {
    const rebuilding = st.disks.some((d) => d.state === 'rebuilding');
    const chance = (0.06 + st.day * 0.006) * (rebuilding ? 1.5 : 1) * (st.heat > 0 ? 2 : 1);
    if (Math.random() < chance) failDisk();
  }
  evaluate();
  render();
}

function failDisk(idx) {
  if (st.phase !== 'running') return;
  const healthy = [0, 1, 2, 3].filter((i) => st.disks[i].state === 'ok');
  if (!healthy.length) return;
  const i = healthy.includes(idx) ? idx : healthy[Math.floor(Math.random() * healthy.length)];
  st.disks[i].state = 'failed';
  st.disks[i].cells = Array(12).fill(null);
  flash('shake', 500); alarm(); sfx.fail();
  log(`!! ERROR: Disk ${i + 1} terbakar / tidak merespons`, 'err');
  if (st.raid !== 0 && survives())
    log(`Mode DEGRADED: ${RAIDS[st.raid].name} tetap berjalan. Beli pengganti untuk Disk ${i + 1}`, 'warn');
  evaluate();
  render();
  burst($$('#disks .disk')[i], '\u{1F525}', 10);
}

function survives() {
  const bad = st.disks.map((d) => d.state !== 'ok'), n = bad.filter(Boolean).length;
  if (st.raid === 0) return n === 0;
  if (st.raid === 5) return n <= 1;
  if (st.raid === 1) return n < 4;
  return !((bad[0] && bad[1]) || (bad[2] && bad[3])); 
}

function makeBackup() {
  if (st.phase !== 'running' || st.backup || st.money < BACKUP_COST) return;
  st.money -= BACKUP_COST; st.backup = true; sfx.ok();
  log(`Backup eksternal dibuat ($${BACKUP_COST}). RAID bukan pengganti backup!`, 'warn');
  render();
}
function restoreBackup() {
  st.backup = false; st.money = Math.max(0, st.money - RESTORE_FEE);
  st.disks.forEach((d, i) => { d.state = 'ok'; d.prog = 0; d.cells = st.layout[i].slice(); });
  alarm(); sfx.fail(); st._needRender = true;
  log(`DATA HILANG! Dipulihkan dari backup (denda restore $${RESTORE_FEE}).`, 'warn');
}
function randomEvent() {
  if (Math.random() > 0.14) return;
  const e = Math.floor(Math.random() * 3);
  if (e === 0) { const b = 80 + Math.floor(Math.random() * 71); st.money += b; log(`\u{1F4B8} Klien baru membayar bonus +$${b}`, 'warn'); sfx.ok(); }
  else if (e === 1) { st.money = Math.max(0, st.money - 60); log('\u{1F4CB} Audit keamanan: denda -$60', 'warn'); }
  else { st.heat = 3; log('\u{1F525} Ruang server panas! Risiko disk rusak 2x selama 3 hari', 'err'); }
}
function alarm() { document.body.classList.add('alarm'); setTimeout(() => document.body.classList.remove('alarm'), 750); }
let audioCtx = null, soundOn = true;
function beep(f, d = .12, type = 'square', v = .05, when = 0) {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime + when;
    o.type = type; o.frequency.value = f; g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.001, t + d);
    o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + d);
  } catch (e) {}
}
const sfx = {
  fail: () => { beep(180, .25, 'sawtooth', .08); beep(120, .3, 'sawtooth', .08, .12); },
  ok: () => { beep(520, .1); beep(780, .14, 'square', .05, .1); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => beep(f, .2, 'square', .06, i * .13)),
  over: () => [300, 220, 150].forEach((f, i) => beep(f, .28, 'sawtooth', .07, i * .2)),
};
function setSound(on) { soundOn = on; store('sound', on ? '1' : '0'); $('#btnSound').textContent = 'SUARA: ' + (on ? 'ON' : 'OFF'); if (on) beep(660, .06); }
function updateBest() { const b = +load('best') || 0, t = $('#bestTag'); t.hidden = !b; t.textContent = '\u{1F3C6} REKOR SKOR: $' + b; }

function evaluate() {
  if (st.phase !== 'running') return;
  const bad = badCount();
  if (!survives()) {
    if (st.backup) return restoreBackup();
    const reasons = {
      0: 'RAID 0: 1 disk rusak = data hilang',
      5: '2 disk RAID 5 rusak bersamaan',
      1: 'Keempat salinan RAID 1 rusak bersamaan',
      10: 'Kedua disk dalam satu pasangan mirror RAID 10 rusak',
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
  log('!! GAME OVER: ' + reason + '.', 'err'); sfx.over(); alarm();
  render();
  $('#overReason').textContent = reason;
  $('#overDay').textContent = 'Hari ' + st.day;
  $('#overPts').textContent = '$' + st.money;
  $('#overRaid').textContent = RAIDS[st.raid].name;
  setTimeout(() => { $('#ovOver').hidden = false; }, 500);
}

function win() {
  st.phase = 'over';
  log('Hari ke-30 tercapai. Server selamat!'); sfx.win();
  render();
  const total = st.money + WIN_BONUS;
  $('#winRaidLbl').textContent = `Poin Akhir (${RAIDS[st.raid].name})`;
  $('#winPts').textContent = '$' + st.money;
  $('#winBonus').textContent = '+$' + WIN_BONUS;
  $('#winTotal').textContent = '$' + total;
  const stars = total >= 2900 ? 3 : total >= 2400 ? 2 : 1;
  $('#rankTag').textContent = ['', 'JUNIOR ADMIN', 'SENIOR ADMIN', 'SYSADMIN LEGEND'][stars];
  if (total > (+load('best') || 0)) { store('best', total); $('#rankTag').textContent += ' \u00B7 REKOR BARU!'; }
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
  updateBest();
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
function setRandom(on) {
  randomOn = on; store('random', on ? '1' : '0');
  $$('#randRow .btn').forEach((x) => x.classList.toggle('active', (x.dataset.r === '1') === on));
  if (st) render();
}
function setSpeed(ms) {
  dayMs = ms; store('speed', ms);
  $$('#speedRow .btn').forEach((x) => x.classList.toggle('active', +x.dataset.ms === ms));
}

function init() {
  st = newState();
  if (load('dark') === '1') setDark(true);
  if (load('speed')) setSpeed(+load('speed'));
  setRandom(load('random') !== '0');
  setSound(load('sound') !== '0');
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
  $('#btnFail').onclick = () => failDisk();
  $('#btnBackup').onclick = makeBackup;
  $('#btnSound').onclick = () => setSound(!soundOn);
  $$('#randRow .btn').forEach((b) => (b.onclick = () => setRandom(b.dataset.r === '1')));
  $$('.raid-btn').forEach((b) => (b.onclick = () => selectRaid(+b.dataset.raid)));

  $('#dataInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/\s/g, '');
    st.data = e.target.value;  // (bug asli: di-reset '' sehingga tombol tak pernah aktif)
    render();
  });
  $('#dataInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') storeData(); });

  $$('#speedRow .btn').forEach((b) => (b.onclick = () => setSpeed(+b.dataset.ms)));

  $('#btnRetry').onclick = () => { resetGame(); };
  $('#btnAgain').onclick = () => { resetGame(); };
  $('#btnMenu1').onclick = $('#btnMenu2').onclick = () => { resetGame(); showScreen('startScreen'); };

  $('#ovHelp').addEventListener('click', (e) => { if (e.target === $('#ovHelp')) closeHelp(); });
  $('#ovSettings').addEventListener('click', (e) => { if (e.target === $('#ovSettings')) $('#ovSettings').hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#ovHelp').hidden) closeHelp();
    else if (!$('#ovSettings').hidden) $('#ovSettings').hidden = true;
  });

  $('#disks').addEventListener('click', (e) => {   // mode demo: klik disk untuk merusaknya
    const el = e.target.closest('.disk');
    if (!el || !el.parentNode || randomOn || st.phase !== 'running') return;
    const i = [...el.parentNode.children].indexOf(el);
    if (st.disks[i] && st.disks[i].state === 'ok') failDisk(i);
  });
  rsInit(); duInit(); fxInit(); tourInit(); olInit();
  lastTick = performance.now();
  loopId = requestAnimationFrame(loop);
}

const RS = { round: 0, total: 8, score: 0, streak: 0, lives: 3, left: 0, tl: 25, timer: null, q: null, bits: [], hint: false, locked: false };
const bin8 = (n) => n.toString(2).padStart(8, '0');
const hex2 = (n) => '0x' + n.toString(16).toUpperCase().padStart(2, '0');

function rsStart() {
  Object.assign(RS, { round: 0, score: 0, streak: 0, lives: 3 });
  RS.total = T.active ? 5 : 8;
  $('#ovRescue').hidden = true; showScreen('rescueScreen'); rsNext();
}
function rsNext() {
  clearInterval(RS.timer);
  if (RS.round >= RS.total) return rsEnd(true);
  RS.round++;
  RS.q = T.active ? T.puzzles[RS.round - 1] : genPuzzle();   // turnamen: soal sama untuk semua pemain
  Object.assign(RS, { bits: Array(8).fill(0), left: RS.tl, hint: false, locked: false });
  $('#rsMsg').textContent = '';
  rsRender();
  RS.timer = setInterval(rsTick, 100);
}
function rsTick() {
  if (RS.locked) return;
  RS.left -= 0.1;
  $('#rsTime').style.width = Math.max(0, RS.left / RS.tl * 100) + '%';
  $('#rsTime').parentNode.classList.toggle('low', RS.left < 7);
  if (RS.left <= 0) rsWrong('Waktu habis!');
}
function rsStats() {
  $('#rsRound').textContent = `${Math.min(RS.round, RS.total)}/${RS.total}`;
  $('#rsScore').textContent = RS.score;
  $('#rsLives').textContent = '\u2764'.repeat(RS.lives) + '\u{1F5A4}'.repeat(3 - RS.lives);
  $('#rsStreak').textContent = 'STREAK x' + RS.streak;
}
function rsRender() {
  const q = RS.q;
  const rows = q.disks.map((d, i) => {
    if (i === q.dead) {
      const btns = RS.bits.map((b, n) => `<button class="rs-bit ${b ? 'on' : ''}" data-n="${n}">${b}</button>`).join('');
      return `<div class="rs-row dead"><div class="rs-lbl">Disk ${i + 1} \u{1F4A5}<small>HANCUR: isi ulang!</small></div><div class="rs-bits">${btns}</div></div>`;
    }
    const lbl = d.par ? 'PARITY' : 'DATA "' + String.fromCharCode(d.v) + '"';
    return `<div class="rs-row ${d.par ? 'par' : ''}"><div class="rs-lbl">Disk ${i + 1}<small>${lbl}</small></div><div class="rs-bits">${[...bin8(d.v)].map((c) => `<b>${c}</b>`).join('')}</div></div>`;
  });
  if (RS.hint) {
    const known = q.disks.filter((_, i) => i !== q.dead);
    const cnt = [...Array(8).keys()].map((n) => `<b>${known.filter((d) => bin8(d.v)[n] === '1').length}</b>`).join('');
    rows.push(`<div class="rs-row"><div class="rs-lbl">Jumlah angka 1<small>ganjil=1, genap=0</small></div><div class="rs-bits hint">${cnt}</div></div>`);
  }
  $('#rsBoard').innerHTML = rows.join('');
  const v = parseInt(RS.bits.join(''), 2);
  $('#rsPrev').textContent = `${RS.bits.join('')} = ${hex2(v)} = ${v}` + (v >= 32 && v < 127 ? ` = "${String.fromCharCode(v)}"` : '');
  rsStats();
}
function rsCheck() {
  if (RS.locked) return;
  const v = parseInt(RS.bits.join(''), 2);
  if (v !== RS.q.ans) return rsWrong('Salah! XOR-nya belum tepat.');
  RS.locked = true; clearInterval(RS.timer);
  const pts = Math.round((100 + RS.left * 5) * (1 + RS.streak * 0.25) * (RS.hint ? 0.5 : 1));
  RS.score += pts; RS.streak++; sfx.ok(); rsStats(); floatText('+' + pts, $('#rsScore'));
  $('#rsMsg').textContent = `\u2705 Benar! +${pts} poin`;
  setTimeout(rsNext, 1400);
}
function rsWrong(msg) {
  RS.lives--; RS.streak = 0; sfx.fail(); alarm(); rsStats();
  const b = $('#rsBoard'); b.classList.add('shake'); setTimeout(() => b.classList.remove('shake'), 400);
  if (RS.lives <= 0) {
    RS.locked = true; clearInterval(RS.timer);
    $('#rsMsg').textContent = '\u274C ' + msg;
    return setTimeout(() => rsEnd(false), 900);
  }
  if (RS.left <= 0) {
    RS.locked = true; clearInterval(RS.timer);
    $('#rsMsg').textContent = `\u23F0 Waktu habis! Jawabannya ${bin8(RS.q.ans)}`;
    setTimeout(rsNext, 1800);
  } else $('#rsMsg').textContent = '\u274C ' + msg;
}
function rsEnd(done) {
  clearInterval(RS.timer);
  if (T.active) return tourNext(RS.score);
  const best = Math.max(+load('rsbest') || 0, RS.score); store('rsbest', best);
  $('#rsEndTitle').textContent = done ? 'DATA SELAMAT!' : 'DATA HILANG!';
  $('#rsEndRank').textContent = RS.score >= 2000 ? 'XOR MASTER' : RS.score >= 1000 ? 'SENIOR ADMIN' : 'JUNIOR ADMIN';
  $('#rsEndScore').textContent = RS.score;
  $('#rsEndRound').textContent = `${Math.min(RS.round, RS.total)}/${RS.total}`;
  $('#rsEndBest').textContent = best;
  $('#ovRescue').hidden = false;
  if (done) { sfx.win(); confetti(); } else sfx.over();
}
function rsInit() {
  $('#btnRescue').onclick = rsStart;
  $('#rsBack').onclick = () => { T.active = false; clearInterval(RS.timer); showScreen('startScreen'); };
  $('#rsCheck').onclick = rsCheck;
  $('#rsHint').onclick = () => { if (!RS.locked && !RS.hint) { RS.hint = true; rsRender(); } };
  $('#rsAgain').onclick = rsStart;
  $('#rsMenu').onclick = () => { $('#ovRescue').hidden = true; showScreen('startScreen'); };
  $('#rsBoard').addEventListener('click', (e) => {
    const b = e.target.closest('.rs-bit');
    if (!b || RS.locked) return;
    RS.bits[+b.dataset.n] ^= 1; beep(500, .04); rsRender();
  });
}

function floatText(text, el, color) {
  const r = (el || document.body).getBoundingClientRect(), s = document.createElement('div');
  s.className = 'float-text'; s.textContent = text;
  s.style.left = r.left + r.width / 2 + 'px'; s.style.top = r.top + 'px';
  if (color) s.style.color = color;
  document.body.appendChild(s); setTimeout(() => s.remove(), 1100);
}
function burst(el, emoji, n = 8) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  for (let i = 0; i < n; i++) {
    const s = document.createElement('div'), a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 70;
    s.className = 'particle'; s.textContent = emoji;
    s.style.left = r.left + r.width / 2 + 'px'; s.style.top = r.top + r.height / 2 + 'px';
    s.style.setProperty('--dx', Math.cos(a) * d + 'px'); s.style.setProperty('--dy', Math.sin(a) * d - 30 + 'px');
    document.body.appendChild(s); setTimeout(() => s.remove(), 900);
  }
}
function fxInit() {
  const lg = $('.logo'); lg.setAttribute('aria-label', lg.textContent);
  lg.innerHTML = [...lg.textContent].map((c, i) => `<span aria-hidden="true" style="animation-delay:${i * .09}s">${c}</span>`).join('');
  $$('.screen').forEach((s) => {   // hujan bit 0/1 sebagai latar
    const r = document.createElement('div'); r.className = 'bitrain'; r.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 22; i++) {
      const b = document.createElement('span'); b.textContent = Math.random() < .5 ? '0' : '1';
      b.style.cssText = `left:${Math.random() * 100}%;animation-duration:${8 + Math.random() * 10}s;animation-delay:${-Math.random() * 14}s;font-size:${12 + Math.random() * 16}px`;
      r.appendChild(b);
    }
    s.prepend(r);
  });
}

const D = { round: 0, max: 7, need: 3, tl: 20, left: 0, wins: [0, 0], bits: [], stun: [0, 0], q: null, timer: null, locked: true };
const KEYS = [['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'], ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8']];
const KEYLBL = [['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K'], ['1', '2', '3', '4', '5', '6', '7', '8']];

function genPuzzle() {
  const d = Array.from({ length: 3 }, () => 65 + Math.floor(Math.random() * 26));
  const par = d[0] ^ d[1] ^ d[2], p = Math.floor(Math.random() * 4); let k = 0;
  const disks = [0, 1, 2, 3].map((i) => (i === p ? { v: par, par: true } : { v: d[k++], par: false }));
  const dead = Math.floor(Math.random() * 4);
  return { disks, dead, ans: disks[dead].v };
}
function duStart() {
  Object.assign(D, { round: 0, wins: [0, 0] });
  $('#ovDuel').hidden = true; showScreen('duelScreen'); duNext();
}
function duNext() {
  clearInterval(D.timer);
  if (D.wins[0] >= D.need || D.wins[1] >= D.need || D.round >= D.max) return duEnd();
  D.round++; D.q = genPuzzle(); D.bits = [Array(8).fill(0), Array(8).fill(0)];
  D.stun = [0, 0]; D.left = D.tl; D.locked = true;
  $('#duMsg').textContent = ''; $('#duTime').style.width = '100%';
  $('#duQ').textContent = `Disk ${D.q.dead + 1} hancur! Siapa paling cepat menghitung XOR-nya? P1: tombol A-K + SPASI \u00B7 P2: tombol 1-8 + ENTER (atau klik/tap).`;
  duRender();
  const seq = D.round === 1 ? ['3', '2', '1', 'GO!'] : ['RONDE ' + D.round, 'GO!'], el = $('#duCount');
  let i = 0; el.hidden = false;
  const step = () => {
    if (i >= seq.length) { el.hidden = true; D.locked = false; D.timer = setInterval(duTick, 100); return; }
    el.textContent = seq[i]; el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    beep(i === seq.length - 1 ? 880 : 440, .12); i++; setTimeout(step, D.round === 1 ? 650 : 800);
  };
  step();
}
function duTick() {
  if (D.locked) return;
  D.left -= 0.1; $('#duTime').style.width = Math.max(0, D.left / D.tl * 100) + '%';
  $('#duTime').parentNode.classList.toggle('low', D.left < 6);
  let redraw = false;
  [0, 1].forEach((p) => { if (D.stun[p] > 0) { D.stun[p] -= 100; if (D.stun[p] <= 0) redraw = true; } });
  if (redraw) duRender();
  if (D.left <= 0) {
    D.locked = true; clearInterval(D.timer); sfx.fail();
    $('#duMsg').textContent = `\u23F0 Waktu habis! Jawabannya ${bin8(D.q.ans)}`; setTimeout(duNext, 1900);
  }
}
function duRender() {
  const q = D.q;
  $('#duRound').textContent = D.round;
  $('#duPuzzle').innerHTML = q.disks.map((d, i) => i === q.dead
    ? `<div class="rs-row dead"><div class="rs-lbl">Disk ${i + 1} \u{1F4A5}<small>HANCUR</small></div><div class="rs-bits"><b class="qm">?</b><b class="qm">?</b><b class="qm">?</b><b class="qm">?</b><b class="qm">?</b><b class="qm">?</b><b class="qm">?</b><b class="qm">?</b></div></div>`
    : `<div class="rs-row ${d.par ? 'par' : ''}"><div class="rs-lbl">Disk ${i + 1}<small>${d.par ? 'PARITY' : 'DATA "' + String.fromCharCode(d.v) + '"'}</small></div><div class="rs-bits">${[...bin8(d.v)].map((c) => `<b>${c}</b>`).join('')}</div></div>`).join('');
  $('#duPlayers').innerHTML = [0, 1].map((p) => {
    const v = parseInt(D.bits[p].join(''), 2);
    const btns = D.bits[p].map((b, n) => `<button class="rs-bit ${b ? 'on' : ''}" data-p="${p}" data-n="${n}">${b}<kbd>${KEYLBL[p][n]}</kbd></button>`).join('');
    return `<div class="du-p p${p} ${D.stun[p] > 0 ? 'stun' : ''}"><div class="du-ph"><b>PLAYER ${p + 1}</b><span>${'\u2B50'.repeat(D.wins[p])}${'\u2606'.repeat(D.need - D.wins[p])}</span></div><div class="rs-bits">${btns}</div><div class="rs-prev">${D.stun[p] > 0 ? '\u{1F635} STUN!' : hex2(v) + ' = ' + v}</div><button class="btn ${p ? 'pink' : 'blue'}" data-submit="${p}">${p ? 'ENTER' : 'SPASI'} \u2714 KIRIM</button></div>`;
  }).join('');
}
function duToggle(p, n) {
  if (D.locked || D.stun[p] > 0) return;
  D.bits[p][n] ^= 1; beep(p ? 620 : 480, .04); duRender();
}
function duSubmit(p) {
  if (D.locked || D.stun[p] > 0) return;
  if (parseInt(D.bits[p].join(''), 2) === D.q.ans) {
    D.locked = true; clearInterval(D.timer); D.wins[p]++; sfx.ok();
    $('#duMsg').textContent = `\u{1F3C6} PLAYER ${p + 1} MENANG RONDE ${D.round}!`; duRender();
    burst($$('.du-p')[p], '\u2B50', 12); setTimeout(duNext, 1700);
  } else {
    D.stun[p] = 2000; sfx.fail(); duRender();
    floatText('SALAH! STUN 2 dtk', $$('.du-p')[p], '#e04b3a');
  }
}
function duEnd() {
  clearInterval(D.timer);
  const [a, b] = D.wins, w = a === b ? -1 : a > b ? 0 : 1;
  $('#duEndTitle').textContent = w < 0 ? 'SERI!' : `PLAYER ${w + 1} MENANG!`;
  $('#duEndRank').textContent = w < 0 ? 'IMBANG' : 'JUARA';
  $('#duEndScore').textContent = `${a} : ${b}`; $('#duEndRound').textContent = D.round;
  $('#ovDuel').hidden = false;
  if (w < 0) sfx.over(); else { sfx.win(); confetti(); }
}
function duInit() {
  $('#btnDuel').onclick = duStart; $('#duAgain').onclick = duStart;
  $('#duBack').onclick = () => { clearInterval(D.timer); D.locked = true; $('#duCount').hidden = true; showScreen('startScreen'); };
  $('#duMenu').onclick = () => { $('#ovDuel').hidden = true; showScreen('startScreen'); };
  $('#duPlayers').addEventListener('click', (e) => {
    const b = e.target.closest('.rs-bit'), s = e.target.closest('[data-submit]');
    if (b) duToggle(+b.dataset.p, +b.dataset.n); else if (s) duSubmit(+s.dataset.submit);
  });
  document.addEventListener('keydown', (e) => {
    if (!$('#duelScreen').classList.contains('active') || e.repeat) return;
    for (let p = 0; p < 2; p++) { const n = KEYS[p].indexOf(e.code); if (n >= 0) { e.preventDefault(); return duToggle(p, n); } }
    if (e.code === 'Space') { e.preventDefault(); duSubmit(0); }
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); duSubmit(1); }
  });
}

/* ================= TURNAMEN (2-6 PEMAIN, BERGILIRAN) ================= */
const T = { active: false, players: [], idx: 0, puzzles: [], names: [] };
function tourOpen() {
  $('#tourNames').innerHTML = Array.from({ length: 6 }, (_, i) => `<input class="tour-in" maxlength="12" placeholder="Pemain ${i + 1}" autocomplete="off">`).join('');
  $$('.tour-in').forEach((x, i) => (x.value = T.names[i] || ''));
  $('#ovTour').hidden = false; $$('.tour-in')[0].focus();
}
function tourStart() {
  T.names = $$('.tour-in').map((x) => x.value.trim());
  const list = T.names.filter(Boolean);
  if (list.length < 2) return floatText('Minimal 2 pemain!', $('#tourGo'), '#e04b3a');
  Object.assign(T, { active: true, players: list.map((name) => ({ name, score: 0 })), idx: -1, puzzles: Array.from({ length: 5 }, genPuzzle) });
  $('#ovTour').hidden = true; $('#ovBoard').hidden = true; tourNext();
}
function tourNext(score) {
  if (T.idx >= 0) T.players[T.idx].score = score;
  T.idx++;
  if (T.idx >= T.players.length) return tourBoard();
  const sp = $('#turnSplash');
  sp.innerHTML = `<div class="splash-name">GILIRAN<span>${esc(T.players[T.idx].name)}</span><small>${T.idx + 1} dari ${T.players.length} pemain</small></div>`;
  sp.hidden = false; sp.style.animation = 'none'; void sp.offsetWidth; sp.style.animation = ''; sfx.ok();
  setTimeout(() => { sp.hidden = true; if (T.active) rsStart(); }, 1900);
}
function tourBoard() {
  T.active = false;
  const r = [...T.players].sort((a, b) => b.score - a.score), hgt = [150, 110, 80];
  $('#podium').innerHTML = [1, 0, 2].filter((i) => r[i]).map((i) =>
    `<div class="pod p${i}"><div class="pod-n">${i === 0 ? '\u{1F451}<br>' : ''}${esc(r[i].name)}<small>${r[i].score}</small></div><div class="pod-bar" style="height:${hgt[i]}px;animation-delay:${(2 - i) * .35}s">${i + 1}</div></div>`).join('');
  $('#boardList').innerHTML = r.map((p, i) => `<div class="stat ${['yellow', 'mint', 'purple'][i] || 'cream'}"><span>#${i + 1} ${esc(p.name)}</span><b>${p.score}</b></div>`).join('');
  showScreen('startScreen'); $('#ovBoard').hidden = false; sfx.win(); confetti();
}
function tourInit() {
  $('#btnTour').onclick = tourOpen; $('#tourGo').onclick = tourStart;
  $('#tourCancel').onclick = () => ($('#ovTour').hidden = true);
  $('#tourAgain').onclick = () => { $('#ovBoard').hidden = true; tourOpen(); };
  $('#tourMenu').onclick = () => { $('#ovBoard').hidden = true; showScreen('startScreen'); };
  $('#tourNames').addEventListener('keydown', (e) => { if (e.key === 'Enter') tourStart(); });
}

const NET = { peer: null, host: false, code: '', id: '', name: '', conns: {}, hc: null };
let OG = null, lastEvt = 0, lastPhase = '';
const HOST = { ans: 0, stun: {}, cd: {}, timer: null, seq: 0, evt: null, gen: 0 };
const MAXP = 8, CODECH = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const ORDER = [['r1', 0], ['r1', 1], ['r1', 2], ['r1', 3], ['r2', 0], ['r2', 1], ['fin', 0]];
const genCode = () => Array.from({ length: 4 }, () => CODECH[Math.floor(Math.random() * CODECH.length)]).join('');
const pname = (id) => ((OG && OG.players.find((p) => p.id === id)) || {}).name || '?';


function olStatus(t, bad) { const s = $('#olStatus'); s.textContent = t; s.classList.toggle('bad', !!bad); }
function olOpen() {
  $('#olName').value = load('olname') || ''; olStatus('');
  $('#ovOnline').hidden = false; ($('#olCode').value ? $('#olName') : $('#olName')).focus();
}
function olName() {
  const n = $('#olName').value.trim().slice(0, 12);
  if (!n) { olStatus('Isi nama dulu ya.', 1); return ''; }
  store('olname', n); return n;
}
function olReady() { if (typeof Peer === 'undefined') { olStatus('PeerJS belum termuat. Cek internet lalu muat ulang halaman.', 1); return false; } return true; }
function olCreate() {
  const name = olName(); if (!name || !olReady()) return;
  olStatus('Membuat room...');
  const code = genCode(), peer = new Peer('raidshield-' + code);
  peer.on('open', () => {
    Object.assign(NET, { peer, host: true, code, id: 'host', name, conns: {} });
    OG = { phase: 'lobby', mode: 'duel', host: 'host', players: [{ id: 'host', name }] };
    $('#ovOnline').hidden = true; olEnter();
  });
  peer.on('connection', (c) => {
    c.on('data', (m) => hostMsg(c, m));
    c.on('close', () => hostDrop(c.peer)); c.on('error', () => hostDrop(c.peer));
  });
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id') { try { peer.destroy(); } catch (x) {} olCreate(); }
    else if (!NET.peer) olStatus('Gagal membuat room: ' + e.type, 1);
  });
}
function olJoin() {
  const name = olName(), code = $('#olCode').value.trim().toUpperCase();
  if (!name || !olReady()) return;
  if (code.length !== 4) return olStatus('Kode room terdiri dari 4 huruf.', 1);
  olStatus('Menyambung ke room ' + code + '...');
  const peer = new Peer(); let done = false;
  const fail = (t) => { if (!done) { olStatus(t, 1); try { peer.destroy(); } catch (e) {} } };
  const to = setTimeout(() => fail('Room tidak ditemukan atau koneksi terlalu lambat.'), 12000);
  peer.on('open', () => {
    const c = peer.connect('raidshield-' + code, { reliable: true });
    c.on('open', () => c.send({ t: 'hello', name }));
    c.on('data', (m) => {
      if (m.t === 'welcome') {
        clearTimeout(to); done = true;
        Object.assign(NET, { peer, host: false, code, id: m.id, name, hc: c }); $('#ovOnline').hidden = true; olEnter();
      } else if (m.t === 'deny') { clearTimeout(to); fail(m.why); }
      else clientMsg(m);
    });
    c.on('close', () => { if (done) olLeave('Koneksi ke host terputus.'); });
  });
  peer.on('error', (e) => { clearTimeout(to); fail(e.type === 'peer-unavailable' ? 'Room ' + code + ' tidak ditemukan.' : 'Gagal: ' + e.type); });
}
function olEnter() {
  $('#chatLog').innerHTML = ''; lastEvt = 0; lastPhase = '';
  chatAdd('', 'Selamat datang! Bagikan kode room ke temanmu.'); showScreen('roomScreen'); olRender();
}
function olLeave(msg) {
  clearInterval(HOST.timer); HOST.gen++;
  try { NET.peer && NET.peer.destroy(); } catch (e) {}
  Object.assign(NET, { peer: null, host: false, conns: {}, hc: null, code: '' }); OG = null;
  $('#olCount').hidden = true; showScreen('startScreen');
  if (msg) floatText(msg, $('.main-win'), '#e04b3a');
}
function clientMsg(m) {
  if (m.t === 'state') { OG = m.G; olRender(); }
  else if (m.t === 'chat') chatAdd(m.from, m.text);
  else if (m.t === 'tick' && OG && OG.match) { OG.match.left = m.left; olBar(m.left); }
}
const act = (m) => (NET.host ? hostAct('host', m) : NET.hc && NET.hc.send(m));
const bc = (m) => Object.values(NET.conns).forEach((c) => c.open && c.send(m));
function chat(from, text) { bc({ t: 'chat', from, text }); chatAdd(from, text); }
const sys = (t) => chat('', t);
function chatAdd(from, text) {
  const l = $('#chatLog'), d = document.createElement('div');
  d.className = 'cm' + (from ? '' : ' sys'); d.innerHTML = (from ? `<b>${esc(from)}</b> ` : '') + esc(text);
  l.appendChild(d); l.scrollTop = l.scrollHeight; while (l.children.length > 80) l.firstChild.remove();
}

function hostMsg(c, m) {
  if (m.t === 'hello') {
    if (!OG || OG.phase !== 'lobby') return c.send({ t: 'deny', why: 'Game sedang berjalan, coba lagi setelah selesai.' });
    if (OG.players.length >= MAXP) return c.send({ t: 'deny', why: 'Room penuh (maksimal 8 pemain).' });
    const name = String(m.name || 'Pemain').slice(0, 12);
    NET.conns[c.peer] = c; OG.players.push({ id: c.peer, name });
    c.send({ t: 'welcome', id: c.peer }); sys(`${name} bergabung`); push();
  } else if (NET.conns[c.peer]) hostAct(c.peer, m);
}
function hostAct(id, m) {
  if (m.t === 'chat') return chat(pname(id), String(m.text || '').slice(0, 120));
  if (m.t === 'toggle') return hToggle(id, m.n);
  if (m.t === 'submit') return hSubmit(id);
  if (m.t === 'attack') return hAttack(id, m.to);
  if (id !== 'host') return;
  if (m.t === 'mode' && OG.phase === 'lobby') { OG.mode = m.m === 'tour' ? 'tour' : 'duel'; push(); }
  else if (m.t === 'start' && OG.phase === 'lobby') hStart();
  else if (m.t === 'lobby') hLobby();
}
function push() {
  const now = Date.now(), M = OG.match;
  if (M) {
    M.stunL = {}; M.cdL = {}; M.prog = {};
    M.ids.forEach((i) => {
      M.stunL[i] = Math.max(0, (HOST.stun[i] || 0) - now); M.cdL[i] = Math.max(0, (HOST.cd[i] || 0) - now);
      M.prog[i] = M.bits[i] ? M.bits[i].filter((b, n) => b === ((HOST.ans >> (7 - n)) & 1)).length : 0;
    });
  }
  OG.evt = HOST.evt;
  Object.entries(NET.conns).forEach(([id, c]) => {
    if (!c.open) return;
    const G = { ...OG }; if (M) G.match = { ...M, bits: M.bits[id] ? { [id]: M.bits[id] } : {} };
    c.send({ t: 'state', G });
  });
  olRender();
}
function hStart() {
  const n = OG.players.length;
  if (n < 2) return sys('Butuh minimal 2 pemain untuk mulai.');
  if (OG.mode === 'duel' && n > 4) return sys('Mode DUEL maksimal 4 pemain. Pakai TURNAMEN untuk lebih banyak.');
  HOST.gen++; OG.champ = null;
  if (OG.mode === 'duel') return newMatch(OG.players.map((p) => p.id), 3);
  const ids = OG.players.map((p) => p.id).sort(() => Math.random() - 0.5);
  OG.br = { r1: Array.from({ length: 8 }, (_, i) => ids[i] || null), r2: [null, null, null, null], fin: [null, null], champ: null, k: -1, cur: null };
  tourAdvance();
}
function hLobby() { clearInterval(HOST.timer); HOST.gen++; Object.assign(OG, { phase: 'lobby', match: null, br: null, champ: null }); push(); }
function newMatch(ids, need) {
  OG.match = { ids, need, max: need * 2 - 1, wins: Object.fromEntries(ids.map((i) => [i, 0])), round: 0 };
  nextRound();
}
function nextRound() {
  const M = OG.match, g = HOST.gen;
  const lead = Object.entries(M.wins).sort((a, b) => b[1] - a[1]);
  if (lead[0][1] >= M.need || M.round >= M.max) {
    const top = lead.filter(([, v]) => v === lead[0][1]);
    return endMatch(top[Math.floor(Math.random() * top.length)][0]);
  }
  M.round++; const q = genPuzzle(); HOST.ans = q.ans; M.q = { disks: q.disks, dead: q.dead };
  M.bits = {}; M.ids.forEach((i) => (M.bits[i] = Array(8).fill(0)));
  HOST.stun = {}; HOST.cd = {}; M.left = 25; M.msg = '';
  OG.phase = 'count'; let c = 3; OG.cnt = c; push();
  const step = () => {
    if (g !== HOST.gen) return;
    c--;
    if (c > 0) { OG.cnt = c; push(); setTimeout(step, 700); }
    else { OG.phase = 'play'; OG.cnt = 0; push(); clearInterval(HOST.timer); HOST.timer = setInterval(hTick, 250); }
  };
  setTimeout(step, 700);
}
function hTick() {
  const M = OG.match; if (!M || OG.phase !== 'play') return;
  M.left = Math.round((M.left - 0.25) * 100) / 100; bc({ t: 'tick', left: M.left }); olBar(M.left);
  if (M.left <= 0) return endRound(null);
  if (Math.round(M.left * 4) % 4 === 0) push();
}
function hToggle(id, n) {
  const M = OG.match;
  if (OG.phase !== 'play' || !M || !M.bits[id] || (HOST.stun[id] || 0) > Date.now() || !(n >= 0 && n < 8)) return;
  M.bits[id][n] ^= 1; push();
}
function hSubmit(id) {
  const M = OG.match;
  if (OG.phase !== 'play' || !M || !M.bits[id] || (HOST.stun[id] || 0) > Date.now()) return;
  if (parseInt(M.bits[id].join(''), 2) === HOST.ans) { M.wins[id]++; endRound(id); }
  else { HOST.stun[id] = Date.now() + 2000; M.msg = `${pname(id)} salah! STUN 2 dtk`; HOST.evt = { n: ++HOST.seq, k: 'wrong', to: id }; push(); }
}
function hAttack(id, to) {   // saling rusakin disk: 3 bit jawaban lawan teracak
  const M = OG.match, now = Date.now();
  if (OG.phase !== 'play' || !M || !M.bits[id] || !M.bits[to] || id === to || (HOST.cd[id] || 0) > now) return;
  HOST.cd[id] = now + 6000;
  [0, 1, 2, 3, 4, 5, 6, 7].sort(() => Math.random() - 0.5).slice(0, 3).forEach((n) => (M.bits[to][n] ^= 1));
  HOST.stun[to] = Math.max(HOST.stun[to] || 0, now + 800);
  M.msg = `\u{1F4A5} ${pname(id)} merusak disk ${pname(to)}!`; HOST.evt = { n: ++HOST.seq, k: 'hit', from: id, to }; push();
}
function endRound(w) {
  clearInterval(HOST.timer); const M = OG.match, g = HOST.gen; OG.phase = 'between';
  M.msg = w ? `\u{1F3C6} ${pname(w)} menang ronde ${M.round}!` : `\u23F0 Waktu habis! Jawabannya ${bin8(HOST.ans)}`;
  HOST.evt = { n: ++HOST.seq, k: w ? 'win' : 'time', to: w }; M.left = 0; push();
  setTimeout(() => g === HOST.gen && nextRound(), 2200);
}
function endMatch(w) {
  clearInterval(HOST.timer); const g = ++HOST.gen; OG.match.winner = w;
  if (OG.mode === 'duel') { OG.phase = 'over'; OG.champ = w; return push(); }
  OG.phase = 'matchend'; OG.match.msg = `\u2705 ${pname(w)} lolos ke babak berikutnya!`; tourPlace(w); push();
  setTimeout(() => g === HOST.gen && tourAdvance(), 3500);
}
const alive = (x) => (x && OG.players.some((p) => p.id === x) ? x : null);
function tourPair(B, k) { const [r, i] = ORDER[k], a = B[r]; return r === 'fin' ? [alive(a[0]), alive(a[1])] : [alive(a[2 * i]), alive(a[2 * i + 1])]; }
function tourPlace(w) { const B = OG.br, [r, i] = ORDER[B.k]; if (r === 'r1') B.r2[i] = w; else if (r === 'r2') B.fin[i] = w; else B.champ = w; }
function tourAdvance() {
  const B = OG.br; B.k++;
  while (B.k < ORDER.length) {
    const [a, b] = tourPair(B, B.k);
    if (a && b) { B.cur = B.k; return newMatch([a, b], 2); }
    tourPlace(a || b || null); B.k++;   // BYE: lawan kosong, otomatis lolos
  }
  B.cur = null; OG.phase = 'over'; OG.match = null; OG.champ = B.champ; push();
}
function hostDrop(id) {
  if (!NET.conns[id]) return;
  const nm = pname(id); delete NET.conns[id]; OG.players = OG.players.filter((p) => p.id !== id); sys(`${nm} keluar`);
  const M = OG.match;
  if (M && M.ids.includes(id) && ['count', 'play', 'between'].includes(OG.phase)) {
    M.ids = M.ids.filter((i) => i !== id); delete M.bits[id];
    if (M.ids.length < 2) return endMatch(M.ids[0] || null);
  }
  push();
}

function olBar(left) { const b = $('#olTime'); if (b) { b.style.width = Math.max(0, left / 25 * 100) + '%'; b.parentNode.classList.toggle('low', left < 6); } }
function olLink() { return /^https?:/.test(location.protocol) ? location.origin + location.pathname + '?room=' + NET.code : ''; }
function olInvite(kind) {
  const link = olLink(), txt = `Ayo mabar RAID-Shield! Kode room: ${NET.code}` + (link ? `\n${link}` : '');
  if (kind === 'wa') window.open('https://wa.me/?text=' + encodeURIComponent(txt), '_blank');
  else if (kind === 'share' && navigator.share) navigator.share({ title: 'RAID-Shield', text: txt }).catch(() => {});
  else { (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).catch(() => {}); floatText('Undangan tersalin!', $('#rmBody')); }
}
function bracketHTML(B) {
  const bx = (id) => `<div class="bx ${id ? '' : 'bye'}">${id ? esc(pname(id)) : '\u2014'}</div>`;
  const cur = B.cur != null ? ORDER[B.cur] : null, act2 = (r, i) => (cur && cur[0] === r && cur[1] === i ? 'live' : '');
  const pair = (a, i0, r, mi) => `<div class="pair ${act2(r, mi)}">${bx(a[i0])}${bx(a[i0 + 1])}</div>`;
  return `<div class="br-wrap"><div class="br-head"><div class="br-title">JADWAL<br>PERTANDINGAN</div><div class="br-liga">LIGA XOR</div></div><div class="bracket">
    <div class="half"><div class="bcol">${pair(B.r1, 0, 'r1', 0)}${pair(B.r1, 2, 'r1', 1)}</div><div class="bcol">${pair(B.r2, 0, 'r2', 0)}</div></div>
    <div class="fincol">${bx(B.fin[0])}<div class="finbadge ${act2('fin', 0)}">FINAL</div>${bx(B.fin[1])}${B.champ ? `<div class="bx champ">\u{1F3C6} ${esc(pname(B.champ))}</div>` : ''}</div>
    <div class="half rev"><div class="bcol">${pair(B.r1, 4, 'r1', 2)}${pair(B.r1, 6, 'r1', 3)}</div><div class="bcol">${pair(B.r2, 2, 'r2', 1)}</div></div></div></div>`;
}
function olRender() {
  if (!OG) return;
  const me = NET.id, isH = NET.host, M = OG.match; let h = '';
  $('#rmCode').textContent = NET.code;
  if (OG.phase === 'lobby') {
    h += `<div class="rm-code">KODE ROOM<b>${NET.code}</b></div>
      <div class="row"><button class="btn mint" data-ol="copy">\u{1F4CB} Salin undangan</button><button class="btn green" data-ol="wa">\u{1F4AC} WhatsApp</button><button class="btn purple" data-ol="share">\u{1F4E4} Bagikan</button></div>
      <p class="set-label">Pemain (${OG.players.length}/${MAXP})</p>
      <div class="rm-players">${OG.players.map((p) => `<span class="pl ${p.id === me ? 'me' : ''}">${p.id === OG.host ? '\u{1F451} ' : ''}${esc(p.name)}</span>`).join('')}</div>`;
    h += isH
      ? `<p class="set-label">Mode permainan</p><div class="row"><button class="btn ${OG.mode === 'duel' ? 'yellow' : 'cream'}" data-ol="mode" data-m="duel">\u2694 DUEL 2-4</button><button class="btn ${OG.mode === 'tour' ? 'yellow' : 'cream'}" data-ol="mode" data-m="tour">\u{1F3C6} TURNAMEN 2-8</button></div><button class="btn big green" data-ol="start">MULAI!</button>`
      : `<p class="rs-msg">Mode: <b>${OG.mode === 'duel' ? 'DUEL' : 'TURNAMEN'}</b> \u00B7 menunggu host memulai...</p>`;
  } else {
    if (OG.br) h += bracketHTML(OG.br);
    if (M && M.q) {
      const inM = M.ids.includes(me), q = M.q;
      h += `<p class="rs-q"><b>${M.ids.map((i) => esc(pname(i))).join(' vs ')}</b> \u00B7 ronde ${M.round} \u00B7 ${M.need} kemenangan${inM ? '' : ' \u00B7 kamu menonton'}<br>Disk ${q.dead + 1} hancur! Isi XOR-nya paling cepat, atau rusakkan disk lawan!</p>
        <div class="mini-bar rs-time"><b id="olTime" style="width:${Math.max(0, M.left / 25 * 100)}%"></b></div>`;
      h += q.disks.map((d, i) => i === q.dead
        ? `<div class="rs-row dead"><div class="rs-lbl">Disk ${i + 1} \u{1F4A5}<small>HANCUR</small></div><div class="rs-bits">${'<b class="qm">?</b>'.repeat(8)}</div></div>`
        : `<div class="rs-row ${d.par ? 'par' : ''}"><div class="rs-lbl">Disk ${i + 1}<small>${d.par ? 'PARITY' : 'DATA "' + String.fromCharCode(d.v) + '"'}</small></div><div class="rs-bits">${[...bin8(d.v)].map((c) => `<b>${c}</b>`).join('')}</div></div>`).join('');
      h += `<div class="ol-cards">` + M.ids.map((id) => {
        const mine = id === me, stun = (M.stunL || {})[id] > 0, st = '\u2B50'.repeat(M.wins[id]) + '\u2606'.repeat(Math.max(0, M.need - M.wins[id]));
        if (mine) {
          const b = M.bits[me] || Array(8).fill(0), v = parseInt(b.join(''), 2);
          return `<div class="du-p p0 ${stun ? 'stun' : ''}"><div class="du-ph"><b>${esc(pname(id))} (KAMU)</b><span>${st}</span></div><div class="rs-bits">${b.map((x, n) => `<button class="rs-bit ${x ? 'on' : ''}" data-ol="bit" data-n="${n}">${x}<kbd>${KEYLBL[0][n]}</kbd></button>`).join('')}</div><div class="rs-prev">${stun ? '\u{1F635} STUN!' : hex2(v) + ' = ' + v}</div><button class="btn blue" data-ol="submit" ${OG.phase !== 'play' ? 'disabled' : ''}>\u2714 KIRIM (SPASI)</button></div>`;
        }
        const cd = (M.cdL || {})[me] || 0, pr = (M.prog || {})[id] || 0;
        return `<div class="du-p p1 ${stun ? 'stun' : ''}"><div class="du-ph"><b>${esc(pname(id))}</b><span>${st}</span></div><div class="prog"><b style="width:${pr / 8 * 100}%"></b></div><div class="rs-prev">${stun ? '\u{1F635} STUN!' : 'progres ' + pr + '/8 bit benar'}</div>${inM ? `<button class="btn orange" data-ol="atk" data-to="${id}" ${cd > 0 || OG.phase !== 'play' ? 'disabled' : ''}>\u{1F4A5} RUSAKKAN DISK${cd > 0 ? ' (' + Math.ceil(cd / 1000) + 's)' : ''}</button>` : ''}</div>`;
      }).join('') + `</div><div class="rs-msg">${esc(M.msg || '')}</div>`;
    }
    if (OG.phase === 'over') {
      h += `<div class="rm-champ">\u{1F3C6} ${esc(pname(OG.champ))} JUARA!</div>` + (isH ? '<button class="btn big green" data-ol="lobby">KEMBALI KE LOBI</button>' : '<p class="rs-msg">Menunggu host...</p>');
    }
  }
  $('#rmBody').innerHTML = h;
  const cnt = $('#olCount'); cnt.hidden = OG.phase !== 'count';
  if (!cnt.hidden) { cnt.textContent = OG.cnt; cnt.style.animation = 'none'; void cnt.offsetWidth; cnt.style.animation = ''; beep(440, .1); }
  const e = OG.evt;
  if (e && e.n !== lastEvt) {
    lastEvt = e.n;
    if (e.k === 'hit') { burst($('#rmBody'), '\u{1F4A5}', 8); if (e.to === me) { alarm(); sfx.fail(); floatText('DISKMU RUSAK!', $('#rmBody'), '#e04b3a'); } else sfx.ok(); }
    else if (e.k === 'win') { if (e.to === me) { sfx.win(); burst($('#rmBody'), '\u2B50', 12); } else sfx.ok(); }
    else if (e.k === 'wrong' && e.to === me) sfx.fail();
  }
  if (OG.phase === 'over' && lastPhase !== 'over') { sfx.win(); confetti(); }
  lastPhase = OG.phase;
}
function olInit() {
  $('#btnOnline').onclick = olOpen; $('#olCancel').onclick = () => ($('#ovOnline').hidden = true);
  $('#olCreate').onclick = olCreate; $('#olJoin').onclick = olJoin; $('#rmLeave').onclick = () => olLeave();
  $('#olCode').addEventListener('input', (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '')));
  const send = () => { const t = $('#chatIn').value.trim(); if (t) { act({ t: 'chat', text: t }); $('#chatIn').value = ''; } };
  $('#chatSend').onclick = send; $('#chatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  $('#rmBody').addEventListener('pointerdown', (e) => {   // pointerdown: tetap responsif walau layar di-render ulang
    const b = e.target.closest('[data-ol]'); if (!b || b.disabled) return; e.preventDefault();
    const k = b.dataset.ol;
    if (k === 'bit') act({ t: 'toggle', n: +b.dataset.n }); else if (k === 'submit') act({ t: 'submit' });
    else if (k === 'atk') act({ t: 'attack', to: b.dataset.to }); else if (k === 'mode') act({ t: 'mode', m: b.dataset.m });
    else if (k === 'start') act({ t: 'start' }); else if (k === 'lobby') act({ t: 'lobby' });
    else olInvite(k);
  });
  document.addEventListener('keydown', (e) => {
    if (!OG || !$('#roomScreen').classList.contains('active') || e.repeat || document.activeElement.tagName === 'INPUT') return;
    const n = KEYS[0].indexOf(e.code);
    if (n >= 0) { e.preventDefault(); act({ t: 'toggle', n }); } else if (e.code === 'Space') { e.preventDefault(); act({ t: 'submit' }); }
  });
  const room = new URLSearchParams(location.search).get('room');   // link undangan: ?room=KODE
  if (room) { olOpen(); $('#olCode').value = room.toUpperCase().slice(0, 4); $('#olName').focus(); }
}

document.addEventListener('DOMContentLoaded', init);
