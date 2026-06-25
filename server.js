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

    // LANGKAH KRISITIAL: Jika ada socket lama yang berjalan, matikan total dulu agar tidak tabrakan
    if (activeSessions[username] && activeSessions[username].sock) {
        try {
            activeSessions[username].sock.ev.removeAllListeners();
            activeSessions[username].sock.end();
        } catch (e) {
            console.log("Mencoba membersihkan socket lama:", e.message);
        }
    }

    if (!activeSessions[username]) {
        activeSessions[username] = { status: 'connecting', lastQR: null, sock: null };
    }

    io.to(username).emit('whatsapp_status', { status: 'connecting' });
    io.to(username).emit('whatsapp_event', { event: 'connection.update', data: { info: "Initializing Baileys Socket..." } });

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["WA Debugger Professional", "Chrome", "1.0.0"] // Info browser wajib agar pairing valid
    });

    activeSessions[username].sock = sock;

    // Logika Request Pairing Code (Wajib dieksekusi sebelum ada intervensi koneksi lain)
    if (pairingPhone && !sock.authState.creds.registered) {
        // Beri jeda 1.5 detik agar socket siap seutuhnya sebelum menembak request ke server WA
        setTimeout(async () => {
            try {
                io.to(username).emit('whatsapp_event', { event: 'connection.update', data: { info: `Requesting pairing code untuk ${pairingPhone}...` } });
                let code = await sock.requestPairingCode(pairingPhone);
                io.to(username).emit('whatsapp_pairing', { code });
                io.to(username).emit('whatsapp_event', { event: 'connection.update', data: { info: `Pairing code berhasil didapatkan: ${code}` } });
            } catch (err) {
                console.error("Gagal mendapatkan pairing code:", err);
                io.to(username).emit('whatsapp_event', { event: 'connection.update', data: { error: 'Gagal generate pairing code, coba klik sekali lagi.' } });
            }
        }, 1500);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr && !pairingPhone) { // Hanya render QR jika user tidak sedang meminta pairing code
            QRCode.toDataURL(qr, (err, url) => {
                if (!err) {
                    activeSessions[username].lastQR = url;
                    io.to(username).emit('whatsapp_qr', { qr: url });
                }
            });
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            activeSessions[username].status = 'disconnected';
            activeSessions[username].lastQR = null;
            io.to(username).emit('whatsapp_status', { status: 'disconnected' });
            
            // Auto reconnect jika bukan karena logout sengaja
            if (shouldReconnect) {
                console.log(`Koneksi terputus (Reason: ${statusCode}), mencoba menyambungkan ulang...`);
                startWhatsAppEngine(username, null);
            }
        } else if (connection === 'open') {
            activeSessions[username].status = 'connected';
            activeSessions[username].lastQR = null;
            io.to(username).emit('whatsapp_status', { status: 'connected' });
        }

        io.to(username).emit('whatsapp_event', { event: 'connection.update', data: update });
    });

    // Pipa Log Event Kolektor
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
