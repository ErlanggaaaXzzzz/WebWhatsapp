let socket;
let allLogs = [];
let filteredLogs = [];
let currentView = 'dashboard';

// Sinkronisasi data metrik lokal
let metrics = { msgCount: 0, groupCount: 0, eventCount: 0 };
let startTime = Date.now();

// Validasi Token Akses Utama
const token = localStorage.getItem('token') || sessionStorage.getItem('token');
if (!token) {
    window.location.href = '/login.html';
}

// Parsing Data User dari JWT (Secara visual aman)
const base64Url = token.split('.')[1];
const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
const userData = JSON.parse(window.atob(base64));
document.getElementById('topUsername').innerText = userData.username;
document.getElementById('topSessionId').innerText = userData.username;

// Mengatur Runtime Clock
setInterval(() => {
    const elapsed = Date.now() - startTime;
    const hrs = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
    const mins = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
    const secs = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
    document.getElementById('cardRuntime').innerText = `${hrs}:${mins}:${secs}`;
}, 1000);

// Inisialisasi Jalur Socket.IO Komunikasi Dupleks
function initSocket() {
    socket = io({ auth: { token } });

    socket.on('connect', () => {
        writeLog('info', 'Berhasil membangun jalur pipa realtime (Socket.IO)');
    });

    socket.on('connect_error', (err) => {
        writeLog('error', `Kegagalan Otorisasi Socket: ${err.message}`);
    });

    socket.on('whatsapp_status', (data) => {
        updateStatusUI(data.status);
    });

    // Perbaikan penampilan QR Code
    socket.on('whatsapp_qr', (data) => {
        const qrImage = document.getElementById('qrImage');
        const qrStateText = document.getElementById('qrStateText');
        if (data.qr) {
            qrImage.src = data.qr;
            qrImage.style.display = 'block'; // Pastikan gambar tampil dari sembunyi
            qrStateText.innerText = 'QR Code diperbarui! Silakan scan menggunakan menu Perangkat Tertaut di WhatsApp Anda.';
            writeLog('info', 'QR Code baru diterima dari Baileys Engine.');
        }
    });

    socket.on('whatsapp_pairing', (data) => {
        const container = document.getElementById('pairingCodeContainer');
        if (data.code) {
            container.innerText = data.code;
            container.style.display = 'block';
            writeLog('info', `Pairing Code sukses digenerate: ${data.code}. Periksa HP Anda untuk memasukkan kode.`);
        }
    });

    socket.on('whatsapp_event', (evt) => {
        metrics.eventCount++;
        document.getElementById('cardEvents').innerText = metrics.eventCount;

        let category = 'event';
        if (evt.event.includes('messages.upsert')) {
            category = 'message';
            metrics.msgCount++;
            document.getElementById('cardMessages').innerText = metrics.msgCount;
        } else if (evt.event.includes('groups') || evt.event.includes('group-participants')) {
            category = 'event';
            metrics.groupCount++;
            document.getElementById('cardGroups').innerText = metrics.groupCount;
        } else if (evt.event.includes('connection')) {
            category = 'info';
        } else if (evt.event.includes('presence')) {
            category = 'presence';
        }

        writeLog(category, `[${evt.event}] ${JSON.stringify(evt.data)}`, evt.event);
    });
}


// Manajemen Perpindahan View Tab Dashboard
function switchView(viewId) {
    currentView = viewId;
    document.querySelectorAll('.view-pane').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.menu-btn').forEach(el => el.classList.remove('active'));

    document.getElementById(`view-${viewId}`).classList.add('active');
    event.currentTarget.classList.add('active');
}

// Log Writer Engine Ke Konsol Virtual Terminal
function writeLog(type, message, rawEventName = 'system') {
    const logObj = {
        id: Date.now() + Math.random().toString(36).substr(2, 5),
        timestamp: new Date().toISOString(),
        type,
        eventName: rawEventName,
        message
    };
    allLogs.push(logObj);
    filterLogs();
}

function renderConsole(logsToRender) {
    const consoleLogs = document.getElementById('consoleLogs');
    consoleLogs.innerHTML = '';
    
    logsToRender.forEach(log => {
        const div = document.createElement('div');
        div.className = `log-row log-${log.type}`;
        div.innerText = `[${log.timestamp}] [${log.type.toUpperCase()}] ${log.message}`;
        consoleLogs.appendChild(div);
    });

    consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

// Realtime Complex Filtering Multi-Kriteria (Search Bar & Checkboxes)
function filterLogs() {
    const query = document.getElementById('logSearch').value.toLowerCase();
    
    const fMsg = document.getElementById('f-msg').checked;
    const fGrp = document.getElementById('f-grp').checked;
    const fPrs = document.getElementById('f-prs').checked;
    const fCal = document.getElementById('f-cal').checked;
    const fCon = document.getElementById('f-con').checked;
    const fCnt = document.getElementById('f-cnt').checked;

    filteredLogs = allLogs.filter(log => {
        // Filter Berdasarkan Kategori Checkbox
        if (log.eventName.startsWith('messages') && !fMsg) return false;
        if ((log.eventName.startsWith('group') || log.eventName.startsWith('group-participants')) && !fGrp) return false;
        if (log.eventName.startsWith('presence') && !fPrs) return false;
        if (log.eventName.startsWith('call') && !fCal) return false;
        if (log.eventName.startsWith('connection') && !fCon) return false;
        if (log.eventName.startsWith('contacts') && !fCnt) return false;

        // Filter Berdasarkan Input Search Bar
        if (query) {
            return log.message.toLowerCase().includes(query) || log.eventName.toLowerCase().includes(query);
        }
        return true;
    });

    renderConsole(filteredLogs);
}

function clearConsole() {
    allLogs = [];
    filterLogs();
}

// Ekspor Data Log Logika Ke JSON Berkas
function downloadLogs() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(filteredLogs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `debug-log-${userData.username}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
}

// Memanggil API Triggers Baileys Core
async function initiateSession() {
    writeLog('info', 'Mengirim perintah inisiasi sesi runtime ke kluster server...');
    socket.emit('init_session');
}

async function requestQR() {
    writeLog('info', 'Meminta generate QR stream parameter...');
    socket.emit('get_qr');
}

async function requestPairingCode() {
    const phone = document.getElementById('pairingPhone').value.trim();
    if(!phone) return alert('Silakan masukkan nomor telepon target!');
    writeLog('info', `Meminta pairing code untuk nomor: ${phone}`);
    socket.emit('get_pairing', { phone });
}

function renderSessionTable(status) {
    const tbody = document.getElementById('sessionTableBody');
    tbody.innerHTML = `
        <tr>
            <td><strong>${userData.username}</strong></td>
            <td><span style="color:${status === 'connected' ? '#00ff87' : '#ef4444'}">${status.toUpperCase()}</span></td>
            <td>
                <button class="btn btn-secondary" style="padding:4px 10px; font-size:12px;" onclick="initiateSession()">Reconnect</button>
                <button class="btn btn-danger" style="padding:4px 10px; font-size:12px;" onclick="deleteSession()">Disconnect & Delete</button>
            </td>
        </tr>
    `;
}

function deleteSession() {
    if(confirm('Apakah Anda yakin ingin menghapus paksa sesi ini dari storage?')) {
        socket.emit('terminate_session');
        clearConsole();
    }
}

function logout() {
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
    window.location.href = '/login.html';
}

// Entry Point Aliran Eksekusi Utama
initSocket();
