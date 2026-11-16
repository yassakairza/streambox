// Konfigurasi Stream Box. Edit sesuai kebutuhan, lalu deploy ulang.
window.STREAMBOX_CONFIG = {
  // Server ICE untuk WebRTC. STUN saja sudah cukup di banyak jaringan,
  // tapi listener di balik CGNAT/jaringan seluler sering butuh TURN.
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }

    // Aktifkan TURN (sangat disarankan untuk dipakai mobile). Contoh Metered Open Relay:
    // { urls: 'turn:YOUR_SUBDOMAIN.metered.live:80',                 username: 'USER', credential: 'PASS' },
    // { urls: 'turn:YOUR_SUBDOMAIN.metered.live:443?transport=tcp',  username: 'USER', credential: 'PASS' },
    // { urls: 'turns:YOUR_SUBDOMAIN.metered.live:443?transport=tcp', username: 'USER', credential: 'PASS' }
  ],

  // null = pakai PeerJS Cloud gratis (0.peerjs.com).
  // Kalau nanti mau self-host signaling: { host: 'peer.domainanda.com', port: 443, path: '/', secure: true }
  peerServer: null,

  // Bitrate audio stereo ke tiap listener (bps). 20 listener x 128 kbps ~ 2,5 Mbps upload host.
  audioBitrate: 128000
};
