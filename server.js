const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

// ---------- DATA (in memory: resets on restart. Use a real DB for real balances) ----------
let users = {};
let orders = {}; // marketplace orders posted by users
let requests = {}; // deposit / withdraw requests

// ---------- HELPERS ----------
const round = n => Math.round(n * 100) / 100;

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 32).toString('hex');
  return salt + ':' + hash;
}
function checkPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
function safe(u) {
  return { name: u.name, phone: u.phone, balance: round(u.balance), coins: round(u.coins), isAdmin: u.phone === BONUS_PHONE };
}
// Special account: the ONLY account that gets bonuses (1000 KSh + 100,000,000 MES, once)
const BONUS_PHONE = '0768871831';
const BONUS_KSH = 1000;
const BONUS_MES = 100000000;
const PAY_NUMBER = BONUS_PHONE; // M-Pesa number users send deposits to (change if needed)
function giveBonus(u) {
  if (u.phone === BONUS_PHONE && !u.bonusGiven) {
    u.balance = round(u.balance + BONUS_KSH);
    u.coins = round(u.coins + BONUS_MES);
    u.bonusGiven = true;
  }
}
function mask(phone) {
  return phone.slice(0, 4) + '***' + phone.slice(-3);
}

// PIN attempt limiter: 5 wrong tries = locked 5 minutes
const attempts = {};
function locked(phone) {
  const a = attempts[phone];
  return a && a.until && Date.now() < a.until;
}
function fail(phone) {
  const a = attempts[phone] || (attempts[phone] = { n: 0, until: 0 });
  a.n++;
  if (a.n >= 5) { a.until = Date.now() + 5 * 60 * 1000; a.n = 0; }
}
function ok(phone) { delete attempts[phone]; }

// returns user if PIN is right, otherwise sends an error response and returns null
function authUser(res, phone, pin) {
  const u = users[phone];
  if (!u) { res.json({ success: false, msg: "No account" }); return null; }
  if (locked(phone)) { res.json({ success: false, msg: "Too many wrong PINs. Try again in 5 minutes" }); return null; }
  if (!checkPin(String(pin || ''), u.pin)) { fail(phone); res.json({ success: false, msg: "Wrong PIN" }); return null; }
  ok(phone);
  return u;
}

// ---------- HTML ----------
const HTML = require('./html')(PAY_NUMBER);

app.get('/', (req, res) => res.send(HTML));

// ---------- AUTH ----------
app.post('/api/signup', (req, res) => {
  let { name, phone, pin } = req.body;
  name = String(name || '').trim();
  phone = String(phone || '').trim();
  pin = String(pin || '');
  if (name.length < 2 || name.length > 40) return res.json({ success: false, msg: "Enter a valid name" });
  if (!/^\d{9,13}$/.test(phone)) return res.json({ success: false, msg: "Enter a valid phone number" });
  if (!/^\d{4}$/.test(pin)) return res.json({ success: false, msg: "PIN must be 4 digits" });
  if (users[phone]) return res.json({ success: false, msg: "Account already exists. Please LOGIN" });
  // Everyone starts with 0 KSh and 0 MES. Only BONUS_PHONE gets a bonus (via giveBonus).
  users[phone] = { name, phone, pin: hashPin(pin), coins: 0, balance: 0 };
  giveBonus(users[phone]);
  const isBonus = phone === BONUS_PHONE;
  res.json({
    success: true,
    msg: isBonus ? "Account Created! Bonus added" : "Account Created!",
    user: safe(users[phone])
  });
});

app.post('/api/login', (req, res) => {
  const phone = String(req.body.phone || '').trim();
  if (!users[phone]) return res.json({ success: false, msg: "No account. Please CREATE ACCOUNT first" });
  const u = authUser(res, phone, req.body.pin);
  if (!u) return;
  giveBonus(u);
  res.json({ success: true, msg: "Welcome " + u.name, user: safe(u) });
});

// ---------- SEND (PIN required) ----------
app.post('/api/send', (req, res) => {
  const { fromPhone, toPhone, pin } = req.body;
  const coins = Number(req.body.coins);
  if (!(coins > 0) || !isFinite(coins)) return res.json({ success: false, msg: "Invalid amount" });
  if (fromPhone === toPhone) return res.json({ success: false, msg: "You can't send to yourself" });
  if (!users[toPhone]) return res.json({ success: false, msg: "❌ " + toPhone + " has NO account. Tell them to create account." });
  const from = authUser(res, fromPhone, pin);
  if (!from) return;
  if (from.coins < coins) return res.json({ success: false, msg: "Not enough MES" });
  from.coins = round(from.coins - coins);
  users[toPhone].coins = round(users[toPhone].coins + coins);
  res.json({ success: true, msg: "Sent " + coins + " MES to " + users[toPhone].name, user: safe(from) });
});

// ---------- WALLET (deposit / withdraw requests) ----------
// Money is NOT moved automatically. The admin (BONUS_PHONE) approves each request:
//   DEPOSIT  -> user pays by M-Pesa, sends the code; KSh is credited on approval
//   WITHDRAW -> KSh is locked immediately; admin pays by M-Pesa, then approves
//               (rejecting a withdrawal returns the KSh)
function validAmount(a) { return a >= 10 && a <= 150000; }
function pendingCount(phone) {
  return Object.values(requests).filter(r => r.phone === phone && r.status === 'pending').length;
}

app.post('/api/wallet/deposit', (req, res) => {
  const { phone, pin } = req.body;
  const amount = round(Number(req.body.amount));
  const ref = String(req.body.ref || '').trim().toUpperCase();
  if (!validAmount(amount)) return res.json({ success: false, msg: "Amount must be KSh 10 - 150,000" });
  if (!/^[A-Z0-9]{8,12}$/.test(ref)) return res.json({ success: false, msg: "Enter the M-Pesa code" });
  const u = authUser(res, phone, pin);
  if (!u) return;
  if (Object.values(requests).some(r => r.type === 'deposit' && r.ref === ref)) return res.json({ success: false, msg: "That M-Pesa code was already used" });
  if (pendingCount(phone) >= 5) return res.json({ success: false, msg: "Too many pending requests. Please wait" });
  const id = crypto.randomBytes(8).toString('hex');
  requests[id] = { id, phone, type: 'deposit', amount, ref, status: 'pending', created: Date.now() };
  res.json({ success: true, msg: "Deposit request sent. It will be credited after approval." });
});

app.post('/api/wallet/withdraw', (req, res) => {
  const { phone, pin } = req.body;
  const amount = round(Number(req.body.amount));
  if (!validAmount(amount)) return res.json({ success: false, msg: "Amount must be KSh 10 - 150,000" });
  const u = authUser(res, phone, pin);
  if (!u) return;
  if (u.balance < amount) return res.json({ success: false, msg: "Not enough KSh" });
  if (pendingCount(phone) >= 5) return res.json({ success: false, msg: "Too many pending requests. Please wait" });
  u.balance = round(u.balance - amount);
  const id = crypto.randomBytes(8).toString('hex');
  requests[id] = { id, phone, type: 'withdraw', amount, status: 'pending', created: Date.now() };
  res.json({ success: true, msg: "Withdrawal requested. KSh " + amount + " is locked until it is processed.", user: safe(u) });
});

// My own requests (latest 10)
app.post('/api/wallet/mine', (req, res) => {
  const { phone } = req.body;
  const list = Object.values(requests)
    .filter(r => r.phone === phone)
    .sort((a, b) => b.created - a.created)
    .slice(0, 10)
    .map(r => ({ type: r.type, amount: r.amount, status: r.status }));
  res.json({ requests: list });
});

// Admin: list pending requests
app.post('/api/wallet/pending', (req, res) => {
  const { phone, pin } = req.body;
  const u = authUser(res, phone, pin);
  if (!u) return;
  if (phone !== BONUS_PHONE) return res.json({ success: false, msg: "Not allowed" });
  const list = Object.values(requests)
    .filter(r => r.status === 'pending')
    .sort((a, b) => a.created - b.created)
    .map(r => ({ id: r.id, type: r.type, amount: r.amount, ref: r.ref || '', phone: r.phone, name: users[r.phone].name }));
  res.json({ success: true, requests: list });
});

// Admin: approve or reject
app.post('/api/wallet/resolve', (req, res) => {
  const { phone, pin, id, action } = req.body;
  const admin = authUser(res, phone, pin);
  if (!admin) return;
  if (phone !== BONUS_PHONE) return res.json({ success: false, msg: "Not allowed" });
  const r = requests[id];
  if (!r || r.status !== 'pending') return res.json({ success: false, msg: "Request not found" });
  if (!['approve', 'reject'].includes(action)) return res.json({ success: false, msg: "Invalid action" });
  const target = users[r.phone];
  if (action === 'approve') {
    if (r.type === 'deposit') target.balance = round(target.balance + r.amount);
    r.status = 'approved';
  } else {
    if (r.type === 'withdraw') target.balance = round(target.balance + r.amount);
    r.status = 'rejected';
  }
  res.json({ success: true, msg: "Request " + r.status, user: safe(admin) });
});

// ---------- MARKETPLACE ----------
// Funds are locked (escrow) when an order is posted:
//   SELL order -> poster's MES is locked
//   BUY order  -> poster's KSh is locked
// Locked funds go back to the poster if they cancel.

// Post an order (PIN required)
app.post('/api/market/post', (req, res) => {
  const { phone, type, pin } = req.body;
  const mes = round(Number(req.body.mes));
  const price = round(Number(req.body.price));
  if (!['buy', 'sell'].includes(type)) return res.json({ success: false, msg: "Invalid order type" });
  if (!(mes > 0) || !(price > 0) || mes > 1e9 || price > 1e6) return res.json({ success: false, msg: "Enter a valid amount and price" });
  const ksh = round(mes * price);
  if (!(ksh > 0)) return res.json({ success: false, msg: "Order too small" });
  const u = authUser(res, phone, pin);
  if (!u) return;
  if (type === 'sell') {
    if (u.coins < mes) return res.json({ success: false, msg: "Not enough MES" });
    u.coins = round(u.coins - mes);
  } else {
    if (u.balance < ksh) return res.json({ success: false, msg: "Not enough KSh" });
    u.balance = round(u.balance - ksh);
  }
  const id = crypto.randomBytes(8).toString('hex');
  orders[id] = { id, owner: phone, type, mes, price, ksh, status: 'open', created: Date.now() };
  res.json({ success: true, msg: "Order posted. Your " + (type === 'sell' ? mes + " MES is" : "KSh " + ksh + " is") + " locked until someone accepts or you cancel.", user: safe(u) });
});

// List open orders of one type from OTHER users (everyone can see them)
app.post('/api/market/list', (req, res) => {
  const { phone, type } = req.body;
  if (!users[phone] || !['buy', 'sell'].includes(type)) return res.json({ orders: [] });
  const list = Object.values(orders)
    .filter(o => o.status === 'open' && o.type === type && o.owner !== phone)
    .sort((a, b) => b.created - a.created)
    .slice(0, 50)
    .map(o => ({ id: o.id, ownerName: users[o.owner].name, ownerPhone: mask(o.owner), type: o.type, mes: o.mes, price: o.price, ksh: o.ksh }));
  res.json({ orders: list });
});

// Accept an order and complete it with PIN
app.post('/api/market/accept', (req, res) => {
  const { orderId, phone, pin } = req.body;
  const o = orders[orderId];
  if (!o || o.status !== 'open') return res.json({ success: false, refresh: true, msg: "Order no longer available" });
  if (o.owner === phone) return res.json({ success: false, msg: "You can't accept your own order" });
  const taker = authUser(res, phone, pin);
  if (!taker) return;
  const owner = users[o.owner];

  if (o.type === 'sell') {
    // owner sells MES (already locked), taker buys with KSh
    if (taker.balance < o.ksh) return res.json({ success: false, msg: "Not enough KSh" });
    taker.balance = round(taker.balance - o.ksh);
    taker.coins = round(taker.coins + o.mes);
    owner.balance = round(owner.balance + o.ksh);
  } else {
    // owner buys MES (KSh already locked), taker sells MES
    if (taker.coins < o.mes) return res.json({ success: false, msg: "Not enough MES" });
    taker.coins = round(taker.coins - o.mes);
    taker.balance = round(taker.balance + o.ksh);
    owner.coins = round(owner.coins + o.mes);
  }
  o.status = 'done';
  o.taker = phone;
  res.json({ success: true, msg: "Order complete with " + owner.name, user: safe(taker) });
});

// My open orders
app.post('/api/market/mine', (req, res) => {
  const { phone } = req.body;
  const list = Object.values(orders)
    .filter(o => o.status === 'open' && o.owner === phone)
    .sort((a, b) => b.created - a.created)
    .map(o => ({ id: o.id, type: o.type, mes: o.mes, price: o.price, ksh: o.ksh }));
  res.json({ orders: list });
});

// Cancel my order (PIN required) and get locked funds back
app.post('/api/market/cancel', (req, res) => {
  const { orderId, phone, pin } = req.body;
  const o = orders[orderId];
  if (!o || o.status !== 'open' || o.owner !== phone) return res.json({ success: false, refresh: true, msg: "Order not found" });
  const u = authUser(res, phone, pin);
  if (!u) return;
  if (o.type === 'sell') u.coins = round(u.coins + o.mes);
  else u.balance = round(u.balance + o.ksh);
  o.status = 'cancelled';
  res.json({ success: true, msg: "Order cancelled. Funds returned.", user: safe(u) });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Running on " + PORT));
  
