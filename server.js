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
    DisconnectReason 
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
    const username = socket.username;
    socket.join(username);

    // Kirim status awal saat user baru konek/refresh web
    if (activeSessions[username]) {
        socket.emit('whatsapp_status', { status: activeSessions[username].status || 'disconnected' });
        if (activeSessions[username].lastQR) {
            socket.emit('whatsapp_qr', { qr: activeSessions[username].lastQR });
        }
    } else {
        socket.emit('whatsapp_status', { status: 'disconnected' });
    }

    // Event: Inisialisasi Sesi Utama (Kosongan / Default tanpa pairing dulu)
    socket.on('init_session', async () => {
        if (activeSessions[username] && activeSessions[username].status === 'connected') {
            return io.to(username).emit('whatsapp_status', { status: 'connected' });
        }
        // Jalankan tanpa nomor hp (untuk standby QR atau auto-reconnect)
        startWhatsAppEngine(username, null);
    });

    // Event: Request QR Code Manual (Memaksa engine refresh & dengarkan QR)
    socket.on('get_qr', () => {
        // Jika sudah terhubung, tidak perlu QR lagi
        if (activeSessions[username] && activeSessions[username].status === 'connected') return;
        
        // Buat ulang engine tanpa nomor HP untuk mentrigger event 'connection.update' membawa QR
        startWhatsAppEngine(username, null);
    });

    // Event: Request Pairing Code (Memastikan socket bersih sebelum request)
    socket.on('get_pairing', async (data) => {
        if (!data.phone) return;
        let cleanPhone = data.phone.replace(/[^0-9]/g, '');
        // Jalankan engine khusus dengan membawa nomor telepon pairing
        startWhatsAppEngine(username, cleanPhone);
    });

    socket.on('terminate_session', () => {
        if (activeSessions[username]) {
            try { activeSessions[username].sock.end(); } catch(e){}
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

    // 1. Bersihkan socket lama secara total agar resource internal OS lepas
    if (activeSessions[username] && activeSessions[username].sock) {
        try {
            activeSessions[username].sock.ev.removeAllListeners();
            activeSessions[username].sock.end();
            delete activeSessions[username].sock;
        } catch (e) {
            console.log("Error membersihkan socket:", e.message);
        }
    }

    if (!activeSessions[username]) {
        activeSessions[username] = { status: 'connecting', lastQR: null, sock: null };
    }

    io.to(username).emit('whatsapp_status', { status: 'connecting' });
    io.to(username).emit('whatsapp_event', { event: 'connection.update', data: { info: "Memulai inisialisasi Baileys Core Engine..." } });

    // 2. Gunakan User-Agent Chrome MacOS Terbaru yang paling stabil untuk Baileys Web
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        mobile: false,
        keepAliveIntervalMs: 30000, // Menjaga kestabilan koneksi di cloud server
        browser: ['Mac OS', 'Chrome', '125.0.0.0'] 
    });

    activeSessions[username].sock = sock;

    // 3. Alur Request Pairing Code dengan Penanganan Error Ketat
    if (pairingPhone && !sock.authState.creds.registered) {
        // Beri jeda 4 detik agar proses websocket handshake selesai sempurna di server Railway
        setTimeout(async () => {
            try {
                // Pastikan socket tidak tertutup di tengah jalan sebelum meminta kode
                if (!activeSessions[username] || !activeSessions[username].sock) return;

                io.to(username).emit('whatsapp_event', { event: 'connection.update', data: { info: `Mengirim sinyal permintaan pairing code ke WhatsApp untuk nomor: ${pairingPhone}...` } });
                
                let code = await sock.requestPairingCode(pairingPhone);
                
                io.to(username).emit('whatsapp_pairing', { code });
                io.to(username).emit('whatsapp_event', { event: 'connection.update', data: { info: `Sukses! Pairing Code didapatkan: ${code}. Silakan cek HP Anda.` } });
            } catch (err) {
                console.error("Gagal mendapatkan pairing code:", err);
                io.to(username).emit('whatsapp_event', { 
                    event: 'connection.update', 
                    data: { error: `WhatsApp menolak pembuatan kode (IP Server Terblokir / Terlalu Banyak Request). Silakan ganti IP atau tunggu beberapa saat.` } 
                });
            }
        }, 4000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Hanya render QR jika user tidak memasukkan nomor telepon pairing
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
            activeSessions[username].lastQR = null;
            io.to(username).emit('whatsapp_status', { status: 'disconnected' });
            
            // PROTEKSI ANTI SPAM IP: Jika terkena status 405, 401, atau 429 (Too Many Requests)
            if (statusCode === 405 || statusCode === 401 || statusCode === 429) {
                console.log(`[!] Menghentikan perulangan mesin. WhatsApp merespons dengan kode: ${statusCode}`);
                io.to(username).emit('whatsapp_event', { 
                    event: 'connection.update', 
                    data: { error: `Koneksi dihentikan oleh WhatsApp dengan kode status ${statusCode}. Folder sesi otomatis dibersihkan demi keamanan IP.` } 
                });
                
                // Hapus sesi lokal agar tidak terjadi penumpukan cache data korup
                if (fs.existsSync(userSessionPath)) {
                    try { fs.rmSync(userSessionPath, { recursive: true, force: true }); } catch(e){}
                }
                if(activeSessions[username]) delete activeSessions[username].sock;
            } else {
                // Hubungkan ulang otomatis hanya untuk kegagalan jaringan kasual (Jeda 5 detik)
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect && activeSessions[username]) {
                    console.log(`Koneksi terputus biasa (${statusCode}), mencoba rekoneksi...`);
                    setTimeout(() => {
                        // Pastikan tidak meluncurkan ulang jika user sudah mengubah aksi ke pairing
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
