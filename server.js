const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
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
    // Bergabung dengan kamar terisolasi berdasarkan username uniknya
    socket.join(username);

    // Sinkronisasi status instan saat browser terhubung kembali
    if (activeSessions[username]) {
        io.to(username).emit('whatsapp_status', { status: activeSessions[username].status || 'disconnected' });
    } else {
        io.to(username).emit('whatsapp_status', { status: 'disconnected' });
    }

    // Event: Memulai Mesin Sesi Baileys
    socket.on('init_session', async () => {
        if (activeSessions[username] && activeSessions[username].status === 'connected') {
            return io.to(username).emit('whatsapp_status', { status: 'connected' });
        }
        startWhatsAppEngine(username);
    });

    // Event: Request QR Code Manual
    socket.on('get_qr', () => {
        if (activeSessions[username] && activeSessions[username].lastQR) {
            io.to(username).emit('whatsapp_qr', { qr: activeSessions[username].lastQR });
        }
    });

    // Event: Request Pairing Code
    socket.on('get_pairing', async (data) => {
        if (!data.phone) return;
        startWhatsAppEngine(username, data.phone);
    });

    // Event: Tutup Paksa dan Hapus Folder Sesi Selesai
    socket.on('terminate_session', () => {
        if (activeSessions[username]) {
            try { activeSessions[username].sock.logout(); } catch(e){}
            delete activeSessions[username];
        }
        const userSessionPath = path.join(SESSIONS_DIR, username);
        if (fs.existsSync(userSessionPath)) {
            fs.rmSync(userSessionPath, { recursive: true, force: true });
        }
        io.to(username).emit('whatsapp_status', { status: 'disconnected' });
    });
});

// CORE ENGINE: KERNEL MANAGER WHATSAPP (BAILEYS MULTI-SESSION INSTANCE)
async function startWhatsAppEngine(username, pairingPhone = null) {
    const userSessionPath = path.join(SESSIONS_DIR, username);
    const { state, saveCreds } = await useMultiFileAuthState(userSessionPath);

    if (!activeSessions[username]) {
        activeSessions[username] = { status: 'connecting', lastQR: null, sock: null };
    }

    io.to(username).emit('whatsapp_status', { status: 'connecting' });

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    activeSessions[username].sock = sock;

    // Menangani Alur Pairing Code
    if (pairingPhone && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(pairingPhone.replace(/[^0-9]/g, ''));
                io.to(username).emit('whatsapp_pairing', { code });
            } catch (err) {
                io.to(username).emit('whatsapp_event', { event: 'connection.update', data: { error: 'Gagal membuat pairing code' } });
            }
        }, 3000);
    }

    // SINKRONISASI UPDATE CREDENTIALS
    sock.ev.on('creds.update', saveCreds);

    // SINKRONISASI EVENT CONNECTION UPDATE
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            QRCode.toDataURL(qr, (err, url) => {
                if (!err) {
                    activeSessions[username].lastQR = url;
                    io.to(username).emit('whatsapp_qr', { qr: url });
                }
            });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            activeSessions[username].status = 'disconnected';
            activeSessions[username].lastQR = null;
            io.to(username).emit('whatsapp_status', { status: 'disconnected' });
            
            if (shouldReconnect) {
                startWhatsAppEngine(username);
            }
        } else if (connection === 'open') {
            activeSessions[username].status = 'connected';
            activeSessions[username].lastQR = null;
            io.to(username).emit('whatsapp_status', { status: 'connected' });
        }

        io.to(username).emit('whatsapp_event', { event: 'connection.update', data: update });
    });

    // DAFTAR EVENT LISTENER PENUH UNTUK LIVE DEBUGGER PIPELINE
    const targetEvents = [
        'messages.upsert', 'messages.update', 'messages.delete',
        'group-participants.update', 'groups.update', 'contacts.update',
        'presence.update', 'call', 'chat.update', 'labels.update'
    ];

    targetEvents.forEach(eventName => {
        sock.ev.on(eventName, (data) => {
            // Emisi event mentah ke user pemilik sesi
            io.to(username).emit('whatsapp_event', { event: eventName, data });
        });
    });
}

// Jalankan Engine Server Utama
server.listen(PORT, () => {
    console.log(`=== WA DEBUGGER ENGINE RUNNING ON PORT ${PORT} ===`);
});
