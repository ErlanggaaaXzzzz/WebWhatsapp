let socket;
let allLogs = [];
let filteredLogs = [];
let currentView = 'dashboard';

// Sinkronisasi data metrik lokal
let metrics = { msgCount: 0, groupCount: 0, eventCount: 0 };
let startTime = Date.now();

// Validasi Token Akses Utama (Bawaan Asli)
const token = localStorage.getItem('token') || sessionStorage.getItem('token');
if (!token) {
    window.location.href = '/login.html';
}

// Parsing Data User dari JWT (Bawaan Asli)
const base64Url = token.split('.')[1];
const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
const userData = JSON.parse(window.atob(base64));

// Jalankan saat DOM siap
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('topUsername').innerText = userData.username;
    document.getElementById('topSessionId').innerText = userData.username;
    
    initSocket();
    loadSavedState(); // FIX REFRESH: Pulihkan tab, metrik, dan log dari localStorage
});

// Mengatur Runtime Clock (Bawaan Asli)
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

    // Menangani sinkronisasi status realtime global dari backend server cloud
    socket.on('whatsapp_status', (data) => {
        console.log("Sinkronisasi status soket masuk:", data.status);
        updateStatusUI(data.status);
        
        // Amankan status ke localStorage agar saat di-refresh tidak berkedip merah
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
        // Hitung metrik pesan masuk secara realtime
        if (evt.event === 'messages.upsert') {
            metrics.msgCount++;
            const cardMsg = document.getElementById('cardMessages');
            if (cardMsg) cardMsg.innerText = metrics.msgCount;
            localStorage.setItem('metric_msg_count', metrics.msgCount);
        }

        // Hitung metrik grup masuk secara realtime
        if (evt.event === 'groups.update' || evt.event === 'group-participants.update') {
            metrics.groupCount++;
            const cardGrp = document.getElementById('cardGroups');
            if (cardGrp) cardGrp.innerText = metrics.groupCount;
            localStorage.setItem('metric_group_count', metrics.groupCount);
        }

        // Hitung total event
        metrics.eventCount++;
        const cardEvt = document.getElementById('cardEvents');
        if (cardEvt) cardEvt.innerText = metrics.eventCount;
        localStorage.setItem('metric_event_count', metrics.eventCount);

        let category = 'event';
        if (evt.event.includes('connection')) category = 'info';
        if (evt.event.includes('messages.upsert')) category = 'message';

        // FIX JSON: Penataan Payload JSON Supaya Teratur ke Bawah (Indentasi 2 Spasi)
        let formattedJSON = "";
        try {
            let dataObject = typeof evt.data === 'string' ? JSON.parse(evt.data) : evt.data;
            formattedJSON = JSON.stringify(dataObject, null, 2);
        } catch (e) {
            formattedJSON = typeof evt.data === 'object' ? JSON.stringify(evt.data, null, 2) : evt.data;
        }

        writeLog(category, `[${evt.event}]\n${formattedJSON}`, evt.event);
    });
}

// Fungsi Manajemen Pergantian Tab (View Switcher) Terintegrasi LocalStorage
function switchView(viewName) {
    currentView = viewName;
    
    // Sembunyikan seluruh view pane yang ada
    document.querySelectorAll('.view-pane').forEach(pane => pane.classList.remove('active'));
    document.querySelectorAll('.menu-btn').forEach(btn => btn.classList.remove('active'));

    // Aktifkan view target pilihan user
    const targetPane = document.getElementById(`view-${viewName}`);
    if (targetPane) targetPane.classList.add('active');

    // Aktifkan visual tombol menu penunjuk
    const targetBtn = document.getElementById(`btn-${viewName}`) || document.getElementById(`id-${viewName}`);
    if (targetBtn) targetBtn.classList.add('active');

    // Simpan preferensi menu user ke dalam localStorage agar awet saat refresh
    localStorage.setItem('active_view_pane', viewName);

    // Otomatis tutup sidebar di mode mobile setelah tombol diklik
    const sidebar = document.getElementById('appSidebar');
    if (sidebar && window.innerWidth <= 768) {
        sidebar.classList.remove('open');
    }
}

// Pemuat State Cadangan (Anti-Reset saat Halaman Di-refresh)
function loadSavedState() {
    // 1. Pulihkan Tab Terakhir
    const savedView = localStorage.getItem('active_view_pane') || 'dashboard';
    switchView(savedView);

    // 2. Pulihkan Angka Pencatatan Metrik
    metrics.msgCount = parseInt(localStorage.getItem('metric_msg_count')) || 0;
    metrics.groupCount = parseInt(localStorage.getItem('metric_group_count')) || 0;
    metrics.eventCount = parseInt(localStorage.getItem('metric_event_count')) || 0;
    
    if (document.getElementById('cardMessages')) document.getElementById('cardMessages').innerText = metrics.msgCount;
    if (document.getElementById('cardGroups')) document.getElementById('cardGroups').innerText = metrics.groupCount;
    if (document.getElementById('cardEvents')) document.getElementById('cardEvents').innerText = metrics.eventCount;

    // 3. Pasang Status Terakhir di UI Sembari Menunggu Koneksi Handshake Socket Selesai
    const savedStatus = localStorage.getItem('wa_current_status') || 'disconnected';
    updateStatusUI(savedStatus);

    // 4. Bangun Kembali Log Terminal dari Memory Lokal
    const savedLogs = localStorage.getItem('terminal_logs_backup');
    if (savedLogs) {
        try {
            allLogs = JSON.parse(savedLogs);
            const consoleLogs = document.getElementById('consoleLogs');
            if (consoleLogs) {
                consoleLogs.innerHTML = ""; // Bersihkan placeholder
                allLogs.forEach(log => {
                    const row = document.createElement('div');
                    row.className = `log-row log-${log.type}`;
                    row.dataset.event = log.event;
                    row.innerText = log.text;
                    consoleLogs.appendChild(row);
                });
                consoleLogs.scrollTop = consoleLogs.scrollHeight; // Auto-scroll ke bawah
            }
        } catch (e) { console.error("Gagal membaca arsip log.", e); }
    }
}

// Fungsi Penulis Log Terminal Utama dengan Sistem Cadangan Otomatis
function writeLog(type, text, eventName = '') {
    const consoleLogs = document.getElementById('consoleLogs');
    if (!consoleLogs) return;

    const timestamp = new Date().toISOString().split('T')[1].slice(0, 8);
    const textWithTime = `[${timestamp}] ${text}`;

    // Buat elemen baris log baru di DOM
    const row = document.createElement('div');
    row.className = `log-row log-${type}`;
    row.dataset.event = eventName;
    row.innerText = textWithTime;

    consoleLogs.appendChild(row);
    consoleLogs.scrollTop = consoleLogs.scrollHeight; // Gulir otomatis terminal ke bawah

    // Amankan data ke array internal (Sesuai fungsional asli) & backup ke localStorage
    allLogs.push({ type, text: textWithTime, event: eventName });
    
    // Batasi cache maksimal 150 baris di browser agar performa tab tetap enteng dan kencang
    if (allLogs.length > 150) allLogs.shift();
    localStorage.setItem('terminal_logs_backup', JSON.stringify(allLogs));
}

// Menangani Update Tampilan Teks Status dan Warna Indikator Secara Realtime Global
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

// Inisiasi Mesin Sesi (Bawaan Asli)
async function initiateSession() {
    writeLog('info', 'Mengirim perintah inisiasi sesi runtime ke kluster server...');
    socket.emit('init_session');
}

// Generate QR Code (Bawaan Asli)
async function requestQR() {
    writeLog('info', 'Meminta generate QR stream parameter...');
    socket.emit('get_qr');
}

// Generate Pairing Code (Bawaan Asli)
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

// Hapus Sesi Paksa (Bawaan Asli dengan Pembersihan Cache Local)
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

// Filter Log Terminal (Bawaan Asli dengan Fitur Baru)
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
        else if (evType.includes('groups') && !showGrp) matchFilter = false;
        else if (evType.includes('presence') && !showPrs) matchFilter = false;
        else if (evType.includes('call') && !showCal) matchFilter = false;
        else if (evType.includes('connection') && !showCon) matchFilter = false;
        else if (evType.includes('contacts') && !showCnt) matchFilter = false;

        const matchQuery = text.includes(query);
        row.style.display = (matchFilter && matchQuery) ? 'block' : 'none';
    });
}

// Download Berkas Log Eksternal
function downloadLogs() {
    if(allLogs.length === 0) return alert("Belum ada logs data yang terkumpul.");
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(allLogs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `debug-log-${userData.username}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

// Buka Tutup Sidebar Mobile Mode
function toggleSidebar() {
    const sidebar = document.getElementById('appSidebar');
    if (sidebar) sidebar.classList.toggle('open');
}

// Keluar Aplikasi (Bawaan Asli)
function logout() {
    if(confirm("Apakah Anda yakin ingin keluar dari sistem?")) {
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = '/login.html';
    }
}
