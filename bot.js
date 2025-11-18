const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

require('dotenv').config();

const User = require('./models/User');
const Product = require('./models/Product');
const Transaction = require('./models/Transaction');
const Setting = require('./models/Setting');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const SERVER_BASE_URL = process.env.SERVER_BASE_URL;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
const CHANNEL_ID = process.env.CHANNEL_ID; 

if (!BOT_TOKEN || !MONGO_URI || !VIOLET_API_KEY || !VIOLET_SECRET_KEY || !SERVER_BASE_URL || !CHANNEL_ID) {
    console.error("❌ ERROR: Pastikan semua variabel environment terisi (termasuk CHANNEL_ID).");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

const adminStates = {};
const userStates = {}; 

const mainKeyboard = Markup.keyboard([
    ['🛍️ Lihat Produk', '💰 Saldo & Top Up'], 
    ['📜 Riwayat Transaksi'],
    ['🔥 Best Seller', '💡 Cara Order'],
    ['🧑‍💼 Bantuan']
]).resize();


bot.use(async (ctx, next) => {
    try {
        const from = ctx.from;
        if (!from) {
            console.log("Menerima update tanpa info 'from' (misal: channel post)");
            return next(); 
        }

        const userId = from.id;
        const username = from.username ? `@${from.username}` : from.first_name;
        
        const role = isAdmin(ctx) ? "ADMIN" : "USER"; 

        let logMessage = `[LOG | ${role}] ${username} (ID: ${userId})`;

        if (ctx.updateType === 'message' && ctx.message.text) {
            logMessage += ` mengirim: "${ctx.message.text}"`;
        } else if (ctx.updateType === 'callback_query' && ctx.callbackQuery.data) {
            logMessage += ` menekan tombol: "${ctx.callbackQuery.data}"`;
        } else {
            logMessage += ` melakukan aksi: "${ctx.updateType}"`;
        }

        console.log(logMessage);

    } catch (error) {
        console.error("Error di dalam middleware logging:", error);
    }

    await next();
});

function isAdmin(ctx) {
    return ADMIN_IDS.includes(ctx.from.id);
}

const adminGuard = (ctx, next) => {
    if (isAdmin(ctx)) {
        return next();
    }
    ctx.reply('❌ Akses Ditolak. Anda bukan Admin/Owner.');
};

async function getUser(ctx) {
    const userId = ctx.from.id;
    const username = ctx.from.username || ctx.from.first_name;
    let user = await User.findOne({ userId });

    if (!user) {
        user = new User({ userId, username });
        await user.save();
    }
    if (user.username !== username) {
        await User.updateOne({ userId }, { username: username });
        user.username = username;
    }
    return user;
}

function generateRefId(type, userId) {
    return `${type}-${userId}-${Date.now()}`;
}

async function callVioletPay(refId, amount, customerName, productDesc) {
    const API_URL = "https://violetmediapay.com/api/live/create";
    const nominal = String(amount);

    const signatureString = refId + VIOLET_API_KEY + nominal;
    const signature = crypto
        .createHmac("sha256", VIOLET_SECRET_KEY)
        .update(signatureString)
        .digest("hex");

    const params = new URLSearchParams({
        api_key: VIOLET_API_KEY,
        secret_key: VIOLET_SECRET_KEY,
        channel_payment: "QRIS",
        ref_kode: refId,
        nominal: nominal,
        cus_nama: customerName,
        cus_email: `tg_${refId}@usermedia.app`,
        cus_phone: '081234567890',
        produk: productDesc,
        url_redirect: SERVER_BASE_URL + '/success',
        url_callback: SERVER_BASE_URL + '/violet-callback',
        expired_time: Math.floor(Date.now() / 1000) + 300, 
        signature: signature
    });

    try {
        const res = await fetch(API_URL, { method: "POST", body: params });
        const text = await res.text();
        const data = JSON.parse(text);

        if (data.status === true && data.data?.target) {
            return {
                status: true,
                qrisUrl: data.data.target,
                checkoutUrl: data.data.checkout_url
            };
        } else {
            return { status: false, message: data.msg || "API Error VMP" };
        }
    } catch (err) {
        console.error("Error VMP:", err);
        return { status: false, message: "Server Error VMP" };
    }
}


async function startBroadcast(ctx) {
    const userId = ctx.from.id;
    adminStates[userId] = { step: 'BROADCAST_WAITING_MESSAGE' };
    await ctx.reply('Silakan kirim *PESAN TEKS* yang ingin Anda broadcast ke semua user.\n\n(Ketik /cancel untuk membatalkan)');
}

async function sendChannelNotification(message) {
    if (!CHANNEL_ID) return; 

    try {
        await bot.telegram.sendMessage(CHANNEL_ID, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(`❌ Gagal mengirim notifikasi ke channel ${CHANNEL_ID}: ${error.message}`);
        if (ADMIN_IDS.length > 0) {
            try {
                await bot.telegram.sendMessage(ADMIN_IDS[0], 
                    `⚠️ Gagal mengirim notifikasi ke channel. Pastikan bot adalah admin di channel ${CHANNEL_ID} dan ID-nya benar.\n\nError: ${error.message}`
                );
            } catch (adminError) {
                console.error("Gagal mengirim notifikasi error ke admin:", adminError.message);
            }
        }
    }
}

async function processCheckout(ctx, method, param) {
    const user = await getUser(ctx);
    let amount = 0;
    let productDesc = '';
    let transactionType = 'PRODUCT';
    let product = null;
    let productId = null;

    if (param.includes('topup')) { 
        const amountStr = param.split(':')[1];
        amount = parseInt(amountStr);
        productDesc = `Isi Saldo Rp ${amount.toLocaleString('id-ID')}`;
        transactionType = 'TOPUP';
    } else {
        productId = param; 
        product = await Product.findById(productId);
        if (!product || product.stok === 0) {
            if (ctx.callbackQuery) await ctx.deleteMessage().catch(() => {});
            await ctx.reply('❌ Stok habis atau produk tidak valid.', mainKeyboard);
            return; 
        }
        amount = product.harga;
        productDesc = `Beli ${product.namaProduk}`;
    }


    if (method === 'saldo') {
        if (user.saldo < amount) {
            if (ctx.callbackQuery) await ctx.deleteMessage().catch(() => {});
            return ctx.reply(`❌ Saldo Anda (Rp ${user.saldo.toLocaleString('id-ID')}) tidak mencukupi untuk transaksi ini (Rp ${amount.toLocaleString('id-ID')}).`, mainKeyboard);
        }

        try {
            const stickerSetting = await Setting.findOne({ key: 'success_sticker_id' });
            
            user.saldo -= amount;
            user.totalTransaksi += 1;
            await user.save();

            const refId = generateRefId('SALDO', user.userId);
            const newTransaction = new Transaction({
                userId: user.userId, refId, totalBayar: amount, metodeBayar: 'SALDO', status: 'SUCCESS',
                produkInfo: {
                    type: transactionType,
                    kategori: product ? product.kategori : 'SALDO',
                    namaProduk: product ? product.namaProduk : 'TOPUP',
                    jumlah: 1, hargaSatuan: amount
                }
            });
            await newTransaction.save();
            
            if (transactionType === 'PRODUCT') {
                const stokAwal = product.stok; 
                const stokAkhir = stokAwal - 1; 
                const notifMessage = `🎉 **PENJUALAN BARU (SALDO)** 🎉\n\n` +
                                   `👤 **Pembeli:** [${user.username}](tg://user?id=${user.userId})\n` +
                                   `🛍️ **Produk:** \`${product.namaProduk}\`\n` +
                                   `💰 **Total:** \`Rp ${amount.toLocaleString('id-ID')}\`\n\n` +
                                   `--- *Info Tambahan* ---\n` +
                                   `📦 **Sisa Stok:** \`${stokAkhir}\` pcs (dari ${stokAwal})\n` +
                                   `🏦 **Metode:** Saldo Bot\n` +
                                   `🆔 **Ref ID:** \`${refId}\``;
                await sendChannelNotification(notifMessage);
            } else if (transactionType === 'TOPUP') {
                 const notifMessage = `💰 **TOP-UP SUKSES (SALDO)** 💰\n\n` +
                                   `👤 **User:** [${user.username}](tg://user?id=${user.userId})\n` +
                                   `💰 **Total:** \`Rp ${amount.toLocaleString('id-ID')}\`\n` +
                                   `🆔 **Ref ID:** \`${refId}\``;
                await sendChannelNotification(notifMessage);
            }

            if (ctx.callbackQuery) await ctx.deleteMessage().catch(() => {}); 

            if (stickerSetting && stickerSetting.value) {
                await ctx.replyWithSticker(stickerSetting.value);
            }

            if (transactionType === 'PRODUCT') {
                
                const deliveredContent = await deliverProduct(user.userId, productId); 
                
                if (deliveredContent) {
                    
                    const date = new Date();
                    const dateCreated = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}, ${date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/:/g, '.')}`;

                    let successMessage = `📜 *Pembelian Berhasil*\n`;
successMessage += `Terimakasih telah Melakukan pembelian di store kami\n\n`;

successMessage += `*Informasi Pembelian:*\n`;
successMessage += `— *Total Dibayar:* Rp ${amount.toLocaleString('id-ID')}\n`;
successMessage += `— *Date Created:* ${dateCreated}\n`;
successMessage += `— *Metode Pembayaran:* Saldo Bot\n`;
successMessage += `— *Jumlah Item:* 1x\n`;
successMessage += `— *ID transaksi:* ${refId}\n\n`;

successMessage += `*${product.namaProduk}*\n`;

successMessage += "```txt\n";
successMessage += `1. ${deliveredContent}\n`;
successMessage += "```";

                    
                    return ctx.replyWithMarkdown(successMessage, mainKeyboard);

                } else {
                    return ctx.reply(`⚠️ Saldo Anda telah dipotong, namun pengiriman produk gagal (stok habis). Harap hubungi Admin dengan Ref ID: \`${refId}\``, { parse_mode: 'Markdown', reply_markup: mainKeyboard.reply_markup });
                }

            } else {
                 return ctx.reply(`╭─────────────────────────\n│ 🎉 Top Up Saldo Berhasil!\n│ Saldo kini: Rp ${user.saldo.toLocaleString('id-ID')}.\n╰─────────────────────────`, { parse_mode: 'Markdown', reply_markup: mainKeyboard.reply_markup });
            }

        } catch (error) {
            console.error("Error saldo payment:", error);
            return ctx.reply('⚠️ Terjadi kesalahan saat memproses pembayaran saldo.', mainKeyboard);
        }

    } else if (method === 'qris') {
        
        if (ctx.callbackQuery && ctx.update.callback_query.message) {
            await ctx.deleteMessage().catch(e => console.warn(e.message));
        }

        const refId = generateRefId(transactionType === 'TOPUP' ? 'TOPUP' : 'PROD', user.userId);

        const newTransaction = new Transaction({
            userId: user.userId, refId, totalBayar: amount, metodeBayar: 'QRIS', status: 'PENDING',
            produkInfo: {
                type: transactionType,
                kategori: product ? product.kategori : 'SALDO',
                namaProduk: product ? product.namaProduk : 'TOPUP',
                jumlah: 1, hargaSatuan: amount
            }
        });

        try {
            await newTransaction.save(); 
        } catch (saveError) {
             console.error(`❌ [BOT] GAGAL SIMPAN TRANSAKI PENDING ${refId}:`, saveError);
             return ctx.reply(`❌ Gagal menyimpan transaksi PENDING ke database. Mohon coba lagi. (Ref: ${refId})`, mainKeyboard);
        }

        const vmpResult = await callVioletPay(refId, amount, user.username || 'User Telegram', productDesc);

if (vmpResult.status) {

    const captionText =
`╭━━━━━━━━━━━━━━━━━━
│ 💳 *PEMBAYARAN QRIS*
│ 📦 ${productDesc}
│ 🆔 *Ref:* \`${refId}\`
╰━━━━━━━━━━━━━━━━━━

💰 *Total:* Rp ${amount.toLocaleString('id-ID')}
⏳ *Expired:* 5 Menit

*Scan QR di atas atau klik tombol di bawah!*`;

   await ctx.replyWithPhoto(
    { url: vmpResult.qrisUrl },
    {
        caption: captionText,
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
        [{ text: "🔗 Link Pembayaran", url: vmpResult.checkoutUrl }],
        [{ text: "⏳ Cek Status", callback_data: `check_status:${refId}` }], 
        [{ text: "❌ Batalkan Transaksi", callback_data: `cancel_trx:${refId}` }] 
    ]
        }
    }
);


} else {
    await Transaction.deleteOne({ refId });
    return ctx.reply(
        `❌ Gagal membuat QRIS: ${vmpResult.message}`,
        mainKeyboard
    );
}
    }
}

async function displayEditMenu(ctx, productId) {
    if (typeof productId !== 'string' || !mongoose.Types.ObjectId.isValid(productId)) {
        console.error("Kesalahan Internal: displayEditMenu dipanggil dengan productId yang tidak valid:", productId);
        return ctx.reply("⚠️ Terjadi kesalahan internal. ID Produk tidak valid.");
    }
    
    const product = await Product.findById(productId);
    if (!product) {
        return ctx.reply('❌ Produk tidak ditemukan (mungkin sudah dihapus).');
    }
    
    const contentCount = product.kontenProduk.length;
    let message = `╭─────────────────────────\n`;
    message += `│ ⚙️ EDIT PRODUK\n`;
    message += `│ ${product.namaProduk}\n`;
    message += '╰─────────────────────────\n\n';
    message += `│ ID: \`${product._id}\`\n`;
    message += `│ Kategori: ${product.kategori}\n`;
    message += `│ Harga: Rp ${product.harga.toLocaleString('id-ID')}\n`;
    message += `│ Stok: ${contentCount} item\n\n`;
    message += `│ Deskripsi: ${product.deskripsi || 'N/A'}\n`;
    
    adminStates[ctx.from.id] = {
        step: 'EDIT_MODE_WAITING_FIELD',
        productId: productId 
    };

    const markup = Markup.inlineKeyboard([
        [Markup.button.callback('Kategori', `edit_field:kategori`), Markup.button.callback('Nama Produk', `edit_field:namaProduk`)],
        [Markup.button.callback('Harga', `edit_field:harga`), Markup.button.callback('Deskripsi', `edit_field:deskripsi`)],
        
        [Markup.button.callback('⬅️ Kembali ke Panel Admin', 'admin_panel')],
        [Markup.button.callback('❌ BATAL EDIT', 'edit_cancel')]
    ]).reply_markup;

    if (ctx.callbackQuery) {
        await ctx.deleteMessage().catch(() => {});
        await ctx.replyWithMarkdown(message, { reply_markup: markup });
    } else {
        await ctx.replyWithMarkdown(message, { reply_markup: markup });
    }
}

async function deliverProduct(userId, productId) {
    const product = await Product.findById(productId);

    if (product && product.kontenProduk.length > 0) {
        const deliveredContent = product.kontenProduk.shift();

        await Product.updateOne({ _id: productId }, {
            $set: { kontenProduk: product.kontenProduk },
            $inc: { stok: -1, totalTerjual: 1 }
        });

        return deliveredContent; 
    } else {
        bot.telegram.sendMessage(userId, `⚠️ Pembelian Berhasil, namun stok konten habis. Harap hubungi Admin.`).catch(e => console.error("Gagal kirim notif stok habis:", e));
        return null; 
    }
}

async function displayCategoryList(ctx) {
    const categories = await Product.distinct('kategori').sort();

    if (categories.length === 0) {
        return ctx.reply('❌ Belum ada produk yang terdaftar.', mainKeyboard); 
    }
    
    let message = '╭ - - - - - - - - - - - - - - - - - - - ╮\n';
    message += '┊  LIST PRODUK\n';
    message += `┊  (Total: ${categories.length} Kategori)\n`; 
    message += '┊- - - - - - - - - - - - - - - - - - - - - \n';
    
    const keyboardButtons = []; 
    
    categories.forEach((cat, index) => {
        const categoryNumber = index + 1;
        message += `┊ [${categoryNumber}] ${cat}\n`; 
        keyboardButtons.push(String(categoryNumber));
    });

    message += '╰ - - - - - - - - - - - - - - - - - - - ╯\n';
    message += '╰➤ Silakan pilih nomor kategori di bawah atau ketik manual.';
    
    const rows = [];
    while (keyboardButtons.length > 0) {
        rows.push(keyboardButtons.splice(0, 5)); 
    }
    rows.push(['❌ Batal']); 
    
    const categoryKeyboard = Markup.keyboard(rows).resize();

    if (ctx.callbackQuery) {
        await ctx.deleteMessage().catch(() => {});
    }

    await ctx.reply(message, categoryKeyboard);
}

async function saveNewProduct(ctx, data) {
    try {
        const newProduct = new Product({
            kategori: data.kategori,
            namaProduk: data.namaProduk,
            harga: data.harga,
            deskripsi: data.deskripsi, 
            
            stok: data.stok,
            kontenProduk: data.kontenProduk,
        });
        await newProduct.save();

        let replyMessage = `╭─────────────────────────\n`;
        replyMessage += `│ ✨ PRODUK BARU BERHASIL\n`;
        replyMessage += `│ DITAMBAHKAN!\n`;
        replyMessage += '╰─────────────────────────\n\n';
        replyMessage += `│ Kategori: ${data.kategori}\n`;
        replyMessage += `│ Nama: ${data.namaProduk}\n`;
        replyMessage += `│ Harga: Rp ${data.harga.toLocaleString('id-ID')}\n`;
        replyMessage += `│ Deskripsi: ${data.deskripsi}\n`; 
        
        replyMessage += `│ Stok Awal: ${data.stok} pcs\n`;
        replyMessage += `│ (Konten: ${data.kontenProduk.length} item)\n`;

        ctx.replyWithMarkdown(replyMessage);
    } catch (error) {
        if (error.code === 11000) {
             ctx.reply('❌ Gagal: Produk dengan nama ini mungkin sudah ada (Duplikat Key).');
        } else {
             ctx.reply(`❌ Gagal menyimpan produk ke database: ${error.message}`);
        }
    }
}

async function startAddProduk(ctx) {
    const userId = ctx.from.id;
    adminStates[userId] = {
        step: 'WAITING_KATEGORI',
        data: {}
    };
    ctx.reply('📝 **Mode Tambah Produk**\n\nMasukkan **Kategori** produk (Contoh: CANVA PRO):', { parse_mode: 'Markdown' });
}

async function startDeleteProduk(ctx) {
    const products = await Product.find({}).select('kategori namaProduk _id').sort({ kategori: 1, namaProduk: 1 });
    if (products.length === 0) {
        return ctx.reply('❌ Tidak ada produk untuk dihapus.');
    }
    let message = '╭─────────────────────────\n';
    message += '│ 🗑️ PILIH PRODUK HAPUS\n';
    message += '╰─────────────────────────\n\n';
    const deleteButtons = [];
    products.forEach((p, index) => {
        if (index < 50) {
            message += `└─ [${p.kategori}] ${p.namaProduk}\n`;
            deleteButtons.push(
                Markup.button.callback(
                    `${p.kategori} - ${p.namaProduk}`,
                    `confirm_delete:${p._id}`
                )
            );
        }
    });
    ctx.replyWithMarkdown(message, Markup.inlineKeyboard(deleteButtons.map(btn => [btn])));
}

async function startEditProduk(ctx) {
    const products = await Product.find({}).select('kategori namaProduk _id').sort({ kategori: 1, namaProduk: 1 });
    if (products.length === 0) {
        return ctx.reply('❌ Tidak ada produk yang terdaftar untuk diedit.');
    }
    let message = '╭─────────────────────────\n';
    message += '│ ✏️ PILIH PRODUK EDIT\n';
    message += '╰─────────────────────────\n\n';
    const editButtons = [];
    products.forEach((p, index) => {
        if (index < 50) {
            message += `└─ [${p.kategori}] ${p.namaProduk}\n`;
            editButtons.push(
                Markup.button.callback(
                    `${p.kategori} - ${p.namaProduk}`,
                    `edit_select:${p._id}`
                )
            );
        }
    });
    ctx.replyWithMarkdown(message, Markup.inlineKeyboard(editButtons.map(btn => [btn])));
}

async function startAddStok(ctx) {
    const products = await Product.find({}).select('kategori namaProduk _id stok kontenProduk').sort({ kategori: 1, namaProduk: 1 });
    if (products.length === 0) {
        return ctx.reply('❌ Tidak ada produk untuk diisi stok.');
    }
    let message = '╭─────────────────────────\n';
    message += '│ 📦 PILIH PRODUK STOK\n';
    message += '╰─────────────────────────\n\n';
    const stokButtons = [];
    products.forEach((p) => {
        message += `└─ [${p.stok} item] ${p.namaProduk}\n`;
        stokButtons.push(
            Markup.button.callback(
                `[${p.stok} item] ${p.namaProduk}`,
                `stok_select:${p._id}`
            )
        );
    });
    ctx.replyWithMarkdown(message, Markup.inlineKeyboard(stokButtons.map(btn => [btn])));
}

async function startDeleteStok(ctx) {
    const products = await Product.find({}).select('kategori namaProduk _id stok').sort({ kategori: 1, namaProduk: 1 });
    if (products.length === 0) {
        return ctx.reply('❌ Tidak ada produk.');
    }
    let message = '╭─────────────────────────\n';
    message += '│ 🗑️ HAPUS SEMUA STOK\n';
    message += '╰─────────────────────────\n\n';
    const cleanButtons = [];
    products.forEach((p) => {
        message += `└─ [${p.stok} item] ${p.namaProduk}\n`;
        cleanButtons.push(
            Markup.button.callback(
                `[${p.stok} item] ${p.namaProduk}`,
                `stok_clean_confirm:${p._id}`
            )
        );
    });
    ctx.replyWithMarkdown(message, Markup.inlineKeyboard(cleanButtons.map(btn => [btn])));
}

async function displayAdminStats(ctx) {
    const totalUsers = await User.countDocuments();
    const totalProducts = await Product.countDocuments();
    const totalTransactions = await Transaction.countDocuments({ status: 'SUCCESS' });
    const revenueResult = await Transaction.aggregate([
        { $match: { status: 'SUCCESS' } },
        { $group: { _id: null, totalRevenue: { $sum: "$totalBayar" } } }
    ]);
    const totalRevenue = revenueResult[0]?.totalRevenue || 0;
    const pendingTransactions = await Transaction.countDocuments({ status: 'PENDING' });

    let message = `╭─────────────────────────\n`;
    message += `│ 📊 DASHBOARD STATISTIK\n`;
    message += `╰─────────────────────────\n\n`;
    message += `│ 👤 Total User: ${totalUsers}\n`;
    message += `│ 🛍️ Total Produk: ${totalProducts}\n`;
    message += `│ 🛒 Transaksi Sukses: ${totalTransactions}\n`;
    message += `│ 💰 Total Pendapatan: Rp ${totalRevenue.toLocaleString('id-ID')}\n`;
    message += `│ ⏳ Transaksi Pending: ${pendingTransactions}\n`;

    await ctx.replyWithMarkdown(message, {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('⬅️ Kembali ke Panel Admin', 'admin_panel')]
        ]).reply_markup
    });
}

async function displayAdminPanel(ctx) {
    let message = `╭─────────────────────────\n`;
    message += `│ ⚙️ PANEL ADMIN\n`;
    message += `╰─────────────────────────\n\n`;
    message += `Silakan pilih salah satu opsi di bawah ini untuk mengelola bot.\n\n`;
    message += `Perintah manual seperti /setbalance dan /checkuser juga tersedia.`;
    
    await ctx.replyWithMarkdown(message, {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('➕ Tambah Produk', 'admin_add_prod'), Markup.button.callback('✏️ Edit Produk', 'admin_edit_prod')],
            [Markup.button.callback('🗑️ Hapus Produk', 'admin_del_prod'), Markup.button.callback('📊 Lihat Statistik', 'admin_stats')],
            [Markup.button.callback('📦 Tambah Stok', 'admin_add_stok'), Markup.button.callback('🧹 Kosongkan Stok', 'admin_del_stok')],
            [Markup.button.callback('📢 Broadcast Pesan', 'admin_broadcast')], 
            [Markup.button.callback('❌ Tutup Panel', 'admin_close')]
        ]).reply_markup
    });
}

bot.command('setsticker', adminGuard, async (ctx) => {
    try {
        if (!ctx.message.reply_to_message) {
            return ctx.reply('Gunakan perintah ini dengan me-reply sebuah stiker or GIF.');
        }
        
        let fileId = null;
        if (ctx.message.reply_to_message.sticker) {
            fileId = ctx.message.reply_to_message.sticker.file_id;
        } else if (ctx.message.reply_to_message.animation) {
            fileId = ctx.message.reply_to_message.animation.file_id;
        }

        if (fileId) {
            await Setting.updateOne(
                { key: 'success_sticker_id' }, 
                { value: fileId },             
                { upsert: true }               
            );
            
            await ctx.replyWithSticker(fileId);
            await ctx.reply('✅ Stiker/GIF ini telah disimpan sebagai notifikasi transaksi sukses.');
        } else {
            ctx.reply('❌ Ini bukan stiker atau GIF. Balas stiker/GIF.');
        }
    } catch (error) {
        console.error('Error di /setsticker:', error);
        ctx.reply('⚠️ Terjadi kesalahan saat menyimpan stiker.');
    }
});

bot.command('setimage', adminGuard, async (ctx) => {
    try {
        if (!ctx.message.reply_to_message || !ctx.message.reply_to_message.photo) {
            return ctx.reply('Gunakan perintah ini dengan me-reply sebuah FOTO (bukan stiker/GIF).');
        }
        
        const photoArray = ctx.message.reply_to_message.photo;
        const fileId = photoArray[photoArray.length - 1].file_id;

        if (fileId) {
            await Setting.updateOne(
                { key: 'start_image_id' }, 
                { value: fileId },             
                { upsert: true }               
            );
            
            await ctx.replyWithPhoto(fileId, { caption: '✅ Foto ini telah disimpan sebagai gambar /start.' });
        } else {
            ctx.reply('❌ Gagal mendapatkan File ID dari foto ini.');
        }
    } catch (error) {
        console.error('Error di /setimage:', error);
        ctx.reply('⚠️ Terjadi kesalahan saat menyimpan foto.');
    }
});

bot.command('admin', adminGuard, displayAdminPanel);
bot.command('broadcast', adminGuard, startBroadcast);

bot.action(/check_status:(.+)/, async (ctx) => {
    const refId = ctx.match[1];
    
    try {
        const transaction = await Transaction.findOne({ 
            refId: refId, 
            userId: ctx.from.id 
        });

        if (!transaction) {
            return ctx.answerCbQuery('❌ Transaksi tidak ditemukan.', { show_alert: true });
        }

        switch (transaction.status) {
            case 'SUCCESS':
                await ctx.answerCbQuery('✅ Pembayaran Anda sudah lunas.', { show_alert: true });
                await ctx.deleteMessage().catch(() => {});
                await ctx.reply(`✅ Pembayaran untuk \`${refId}\` sudah lunas dan diproses.`, {
                    parse_mode: 'Markdown',
                    reply_markup: mainKeyboard.reply_markup
                });
                break;
            case 'PENDING':
                await ctx.answerCbQuery('⏳ Pembayaran masih PENDING. Silakan selesaikan pembayaran.', { show_alert: true });
                break;
            case 'FAILED':
            case 'EXPIRED':
                await ctx.answerCbQuery('❌ Transaksi ini telah gagal atau kedaluwarsa.', { show_alert: true });
                await ctx.deleteMessage().catch(() => {});
                await ctx.reply(`❌ Transaksi \`${refId}\` telah gagal/kedaluwarsa.`, {
                    parse_mode: 'Markdown',
                    reply_markup: mainKeyboard.reply_markup
                });
                break;
            default:
                await ctx.answerCbQuery('Status transaksi tidak diketahui.', { show_alert: true });
        }

    } catch (error) {
        console.error("Error saat check_status:", error);
        await ctx.answerCbQuery('⚠️ Terjadi kesalahan server saat cek status.', { show_alert: true });
    }
});

bot.action(/cancel_trx:(.+)/, async (ctx) => {
    const refId = ctx.match[1];
    
    try {
        const transaction = await Transaction.findOneAndDelete({ 
            refId: refId, 
            userId: ctx.from.id,
            status: 'PENDING' 
        });

        if (transaction) {
            await ctx.answerCbQuery('Transaksi dibatalkan.');
            await ctx.deleteMessage().catch(() => {}); 
            await ctx.reply(`✅ Transaksi \`${refId}\` telah dibatalkan.`, {
                parse_mode: 'Markdown',
                reply_markup: mainKeyboard.reply_markup 
            });
        } else {
            await ctx.answerCbQuery('❌ Gagal batal (mungkin sudah lunas atau kedaluwarsa).', { show_alert: true });
        }
    } catch (error) {
        console.error("Error saat cancel_trx:", error);
        await ctx.answerCbQuery('⚠️ Terjadi kesalahan server.', { show_alert: true });
    }
});

bot.action('admin_broadcast', adminGuard, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await startBroadcast(ctx); 
});

bot.action('admin_panel', adminGuard, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await displayAdminPanel(ctx);
});

bot.action('admin_add_prod', adminGuard, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await startAddProduk(ctx);
});

bot.action('admin_edit_prod', adminGuard, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await startEditProduk(ctx);
});

bot.action('admin_del_prod', adminGuard, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await startDeleteProduk(ctx);
});

bot.action('admin_add_stok', adminGuard, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await startAddStok(ctx);
});

bot.action('admin_del_stok', adminGuard, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await startDeleteStok(ctx);
});

bot.action('admin_stats', adminGuard, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await displayAdminStats(ctx);
});

bot.action('admin_close', adminGuard, async (ctx) => {
    await ctx.answerCbQuery('Panel ditutup.');
    await ctx.deleteMessage().catch(() => {});
});

bot.command('addproduk', adminGuard, startAddProduk);
bot.command('deleteproduk', adminGuard, startDeleteProduk);
bot.command('editproduk', adminGuard, startEditProduk);
bot.command('addstok', adminGuard, startAddStok);
bot.command('deletestok', adminGuard, startDeleteStok);

bot.action(/confirm_delete:(.+)/, adminGuard, async (ctx) => {
    const productId = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {}); 
    const product = await Product.findById(productId);
    if (!product) {
        return ctx.reply('❌ Produk sudah tidak ada.');
    }
    const confirmationText =
        `╭─────────────────────────\n` +
        `│ ⚠️ KONFIRMASI HAPUS\n` +
        `╰─────────────────────────\n\n` +
        `│ [${product.kategori}] ${product.namaProduk}?\n\n` +
        `_Tindakan ini permanen._`;
    ctx.replyWithMarkdown(confirmationText, {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('✅ YA, HAPUS PERMANEN', `execute_delete:${productId}`)],
            [Markup.button.callback('❌ BATAL', 'cancel_delete')]
        ]).reply_markup
    });
});

bot.action(/execute_delete:(.+)/, adminGuard, async (ctx) => {
    const productId = ctx.match[1];
    await ctx.answerCbQuery('Menghapus produk...');
    await ctx.deleteMessage().catch(() => {}); 
    try {
        const result = await Product.deleteOne({ _id: productId });
        if (result.deletedCount > 0) {
            ctx.reply(`╭─────────────────────────\n│ ✅ Produk berhasil dihapus.\n╰─────────────────────────`);
        } else {
            ctx.reply('❌ Gagal menghapus. Produk tidak ditemukan.');
        }
    } catch (error) {
        console.error("Error saat menghapus produk:", error);
        ctx.reply('⚠️ Terjadi kesalahan saat menghapus produk.');
    }
});

bot.action('cancel_delete', adminGuard, (ctx) => {
    ctx.answerCbQuery('Penghapusan dibatalkan.');
    ctx.deleteMessage().catch(() => {});
    ctx.reply('Penghapusan produk dibatalkan.');
});

bot.action(/edit_select:(.+)/, adminGuard, async (ctx) => {
    const productId = ctx.match[1]; 
    if (ctx.callbackQuery && ctx.callbackQuery.id) {
        await ctx.answerCbQuery();
    }
    await displayEditMenu(ctx, productId); 
});

bot.action(/edit_field:(.+)/, adminGuard, async (ctx) => {
    const field = ctx.match[1];
    const userId = ctx.from.id;
    const state = adminStates[userId];
    if (!state || state.step !== 'EDIT_MODE_WAITING_FIELD') {
        return ctx.answerCbQuery('❌ Sesi edit kedaluwarsa. Mulai lagi dengan /editproduk.', { show_alert: true });
    }
    state.step = `EDIT_WAITING_VALUE:${field}`;
    let prompt = `╭─────────────────────────\n`;
    prompt += `│ Masukkan nilai baru\n`;
    prompt += `│ untuk **${field.toUpperCase()}**:\n`;
    prompt += '╰─────────────────────────\n\n';
    
    prompt += `(Ketik /cancel untuk membatalkan)`;
    ctx.answerCbQuery();
    ctx.deleteMessage().catch(() => {});
    ctx.replyWithMarkdown(prompt);
});

bot.action('edit_cancel', adminGuard, (ctx) => {
    delete adminStates[ctx.from.id];
    ctx.answerCbQuery('Pembatalan edit.');
    ctx.deleteMessage().catch(() => {});
    ctx.reply('Pembatalan edit produk.');
});

bot.action(/stok_select:(.+)/, adminGuard, async (ctx) => {
    const productId = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {}); 
    const product = await Product.findById(productId);
    if (!product) {
        return ctx.reply('❌ Produk tidak ditemukan.');
    }
    adminStates[ctx.from.id] = {
        step: 'STOK_WAITING_CONTENT',
        productId: productId
    };
    let message = `╭─────────────────────────\n`;
    message += `│ 📦 ISI STOK UNTUK\n`;
    message += `│ ${product.namaProduk}\n`;
    message += '╰─────────────────────────\n\n';
    message += `│ Stok Saat Ini: **${product.kontenProduk.length} item**\n\n`;
    message += `│ Masukkan **Konten Baru**\n`;
    message += `│ (Pisahkan dengan baris baru):\n`;
    message += `(Ketik /cancel untuk membatalkan)`;
    ctx.replyWithMarkdown(message);
});

bot.action(/stok_clean_confirm:(.+)/, adminGuard, async (ctx) => {
    const productId = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {}); 
    const product = await Product.findById(productId);
    if (!product) {
        return ctx.reply('❌ Produk tidak ditemukan.');
    }
    const confirmationText =
        `╭─────────────────────────\n` +
        `│ ⚠️ KONFIRMASI HAPUS STOK\n` +
        '╰─────────────────────────\n\n' +
        `│ Hapus **${product.kontenProduk.length} item**\n` +
        `│ dari: **[${product.kategori}] ${product.namaProduk}**\n\n` +
        `│ _TIDAK DAPAT DIBATALKAN._`;
    ctx.replyWithMarkdown(confirmationText, {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('✅ YA, HAPUS SEMUA STOK', `stok_clean_execute:${productId}`)],
            [Markup.button.callback('❌ BATAL', 'edit_cancel')]
        ]).reply_markup
    });
});

bot.action(/stok_clean_execute:(.+)/, adminGuard, async (ctx) => {
    const productId = ctx.match[1];
    await ctx.answerCbQuery('Menghapus semua stok...');
    await ctx.deleteMessage().catch(() => {}); 
    try {
        await Product.updateOne(
            { _id: productId },
            { $set: { kontenProduk: [], stok: 0 } }
        );
        ctx.reply(`╭─────────────────────────\n│ ✅ Semua stok dihapus.\n╰─────────────────────────`);
    } catch (error) {
        console.error("Error saat menghapus stok:", error);
        ctx.reply('⚠️ Terjadi kesalahan saat menghapus stok.');
    }
});

bot.on('text', async (ctx, next) => { 
    
    if (isAdmin(ctx) && ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
        const repliedText = ctx.message.reply_to_message.text;
        const match = repliedText.match(/│ Dari: .* \(ID: (\d+)\)/); 
        
        if (match && match[1]) {
            try {
                const targetUserId = parseInt(match[1]); 
                const adminReply = ctx.message.text; 

                await bot.telegram.sendMessage(targetUserId, 
                    `🧑‍💼 **Balasan dari Admin:**\n\n${adminReply}`, 
                    { parse_mode: 'Markdown' }
                );
                await ctx.reply('✅ Balasan Anda telah terkirim ke user.');
            } catch (e) {
                console.error("Gagal mengirim balasan admin:", e.message);
                await ctx.reply(`❌ Gagal mengirim balasan. User mungkin memblokir bot.\nError: ${e.message}`);
            }
            return; 
        }
    }

    if (isAdmin(ctx)) {
        const userId = ctx.from.id;
        const state = adminStates[userId];

        if (state) { 
            const text = ctx.message.text.trim();

            if (text.toLowerCase() === '/cancel') {
                if (state.step === 'STOK_WAITING_CONTENT' || 
                    state.step.startsWith('EDIT_WAITING_VALUE:') ||
                    state.step === 'BROADCAST_WAITING_MESSAGE' ||
                    state.step === 'BROADCAST_WAITING_CONFIRMATION') 
                {
                    ctx.reply('✅ Perubahan/Broadcast dibatalkan.');
                    delete adminStates[userId];
                    return;
                }
            }

            try {
                switch (state.step) {
                    case 'WAITING_KATEGORI':
                        state.data.kategori = text.toUpperCase();
                        state.step = 'WAITING_NAMA';
                        ctx.reply(`✅ Kategori: ${text}\n\nMasukkan **Nama Produk** (Contoh: 1 BULAN AKUN):`);
                        break;
                    case 'WAITING_NAMA':
                        state.data.namaProduk = text;
                        state.step = 'WAITING_HARGA';
                        ctx.reply(`✅ Nama Produk: ${text}\n\nMasukkan **Harga** (Hanya angka, Contoh: 1000):`);
                        break;
                    case 'WAITING_HARGA':
                        const harga = parseInt(text);
                        if (isNaN(harga) || harga <= 0) {
                            return ctx.reply('❌ Harga tidak valid. Masukkan hanya angka positif.');
                        }
                        state.data.harga = harga;
                        state.step = 'WAITING_DESKRIPSI'; 
                        ctx.reply(`✅ Harga: Rp ${harga.toLocaleString('id-ID')}\n\nMasukkan **Deskripsi Singkat** produk:`);
                        break;
                    case 'WAITING_DESKRIPSI':
                        state.data.deskripsi = text;
                        state.step = 'WAITING_STOK'; 
                        ctx.reply(`✅ Deskripsi: ${text}\n\nMasukkan **Stok Awal** (Hanya angka):`);
                        break;
                    case 'WAITING_STOK':
                        const stok = parseInt(text);
                        if (isNaN(stok) || stok < 0) {
                            return ctx.reply('❌ Stok tidak valid. Masukkan hanya angka positif.');
                        }
                        state.data.stok = stok;
                        state.step = 'WAITING_KONTEN';
                        ctx.reply(`✅ Stok: ${stok} pcs\n\nMasukkan **Konten Produk** (Dipisahkan dengan baris baru untuk setiap item):\n\nContoh:\n*key123*\n*akun@mail.com:pass*`);
                        break;
                    case 'WAITING_KONTEN':
                        const kontenArray = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
                        if (kontenArray.length === 0 && state.data.stok > 0) {
                            return ctx.reply('❌ Konten tidak boleh kosong jika stok > 0.');
                        }
                        state.data.kontenProduk = kontenArray;
                        await saveNewProduct(ctx, state.data);
                        delete adminStates[userId];
                        break;
                    case 'STOK_WAITING_CONTENT':
                        const newContentArray = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
                        const currentProduct = await Product.findById(state.productId);
                        if (newContentArray.length === 0) {
                            return ctx.reply('❌ Konten tidak boleh kosong.');
                        }
                        await Product.updateOne(
                            { _id: currentProduct._id },
                            {
                                $push: { kontenProduk: { $each: newContentArray } },
                                $inc: { stok: newContentArray.length }
                            }
                        );
                        ctx.reply(`✅ Berhasil menambahkan **${newContentArray.length}** item stok baru untuk ${currentProduct.namaProduk}.`);
                        delete adminStates[userId];
                        break;
                        
                    case 'BROADCAST_WAITING_MESSAGE': {
                        const messageToBroadcast = text; 
                        adminStates[userId] = {
                            step: 'BROADCAST_WAITING_CONFIRMATION',
                            message: messageToBroadcast
                        };
                        const totalUsers = await User.countDocuments();
                        await ctx.replyWithMarkdown(
                            `⚠️ **KONFIRMASI BROADCAST** ⚠️\n\n` +
                            `Anda akan mengirim pesan berikut:\n` +
                            `---------------------------------------\n` +
                            `${messageToBroadcast}\n` +
                            `---------------------------------------\n` +
                            `Ke **${totalUsers}** user.\n\n` +
                            `Ketik **YA** untuk melanjutkan, atau /cancel untuk batal.`
                        );
                        break;
                    }
        
                    case 'BROADCAST_WAITING_CONFIRMATION': {
                        if (text.toLowerCase() !== 'ya') {
                            ctx.reply('Broadcast dibatalkan. Balasan Anda bukan "YA".');
                            delete adminStates[userId];
                            return;
                        }
        
                        const messageToBroadcast = state.message; 
                        delete adminStates[userId]; 
        
                        await ctx.reply('✅ Konfirmasi diterima. Memulai pengiriman broadcast... Ini mungkin perlu waktu.');
        
                        const allUsers = await User.find({}).select('userId');
                        let successCount = 0;
                        let failCount = 0;
        
                        for (const user of allUsers) {
                            try {
                                await bot.telegram.sendMessage(user.userId, messageToBroadcast);
                                successCount++;
                            } catch (error) {
                                console.warn(`Gagal kirim broadcast ke ${user.userId}: ${error.message}`);
                                failCount++;
                            }
                            await new Promise(resolve => setTimeout(resolve, 100)); 
                        }
        
                        await ctx.replyWithMarkdown(`🎉 **Broadcast Selesai!**\n\n` +
                            `Berhasil terkirim: **${successCount}** user\n` +
                            `Gagal terkirim: **${failCount}** user (Mungkin memblokir bot)`);
                        
                        break;
                    }
        
                    default:
                        if (state.step.startsWith('EDIT_WAITING_VALUE:')) {
                            const field = state.step.split(':')[1];
                            const productId = state.productId; 
                            let updateValue = text;
                            let updateObject = {};
        
                            if (field === 'harga' || field === 'expiredDays') {
                                updateValue = parseInt(text);
                                if (isNaN(updateValue) || updateValue < 0) {
                                    return ctx.reply(`❌ Input tidak valid. Masukkan angka positif.`);
                                }
                            } else if (field === 'kategori') {
                                updateValue = text.toUpperCase();
                            }
                            
                            updateObject[field] = updateValue;
        
                            try {
                                await Product.updateOne({ _id: productId }, updateObject);
                                await ctx.reply(`✅ **${field.toUpperCase()}** berhasil diupdate menjadi: **${updateValue}**`);
                                delete adminStates[userId];
                                await displayEditMenu(ctx, productId); 
        
                            } catch (error) {
                                console.error("Error saat update field produk:", error);
                                ctx.reply(`❌ Gagal mengupdate ${field}. Coba lagi.`);
                                delete adminStates[userId]; 
                            }
        
                        } else {
                            return next();
                        }
                } 
            } catch (error) {
                console.error("Error dalam proses admin text handler:", error);
                ctx.reply('⚠️ Terjadi kesalahan. Proses dibatalkan.');
                delete adminStates[userId];
            }
            return; 
        }
    }

    const userId = ctx.from.id;
    const state = userStates[userId];

    if (!state) return next(); 
    
    
    const text = ctx.message.text.trim();

    if (text.toLowerCase() === '/cancel' || text === '❌ Batal') {
        ctx.reply('✅ Aksi dibatalkan. Kembali ke menu utama.', mainKeyboard);
        delete userStates[userId];
        return;
    }

    try {
        switch (state.step) {
            
            case 'WAITING_TOPUP_AMOUNT': {
                const amount = parseInt(text);
                if (isNaN(amount) || amount < 1000) {
                    return ctx.reply('❌ Nominal tidak valid. Masukkan hanya angka positif minimal Rp 1.000. (Tekan ❌ Batal untuk kembali)');
                }
                delete userStates[userId]; 
                await ctx.reply('Memproses nominal kustom...', mainKeyboard); 
                await processCheckout(ctx, 'qris', `topup:${amount}`);
                break;
            }

            case 'WAITING_SUPPORT_MESSAGE': {
                const fromUser = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
                const fromId = ctx.from.id;
                
                const messageToAdmin = `╭─────────────────────────\n` +
                                     `│ 📩 PESAN BANTUAN BARU\n` +
                                     `╰─────────────────────────\n` +
                                     `│ Dari: ${fromUser} (ID: ${fromId})\n` +
                                     `│\n` +
                                     `│ Pesan:\n` +
                                     `│ ${text}\n` +
                                     `╰─────────────────────────\n` +
                                     `Balas pesan ini untuk membalas ke user.`;
                
                let sentToAdmin = false;
                for (const adminId of ADMIN_IDS) {
                    try {
                        await bot.telegram.sendMessage(adminId, messageToAdmin);
                        sentToAdmin = true; 
                    } catch (e) {
                        console.error(`Gagal kirim pesan bantuan ke Admin ${adminId}:`, e.message);
                    }
                }

                if (sentToAdmin) {
                    await ctx.reply('✅ Pesan Anda telah berhasil diteruskan ke Admin. Harap tunggu balasan.', mainKeyboard);
                } else {
                    await ctx.reply('❌ Maaf, gagal mengirim pesan ke Admin. Silakan coba lagi nanti.', mainKeyboard);
                }
                
                delete userStates[userId]; 
                break;
            }

            case 'WAITING_CATEGORY_CHOICE': {
                const choice = parseInt(text);
                
                if (isNaN(choice) || choice <= 0) {
                    await ctx.reply('❌ Input tidak valid. Silakan ketik *angka* yang sesuai dengan daftar, atau tekan tombolnya.\n(Tekan ❌ Batal untuk kembali).', { parse_mode: 'Markdown' });
                    return; 
                }

                const categories = await Product.distinct('kategori').sort();
                const selectedCategory = categories[choice - 1]; 

                if (selectedCategory) {
                    
                    
                    
                    await displayProductVariations(ctx, selectedCategory);
                } else {
                    
                    await ctx.reply(`❌ Kategori nomor **${choice}** tidak ditemukan. Silakan pilih angka yang ada di daftar.`, { parse_mode: 'Markdown' });
                    
                }
                break;
            }
            
            default:
                
                ctx.reply('Perintah tidak dikenali. Silakan gunakan tombol atau ketik ❌ Batal untuk kembali.', mainKeyboard);
                delete userStates[userId];
                return;
        }
    } catch (error) {
        console.error("Error di User Text Handler:", error);
        ctx.reply('⚠️ Terjadi kesalahan. Proses dibatalkan.', mainKeyboard);
        delete userStates[userId];
    }
});

bot.command('checkuser', adminGuard, async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length !== 2) {
        return ctx.reply('Format salah.\nGunakan: /checkuser [USER_ID]\nContoh: /checkuser 123456789');
    }

    const targetUserId = parseInt(args[1]);
    if (isNaN(targetUserId)) {
        return ctx.reply('User ID harus berupa angka.');
    }

    try {
        const user = await User.findOne({ userId: targetUserId });
        if (!user) {
            return ctx.reply('❌ User tidak ditemukan di database.');
        }

        let message = `╭─────────────────────────\n`;
        message += `│ 🧑‍💼 INFO USER: ${user.username}\n`;
        message += `╰─────────────────────────\n\n`;
        message += `│ ID: \`${user.userId}\`\n`;
        message += `│ Saldo: Rp ${user.saldo.toLocaleString('id-ID')}\n`;
        message += `│ Total Transaksi: ${user.totalTransaksi || 0} kali\n`;

        ctx.replyWithMarkdown(message);

    } catch (error) {
        ctx.reply(`Terjadi error: ${error.message}`);
    }
});

bot.command('setbalance', adminGuard, async (ctx) => {
    const args = ctx.message.text.split(' ');
    if (args.length !== 3) {
        return ctx.reply('Format salah.\nGunakan: /setbalance [USER_ID] [JUMLAH]\nContoh (Nambah): /setbalance 12345 50000\nContoh (Kurang): /setbalance 12345 -10000');
    }

    const targetUserId = parseInt(args[1]);
    const amount = parseInt(args[2]);

    if (isNaN(targetUserId) || isNaN(amount)) {
        return ctx.reply('User ID dan Jumlah harus berupa angka.');
    }

    try {
        const updatedUser = await User.findOneAndUpdate(
            { userId: targetUserId },
            { $inc: { saldo: amount } },
            { new: true, upsert: true } 
        );

        if (!updatedUser) {
            return ctx.reply('Gagal menemukan atau mengupdate user.');
        }
        
        ctx.reply(`✅ Saldo user ${targetUserId} (@${updatedUser.username}) berhasil diubah.\nSaldo baru: Rp ${updatedUser.saldo.toLocaleString('id-ID')}`);
        
        try {
            await bot.telegram.sendMessage(targetUserId, 
                `Admin telah mengubah saldo Anda sebesar Rp ${amount.toLocaleString('id-ID')}.\nSaldo baru Anda: Rp ${updatedUser.saldo.toLocaleString('id-ID')}`
            );
        } catch (e) {
            console.warn(`Gagal kirim notif setbalance ke user ${targetUserId}. Mungkin user blokir bot.`);
            ctx.reply('(Gagal mengirim notifikasi ke user. Mungkin user memblokir bot).');
        }
        
    } catch (error) {
        ctx.reply(`Terjadi error: ${error.message}`);
    }
});

bot.start(async (ctx) => {
    delete userStates[ctx.from.id]; 
    const user = await getUser(ctx);
    const stats = {
        totalSold: (await Product.aggregate([{$group: {_id: null, total: {$sum: "$totalTerjual"}}}]))[0]?.total || 0,
        totalUsers: await User.countDocuments({})
    };
    
    let message = `╭─────────────────────────\n`;
    message += `│ 👋 SELAMAT DATANG,\n`;
    message += `│ ${user.username.toUpperCase()}!\n`;
    message += '╰─────────────────────────\n\n';
    message += `│ 📊 User Info:\n`;
    message += `│ ├ ID: \`${ctx.from.id}\`\n`;
    message += `│ └ Saldo: Rp ${user.saldo.toLocaleString('id-ID')}\n\n`;
    message += `│ 📈 BOT Stats:\n`;
    message += `│ ├ Terjual: ${stats.totalSold} pcs\n`;
    message += `│ └ User: ${stats.totalUsers}\n\n`;
    message += `_Gunakan tombol di bawah untuk berbelanja._`;

    try {
        const imageSetting = await Setting.findOne({ key: 'start_image_id' });

        if (imageSetting && imageSetting.value) {
            await ctx.replyWithPhoto(imageSetting.value, {
                caption: message,
                parse_mode: 'Markdown',
                reply_markup: mainKeyboard.reply_markup
            });
        } else {
            await ctx.replyWithMarkdown(message, mainKeyboard);
        }
    } catch (error) {
        console.error("Error saat mengirim /start:", error);
        await ctx.replyWithMarkdown(message, mainKeyboard);
    }
});

bot.command('menu', (ctx) => {
    delete userStates[ctx.from.id]; 
    ctx.reply('Kembali ke menu utama.', mainKeyboard);
});

bot.hears('🛍️ Lihat Produk', async (ctx) => {
    userStates[ctx.from.id] = { step: 'WAITING_CATEGORY_CHOICE' }; 
    await displayCategoryList(ctx); 
});

bot.hears('🔥 Best Seller', async (ctx) => {
    delete userStates[ctx.from.id]; 
    const bestSellers = await Product.find({})
        .sort({ totalTerjual: -1 })
        .limit(3);
    if (bestSellers.length === 0) {
        return ctx.reply('Belum ada produk terlaris.', mainKeyboard);
    }
    
    let message = '╭ - - - - - - - - - - - - - - - - - - - ╮\n';
    message += '┊ 🔥 **PRODUK BEST SELLER**\n';
    message += '┊- - - - - - - - - - - - - - - - - - - - - \n';
    bestSellers.forEach((p, index) => {
        message += `┊ **#${index + 1} | ${p.namaProduk}**\n`;
        message += `┊・ Terjual: ${p.totalTerjual || 0} pcs\n`;
        message += `┊・ Harga: Rp ${p.harga.toLocaleString('id-ID')}\n` + (index < bestSellers.length - 1 ? '┊\n' : '');
    });
    message += '╰ - - - - - - - - - - - - - - - - - - - ╯';
    ctx.replyWithMarkdown(message, mainKeyboard);
});

bot.hears('💡 Cara Order', (ctx) => {
    delete userStates[ctx.from.id]; 
    const message = 
        `╭─────────────────────────\n` +
        `│ 💡 CARA ORDER\n` +
        `╰─────────────────────────\n\n` +
        `1. Klik '🛍️ Lihat Produk' untuk memilih kategori.\n` +
        `2. Pilih nomor kategori dari keyboard atau ketik manual.\n` + 
        `3. Pilih produk yang Anda inginkan dari tombol.\n` + 
        `4. Pilih metode pembayaran (Saldo Bot atau QRIS).\n` +
        `5. Jika menggunakan Saldo, produk akan langsung dikirim.\n` +
        `6. Jika menggunakan QRIS, scan kode QR dan lakukan pembayaran.\n` +
        `7. Produk/Saldo akan otomatis masuk setelah pembayaran lunas.\n\n` +
        `Untuk mengisi saldo, klik tombol '💰 Saldo & Top Up'.`;
    ctx.replyWithMarkdown(message, mainKeyboard);
});

bot.hears('🧑‍💼 Bantuan', async (ctx) => {
    const userId = ctx.from.id;
    userStates[userId] = { step: 'WAITING_SUPPORT_MESSAGE' };
    await ctx.replyWithMarkdown(
        `╭─────────────────────────\n` +
        `│ 🧑‍💼 LAYANAN BANTUAN\n` +
        `╰─────────────────────────\n\n` +
        `Silakan **ketik pesan** Anda di bawah ini.\n` +
        `Pesan Anda akan langsung diteruskan ke Admin.\n\n` +
        `(Tekan ❌ Batal untuk kembali)`,
        Markup.keyboard([['❌ Batal']]).resize()
    );
});

bot.action('List Kategori', async (ctx) => {
    await ctx.answerCbQuery('Memuat kategori...');
    userStates[ctx.from.id] = { step: 'WAITING_CATEGORY_CHOICE' }; 
    await ctx.deleteMessage().catch(() => {});
    await displayCategoryList(ctx); 
});

async function displayProductVariations(ctx, category) {
    const products = await Product.find({ kategori: category }).sort({ harga: 1 });
    
    if (products.length === 0) {
        await ctx.reply('❌ Tidak ada produk di kategori ini.', mainKeyboard);
        return;
    }

    const categoryStats = await Product.aggregate([
        { $match: { kategori: category } },
        { $group: { _id: "$kategori", totalTerjual: { $sum: "$totalTerjual" } } }
    ]);
    const totalTerjual = categoryStats[0]?.totalTerjual || 0;
    
    const deskripsi = products[0]?.deskripsi || 'Tidak ada deskripsi.';
    
    
    let message = '╭ - - - - - - - - - - - - - - - - - - - - - ╮\n';
    message += `┊・ Produk: ${category}\n`;
    message += `┊・ Stok Terjual: ${totalTerjual}\n`;
    message += `┊・ Desk: ${deskripsi}\n`;
    message += '╰ - - - - - - - - - - - - - - - - - - - - - ╯\n';
    message += '╭ - - - - - - - - - - - - - - - - - - - ╮\n';
    message += '┊ Variasi, Harga & Stok:\n';
    
    const productButtons = []; 
    
    products.forEach((p, index) => {
        const hargaFormatted = `Rp ${p.harga.toLocaleString('id-ID')}`;
        const stokFormatted = `Stok: ${p.stok > 0 ? p.stok : 'Habis'}`;
        
        message += `┊・ ${p.namaProduk}: ${hargaFormatted} - ${stokFormatted}\n`;

        productButtons.push(
            Markup.button.callback(
                `🛒 ${p.namaProduk} (${hargaFormatted})`, 
                `show_checkout_options:${p._id}`
            )
        );
    });

    message += '╰ - - - - - - - - - - - - - - - - - - - ╯\n';
    
    const now = new Date();
    const timeString = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
    message += `╰➤ Refresh at ${timeString} WIB`;

    const backButton = Markup.button.callback('⬅️ Kembali ke List Kategori', 'List Kategori');

    const productRows = productButtons.map(btn => [btn]); 
    const fullKeyboard = [ ...productRows, [backButton] ];

    await ctx.reply(message, {
        reply_markup: Markup.inlineKeyboard(fullKeyboard).reply_markup
    });
}

bot.action(/show_checkout_options:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {}); 
    const productId = ctx.match[1];
    const product = await Product.findById(productId);
    const user = await getUser(ctx);
    if (!product || product.stok === 0) {
        return ctx.reply('❌ Stok habis atau produk tidak ditemukan.');
    }
    
    let message = `╭─────────────────────────\n`;
    message += `│ 🛒 **KONFIRMASI PESANAN**\n`;
    message += '╰─────────────────────────\n\n';
    message += `│ **Produk:** ${product.namaProduk}\n`;
    message += `│ **Kategori:** ${product.kategori}\n`;
    message += `│ **Deskripsi:** ${product.deskripsi || 'N/A'}\n`; 
    message += `│ **Stok Tersisa:** ${product.stok} pcs\n\n`;
    message += `│ **Total Bayar:** \`Rp ${product.harga.toLocaleString('id-ID')}\`\n\n`;
    message += `_Silakan pilih metode pembayaran._`;
    
    ctx.replyWithMarkdown(message, {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('💳 QRIS Payment (VioletPay)', `checkout_pay:qris:${productId}`)],
            [Markup.button.callback(`💵 SALDO Bot (Rp ${user.saldo.toLocaleString('id-ID')})`, `checkout_pay:saldo:${productId}`)],
            [Markup.button.callback('⬅️ Kembali ke Produk', `select_cat:${product.kategori}`)]
        ]).reply_markup
    });
});

bot.action(/select_cat:(.+)/, async (ctx) => {
    
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    const category = ctx.match[1];
    await displayProductVariations(ctx, category); 
});

bot.hears('💰 Saldo & Top Up', async (ctx) => { 
    delete userStates[ctx.from.id]; 
    const user = await getUser(ctx);
    const saldoFormatted = user.saldo.toLocaleString('id-ID');
    let message = `╭─────────────────────────\n`;
    message += `│ 💰 SALDO ANDA\n`;
    message += `│ Rp ${saldoFormatted}\n`;
    message += '╰─────────────────────────\n\n';
    message += `│ Pilih nominal Top Up\n`;
    message += `│ (Min. Rp 1.000) atau ketik jumlah\n`;
    message += `│ yang diinginkan:`;
    ctx.replyWithMarkdown(
        message,
        Markup.inlineKeyboard([
            [Markup.button.callback('💰 Rp 1.000', 'checkout_pay:qris:topup:1000'), Markup.button.callback('💰 Rp 10.000', 'checkout_pay:qris:topup:10000')],
            [Markup.button.callback('💰 Rp 50.000', 'checkout_pay:qris:topup:50000'), Markup.button.callback('💰 Rp 100.000', 'checkout_pay:qris:topup:100000')],
            [Markup.button.callback('✍️ Input Nominal Lain', 'topup_custom_input')],
            [Markup.button.callback('📜 Riwayat Saldo', 'saldo_history_inline')], 
        ])
    );
});

bot.hears('📜 Riwayat Transaksi', async (ctx) => {
    delete userStates[ctx.from.id]; 
    const transactions = await Transaction.find({ userId: ctx.from.id })
        .sort({ waktuDibuat: -1 })
        .limit(5);
    if (transactions.length === 0) {
        return ctx.reply('Anda belum memiliki riwayat transaksi.', mainKeyboard);
    }
    let message = '╭─────────────────────────\n';
    message += '│ 📜 RIWAYAT TRANSAKSI\n';
    message += '│ TERAKHIR 5\n';
    message += '╰─────────────────────────\n\n';
    transactions.forEach(t => {
        const item = t.produkInfo.namaProduk || 'Top Up Saldo';
        const total = t.totalBayar.toLocaleString('id-ID');
        const date = t.waktuDibuat.toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric' });
        const statusEmoji = t.status === 'SUCCESS' ? '✅' : t.status === 'PENDING' ? '⏳' : '❌';
        message +=
            `${statusEmoji} [${t.status}] ${item}\n` +
            `└ Total: Rp ${total} | ${t.metodeBayar} | ${date}\n\n`;
    });
    ctx.replyWithMarkdown(message, mainKeyboard);
});

bot.action('saldo_history_inline', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {}); 
    const transactions = await Transaction.find({ userId: ctx.from.id })
        .sort({ waktuDibuat: -1 })
        .limit(5);
    if (transactions.length === 0) {
        return ctx.reply('Anda belum memiliki riwayat transaksi.', mainKeyboard);
    }
    let message = '╭─────────────────────────\n';
    message += '│ 📜 RIWAYAT TRANSAKSI\n';
    message += '│ TERAKHIR 5\n';
    message += '╰─────────────────────────\n\n';
    transactions.forEach(t => {
        const item = t.produkInfo.namaProduk || 'Top Up Saldo';
        const total = t.totalBayar.toLocaleString('id-ID');
        const date = t.waktuDibuat.toLocaleDateString('id-ID', { year: 'numeric', month: 'short', day: 'numeric' });
        const statusEmoji = t.status === 'SUCCESS' ? '✅' : t.status === 'PENDING' ? '⏳' : '❌';
        message +=
            `${statusEmoji} [${t.status}] ${item}\n` +
            `└ Total: Rp ${total} | ${t.metodeBayar} | ${date}\n\n`;
    });
    ctx.replyWithMarkdown(message, mainKeyboard);
});

bot.action('topup_custom_input', async (ctx) => {
    const userId = ctx.from.id;
    userStates[userId] = { step: 'WAITING_TOPUP_AMOUNT' }; 
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {}); 
    ctx.replyWithMarkdown('╭─────────────────────────\n│ Silakan **ketik nominal Top Up**\n│ (minimal Rp 1.000, hanya angka).\n╰─────────────────────────\n\nContoh: `15000`\n(Tekan ❌ Batal untuk kembali)', 
        Markup.keyboard([['❌ Batal']]).resize()
    );
});

bot.action('force_back_to_main_menu', async (ctx) => {
    await ctx.answerCbQuery('Aksi dibatalkan.');
    delete userStates[ctx.from.id]; 
    await ctx.deleteMessage().catch(() => {}); 
    await ctx.reply('Kembali ke menu utama.', mainKeyboard);
});

bot.on('text', async (ctx, next) => {
    
    if (isAdmin(ctx)) {
        
        if (ctx.message.reply_to_message && ctx.message.reply_to_message.text) {
            const repliedText = ctx.message.reply_to_message.text;
            const match = repliedText.match(/│ Dari: .* \(ID: (\d+)\)/); 
            if (match && match[1]) {
                try {
                    const targetUserId = parseInt(match[1]); 
                    const adminReply = ctx.message.text; 
                    await bot.telegram.sendMessage(targetUserId, 
                        `🧑‍💼 **Balasan dari Admin:**\n\n${adminReply}`, 
                        { parse_mode: 'Markdown' }
                    );
                    await ctx.reply('✅ Balasan Anda telah terkirim ke user.');
                } catch (e) {
                    console.error("Gagal mengirim balasan admin:", e.message);
                    await ctx.reply(`❌ Gagal mengirim balasan. User mungkin memblokir bot.\nError: ${e.message}`);
                }
                return; 
            }
        }
        
        
        const adminState = adminStates[ctx.from.id];
        if (adminState) {
            
            
            const userId = ctx.from.id;
            const state = adminState;
            const text = ctx.message.text.trim();

            if (text.toLowerCase() === '/cancel') {
                if (state.step === 'STOK_WAITING_CONTENT' || 
                    state.step.startsWith('EDIT_WAITING_VALUE:') ||
                    state.step === 'BROADCAST_WAITING_MESSAGE' ||
                    state.step === 'BROADCAST_WAITING_CONFIRMATION') 
                {
                    ctx.reply('✅ Perubahan/Broadcast dibatalkan.');
                    delete adminStates[userId];
                    return;
                }
            }
            try {
                switch (state.step) {
                    case 'WAITING_KATEGORI':
                        state.data.kategori = text.toUpperCase();
                        state.step = 'WAITING_NAMA';
                        ctx.reply(`✅ Kategori: ${text}\n\nMasukkan **Nama Produk** (Contoh: 1 BULAN AKUN):`);
                        break;
                    case 'WAITING_NAMA':
                        state.data.namaProduk = text;
                        state.step = 'WAITING_HARGA';
                        ctx.reply(`✅ Nama Produk: ${text}\n\nMasukkan **Harga** (Hanya angka, Contoh: 1000):`);
                        break;
                    case 'WAITING_HARGA':
                        const harga = parseInt(text);
                        if (isNaN(harga) || harga <= 0) {
                            return ctx.reply('❌ Harga tidak valid. Masukkan hanya angka positif.');
                        }
                        state.data.harga = harga;
                        state.step = 'WAITING_DESKRIPSI'; 
                        ctx.reply(`✅ Harga: Rp ${harga.toLocaleString('id-ID')}\n\nMasukkan **Deskripsi Singkat** produk:`);
                        break;
                    case 'WAITING_DESKRIPSI':
                        state.data.deskripsi = text;
                        state.step = 'WAITING_STOK'; 
                        ctx.reply(`✅ Deskripsi: ${text}\n\nMasukkan **Stok Awal** (Hanya angka):`);
                        break;
                    case 'WAITING_STOK':
                        const stok = parseInt(text);
                        if (isNaN(stok) || stok < 0) {
                            return ctx.reply('❌ Stok tidak valid. Masukkan hanya angka positif.');
                        }
                        state.data.stok = stok;
                        state.step = 'WAITING_KONTEN';
                        ctx.reply(`✅ Stok: ${stok} pcs\n\nMasukkan **Konten Produk** (Dipisahkan dengan baris baru untuk setiap item):\n\nContoh:\n*key123*\n*akun@mail.com:pass*`);
                        break;
                    case 'WAITING_KONTEN':
                        const kontenArray = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
                        if (kontenArray.length === 0 && state.data.stok > 0) {
                            return ctx.reply('❌ Konten tidak boleh kosong jika stok > 0.');
                        }
                        state.data.kontenProduk = kontenArray;
                        await saveNewProduct(ctx, state.data);
                        delete adminStates[userId];
                        break;
                    case 'STOK_WAITING_CONTENT':
                        const newContentArray = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
                        const currentProduct = await Product.findById(state.productId);
                        if (newContentArray.length === 0) {
                            return ctx.reply('❌ Konten tidak boleh kosong.');
                        }
                        await Product.updateOne(
                            { _id: currentProduct._id },
                            {
                                $push: { kontenProduk: { $each: newContentArray } },
                                $inc: { stok: newContentArray.length }
                            }
                        );
                        ctx.reply(`✅ Berhasil menambahkan **${newContentArray.length}** item stok baru untuk ${currentProduct.namaProduk}.`);
                        delete adminStates[userId];
                        break;
                    case 'BROADCAST_WAITING_MESSAGE': {
                        const messageToBroadcast = text; 
                        adminStates[userId] = {
                            step: 'BROADCAST_WAITING_CONFIRMATION',
                            message: messageToBroadcast
                        };
                        const totalUsers = await User.countDocuments();
                        await ctx.replyWithMarkdown(
                            `⚠️ **KONFIRMASI BROADCAST** ⚠️\n\n` +
                            `Anda akan mengirim pesan berikut:\n` +
                            `---------------------------------------\n` +
                            `${messageToBroadcast}\n` +
                            `---------------------------------------\n` +
                            `Ke **${totalUsers}** user.\n\n` +
                            `Ketik **YA** untuk melanjutkan, atau /cancel untuk batal.`
                        );
                        break;
                    }
                    case 'BROADCAST_WAITING_CONFIRMATION': {
                        if (text.toLowerCase() !== 'ya') {
                            ctx.reply('Broadcast dibatalkan. Balasan Anda bukan "YA".');
                            delete adminStates[userId];
                            return;
                        }
                        const messageToBroadcast = state.message; 
                        delete adminStates[userId]; 
                        await ctx.reply('✅ Konfirmasi diterima. Memulai pengiriman broadcast... Ini mungkin perlu waktu.');
                        const allUsers = await User.find({}).select('userId');
                        let successCount = 0;
                        let failCount = 0;
                        for (const user of allUsers) {
                            try {
                                await bot.telegram.sendMessage(user.userId, messageToBroadcast);
                                successCount++;
                            } catch (error) {
                                console.warn(`Gagal kirim broadcast ke ${user.userId}: ${error.message}`);
                                failCount++;
                            }
                            await new Promise(resolve => setTimeout(resolve, 100)); 
                        }
                        await ctx.replyWithMarkdown(`🎉 **Broadcast Selesai!**\n\n` +
                            `Berhasil terkirim: **${successCount}** user\n` +
                            `Gagal terkirim: **${failCount}** user (Mungkin memblokir bot)`);
                        break;
                    }
                    default:
                        if (state.step.startsWith('EDIT_WAITING_VALUE:')) {
                            const field = state.step.split(':')[1];
                            const productId = state.productId; 
                            let updateValue = text;
                            let updateObject = {};
                            if (field === 'harga' || field === 'expiredDays') {
                                updateValue = parseInt(text);
                                if (isNaN(updateValue) || updateValue < 0) {
                                    return ctx.reply(`❌ Input tidak valid. Masukkan angka positif.`);
                                }
                            } else if (field === 'kategori') {
                                updateValue = text.toUpperCase();
                            }
                            updateObject[field] = updateValue;
                            try {
                                await Product.updateOne({ _id: productId }, updateObject);
                                await ctx.reply(`✅ **${field.toUpperCase()}** berhasil diupdate menjadi: **${updateValue}**`);
                                delete adminStates[userId];
                                await displayEditMenu(ctx, productId); 
                            } catch (error) {
                                console.error("Error saat update field produk:", error);
                                ctx.reply(`❌ Gagal mengupdate ${field}. Coba lagi.`);
                                delete adminStates[userId]; 
                            }
                        } else {
                            return next();
                        }
                } 
            } catch (error) {
                console.error("Error dalam proses admin text handler:", error);
                ctx.reply('⚠️ Terjadi kesalahan. Proses dibatalkan.');
                delete adminStates[userId];
            }
            return; 
        }
    }
    
    const userId = ctx.from.id;
    const state = userStates[userId];

    if (!state) return next(); 
    
    const text = ctx.message.text.trim();

    if (text.toLowerCase() === '/cancel' || text === '❌ Batal') {
        ctx.reply('✅ Aksi dibatalkan. Kembali ke menu utama.', mainKeyboard);
        delete userStates[userId];
        return;
    }

    try {
        switch (state.step) {
            
            case 'WAITING_TOPUP_AMOUNT': {
                const amount = parseInt(text);
                if (isNaN(amount) || amount < 1000) {
                    return ctx.reply('❌ Nominal tidak valid. Masukkan hanya angka positif minimal Rp 1.000. (Tekan ❌ Batal untuk kembali)');
                }
                delete userStates[userId]; 
                await ctx.reply('Memproses nominal kustom...', mainKeyboard); 
                await processCheckout(ctx, 'qris', `topup:${amount}`);
                break;
            }

            case 'WAITING_SUPPORT_MESSAGE': {
                const fromUser = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
                const fromId = ctx.from.id;
                
                const messageToAdmin = `╭─────────────────────────\n` +
                                     `│ 📩 PESAN BANTUAN BARU\n` +
                                     `╰─────────────────────────\n` +
                                     `│ Dari: ${fromUser} (ID: ${fromId})\n` +
                                     `│\n` +
                                     `│ Pesan:\n` +
                                     `│ ${text}\n` +
                                     `╰─────────────────────────\n` +
                                     `Balas pesan ini untuk membalas ke user.`;
                
                let sentToAdmin = false;
                for (const adminId of ADMIN_IDS) {
                    try {
                        await bot.telegram.sendMessage(adminId, messageToAdmin);
                        sentToAdmin = true; 
                    } catch (e) {
                        console.error(`Gagal kirim pesan bantuan ke Admin ${adminId}:`, e.message);
                    }
                }

                if (sentToAdmin) {
                    await ctx.reply('✅ Pesan Anda telah berhasil diteruskan ke Admin. Harap tunggu balasan.', mainKeyboard);
                } else {
                    await ctx.reply('❌ Maaf, gagal mengirim pesan ke Admin. Silakan coba lagi nanti.', mainKeyboard);
                }
                
                delete userStates[userId]; 
                break;
            }

            case 'WAITING_CATEGORY_CHOICE': {
                const choice = parseInt(text);
                
                if (isNaN(choice) || choice <= 0) {
                    await ctx.reply('❌ Input tidak valid. Silakan ketik *angka* yang sesuai dengan daftar, atau tekan tombolnya.\n(Tekan ❌ Batal untuk kembali).', { parse_mode: 'Markdown' });
                    return; 
                }

                const categories = await Product.distinct('kategori').sort();
                const selectedCategory = categories[choice - 1]; 

                if (selectedCategory) {
                    
                    delete userStates[userId];
                    await ctx.reply(`Anda memilih kategori: **${selectedCategory}**`, { 
                        parse_mode: 'Markdown',
                        reply_markup: mainKeyboard.reply_markup 
                    });
                    await displayProductVariations(ctx, selectedCategory);
                } else {
                    
                    await ctx.reply(`❌ Kategori nomor **${choice}** tidak ditemukan. Silakan pilih angka yang ada di daftar.`, { parse_mode: 'Markdown' });
                    
                }
                break;
            }
            
            default:
                
                
                return next();
        }
    } catch (error) {
        console.error("Error di User Text Handler:", error);
        ctx.reply('⚠️ Terjadi kesalahan. Proses dibatalkan.', mainKeyboard);
        delete userStates[userId];
    }
});

bot.action(/checkout_pay:([^:]+):(.+)/, async (ctx) => { 
    await ctx.answerCbQuery('Memproses...'); 
    const [, method, param] = ctx.match;
    await processCheckout(ctx, method, param); 
});

app.get('/success', (req, res) => {
    res.send('Pembayaran berhasil! Silakan cek bot Telegram Anda.');
});

const botPort = process.env.BOT_PORT || 3000;
app.listen(botPort, () => {
    console.log(`🌐 Bot Server berjalan di port ${botPort}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bot.launch()
    .then(() => {
        console.log('🚀 Bot Auto Payment telah berjalan!');
    })
    .catch((err) => {
        console.error('Gagal menjalankan bot:', err);
    });