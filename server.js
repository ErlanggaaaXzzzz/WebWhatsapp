const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const pino = require('pino');
const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion // Tambahkan ini jika belum ada
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'SUPER_SECURE_JWT_ENG_SECRET_KEY_123456';

// Penyiapan Database JSON Sederhana & Aman
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

app.use(express.json());
app.use(cors());

// Rate Limiter untuk Keamanan Server
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { message: "Terlalu banyak permintaan dari IP ini." }
});
app.use('/api/', apiLimiter);

// Routing Static File Dashboard
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/script.js', (req, res) => res.sendFile(path.join(__dirname, 'script.js')));

// Fungsi Utilitas Manajemen Basis Data User
function getUsers() {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]');
}
function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ROUTE ENDPOINT: REGISTER
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password || username.length < 4 || password.length < 6) {
            return res.status(400).json({ message: "Validasi parameter gagal!" });
        }
        const users = getUsers();
        if (users.find(u => u.username === username)) {
            return res.status(400).json({ message: "Username sudah terdaftar!" });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        users.push({ username, password: hashedPassword });
        saveUsers(users);
        res.status(201).json({ message: "Registrasi berhasil" });
    } catch (e) {
        res.status(500).json({ message: "Internal server error" });
    }
});

// ROUTE ENDPOINT: LOGIN
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const users = getUsers();
        const user = users.find(u => u.username === username);
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ message: "Kredensial salah!" });
        }
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token });
    } catch (e) {
        res.status(500).json({ message: "Internal server error" });
    }
});

// REPOSITORI RUNTIME ENGINE BAILEYS (Untuk Isolasi Multi-Session Terstruktur)
const activeSessions = {};

// MIDDLEWARE SOCKET.IO: Autentikasi JWT
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication error"));
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error("Authentication error"));
        socket.username = decoded.username;
        next();
    });
});

// SOCKET.IO HUB PIPELINE
io.on('connection', (socket) => {
    // Ambil username berdasarkan token jabat tangan auth socket kamu
    const username = socket.username || "erlanggax"; 
    socket.join(username);

    console.log(`[Socket.IO] User ${username} terhubung ke pipa realtime.`);

    // ==========================================
    // FIX UTAMA: KETIKA WEB DI-REFRESH / LOG IN
    // ==========================================
    if (activeSessions[username]) {
        const session = activeSessions[username];
        
        // Cek status real dari objek socket Baileys
        let currentStatus = 'disconnected';
        if (session.sock && session.sock.user) {
            currentStatus = 'connected';
            session.status = 'connected';
        } else if (session.status) {
            currentStatus = session.status;
        }

        // Kirim status instan ke UI frontend agar tidak nge-blank saat refresh
        socket.emit('whatsapp_status', { status: currentStatus });
        
        if (session.lastQR && currentStatus !== 'connected') {
            socket.emit('whatsapp_qr', { qr: session.lastQR });
        }
    } else {
        // Jika memang belum ada session aktif sama sekali
        socket.emit('whatsapp_status', { status: 'disconnected' });
    }

    // Handler event inisialisasi biasa
    socket.on('init_session', async () => {
        if (activeSessions[username] && activeSessions[username].sock && activeSessions[username].sock.user) {
            activeSessions[username].status = 'connected';
            return io.to(username).emit('whatsapp_status', { status: 'connected' });
        }
        startWhatsAppEngine(username, null);
    });

    socket.on('get_qr', () => {
        if (activeSessions[username] && activeSessions[username].sock && activeSessions[username].sock.user) return;
        startWhatsAppEngine(username, null);
    });

    socket.on('get_pairing', async (data) => {
        if (!data.phone) return;
        let cleanPhone = data.phone.replace(/[^0-9]/g, '');
        startWhatsAppEngine(username, cleanPhone);
    });

    socket.on('terminate_session', () => {
        if (activeSessions[username]) {
            try { 
                activeSessions[username].sock.ev.removeAllListeners();
                activeSessions[username].sock.end(); 
            } catch(e){}
            delete activeSessions[username];
        }
        const userSessionPath = path.join(SESSIONS_DIR, username);
        if (fs.existsSync(userSessionPath)) {
            fs.rmSync(userSessionPath, { recursive: true, force: true });
        }
        io.to(username).emit('whatsapp_status', { status: 'disconnected' });
    });
});

// CORE ENGINE YANG DIOPTIMALKAN 
    
async function startWhatsAppEngine(username, pairingPhone = null) {
    const userSessionPath = path.join(SESSIONS_DIR, username);
    const { state, saveCreds } = await useMultiFileAuthState(userSessionPath);

    // Ambil versi WA Web terbaru secara dinamis agar terhindar dari 405 Method Not Allowed
    let version = [2, 3000, 1017531287]; // Fallback versi web paling aman di tahun 2026
    try {
        const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
        if (latestVersion) version = latestVersion;
        console.log(`Using WA Web Version: ${version.join('.')}, Is Latest: ${isLatest}`);
    } catch(e) {
        console.log("Gagal fetching versi WA terbaru, menggunakan fallback version.");
    }

    if (activeSessions[username] && activeSessions[username].sock) {
        try {
            activeSessions[username].sock.ev.removeAllListeners();
            activeSessions[username].sock.end();
            delete activeSessions[username].sock;
        } catch (e) {}
    }

    if (!activeSessions[username]) {
        activeSessions[username] = { status: 'connecting', lastQR: null, sock: null };
    }

    io.to(username).emit('whatsapp_status', { status: 'connecting' });

    // RACIKAN UTAMA: Konfigurasi Bypass Sinkronisasi 405
        const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        mobile: false,
        markOnlineOnConnect: true,                
        syncFullHistory: false,            // Jangan download semua chat lama
        shouldSyncHistoryMessage: () => false, // Lewati proses parsing pesan masa lalu
        maxSyncRetries: 1,                 // Batasi percobaan sinkronisasi jika timeout
        connectTimeoutMs: 30000,           // Batas waktu tunggu koneksi soket (30 detik)
        defaultQueryTimeoutMs: 30000,
        
        browser: ['Windows', 'Chrome', '126.0.0.0']
    });


    activeSessions[username].sock = sock;

    // Alur Request Pairing Code dengan Penanganan Cepat
    if (pairingPhone && !sock.authState.creds.registered) {
        // Kurangi delay menjadi 2.5 detik agar langsung dieksekusi sebelum token handshake kedaluwarsa
        setTimeout(async () => {
            try {
                if (!activeSessions[username] || !activeSessions[username].sock) return;

                io.to(username).emit('whatsapp_event', { event: 'connection.update', data: { info: `Mengirim request pairing ke server pusat...` } });
                
                let code = await sock.requestPairingCode(pairingPhone);
                
                io.to(username).emit('whatsapp_pairing', { code });
                io.to(username).emit('whatsapp_event', { event: 'connection.update', data: { info: `Sukses! Pairing Code: ${code}. Cek HP Anda sekarang.` } });
            } catch (err) {
                console.error("Gagal pairing:", err);
            }
        }, 2500);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr && !pairingPhone) {
            QRCode.toDataURL(qr, (err, url) => {
                if (!err) {
                    activeSessions[username].lastQR = url;
                    io.to(username).emit('whatsapp_qr', { qr: url });
                }
            });
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            activeSessions[username].status = 'disconnected';
            
            // Jika sukses pairing tapi mendadak close karena daur ulang socket, jangan hapus session jika statusCode normal
            if (statusCode === 405 || statusCode === 401) {
                io.to(username).emit('whatsapp_status', { status: 'disconnected' });
                io.to(username).emit('whatsapp_event', { 
                    event: 'connection.update', 
                    data: { error: `Sesi ditutup otomatis (Code ${statusCode}). Bersihkan session lama lewat menu My Sessions untuk mencoba ulang.` } 
                });
                
                if (fs.existsSync(userSessionPath)) {
                    try { fs.rmSync(userSessionPath, { recursive: true, force: true }); } catch(e){}
                }
                if(activeSessions[username]) delete activeSessions[username].sock;
            } else {
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect && activeSessions[username]) {
                    setTimeout(() => {
                        if(activeSessions[username] && !activeSessions[username].sock) {
                            startWhatsAppEngine(username, null);
                        }
                    }, 5000);
                }
            }
        } else if (connection === 'open') {
            activeSessions[username].status = 'connected';
            activeSessions[username].lastQR = null;
            io.to(username).emit('whatsapp_status', { status: 'connected' });
            console.log(`[Baileys] Sesi untuk ${username} resmi TERHUBUNG secara penuh.`);
        }


        io.to(username).emit('whatsapp_event', { event: 'connection.update', data: update });
    });
    
    const targetEvents = [
        'messages.upsert', 'messages.update', 'messages.delete',
        'group-participants.update', 'groups.update', 'contacts.update',
        'presence.update', 'call', 'chat.update', 'labels.update'
    ];

    targetEvents.forEach(eventName => {
        sock.ev.on(eventName, (data) => {
            io.to(username).emit('whatsapp_event', { event: eventName, data });
        });
    });
}



// Jalankan Engine Server Utama
server.listen(PORT, () => {
    console.log(`=== WA DEBUGGER ENGINE RUNNING ON PORT ${PORT} ===`);
});
