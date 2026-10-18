const express = require('express');
const fs = require('fs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const app = express();
app.use(cors());
app.use(express.json({ limit: '20kb' }));

// Set JWT_SECRET in your host's environment variables. Fallback keeps old tokens working.
const SECRET = process.env.JWT_SECRET || 'mescoin-secret-2026';
const DB_FILE = fs.existsSync('/data') ? '/data/database.json' : './database.json';

// ---------------- BLOCKCHAIN ----------------
function calculateHash(prev_hash, timestamp, transactions, nonce) {
  return crypto.createHash('sha256').update(prev_hash + timestamp + JSON.stringify(transactions) + nonce).digest('hex');
}
function createGenesisBlock() {
  let timestamp = new Date().toISOString();
  let transactions = [{ from: 'GENESIS', to: 'NETWORK', amount: 0, note: 'Genesis Block' }];
  let prev_hash = '0';
  let nonce = 0;
  let hash = calculateHash(prev_hash, timestamp, transactions, nonce);
  return { index: 0, prev_hash, timestamp, transactions, nonce, hash };
}
function getLastBlock() { return blockchain[blockchain.length - 1]; }
function mineBlock(transactions) {
  let prevBlock = getLastBlock();
  let index = prevBlock.index + 1;
  let timestamp = new Date().toISOString();
  let prev_hash = prevBlock.hash;
  let nonce = 0;
  let hash = '';
  do {
    nonce++;
    hash = calculateHash(prev_hash, timestamp, transactions, nonce);
  } while (!hash.startsWith('00'));
  return { index, prev_hash, timestamp, transactions, nonce, hash };
}
function isChainValid(chain) {
  for (let i = 1; i < chain.length; i++) {
    let curr = chain[i];
    let prev = chain[i - 1];
    if (curr.prev_hash !== prev.hash) return false;
    if (curr.hash !== calculateHash(curr.prev_hash, curr.timestamp, curr.transactions, curr.nonce)) return false;
    if (!curr.hash.startsWith('00')) return false;
  }
  return true;
}
function getBalanceFromChain(mes_account) {
  let balance = 0;
  let acc = mes_account.toUpperCase();
  for (let block of blockchain) {
    for (let tx of block.transactions) {
      if (tx.to && tx.to.toUpperCase() === acc) balance += Number(tx.amount);
      if (tx.from && tx.from.toUpperCase() === acc) balance -= Number(tx.amount);
    }
  }
  return balance;
}
function addToBlockchain(transactions) {
  let newBlock = mineBlock(transactions);
  blockchain.push(newBlock);
  save();
  return newBlock;
}

// ---------------- DATABASE ----------------
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], orders: [], trades: [], messages: [], blockchain: [createGenesisBlock()] }));
  }
  let raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!raw.blockchain || raw.blockchain.length === 0) raw.blockchain = [createGenesisBlock()];
  return raw;
}
function saveDB(d) { fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2)); }
let db = loadDB();
let users = db.users || [];
let orders = db.orders || [];
let trades = db.trades || [];
let messages = db.messages || [];
let blockchain = db.blockchain || [createGenesisBlock()];
function save() { saveDB({ users, orders, trades, messages, blockchain }); }

// ---------------- HELPERS ----------------
const FOUNDER_PHONE = '254768871831';
const FOUNDER_AMOUNT = 100000000;
// last 9 digits, so 0768..., 768... and 254768... all match each other
function cleanPhone(p) { return (p || '').toString().replace(/\D/g, '').slice(-9); }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function checkPassword(user, pw) {
  const s = user.password || '';
  if (s.startsWith('scrypt$')) {
    const [, salt, h] = s.split('$');
    return crypto.timingSafeEqual(crypto.scryptSync(String(pw), salt, 32), Buffer.from(h, 'hex'));
  }
  // old plain-text account: accept once, then upgrade to a hash
  if (s === pw) { user.password = hashPassword(pw); save(); return true; }
  return false;
}
function safe(u) { const { password, ...rest } = u; return rest; }

(function fundFounderOnBoot() {
  try {
    let founder = users.find(u => cleanPhone(u.phone) === cleanPhone(FOUNDER_PHONE));
    if (founder) {
      let already = blockchain.some(b => b.transactions.some(tx => tx.to === founder.mes_account && tx.from === 'GENESIS_BANK_100M'));
      if (!already) {
        founder.mes_balance = FOUNDER_AMOUNT;
        let block = mineBlock([{ from: 'GENESIS_BANK_100M', to: founder.mes_account, amount: FOUNDER_AMOUNT, note: 'Founder 100M allocation' }]);
        blockchain.push(block);
        save();
        console.log('FOUNDER 100M FUNDED: ' + founder.mes_account);
      }
    }
  } catch (e) { console.log('Founder boot error', e.message); }
})();

function auth(req, res, next) {
  try {
    let t = req.headers.authorization?.split(' ')[1];
    let dec = jwt.verify(t, SECRET);
    req.user = users.find(u => u.id === dec.id);
    if (!req.user) return res.status(401).json({ error: 'User not found' });
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ---------------- PUBLIC ----------------
app.get('/api/price', (req, res) => res.json({ price: 2 }));
app.get('/api/blockchain', (req, res) => {
  res.json({ length: blockchain.length, valid: isChainValid(blockchain), chain: blockchain.slice(-10).reverse() });
});
app.get('/api/blockchain/balance/:account', (req, res) => {
  let bal = getBalanceFromChain(req.params.account);
  res.json({ account: req.params.account, blockchain_balance: bal, chain_length: blockchain.length });
});

// ---------------- ACCOUNTS ----------------
app.post('/api/signup', (req, res) => {
  let { full_name, phone, password } = req.body || {};
  if (!full_name || !phone || !password) return res.status(400).json({ error: 'All required' });
  let cp = cleanPhone(phone);
  if (cp.length < 9) return res.status(400).json({ error: 'Enter a valid mobile number' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Password too short' });
  if (users.find(u => cleanPhone(u.phone) === cp)) return res.status(400).json({ error: 'Mobile already registered - click LOGIN' });
  let user = {
    id: Date.now().toString(),
    full_name: String(full_name).trim().slice(0, 60),
    phone: cp,
    password: hashPassword(password),
    mes_account: 'MES' + Math.floor(100000 + Math.random() * 900000),
    kes_balance: 0,
    mes_balance: 0
  };
  if (cp === cleanPhone(FOUNDER_PHONE)) user.mes_balance = FOUNDER_AMOUNT;
  users.push(user);
  if (user.mes_balance === FOUNDER_AMOUNT) {
    blockchain.push(mineBlock([{ from: 'GENESIS_BANK_100M', to: user.mes_account, amount: FOUNDER_AMOUNT, note: 'Founder 100M on signup' }]));
  } else {
    addToBlockchain([{ from: 'GENESIS', to: user.mes_account, amount: 0, note: 'Account created ' + user.full_name }]);
  }
  save();
  let token = jwt.sign({ id: user.id }, SECRET);
  res.json({ token, user: safe(user) });
});

app.post('/api/login', (req, res) => {
  let { login_id, password } = req.body || {};
  if (!login_id || !password) return res.status(400).json({ error: 'All required' });
  let cp = cleanPhone(login_id);
  let up = String(login_id).trim().toUpperCase();
  let u = users.find(x => (cp.length >= 9 && cleanPhone(x.phone) === cp) || x.mes_account.toUpperCase() === up);
  if (!u) return res.status(400).json({ error: 'Account not found' });
  if (!checkPassword(u, password)) return res.status(400).json({ error: 'Wrong password' });
  let token = jwt.sign({ id: u.id }, SECRET);
  res.json({ token, user: safe(u) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ ...safe(req.user), blockchain_balance: getBalanceFromChain(req.user.mes_account) });
});

// ---------------- ORDERS ----------------
app.get('/api/orders', auth, (req, res) => {
  let list = orders.filter(o => o.userId === req.user.id).slice(-20).reverse().map(o => {
    let out = { ...o };
    // For matched trades both people chat on the SELL order so they share one thread
    if (o.status === 'MATCHED' && o.matchedWith) {
      let pair = orders.find(x => x.id == o.matchedWith);
      if (pair) {
        let sell = o.type === 'SELL' ? o : pair;
        out.chat_order_id = sell.id;
        out.chat_with = o.type === 'SELL' ? pair.userId : null; // buyer talks to order owner (seller)
        let cp = users.find(u => u.id === pair.userId);
        out.counterparty = cp ? cp.full_name : '';
      }
    }
    return out;
  });
  res.json(list);
});

app.get('/api/market', (req, res) => {
  function enrich(o) {
    let u = users.find(x => x.id === o.userId);
    return {
      id: o.id, type: o.type, amount: o.amount, status: o.status, date: o.date,
      user_id: o.userId,
      full_name: u ? u.full_name : 'Unknown',
      phone: u ? cleanPhone(u.phone) : '',
      mes_account: u ? u.mes_account : '',
      kes: o.amount * 2
    };
  }
  res.json({
    buys: orders.filter(o => o.type === 'BUY' && o.status === 'PENDING').map(enrich).slice(-30).reverse(),
    sells: orders.filter(o => o.type === 'SELL' && o.status === 'PENDING').map(enrich).slice(-30).reverse(),
    matched: orders.filter(o => o.status === 'MATCHED').map(enrich).slice(-20).reverse()
  });
});

// Cancel: any locked MES goes back to the seller, whoever cancels
app.post('/api/order/cancel/:id', auth, (req, res) => {
  let o = orders.find(x => x.id == req.params.id && x.userId === req.user.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.type !== 'BUY' && o.type !== 'SELL') return res.status(400).json({ error: 'Cannot cancel this' });
  if (o.status !== 'PENDING' && o.status !== 'MATCHED') return res.status(400).json({ error: 'Order already ' + o.status });
  let toCancel = [o];
  if (o.matchedWith) {
    let other = orders.find(x => x.id == o.matchedWith);
    if (other && other.status === 'MATCHED') toCancel.push(other);
  }
  for (let x of toCancel) {
    if (x.type === 'SELL') {
      let owner = users.find(u => u.id === x.userId);
      if (owner) owner.mes_balance += x.amount;
    }
    x.status = 'CANCELLED';
  }
  save();
  res.json({ message: 'Order cancelled. Locked MES returned to the seller.', user: safe(req.user) });
});

// Only the SELLER can release MES (after receiving the KES), so a buyer cannot release it early
app.post('/api/order/complete/:id', auth, (req, res) => {
  let sellOrder = orders.find(o => o.id == req.params.id && o.userId === req.user.id && o.type === 'SELL');
  if (!sellOrder) return res.status(403).json({ error: 'Only the seller can complete the trade' });
  if (sellOrder.status !== 'MATCHED') return res.status(400).json({ error: 'Not matched yet' });
  let buyOrder = orders.find(o => o.id == sellOrder.matchedWith);
  if (!buyOrder) return res.status(400).json({ error: 'Pair not found' });
  let seller = req.user;
  let buyer = users.find(u => u.id === buyOrder.userId);
  if (!buyer) return res.status(400).json({ error: 'Buyer not found' });
  sellOrder.status = 'COMPLETED';
  buyOrder.status = 'COMPLETED';
  buyer.mes_balance += sellOrder.amount;
  seller.kes_balance += sellOrder.amount * 2;
  trades.push({ id: Date.now(), amount: sellOrder.amount, kes: sellOrder.amount * 2, date: new Date() });
  addToBlockchain([{ from: seller.mes_account, to: buyer.mes_account, amount: sellOrder.amount, kes: sellOrder.amount * 2, note: 'P2P TRADE ' + sellOrder.id }]);
  res.json({ message: 'Trade completed! MES released to buyer', user: safe(req.user) });
});

app.post('/api/order/buy', auth, (req, res) => {
  let amount = parseFloat(req.body && req.body.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter amount' });
  let sellMatch = orders.find(o => o.type === 'SELL' && o.status === 'PENDING' && o.userId !== req.user.id && o.amount === amount);
  let buyOrder = { id: Date.now().toString(), userId: req.user.id, type: 'BUY', amount, price: 2, status: sellMatch ? 'MATCHED' : 'PENDING', matchedWith: sellMatch ? sellMatch.id : null, date: new Date() };
  orders.push(buyOrder);
  if (sellMatch) { sellMatch.status = 'MATCHED'; sellMatch.matchedWith = buyOrder.id; }
  save();
  if (sellMatch) {
    let seller = users.find(u => u.id === sellMatch.userId);
    return res.json({ message: 'MATCHED with ' + seller.full_name + '! Open the chat from "My Orders", send ' + (amount * 2) + ' KES by normal M-Pesa, then wait for the seller to confirm.', user: safe(req.user) });
  }
  res.json({ message: 'Buy order saved - visible to all sellers. They can message you.', user: safe(req.user) });
});

app.post('/api/order/sell', auth, (req, res) => {
  let amount = parseFloat(req.body && req.body.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter amount' });
  if (req.user.mes_balance < amount) return res.status(400).json({ error: 'Not enough MES' });
  let buyMatch = orders.find(o => o.type === 'BUY' && o.status === 'PENDING' && o.userId !== req.user.id && o.amount === amount);
  req.user.mes_balance -= amount;
  let sellOrder = { id: Date.now().toString(), userId: req.user.id, type: 'SELL', amount, price: 2, status: buyMatch ? 'MATCHED' : 'PENDING', matchedWith: buyMatch ? buyMatch.id : null, date: new Date() };
  orders.push(sellOrder);
  if (buyMatch) { buyMatch.status = 'MATCHED'; buyMatch.matchedWith = sellOrder.id; }
  save();
  if (buyMatch) {
    let buyer = users.find(u => u.id === buyMatch.userId);
    return res.json({ message: 'MATCHED with ' + buyer.full_name + '! Chat with them from "My Orders". When their KES arrives, click Complete.', user: safe(req.user) });
  }
  res.json({ message: 'Sell order saved, MES locked. Buyers can message you.', user: safe(req.user) });
});

app.post('/api/send', auth, (req, res) => {
  let { to_account } = req.body || {};
  let amount = parseFloat(req.body && req.body.amount);
  if (!to_account) return res.status(400).json({ error: 'Enter receiver' });
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter amount' });
  to_account = String(to_account).trim().toUpperCase();
  if (req.user.mes_balance < amount) return res.status(400).json({ error: 'Not enough MES' });
  let cp = cleanPhone(to_account);
  let receiver = users.find(u => u.mes_account.toUpperCase() === to_account || (cp.length >= 9 && cleanPhone(u.phone) === cp));
  if (!receiver) return res.status(400).json({ error: 'Receiver not found - use MES account or phone' });
  if (receiver.id === req.user.id) return res.status(400).json({ error: 'Cannot send to self' });
  req.user.mes_balance -= amount;
  receiver.mes_balance += amount;
  orders.push({ id: Date.now(), userId: req.user.id, type: 'SEND', amount, to_account: receiver.mes_account, date: new Date() });
  addToBlockchain([{ from: req.user.mes_account, to: receiver.mes_account, amount, note: 'Direct SEND' }]);
  res.json({ message: 'Sent ' + amount + ' to ' + receiver.mes_account, user: safe(req.user) });
});

// ---------------- ORDER CHAT ----------------
// A private thread exists between the order owner and each person who messages that order.
const chatHits = {};
function chatLimited(uid) {
  const now = Date.now();
  chatHits[uid] = (chatHits[uid] || []).filter(t => now - t < 60000);
  if (chatHits[uid].length >= 20) return true;
  chatHits[uid].push(now);
  return false;
}
function findChatOrder(id) {
  return orders.find(o => String(o.id) === String(id) && (o.type === 'BUY' || o.type === 'SELL'));
}

// Send a message about an order
app.post('/api/order/:id/messages', auth, (req, res) => {
  const order = findChatOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'CANCELLED' || order.status === 'COMPLETED') return res.status(400).json({ error: 'This order is closed' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Type a message' });

  let toId;
  if (order.userId === req.user.id) {
    // owner replying: must name someone who already messaged this order
    toId = req.body.to;
    if (!toId || !messages.some(m => m.orderId === String(order.id) && m.from === toId && m.to === req.user.id))
      return res.status(403).json({ error: 'You can only reply to people who messaged you' });
  } else {
    toId = order.userId;
  }
  if (chatLimited(req.user.id)) return res.status(429).json({ error: 'Slow down - too many messages' });

  const m = { id: crypto.randomUUID(), orderId: String(order.id), from: req.user.id, to: toId, text, date: new Date().toISOString(), read: false };
  messages.push(m);
  save();
  res.json({ ok: true, message: { id: m.id, from_me: true, text: m.text, date: m.date } });
});

// Read the conversation about an order (owner passes ?with=<userId>)
app.get('/api/order/:id/messages', auth, (req, res) => {
  const order = findChatOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const other = order.userId === req.user.id ? req.query.with : order.userId;
  if (!other) return res.status(400).json({ error: 'Choose who to chat with' });
  const thread = messages.filter(m => m.orderId === String(order.id) &&
    ((m.from === req.user.id && m.to === other) || (m.from === other && m.to === req.user.id)));
  let changed = false;
  thread.forEach(m => { if (m.to === req.user.id && !m.read) { m.read = true; changed = true; } });
  if (changed) save();
  const ou = users.find(u => u.id === other);
  res.json({
    order: { id: order.id, type: order.type, amount: order.amount, kes: order.amount * 2, status: order.status },
    other: { id: other, full_name: ou ? ou.full_name : 'Unknown' },
    messages: thread.slice(-200).map(m => ({ id: m.id, from_me: m.from === req.user.id, text: m.text, date: m.date }))
  });
});

// Inbox: all my conversations with unread counts
app.get('/api/chats', auth, (req, res) => {
  const map = {};
  for (const m of messages) {
    if (m.from !== req.user.id && m.to !== req.user.id) continue;
    const other = m.from === req.user.id ? m.to : m.from;
    const key = m.orderId + '|' + other;
    const c = map[key] || (map[key] = { order_id: m.orderId, with: other, last_text: '', last_date: '', unread: 0 });
    c.last_text = m.text;
    c.last_date = m.date;
    if (m.to === req.user.id && !m.read) c.unread++;
  }
  const list = Object.values(map).map(c => {
    const o = orders.find(x => String(x.id) === c.order_id);
    const u = users.find(x => x.id === c.with);
    return { ...c, with_name: u ? u.full_name : 'Unknown', order_type: o ? o.type : '', order_amount: o ? o.amount : 0, order_status: o ? o.status : '' };
  }).sort((a, b) => b.last_date.localeCompare(a.last_date)).slice(0, 50);
  res.json({ unread: list.reduce((s, c) => s + c.unread, 0), chats: list });
});

// ---------------- WEB PAGE ----------------
const PAGE = String.raw`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MESCOIN</title>
<style>
body{font-family:system-ui;max-width:430px;margin:auto;padding:12px;background:#f0fdf4}
input,button{width:100%;padding:13px;margin:6px 0;border-radius:10px;border:1px solid #ddd;box-sizing:border-box;font-size:15px}
button{background:#16a34a;color:#fff;border:none;font-weight:bold;cursor:pointer}
button.sm{width:auto;padding:6px 10px;margin:4px 4px 0 0;font-size:12px;border-radius:8px}
.card{background:#fff;padding:14px;border-radius:14px;margin:10px 0;box-shadow:0 2px 8px rgba(0,0,0,.06)}
h1{color:#16a34a;text-align:center;margin-bottom:0}
.order{background:#f8fafc;border:1px solid #e2e8f0;padding:10px;border-radius:10px;margin:6px 0}
.badge{background:#dc2626;color:#fff;border-radius:10px;padding:1px 7px;font-size:12px;margin-left:6px}
.chatrow{display:block;width:100%;text-align:left;background:#f8fafc;color:#111;border:1px solid #e2e8f0;font-weight:normal;font-size:13px;padding:10px;margin:5px 0}
#chat_modal{display:none;position:f
