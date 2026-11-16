/* Stream Box MVP
 * Host memutar & mencampur audio lokal (Web Audio) -> MediaStream -> WebRTC (PeerJS) ke tiap listener.
 * Signaling: PeerJS Cloud. Tidak ada backend sendiri.
 */
(() => {
  'use strict';

  /* ---------- konfigurasi ---------- */
  const CFG = window.STREAMBOX_CONFIG || {};
  const ICE = CFG.iceServers && CFG.iceServers.length ? CFG.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];
  const BITRATE = CFG.audioBitrate || 128000;
  const MAX_LISTENERS = 20;
  const MAX_FILE = 20 * 1024 * 1024;
  const MAX_ROOM = 100 * 1024 * 1024;
  const FADE_S = 2;
  const ROOM_PREFIX = 'streambox-';
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const CATS = [
    { id: 'bgm', label: 'BGM',           hint: 'Musik latar · loop',     kind: 'stream', loop: true,  vol: 70 },
    { id: 'sfx', label: 'Sound Effects', hint: 'Sekali putar · tombol 1-9', kind: 'buffer', loop: false, vol: 100 },
    { id: 'amb', label: 'Ambience',      hint: 'Suasana · loop',         kind: 'stream', loop: true,  vol: 60 },
  ];
  const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));

  /* ---------- util ---------- */
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* abaikan */ } },
    del: k => { try { localStorage.removeItem(k); } catch { /* abaikan */ } },
  };
  const randCode = (n = 6) =>
    [...crypto.getRandomValues(new Uint8Array(n))].map(x => ALPHABET[x % ALPHABET.length]).join('');
  const cleanNick = s => (s || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  const uid = () => Math.random().toString(36).slice(2, 10);
  const fmtTime = s => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '–:––');
  const hiQuality = sdp => sdp.replace(/useinbandfec=1/g,
    `useinbandfec=1; stereo=1; sprop-stereo=1; maxaveragebitrate=${BITRATE}`);

  const views = ['viewHome', 'viewJoin', 'viewHost', 'viewListener'];
  const show = id => views.forEach(v => $(v).classList.toggle('hidden', v !== id));

  /* ---------- state global ---------- */
  let role = null, roomCode = null, hostNick = '', peer = null;
  let pendingCode = null, resumeHost = false;

  // audio (host)
  let ctx, master, dest, mixStream;
  const chGain = {};
  const tracks = [];
  const conns = new Map(); // peerId -> { conn, call, nick }

  function newPeer(id) {
    const opts = Object.assign({ debug: 1, config: { iceServers: ICE } }, CFG.peerServer || {});
    return id ? new Peer(id, opts) : new Peer(opts);
  }

  /* ======================================================================
   * HOST — audio engine
   * ==================================================================== */
  function initAudio() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    dest = ctx.createMediaStreamDestination();
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(dest);          // ke listener
    master.connect(ctx.destination); // monitor host
    for (const c of CATS) {
      const g = ctx.createGain();
      g.gain.value = c.vol / 100;
      g.connect(master);
      chGain[c.id] = g;
    }
    mixStream = dest.stream;
  }
  const ensureRunning = () => { if (ctx && ctx.state !== 'running') ctx.resume(); };

  function ramp(param, to, secs) {
    const n = ctx.currentTime;
    param.cancelScheduledValues(n);
    param.setValueAtTime(param.value, n);
    param.linearRampToValueAtTime(to, n + Math.max(secs, 0.02));
  }

  function setState(t, s) {
    t.state = s;
    if (t.ui) {
      t.ui.li.dataset.state = s;
      t.ui.play.textContent = t.kind === 'stream' && s === 'playing' ? '⏸' : '▶';
    }
    broadcastState();
  }

  function play(t) {
    ensureRunning();
    if (t.kind === 'buffer') return triggerSfx(t);
    const wasFadingOut = !!t.timer;
    clearTimeout(t.timer); t.timer = null;
    t.el.loop = t.loop;
    if (t.fade) {
      if (!wasFadingOut && t.el.paused) t.fadeNode.gain.setValueAtTime(0, ctx.currentTime);
      ramp(t.fadeNode.gain, 1, FADE_S);
    } else {
      t.fadeNode.gain.cancelScheduledValues(ctx.currentTime);
      t.fadeNode.gain.setValueAtTime(1, ctx.currentTime);
    }
    t.el.play().catch(e => console.warn('play gagal', e));
    setState(t, 'playing');
  }

  function triggerSfx(t) {
    const s = ctx.createBufferSource();
    s.buffer = t.buffer;
    s.loop = t.loop;
    s.connect(t.fadeNode);
    t.active.add(s);
    s.onended = () => {
      t.active.delete(s);
      if (!t.active.size && t.state === 'playing') setState(t, 'stopped');
    };
    s.start();
    setState(t, 'playing');
  }

  function pause(t) {
    if (t.kind !== 'stream') return stop(t);
    clearTimeout(t.timer); t.timer = null;
    if (t.fade && !t.el.paused) {
      ramp(t.fadeNode.gain, 0, FADE_S);
      t.timer = setTimeout(() => { t.timer = null; t.el.pause(); }, FADE_S * 1000 + 50);
    } else {
      t.el.pause();
    }
    setState(t, 'paused');
  }

  function stop(t, immediate) {
    if (t.kind === 'buffer') {
      [...t.active].forEach(s => { try { s.stop(); } catch { /* sudah berhenti */ } });
      t.active.clear();
      return setState(t, 'stopped');
    }
    clearTimeout(t.timer); t.timer = null;
    const done = () => { t.timer = null; t.el.pause(); try { t.el.currentTime = 0; } catch { /* abaikan */ } };
    if (t.fade && !immediate && !t.el.paused) {
      ramp(t.fadeNode.gain, 0, FADE_S);
      t.timer = setTimeout(done, FADE_S * 1000 + 50);
    } else {
      done();
    }
    setState(t, 'stopped');
  }

  function toggle(t) {
    if (t.kind === 'stream' && t.state === 'playing') pause(t); else play(t);
  }

  function removeTrack(t) {
    stop(t, true);
    try { t.gain.disconnect(); t.fadeNode.disconnect(); if (t.node) t.node.disconnect(); } catch { /* abaikan */ }
    if (t.url) URL.revokeObjectURL(t.url);
    if (t.el) { t.el.removeAttribute('src'); t.el.load(); }
    tracks.splice(tracks.indexOf(t), 1);
    t.ui.li.remove();
    refreshSfxBadges();
    broadcastState();
  }

  /* ---------- upload ---------- */
  const validType = f => /\.(mp3|wav|ogg)$/i.test(f.name) || /^audio\/(mpeg|mp3|wav|x-wav|wave|ogg)/.test(f.type);
  const roomBytes = () => tracks.reduce((a, t) => a + t.size, 0);

  function readFile(file, onProgress) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error || new Error('Gagal membaca file'));
      fr.readAsArrayBuffer(file);
    });
  }

  function makeProgress(catId, name) {
    const box = document.querySelector(`.channel[data-cat="${catId}"] .progress-list`);
    const wrap = el('div', 'progress');
    const label = el('div', '', name);
    const bar = el('div', 'bar'); const fill = el('i'); bar.append(fill);
    wrap.append(label, bar); box.append(wrap);
    return {
      set: p => { fill.style.width = Math.round(p * 100) + '%'; },
      done: () => setTimeout(() => wrap.remove(), 400),
      fail: msg => { wrap.classList.add('fail'); label.textContent = `${name} — ${msg}`; fill.style.width = '100%'; setTimeout(() => wrap.remove(), 5000); },
    };
  }

  async function addFiles(catId, list) {
    for (const f of list) await addOne(catId, f); // berurutan agar memori terkendali
  }

  async function addOne(catId, file) {
    const cat = CAT[catId];
    const prog = makeProgress(catId, file.name);
    try {
      if (!validType(file)) throw new Error('format harus MP3/WAV/OGG');
      if (file.size > MAX_FILE) throw new Error('maks 20 MB per file');
      if (roomBytes() + file.size > MAX_ROOM) throw new Error('kuota room 100 MB penuh');

      const buf = await readFile(file, p => prog.set(p * 0.8));
      const t = {
        id: uid(), cat: catId, kind: cat.kind, name: file.name.replace(/\.[^.]+$/, ''),
        size: file.size, loop: cat.loop, fade: cat.kind === 'stream',
        state: 'stopped', duration: 0, active: new Set(), timer: null,
      };

      if (cat.kind === 'buffer') {
        t.buffer = await ctx.decodeAudioData(buf);
        t.duration = t.buffer.duration;
      } else {
        t.url = URL.createObjectURL(new Blob([buf], { type: file.type || 'audio/mpeg' }));
        t.el = new Audio();
        t.el.preload = 'auto';
        t.el.src = t.url;
        t.el.loop = t.loop;
        await new Promise((res, rej) => {
          t.el.onloadedmetadata = res;
          t.el.onerror = () => rej(new Error('file tidak bisa dibaca'));
        });
        t.duration = t.el.duration;
        t.node = ctx.createMediaElementSource(t.el);
        t.el.onended = () => setState(t, 'stopped');
      }

      t.fadeNode = ctx.createGain();
      t.gain = ctx.createGain();
      if (t.node) t.node.connect(t.fadeNode);
      t.fadeNode.connect(t.gain);
      t.gain.connect(chGain[catId]);

      prog.set(1);
      tracks.push(t);
      renderTrack(t);
      refreshSfxBadges();
      prog.done();
    } catch (e) {
      prog.fail(e.message || 'gagal');
    }
  }

  /* ---------- UI host ---------- */
  function renderTrack(t) {
    const li = el('li', 'track');
    li.dataset.state = 'stopped';

    const top = el('div', 'top');
    const num = el('span', 'num');
    const name = el('span', 'name', t.name); name.title = t.name;
    const dur = el('span', 'dur', fmtTime(t.duration));
    const del = el('button', 'iconbtn del', '✕'); del.title = 'Hapus';
    del.onclick = () => removeTrack(t);
    top.append(num, name, dur, del);

    const ctl = el('div', 'ctl');
    const playBtn = el('button', 'iconbtn', '▶'); playBtn.title = t.kind === 'buffer' ? 'Picu' : 'Play / pause';
    playBtn.onclick = () => toggle(t);
    const stopBtn = el('button', 'iconbtn', '■'); stopBtn.title = 'Stop';
    stopBtn.onclick = () => stop(t);
    const vol = el('input'); vol.type = 'range'; vol.min = 0; vol.max = 100; vol.value = 100;
    vol.setAttribute('aria-label', 'Volume ' + t.name);
    vol.oninput = () => t.gain.gain.setTargetAtTime(vol.value / 100, ctx.currentTime, 0.01);
    ctl.append(playBtn, stopBtn, vol);

    const opts = el('div', 'opts');
    const loopL = el('label'); const loopC = el('input'); loopC.type = 'checkbox'; loopC.checked = t.loop;
    loopC.onchange = () => {
      t.loop = loopC.checked;
      if (t.el) t.el.loop = t.loop;
      t.active.forEach(s => { s.loop = t.loop; });
    };
    loopL.append(loopC, document.createTextNode('Loop'));
    opts.append(loopL);
    if (t.kind === 'stream') {
      const fadeL = el('label'); const fadeC = el('input'); fadeC.type = 'checkbox'; fadeC.checked = t.fade;
      fadeC.onchange = () => { t.fade = fadeC.checked; };
      fadeL.append(fadeC, document.createTextNode(`Fade ${FADE_S}s`));
      opts.append(fadeL);
    }

    li.append(top, ctl, opts);
    t.ui = { li, play: playBtn, num };
    document.querySelector(`.channel[data-cat="${t.cat}"] .tracks`).append(li);
  }

  function refreshSfxBadges() {
    tracks.filter(t => t.cat === 'sfx').forEach((t, i) => { t.ui.num.textContent = i < 9 ? String(i + 1) : ''; });
  }

  function buildHostUI() {
    const root = $('channels');
    if (root.childElementCount) return;
    for (const c of CATS) {
      const sec = el('section', 'panel channel'); sec.dataset.cat = c.id;

      const head = el('header');
      head.append(el('h2', '', c.label), el('span', 'muted small', c.hint));

      const fader = el('div', 'fader');
      const vol = el('input'); vol.type = 'range'; vol.min = 0; vol.max = 100; vol.value = c.vol;
      vol.setAttribute('aria-label', 'Volume channel ' + c.label);
      vol.oninput = () => chGain[c.id].gain.setTargetAtTime(vol.value / 100, ctx.currentTime, 0.01);
      fader.append(el('span', '', 'CH VOL'), vol);

      const drop = el('label', 'dropzone', 'Seret file MP3/WAV/OGG ke sini, atau klik untuk memilih');
      const input = el('input'); input.type = 'file'; input.multiple = true;
      input.accept = '.mp3,.wav,.ogg,audio/mpeg,audio/wav,audio/ogg';
      input.onchange = () => { addFiles(c.id, [...input.files]); input.value = ''; };
      drop.append(input);
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => addFiles(c.id, [...e.dataTransfer.files]));

      sec.append(head, fader, drop, el('div', 'progress-list'), el('ul', 'tracks'));
      root.append(sec);
    }
    $('masterVol').oninput = e => master.gain.setTargetAtTime(e.target.value / 100, ctx.currentTime, 0.01);
    $('btnStopAll').onclick = () => tracks.forEach(t => stop(t));
  }

  document.addEventListener('keydown', e => {
    if (role !== 'host' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.tagName === 'INPUT' && e.target.type === 'text') return;
    if (e.key >= '1' && e.key <= '9') {
      const t = tracks.filter(x => x.cat === 'sfx')[Number(e.key) - 1];
      if (t) { play(t); t.ui.li.classList.add('flash'); setTimeout(() => t.ui.li.classList.remove('flash'), 150); }
    } else if (e.key === 'Escape') {
      tracks.filter(x => x.cat === 'sfx').forEach(t => stop(t));
    }
  });

  /* ======================================================================
   * HOST — jaringan
   * ==================================================================== */
  function currentState() {
    return {
      type: 'state',
      host: hostNick,
      listeners: [...conns.values()].map(e => e.nick),
      playing: tracks.filter(t => t.state === 'playing').map(t => ({ name: t.name, cat: t.cat })),
    };
  }

  function broadcastState() {
    if (role !== 'host') return;
    const s = currentState();
    conns.forEach(e => { if (e.conn.open) e.conn.send(s); });
    renderStatus('h', s);
  }

  function onListenerConnection(conn) {
    conn.on('open', () => {
      const n = cleanNick((conn.metadata || {}).nick) || 'Anonim';
      if (conns.size >= MAX_LISTENERS) {
        conn.send({ type: 'full' });
        setTimeout(() => conn.close(), 500);
        return;
      }
      const entry = { conn, nick: n, call: null, seen: Date.now() };
      conns.set(conn.peer, entry);
      entry.call = peer.call(conn.peer, mixStream, { sdpTransform: hiQuality });
      entry.call.on('error', e => console.warn('call error', e));
      broadcastState();
    });
    const drop = () => dropListener(conn.peer, conn);
    conn.on('close', drop);
    conn.on('error', drop);
    // Pesan dari listener hanya dipakai sebagai heartbeat. Hanya host yang bisa mengontrol audio.
    conn.on('data', () => { const e = conns.get(conn.peer); if (e && e.conn === conn) e.seen = Date.now(); });
  }

  function dropListener(peerId, conn) {
    const e = conns.get(peerId);
    if (!e || (conn && e.conn !== conn)) return;
    try { e.call && e.call.close(); } catch { /* abaikan */ }
    try { e.conn.close(); } catch { /* abaikan */ }
    conns.delete(peerId);
    broadcastState();
  }

  function startHost(nick, code, attempt = 0) {
    const resume = !!code;
    code = code || randCode();
    const p = newPeer(ROOM_PREFIX + code);
    let opened = false;

    p.on('open', () => {
      opened = true;
      peer = p; role = 'host'; roomCode = code; hostNick = nick;
      store.set('streambox:host:' + code, nick);
      store.set('streambox:nick', nick);
      history.replaceState(null, '', '/room/' + code);
      setRoomBar('host', code);
      buildHostUI();
      show('viewHost');
      broadcastState();
      // Buang listener yang diam (tab mati mendadak): heartbeat tiap 4 dtk, batas 12 dtk.
      setInterval(() => {
        const now = Date.now();
        [...conns.entries()].forEach(([id, e]) => { if (now - e.seen > 12000) dropListener(id); });
      }, 3000);
    });
    p.on('connection', onListenerConnection);
    p.on('disconnected', () => { if (!p.destroyed) p.reconnect(); });
    p.on('error', err => {
      if (opened) return console.warn('peer error', err);
      p.destroy();
      if (err.type === 'unavailable-id') {
        if (!resume) return startHost(nick, null);
        if (attempt < 5) return setTimeout(() => startHost(nick, code, attempt + 1), 2000);
        return startError('Room ini masih aktif di tab lain atau belum dilepas server. Coba lagi sebentar.');
      }
      startError('Gagal membuat room (' + err.type + '). Cek koneksi internet.');
    });
  }

  /* ======================================================================
   * LISTENER
   * ==================================================================== */
  function setStatus(text, kind) {
    const s = $('lStatus'); s.textContent = text; s.className = 'status ' + (kind || '');
  }
  function listenerFail(msg) {
    setStatus(msg, 'err');
    $('lError').textContent = 'Kembali ke beranda untuk mencoba lagi.';
    if (peer) try { peer.destroy(); } catch { /* abaikan */ }
  }

  function startListener(nick, code) {
    role = 'listener'; roomCode = code;
    store.set('streambox:nick', nick);
    history.replaceState(null, '', '/room/' + code);
    setRoomBar('listener', code);
    show('viewListener');
    setStatus('Menghubungkan…', '');
    const audio = $('remoteAudio');

    const p = newPeer(); peer = p;
    let connected = false;
    const timer = setTimeout(() => { if (!connected) listenerFail('Tidak ada respons. Pastikan host online dan link benar.'); }, 15000);

    p.on('open', () => {
      const conn = p.connect(ROOM_PREFIX + code, { metadata: { nick }, reliable: true });
      conn.on('open', () => {
        connected = true; clearTimeout(timer);
        setStatus('Terhubung · menunggu audio dari host…', 'ok');
        const hb = setInterval(() => { if (conn.open) conn.send({ type: 'ping' }); else clearInterval(hb); }, 4000);
      });
      conn.on('data', msg => {
        if (!msg) return;
        if (msg.type === 'state') renderStatus('l', msg);
        else if (msg.type === 'full') { clearTimeout(timer); listenerFail('Room penuh (maks ' + MAX_LISTENERS + ' listener).'); }
      });
      conn.on('close', () => { if (peer === p) { audio.srcObject = null; setStatus('Host terputus.', 'err'); } });
    });

    p.on('call', call => {
      call.answer(undefined, { sdpTransform: hiQuality });
      call.on('stream', stream => {
        audio.srcObject = stream;
        audio.play().then(() => setStatus('Mendengarkan ♪', 'ok'))
          .catch(() => { $('unlockBtn').classList.remove('hidden'); setStatus('Ketuk tombol untuk mengaktifkan audio', ''); });
      });
    });

    p.on('error', err => {
      clearTimeout(timer);
      listenerFail(err.type === 'peer-unavailable' ? 'Room tidak ditemukan atau host sedang offline.' : 'Koneksi gagal (' + err.type + ').');
    });

    $('unlockBtn').onclick = () => { audio.play().then(() => { $('unlockBtn').classList.add('hidden'); setStatus('Mendengarkan ♪', 'ok'); }); };
    $('lVol').oninput = e => { audio.volume = e.target.value / 100; };
    $('btnMute').onclick = () => { audio.muted = !audio.muted; $('btnMute').textContent = audio.muted ? '🔇' : '🔊'; };
  }

  /* ---------- tampilan daftar status (dipakai host & listener) ---------- */
  function renderStatus(p, s) {
    const np = $(p + 'NowPlaying'); np.replaceChildren();
    if (!s.playing.length) np.append(el('li', 'muted', 'Hening…'));
    s.playing.forEach(x => {
      const li = el('li'); li.append(el('span', 'tag', (CAT[x.cat] || {}).label || x.cat), document.createTextNode(x.name));
      np.append(li);
    });
    const ls = $(p + 'Listeners'); ls.replaceChildren();
    ls.append(el('li', 'host', '★ ' + s.host + ' (host)'));
    s.listeners.forEach(n => ls.append(el('li', '', n)));
    $(p + 'ListenerCount').textContent = `${s.listeners.length}/${MAX_LISTENERS}`;
  }

  /* ======================================================================
   * Navigasi & event umum
   * ==================================================================== */
  function setRoomBar(r, code) {
    $('roomInfo').classList.remove('hidden');
    const b = $('roleBadge'); b.textContent = r === 'host' ? 'HOST' : 'LISTENER'; b.dataset.role = r;
    $('roomCode').textContent = code;
  }

  function startError(msg) {
    $('homeError').textContent = msg; $('joinError').textContent = msg;
    ['btnCreate', 'btnJoin', 'joinBtn'].forEach(id => { $(id).disabled = false; });
  }
  const busy = () => ['btnCreate', 'btnJoin', 'joinBtn'].forEach(id => { $(id).disabled = true; });

  $('btnCreate').onclick = () => {
    const nick = cleanNick($('homeNick').value);
    if (!nick) return startError('Isi nickname dulu.');
    $('homeError').textContent = ''; busy();
    initAudio(); // harus di dalam gesture klik
    startHost(nick, null);
  };

  $('btnJoin').onclick = () => {
    const nick = cleanNick($('homeNick').value);
    if (!nick) return startError('Isi nickname dulu.');
    let code = $('joinCode').value.trim();
    const m = code.match(/\/room\/([A-Za-z0-9]+)/); if (m) code = m[1];
    if (!/^[A-Za-z0-9]{4,16}$/.test(code)) return startError('Kode room tidak valid.');
    $('homeError').textContent = '';
    startListener(nick, code);
  };

  $('joinBtn').onclick = () => {
    const nick = cleanNick($('joinNick').value);
    if (!nick) return startError('Isi nickname dulu.');
    $('joinError').textContent = ''; busy();
    if (resumeHost) { initAudio(); startHost(nick, pendingCode); }
    else startListener(nick, pendingCode);
  };

  $('copyLink').onclick = async () => {
    const url = location.origin + '/room/' + roomCode;
    const b = $('copyLink');
    try { await navigator.clipboard.writeText(url); b.textContent = 'Tersalin ✓'; }
    catch { window.prompt('Salin link ini:', url); }
    setTimeout(() => { b.textContent = 'Salin link'; }, 1500);
  };

  $('btnLeave').onclick = () => {
    if (role === 'host') {
      if (!confirm('Menutup room akan memutus semua listener. Lanjutkan?')) return;
      store.del('streambox:host:' + roomCode);
    }
    try { peer && peer.destroy(); } catch { /* abaikan */ }
    location.href = '/';
  };

  // Listener menutup tab: putus eksplisit supaya host langsung tahu.
  window.addEventListener('pagehide', () => { if (role === 'listener' && peer) { try { peer.destroy(); } catch { /* abaikan */ } } });

  window.addEventListener('beforeunload', e => {
    if (role === 'host' && conns.size) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- init ---------- */
  (function init() {
    const saved = store.get('streambox:nick') || '';
    $('homeNick').value = saved; $('joinNick').value = saved;
    const m = location.pathname.match(/^\/room\/([A-Za-z0-9]{4,16})\/?$/);
    if (!m) return show('viewHome');
    pendingCode = m[1];
    $('joinRoomCode').textContent = pendingCode;
    const hostSaved = store.get('streambox:host:' + pendingCode);
    if (hostSaved !== null) {
      resumeHost = true;
      $('joinTitle').textContent = 'Lanjutkan sebagai host';
      $('joinBtn').textContent = 'Lanjutkan';
      $('joinNick').value = hostSaved;
    } else {
      $('joinTitle').textContent = 'Gabung room';
      $('joinBtn').textContent = 'Masuk';
    }
    show('viewJoin');
  })();
})();
