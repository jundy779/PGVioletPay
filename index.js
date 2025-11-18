// FILE: index.js
// Server: Callback + Admin API + Log Streaming + Dashboard

const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { URLSearchParams } = require("url");
const path = require('path');
const http = require('http'); 
const { Server } = require("socket.io"); 
const stream = require('stream'); 

require("dotenv").config();

// ========== ENV VARS ==========
// Menggunakan 1 token saja sesuai permintaan sebelumnya
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 37761;
const HEROKU_API_TOKEN = process.env.HEROKU_API_TOKEN;
const HEROKU_APP_NAME = process.env.HEROKU_APP_NAME;
const CHANNEL_ID = process.env.CHANNEL_ID;

// ========== VALIDASI ENV ==========
if (!BOT_TOKEN || !MONGO_URI || !VIOLET_API_KEY || !VIOLET_SECRET_KEY) {
    console.error("❌ ERROR: Pastikan BOT_TOKEN, MONGO_URI, VIOLET_API_KEY, dan VIOLET_SECRET_KEY terisi di .env");
    process.exit(1);
}

// ========== KONEKSI DB ==========
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Database Connected"))
    .catch(err => console.error("❌ Mongo Error:", err));

// ========== SERVER SETUP ==========
const app = express();
const server = http.createServer(app); 
const io = new Server(server); 

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- PENTING: Menyajikan File Dashboard (Public) ---
app.use(express.static(path.join(__dirname, 'public')));

// ========== MODELS ==========
// Pastikan file model ini ada di folder models/
const User = require('./models/User');
const Product = require('./models/Product');
const Transaction = require('./models/Transaction');
const Setting = require('./models/Setting'); 

// ========== RUTE DASHBOARD ==========
// Ini yang memperbaiki error "Cannot GET /dashboard"
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== HELPER: IP & TELEGRAM ==========
const VMP_ALLOWED_IP = new Set(["202.155.132.37", "2001:df7:5300:9::122"]);

function getClientIp(req) {
    return req.headers["x-forwarded-for"]?.split(",")[0] || req.connection.remoteAddress;
}

async function sendTelegramMessage(userId, msg) {
    if (!BOT_TOKEN) return;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        body: new URLSearchParams({ chat_id: userId, text: msg, parse_mode: "Markdown" })
    }).catch(e => console.log("[TG Error]:", e.message));
}

async function sendChannelNotification(message) {
    if (!CHANNEL_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            body: new URLSearchParams({ chat_id: CHANNEL_ID, text: message, parse_mode: "Markdown" })
        });
    } catch (error) {
        console.error(`❌ Channel Notif Error: ${error.message}`);
    }
}

// ========== HELPER: KIRIM PRODUK ==========
async function deliverProductAndNotify(userId, productId, transaction, product) {
    try {
        const productData = await Product.findById(productId);
        if (!productData || productData.kontenProduk.length === 0) {
            const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
            if (ADMIN_IDS.length > 0) {
                sendTelegramMessage(ADMIN_IDS[0], `⚠️ [ADMIN] Stok Habis! User ${userId} beli ${productData?.namaProduk}. Ref: ${transaction.refId}`);
            }
            return sendTelegramMessage(userId, `⚠️ Pembelian Berhasil (Ref: \`${transaction.refId}\`), namun stok konten habis. Hubungi Admin.`);
        }

        const deliveredContent = productData.kontenProduk.shift();
        await Product.updateOne({ _id: productId }, {
            $set: { kontenProduk: productData.kontenProduk },
            $inc: { stok: -1, totalTerjual: 1 }
        });
        
        const stokAkhir = productData.kontenProduk.length;

        // Notif Channel
        const notifMessage = `🎉 **PENJUALAN BARU (QRIS)** 🎉\n\n` +
                           `👤 **Pembeli:** [${transaction.userId}](tg://user?id=${transaction.userId})\n` +
                           `🛍️ **Produk:** \`${product.namaProduk}\`\n` +
                           `💰 **Total:** \`Rp ${product.harga.toLocaleString('id-ID')}\`\n\n` +
                           `📦 **Sisa Stok:** \`${stokAkhir}\` pcs\n` +
                           `🆔 **Ref ID:** \`${transaction.refId}\``;
        await sendChannelNotification(notifMessage);

        // Kirim Sticker
        const stickerSetting = await Setting.findOne({ key: 'success_sticker_id' });
        if (stickerSetting && stickerSetting.value) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendSticker`, {
                method: "POST",
                body: new URLSearchParams({ chat_id: userId, sticker: stickerSetting.value })
            }).catch(e => console.log("Sticker Error:", e.message));
        }

        // Kirim Produk ke User
        const date = new Date();
        const dateCreated = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}, ${date.toLocaleTimeString('id-ID')}`;
        let successMessage = `📜 *Pembelian Berhasil*\nTerimakasih telah berbelanja.\n\n` +
        `*Detail:*\n— *Total:* Rp ${transaction.totalBayar.toLocaleString('id-ID')}\n— *Tanggal:* ${dateCreated}\n— *Ref:* ${transaction.refId}\n\n` +
        `*${product.namaProduk}*\n` + "```txt\n" + `${deliveredContent}\n` + "```";
        
        sendTelegramMessage(userId, successMessage);

    } catch (err) {
        console.log("[Delivery Error]:", err);
        sendTelegramMessage(userId, `❌ Terjadi kesalahan pengiriman produk (Ref: \`${transaction.refId}\`). Hubungi Admin.`);
    }
}

// ========== API: PRODUCT MANAGEMENT (ADMIN) ==========

// 1. Get All Products
app.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find({}).sort({ kategori: 1, harga: 1 });
        res.json(products);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Add Product
app.post('/api/products', async (req, res) => {
    try {
        const data = req.body;
        data.stok = 0; 
        data.kontenProduk = []; 
        const newProd = new Product(data);
        await newProd.save();
        res.json({ success: true, product: newProd });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Edit Product
app.put('/api/products/:id', async (req, res) => {
    try {
        const { kategori, namaProduk, harga, deskripsi } = req.body;
        const updated = await Product.findByIdAndUpdate(req.params.id, {
            kategori, namaProduk, harga, deskripsi
        }, { new: true });
        res.json({ success: true, product: updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Delete Product
app.delete('/api/products/:id', async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Add Stock (Append)
app.post('/api/products/:id/stock', async (req, res) => {
    try {
        const { newStock } = req.body; 
        const stockArray = Array.isArray(newStock) ? newStock : newStock.split('\n').filter(s => s.trim());
        
        if (stockArray.length === 0) return res.status(400).json({ error: "Stok kosong" });

        const product = await Product.findById(req.params.id);
        if(!product) return res.status(404).json({ error: "Produk tidak ditemukan" });

        product.kontenProduk.push(...stockArray);
        product.stok = product.kontenProduk.length;
        await product.save();

        res.json({ success: true, currentStock: product.stok });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ========== API: STATS ==========
function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
}

app.get('/api/stats', async (req, res) => {
    try {
        const [users, products, allTrx, successTrx, pendingTrx, failedTrx] = await Promise.all([
            User.countDocuments(), Product.countDocuments(), Transaction.countDocuments(),
            Transaction.countDocuments({ status: 'SUCCESS' }),
            Transaction.countDocuments({ status: 'PENDING' }),
            Transaction.countDocuments({ status: { $in: ['FAILED', 'EXPIRED'] } })
        ]);

        res.json({
            dbStatus: mongoose.connection.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED',
            serverUptime: formatUptime(process.uptime()),
            totalUsers: users, totalProducts: products, totalTransactions: allTrx,
            successTransactions: successTrx, pendingTransactions: pendingTrx, failedTransactions: failedTrx
        });
    } catch (e) { res.status(500).json({ error: "Stats Error" }); }
});


// ========== RUTE: CALLBACK VIOLET PAY ==========
app.post("/violet-callback", async (req, res) => {
    const data = req.body;
    const refid = data.ref || data.ref_id || data.ref_kode;
    const status = (data.status || "").toLowerCase();
    const incomingSignature = data.signature || req.headers["x-callback-signature"] || null;
    const clientIp = getClientIp(req);

    console.log(`[CALLBACK] IP:${clientIp} REF:${refid} STATUS:${status}`);

    if (!refid) return res.status(200).send({ status: true });
    if (!refid.startsWith("PROD-") && !refid.startsWith("TOPUP-")) return res.status(200).send({ status: true });

    try {
        const trx = await Transaction.findOne({ refId: refid });
        if (!trx || trx.status === "SUCCESS") return res.status(200).send({ status: true });

        const expectedSignature = crypto.createHmac("sha256", VIOLET_API_KEY).update(refid).digest("hex");
        if (incomingSignature && incomingSignature !== expectedSignature) {
            console.log("🚫 Signature mismatch"); return res.status(200).send({ status: true });
        }
        if (!incomingSignature && !VMP_ALLOWED_IP.has(clientIp)) {
            console.log("🚫 IP Unauthorized"); return res.status(200).send({ status: true });
        }

        if (status === "success") {
            await Transaction.updateOne({ refId: refid }, { status: "SUCCESS", vmpSignature: incomingSignature });
            
            if (trx.produkInfo.type === "TOPUP") {
                await User.updateOne({ userId: trx.userId }, { $inc: { saldo: trx.totalBayar, totalTransaksi: 1 } });
                const u = await User.findOne({ userId: trx.userId });
                const notifMessage = `💰 **TOP-UP SUKSES (QRIS)** 💰\n👤 **User:** [${u.username}](tg://user?id=${trx.userId})\n💰 **Total:** \`Rp ${trx.totalBayar.toLocaleString('id-ID')}\``;
                await sendChannelNotification(notifMessage);
                sendTelegramMessage(trx.userId, `🎉 Top Up Berhasil! Saldo kini: Rp ${u.saldo.toLocaleString("id-ID")}.`);
            } else {
                const product = await Product.findOne({ namaProduk: trx.produkInfo.namaProduk });
                if (product) await deliverProductAndNotify(trx.userId, product._id, trx, product);
                else sendTelegramMessage(trx.userId, `⚠️ Produk tidak ditemukan (Ref: ${refid}).`);
            }
        } else if (status === "failed" || status === "expired") {
            await Transaction.updateOne({ refId: refid }, { status: status.toUpperCase() });
            sendTelegramMessage(trx.userId, `❌ *Transaksi ${status.toUpperCase()}!* (Ref: \`${refid}\`)`);
        }
        return res.status(200).send({ status: true });
    } catch (err) {
        console.error(`[Callback Error] ${err.message}`);
        return res.status(200).send({ status: true });
    }
});


// ========== SOCKET.IO: HEROKU LOGS ==========
io.on('connection', async (socket) => {
    socket.emit('log', { line: '=== Connected to Admin Console ===\n', source: 'server' });
    let controller = new AbortController();

    if (HEROKU_API_TOKEN && HEROKU_APP_NAME) {
        try {
            const sessionRes = await fetch(`https://api.heroku.com/apps/${HEROKU_APP_NAME}/log-sessions`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${HEROKU_API_TOKEN}`, 'Accept': 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' },
                body: JSON.stringify({ lines: 100, tail: true }),
                signal: controller.signal
            });

            if(sessionRes.ok) {
                const data = await sessionRes.json();
                const logplexUrl = data.logplex_url;

                const streamRes = await fetch(logplexUrl, { signal: controller.signal });
                
                socket.emit('log', { line: '=== Heroku Log Stream Connected ===\n', source: 'server' });

                const logProcessor = new stream.Transform({
                    transform(chunk, enc, cb) {
                        chunk.toString().split('\n').forEach(line => {
                            if(line.trim()) {
                                let src = line.includes('heroku[router]') ? 'router' : (line.includes('heroku[') ? 'scheduler' : 'app');
                                socket.emit('log', { line: line + '\n', source: src });
                            }
                        });
                        cb();
                    }
                });

                streamRes.body.pipe(logProcessor);
                
                streamRes.body.on('error', (e) => {
                    if (e.name !== 'AbortError') socket.emit('log', { line: `[Stream Error] ${e.message}\n`, source: 'error' });
                });
            } else {
                const txt = await sessionRes.text();
                socket.emit('log', { line: `[API Error] ${sessionRes.status}: ${txt}\n`, source: 'error' });
            }
        } catch (e) {
            if (e.name !== 'AbortError') socket.emit('log', { line: `[Error] ${e.message}\n`, source: 'error' });
        }
    } else {
        socket.emit('log', { line: '[Config] HEROKU_API_TOKEN missing.\n', source: 'error' });
    }

    socket.on('disconnect', () => controller.abort());
});

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
