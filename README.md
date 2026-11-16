# Stream Box (MVP)

Soundboard kolaboratif real-time untuk sesi TRPG/DnD atau streaming. Host memutar audio dari file lokal; semua orang di room mendengarnya bersamaan.

## Keputusan desain

| Topik | Keputusan |
|---|---|
| Skala | Maks 20 listener per room |
| Penyimpanan audio | Host-only: file tetap di browser host, tidak diunggah ke server |
| Transport | WebRTC mesh dari host ke tiap listener (audio saja) |
| Signaling | PeerJS Cloud (gratis), tanpa backend sendiri |
| Akun | Tanpa login, wajib isi nickname. Room = kode acak 6 karakter |
| Kontrol | Hanya host. Pesan dari listener diabaikan oleh host |
| Platform | Desktop-first untuk host, responsif untuk listener (HP) |
| File | MP3/WAV/OGG, maks 20 MB per file, 100 MB per room (batas di sisi klien) |
| Sinkronisasi | Inheren: semua listener mendengar satu stream yang sama. Jeda tipikal 0,2-0,5 detik |
| Hosting | Vercel (situs statis) |

## Arsitektur

```
                       PeerJS Cloud (signaling saja)
                        ▲          ▲           ▲
                        │ SDP/ICE  │           │
   ┌────────────────────┴───┐      │           │
   │  HOST (browser)        │      │           │
   │  file lokal            │      │           │
   │   ├─ BGM  (<audio>) ─┐ │      │           │
   │   ├─ SFX  (buffer) ──┼─► GainNode per track
   │   └─ AMB  (<audio>) ─┘ │       → gain per channel
   │                        │       → master
   │   MediaStreamDest ─────┼──┐
   └────────────────────────┘  │  WebRTC audio (Opus stereo ~128 kbps)
                               ├──────────────► Listener 1
                               ├──────────────► Listener 2
                               └──────────────► … Listener 20
   Data channel (host → listener): daftar listener + "sedang diputar"
```

Alur: host klik "Buat room" → `Peer('streambox-<kode>')` terdaftar → link `/room/<kode>` dibagikan → listener memasukkan nickname → `peer.connect()` ke host → host membalas dengan `peer.call(listener, mixStream)`.

Mixer di host: setiap track punya GainNode volume dan GainNode fade, masuk ke gain channel (BGM/SFX/Ambience), lalu master, lalu `MediaStreamAudioDestinationNode`. BGM dan Ambience memakai `<audio>` (hemat memori untuk file panjang), SFX memakai AudioBuffer (bisa tumpang-tindih dan latensi rendah).

## Struktur file

```
index.html   UI (4 tampilan: home, join, host, listener)
style.css    tema dark control-panel
app.js       audio engine, UI host, jaringan PeerJS
config.js    ICE/TURN, server signaling, bitrate
vercel.json  rewrite /room/:code -> index.html
```

## Jalankan lokal

```bash
npx serve -s .          # -s = SPA fallback agar /room/xxxx terbuka
# buka http://localhost:3000 di dua browser/tab
```

Uji: tab A buat room (isi nickname, klik "Buat room baru"), salin link, buka di tab B (atau jendela incognito), isi nickname, masuk. Seret MP3 ke panel BGM di tab A lalu tekan ▶. Tab B harus mengeluarkan suara.

Tes otomatis dua browser (Chromium) sudah dijalankan: buat room, upload, listener join lewat link, sinyal audio benar-benar mengalir, pause dengan fade, shortcut `1`, validasi file, dan deteksi listener keluar semuanya lulus. Yang belum teruji: jaringan nyata lintas perangkat/seluler (butuh TURN) dan PeerJS Cloud.

Catatan: gunakan satu perangkat sebagai host. Kalau host dan listener ada di komputer yang sama, bisukan salah satunya agar tidak terjadi gema.

## Deploy ke Vercel

Opsi A, lewat CLI:
```bash
npm i -g vercel
vercel          # jawab pertanyaan: framework "Other", output directory "."
vercel --prod
```

Opsi B, lewat GitHub: push folder ini ke repo, lalu di vercel.com pilih "Add New Project", impor repo, framework "Other", tanpa build command, output directory `.`.

Vercel otomatis memberi HTTPS, yang wajib untuk WebRTC dan Web Audio antar-perangkat. Domain custom (mis. streambox.app) bisa ditambahkan di Project Settings → Domains.

## TURN (penting untuk listener di HP)

STUN saja gagal di sebagian jaringan seluler/CGNAT. Daftar akun gratis di Metered (Open Relay) atau layanan TURN lain, lalu isi kredensial di `config.js` pada bagian `iceServers` dan deploy ulang. Trafik yang lewat TURN memakai kuota layanan tersebut.

## Batasan MVP yang perlu Anda tahu

- **Host adalah titik tunggal.** Tab host ditutup, di-sleep, atau internetnya putus = semua listener terputus. Refresh tab host akan melanjutkan room dengan kode yang sama, tapi file audio harus diunggah ulang (belum ada persistensi).
- **Bandwidth upload host:** sekitar 128 kbps x jumlah listener (20 listener ≈ 2,5 Mbps). Turunkan `audioBitrate` di `config.js` jika koneksi host lemah.
- **Host sebaiknya laptop/desktop** dengan layar tetap menyala. Browser HP biasanya menghentikan audio saat layar mati.
- **Audio dikompres ulang (Opus)** saat dikirim, jadi kualitasnya bagus tapi bukan lossless.
- **PeerJS Cloud gratis** tidak punya jaminan uptime. Untuk penggunaan serius, self-host `peerjs-server` dan isi `peerServer` di `config.js`.
- Listener yang menutup tab langsung terdeteksi; kalau tab mati mendadak (baterai habis, jaringan putus), host membuangnya dalam ±12 detik lewat heartbeat.
- Batas ukuran file bersifat soft (di klien), karena memang tidak ada server yang menyimpannya.

## Roadmap

Fase 2: rename dan reorder (drag) track, simpan library ke IndexedDB supaya tidak upload ulang, tombol kick listener, izin kontrol per listener (co-DM), preset scene (kombinasi BGM+Ambience satu klik).
Nanti: chat, PWA, mode SFX dari listener, self-host signaling + TURN.
