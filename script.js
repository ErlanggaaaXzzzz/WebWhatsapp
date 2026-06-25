let socket;
let allLogs = [];
let currentView = 'dashboard';

// Sinkronisasi data metrik lokal
let metrics = { msgCount: 0, groupCount: 0, eventCount: 0 };
let startTime = Date.now();

// Audio Synthesizer (Audio Bip bawaan browser tanpa file external)
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playNotificationSound() {
    const isAudioOn = document.getElementById('audioToggle') ? document.getElementById('audioToggle').checked : true;
    if (!isAudioOn) return;
    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // Nada D5
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + 0.15);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) { console.log('AudioContext blocked by browser policy'); }
}

// Validasi Token Akses Utama
const token = localStorage.getItem('token') || sessionStorage.getItem('token');
if (!token) {
    window.location.href = '/login.html';
}

// Parsing Data User dari JWT
const base64Url = token.split('.')[1];
const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
const userData = JSON.parse(window.atob(base64));

// Jalankan saat DOM siap
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('topUsername')) document.getElementById('topUsername').innerText = userData.username;
    if (document.getElementById('topSessionId')) document.getElementById('topSessionId').innerText = userData.username;
    
    // Minta izin Web Desktop Notification API browser
    if (Notification.permission !== "granted" && Notification.permission !== "denied") {
        Notification.requestPermission();
    }

    initSocket();
    loadSavedState(); 
});

// Mengatur Runtime Clock
setInterval(() => {
    const elapsed = Date.now() - startTime;
    const hrs = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
    const mins = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
    const secs = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
    const runtimeEl = document.getElementById('cardRuntime');
    if (runtimeEl) runtimeEl.innerText = `${hrs}:${mins}:${secs}`;
}, 1000);

// Inisialisasi Jalur Socket.IO Komunikasi Dupleks
function initSocket() {
    socket = io({ auth: { token } });

    socket.on('connect', () => {
        writeLog('info', 'Berhasil membangun jalur pipa realtime (Socket.IO)');
    });

    socket.on('whatsapp_status', (data) => {
        console.log("Sinkronisasi status soket masuk:", data.status);
        updateStatusUI(data.status);
        localStorage.setItem('wa_current_status', data.status);

        if (document.getElementById('sessionTableBody')) {
            renderSessionTable(data.status);
        }
    });

    socket.on('whatsapp_qr', (data) => {
        const qrImage = document.getElementById('qrImage');
        const qrStateText = document.getElementById('qrStateText');
        if (data.qr && qrImage) {
            qrImage.src = data.qr;
            qrImage.style.display = 'block';
            if (qrStateText) qrStateText.innerText = 'Silakan lakukan scan menggunakan WhatsApp Anda.';
        }
    });

    socket.on('whatsapp_pairing', (data) => {
        const container = document.getElementById('pairingCodeContainer');
        if (data.code && container) {
            container.innerText = data.code;
            container.style.display = 'block';
        }
    });

    // Event Listener Utama Aliran Data Event Baileys Pipeline
    socket.on('whatsapp_event', (evt) => {
        let isMessage = evt.event === 'messages.upsert';
        let isGroup = evt.event === 'groups.update' || evt.event === 'group-participants.update' || evt.event === 'groups.upsert';

        if (isMessage) {
            metrics.msgCount++;
            const cardMsg = document.getElementById('cardMessages');
            if (cardMsg) cardMsg.innerText = metrics.msgCount;
            localStorage.setItem('metric_msg_count', metrics.msgCount);
            
            playNotificationSound(); // Mainkan feedback suara audio

            // Kirim Web Push Notification jika tab sedang di-minimize
            if (Notification.permission === "granted" && document.hidden) {
                new Notification("WA Debugger Event", {
                    body: `Ada pesan WhatsApp masuk terdeteksi di pipeline!`,
                    icon: '/favicon.ico'
                });
            }
        }

        if (isGroup) {
            metrics.groupCount++;
            const cardGrp = document.getElementById('cardGroups');
            if (cardGrp) cardGrp.innerText = metrics.groupCount;
            localStorage.setItem('metric_group_count', metrics.groupCount);
        }

        metrics.eventCount++;
        const cardEvt = document.getElementById('cardEvents');
        if (cardEvt) cardEvt.innerText = metrics.eventCount;
        localStorage.setItem('metric_event_count', metrics.eventCount);

        let category = 'event';
        if (evt.event.includes('connection')) category = 'info';
        if (isMessage) category = 'message';

        let rawObj = null;
        try {
            rawObj = typeof evt.data === 'string' ? JSON.parse(evt.data) : evt.data;
        } catch (e) { rawObj = evt.data; }

        let formattedJSON = JSON.stringify(rawObj, null, 2);
        writeLog(category, `[${evt.event}]\n${formattedJSON}`, evt.event, rawObj);
    });
}

// Fungsi Manajemen Pergantian Tab (View Switcher)
function switchView(viewName) {
    currentView = viewName;
    document.querySelectorAll('.view-pane').forEach(pane => pane.classList.remove('active'));
    document.querySelectorAll('.menu-btn').forEach(btn => btn.classList.remove('active'));

    const targetPane = document.getElementById(`view-${viewName}`);
    if (targetPane) targetPane.classList.add('active');

    const targetBtn = document.getElementById(`btn-${viewName}`) || document.getElementById(`id-${viewName}`);
    if (targetBtn) targetBtn.classList.add('active');

    localStorage.setItem('active_view_pane', viewName);

    const sidebar = document.getElementById('appSidebar');
    if (sidebar && window.innerWidth <= 768) {
        sidebar.classList.remove('open');
    }
}

// Pemuat State Cadangan (Anti-Reset saat Halaman Di-refresh)
function loadSavedState() {
    const savedView = localStorage.getItem('active_view_pane') || 'dashboard';
    switchView(savedView);

    metrics.msgCount = parseInt(localStorage.getItem('metric_msg_count')) || 0;
    metrics.groupCount = parseInt(localStorage.getItem('metric_group_count')) || 0;
    metrics.eventCount = parseInt(localStorage.getItem('metric_event_count')) || 0;
    
    if (document.getElementById('cardMessages')) document.getElementById('cardMessages').innerText = metrics.msgCount;
    if (document.getElementById('cardGroups')) document.getElementById('cardGroups').innerText = metrics.groupCount;
    if (document.getElementById('cardEvents')) document.getElementById('cardEvents').innerText = metrics.eventCount;

    const savedStatus = localStorage.getItem('wa_current_status') || 'disconnected';
    updateStatusUI(savedStatus);

    const savedLogs = localStorage.getItem('terminal_logs_backup');
    if (savedLogs) {
        try {
            allLogs = JSON.parse(savedLogs);
            const consoleLogs = document.getElementById('consoleLogs');
            if (consoleLogs) {
                consoleLogs.innerHTML = ""; 
                allLogs.forEach(log => {
                    appendLogRowToDOM(log.type, log.text, log.event);
                });
                consoleLogs.scrollTop = consoleLogs.scrollHeight;
            }
        } catch (e) { console.error("Gagal membaca arsip log.", e); }
    }
}

// Sistem Highlighting JID Otomatis & Helper Append Baris DOM
function appendLogRowToDOM(type, text, eventName) {
    const consoleLogs = document.getElementById('consoleLogs');
    if (!consoleLogs) return;

    const row = document.createElement('div');
    row.className = `log-row log-${type}`;
    row.dataset.event = eventName;

    // Regex mencocokkan pola format WhatsApp JID (@s.whatsapp.net atau @g.us atau @lid)
    const jidRegex = /([a-zA-0-9._-]+@(s\.whatsapp\.net|g\.us|lid))/g;
    
    if (jidRegex.test(text)) {
        row.innerHTML = text.replace(jidRegex, `<span class="jid-clickable" onclick="copyJIDToClipboard('$1')">$1</span>`);
    } else {
        row.innerText = text;
    }

    consoleLogs.appendChild(row);
}

// Salin JID Otomatis saat Tag Diklik
function copyJIDToClipboard(jid) {
    navigator.clipboard.writeText(jid).then(() => {
        // Pindahkan String JID langsung ke kolom input target di API Sandbox Tester
        const targetInput = document.getElementById('sandboxTarget');
        if (targetInput) targetInput.value = jid;
        alert(`Berhasil menyalin JID: ${jid}\nOtomatis diisikan ke Form JID API Tester!`);
    });
}

// Fungsi Penulis Log Terminal Utama dengan Sistem Cadangan Otomatis + RAW Data Mentah
function writeLog(type, text, eventName = '', rawData = null) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
    const textWithTime = `[${timestamp}] ${text}`;

    appendLogRowToDOM(type, textWithTime, eventName);
    
    const consoleLogs = document.getElementById('consoleLogs');
    if (consoleLogs) consoleLogs.scrollTop = consoleLogs.scrollHeight; 

    allLogs.push({ 
        type, 
        text: textWithTime, 
        event: eventName,
        raw: rawData 
    });
    
    if (allLogs.length > 150) allLogs.shift();
    localStorage.setItem('terminal_logs_backup', JSON.stringify(allLogs));
}

// Menangani Update Tampilan Teks Status dan Warna Indikator
function updateStatusUI(status) {
    const statusText = document.getElementById('statusText');
    const cardStatus = document.getElementById('cardStatus');
    const statusDot = document.getElementById('statusDot');
    let currentStatus = (status || 'disconnected').toLowerCase();

    if (currentStatus === 'connected') {
        if(statusText) { statusText.innerText = "CONNECTED"; statusText.style.color = "#00ff87"; }
        if(cardStatus) { cardStatus.innerText = "CONNECTED"; cardStatus.style.color = "#00ff87"; }
        if(statusDot) { statusDot.className = "status-dot connected"; }
    } else if (currentStatus === 'connecting') {
        if(statusText) { statusText.innerText = "CONNECTING..."; statusText.style.color = "#f59e0b"; }
        if(cardStatus) { cardStatus.innerText = "CONNECTING..."; cardStatus.style.color = "#f59e0b"; }
        if(statusDot) { statusDot.className = "status-dot connecting"; }
    } else {
        if(statusText) { statusText.innerText = "DISCONNECTED"; statusText.style.color = "#ef4444"; }
        if(cardStatus) { cardStatus.innerText = "DISCONNECTED"; cardStatus.style.color = "#ef4444"; }
        if(statusDot) { statusDot.className = "status-dot disconnected"; }
    }
}

// Sandbox Form Sender Engine
async function sendSandboxMessage() {
    const target = document.getElementById('sandboxTarget').value.trim();
    const type = document.getElementById('sandboxType').value;
    const content = document.getElementById('sandboxContent').value.trim();
    const responseBox = document.getElementById('sandboxResponse');

    if (!target || !content) {
        alert("Nomor JID tujuan dan konten pesan wajib diisi!");
        return;
    }

    responseBox.innerText = "Sedang memproses pengiriman payload...";
    responseBox.style.color = "#f59e0b";

    let payloadBody;
    if (type === 'json') {
        try {
            payloadBody = JSON.parse(content);
        } catch (e) {
            responseBox.innerText = `[Error Skema JSON]:\n${e.message}`;
            responseBox.style.color = "#ef4444";
            return;
        }
    } else {
        payloadBody = { text: content };
    }

    try {
        const res = await fetch('/api/whatsapp/send', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ jid: target, message: payloadBody })
        });
        const result = await res.json();
        
        responseBox.innerText = JSON.stringify(result, null, 2);
        responseBox.style.color = res.ok ? "#00ff87" : "#ef4444";
    } catch (err) {
        responseBox.innerText = `[Transmission Error]:\n${err.message}`;
        responseBox.style.color = "#ef4444";
    }
}

// Inisiasi Mesin Sesi
async function initiateSession() {
    writeLog('info', 'Mengirim perintah inisiasi sesi runtime ke kluster server...');
    socket.emit('init_session');
}

// Generate QR Code
async function requestQR() {
    writeLog('info', 'Meminta generate QR stream parameter...');
    socket.emit('get_qr');
}

// Generate Pairing Code
async function requestPairingCode() {
    const phoneInput = document.getElementById('pairingPhone');
    const phone = phoneInput ? phoneInput.value.trim() : '';
    if(!phone) return alert('Silakan masukkan nomor telepon target!');
    writeLog('info', `Meminta pairing code untuk nomor: ${phone}`);
    socket.emit('get_pairing', { phone });
}

// Render Tabel Session List Secara Realtime
function renderSessionTable(status) {
    const tbody = document.getElementById('sessionTableBody');
    if (!tbody) return;

    let displayStatus = (status || 'disconnected').toUpperCase();
    let textColor = displayStatus === 'CONNECTED' ? '#00ff87' : (displayStatus === 'CONNECTING...' ? '#f59e0b' : '#ef4444');

    tbody.innerHTML = `
        <tr>
            <td><strong>${userData.username}</strong></td>
            <td><span style="color:${textColor}; font-weight:700;">${displayStatus}</span></td>
            <td>
                <button class="btn btn-secondary" style="padding:8px 14px; font-size:12px; margin-right:5px;" onclick="initiateSession()">🔄 Reconnect</button>
                <button class="btn btn-danger" style="padding:8px 14px; font-size:12px;" onclick="deleteSession()">🗑️ Delete Session</button>
            </td>
        </tr>
    `;
}

// Hapus Sesi Paksa 
function deleteSession() {
    if(confirm('Apakah Anda yakin ingin menghapus paksa sesi ini dari storage?')) {
        socket.emit('terminate_session');
        clearConsole();
        localStorage.removeItem('wa_current_status');
        localStorage.removeItem('metric_msg_count');
        localStorage.removeItem('metric_group_count');
        localStorage.removeItem('metric_event_count');
        metrics = { msgCount: 0, groupCount: 0, eventCount: 0 };
        
        if (document.getElementById('cardMessages')) document.getElementById('cardMessages').innerText = 0;
        if (document.getElementById('cardGroups')) document.getElementById('cardGroups').innerText = 0;
        if (document.getElementById('cardEvents')) document.getElementById('cardEvents').innerText = 0;
    }
}

// Pembersihan Console Monitor
function clearConsole() {
    const consoleLogs = document.getElementById('consoleLogs');
    if (consoleLogs) consoleLogs.innerHTML = "";
    allLogs = [];
    localStorage.removeItem('terminal_logs_backup');
}

// Reset Paksa Semua Storage Debugger App
function clearAllAppCache() {
    if (confirm("Apakah Anda yakin ingin mengosongkan semua cadangan data metrik lokal dan log terminal di browser? (Sesi login akun Anda akan tetap aman)")) {
        localStorage.removeItem('terminal_logs_backup');
        localStorage.removeItem('metric_msg_count');
        localStorage.removeItem('metric_group_count');
        localStorage.removeItem('metric_event_count');
        localStorage.removeItem('wa_current_status');
        alert("Semua cache lokal dibersihkan! Silakan muat ulang (refresh) halaman.");
        window.location.reload();
    }
}

// Filter Log Terminal 
function filterLogs() {
    const query = document.getElementById('logSearch').value.toLowerCase();
    const showMsg = document.getElementById('f-msg').checked;
    const showGrp = document.getElementById('f-grp').checked;
    const showPrs = document.getElementById('f-prs').checked;
    const showCal = document.getElementById('f-cal').checked;
    const showCon = document.getElementById('f-con').checked;
    const showCnt = document.getElementById('f-cnt').checked;

    document.querySelectorAll('.log-row').forEach(row => {
        const evType = row.dataset.event || '';
        const text = row.innerText.toLowerCase();
        
        let matchFilter = true;
        if (evType.includes('messages.upsert') && !showMsg) matchFilter = false;
        else if ((evType.includes('groups') || evType.includes('group')) && !showGrp) matchFilter = false;
        else if (evType.includes('presence') && !showPrs) matchFilter = false;
        else if (evType.includes('call') && !showCal) matchFilter = false;
        else if (evType.includes('connection') && !showCon) matchFilter = false;
        else if (evType.includes('contacts') && !showCnt) matchFilter = false;

        const matchQuery = text.includes(query);
        row.style.display = (matchFilter && matchQuery) ? 'block' : 'none';
    });
}

// Download Berkas Log Eksternal - Komplit Murni dengan RAW Base Objects data
function downloadLogs() {
    if(allLogs.length === 0) return alert("Belum ada logs data yang terkumpul.");
    
    const query = document.getElementById('logSearch').value.toLowerCase();
    const showMsg = document.getElementById('f-msg').checked;
    const showGrp = document.getElementById('f-grp').checked;
    const showPrs = document.getElementById('f-prs').checked;
    const showCal = document.getElementById('f-cal').checked;
    const showCon = document.getElementById('f-con').checked;
    const showCnt = document.getElementById('f-cnt').checked;

    const filteredExport = allLogs.filter(log => {
        const evType = log.event || '';
        const text = log.text.toLowerCase();
        
        let matchFilter = true;
        if (evType.includes('messages.upsert') && !showMsg) matchFilter = false;
        else if ((evType.includes('groups') || evType.includes('group')) && !showGrp) matchFilter = false;
        else if (evType.includes('presence') && !showPrs) matchFilter = false;
        else if (evType.includes('call') && !showCal) matchFilter = false;
        else if (evType.includes('connection') && !showCon) matchFilter = false;
        else if (evType.includes('contacts') && !showCnt) matchFilter = false;

        const matchQuery = text.includes(query);
        return matchFilter && matchQuery;
    });

    if (filteredExport.length === 0) return alert("Tidak ada data log yang cocok dengan filter saat ini.");

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(filteredExport, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `debug-raw-log-${userData.username}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

// Buka Tutup Sidebar Mobile Mode
function toggleSidebar() {
    const sidebar = document.getElementById('appSidebar');
    if (sidebar) sidebar.classList.toggle('open');
}

// Keluar Aplikasi
function logout() {
    if(confirm("Apakah Anda yakin ingin keluar dari sistem?")) {
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = '/login.html';
    }
}
