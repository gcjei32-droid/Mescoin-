const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

// ---------- DATA (in memory: resets on restart. Use a real DB for real balances) ----------
let users = {};
let orders = {};
const PRICE = 1; // KSh per 1 MES

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
// never send the PIN hash to the browser
function safe(u) {
  return { name: u.name, phone: u.phone, balance: round(u.balance), coins: round(u.coins) };
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
const HTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mescoin</title><style>body{background:#0a0a0a;color:white;font-family:Arial;padding:20px}h1{text-align:center;color:#FFD700}.card{background:#1a1a1a;padding:18px;border-radius:15px}input{width:100%;padding:13px;margin:7px 0;border-radius:10px;border:none;background:#333;color:white;box-sizing:border-box}button{width:100%;padding:14px;border:none;border-radius:10px;font-weight:bold;margin:6px 0}.yellow{background:#FFD700}.green{background:#00c853;color:white}.row{display:flex;gap:8px}#confirmBox{background:#262626;padding:14px;border-radius:12px;margin-top:10px}</style></head><body><h1>🪙 MESCOIN</h1>
<div id="loginPage" class="card"><h2>Welcome</h2><input id="name" placeholder="Your Name"><input id="phone" placeholder="Phone e.g 0722000000"><input id="pin" type="password" inputmode="numeric" maxlength="4" placeholder="4-digit PIN e.g 1234"><button class="yellow" onclick="signup()">CREATE ACCOUNT</button><button class="green" onclick="login()">LOGIN</button><p id="msg"></p></div>
<div id="appPage" class="card" style="display:none">
<h3>Hello <span id="uName"></span></h3>
<p>Balance: KSh <b id="bal">0</b> | Coins: <b id="coins">0</b> MES</p><hr>
<h3>Buy / Sell Mescoin</h3>
<input id="amt" type="number" placeholder="Buy: amount in KSh | Sell: amount in MES">
<div class="row"><button class="yellow" onclick="startOrder('buy')">BUY</button><button class="green" onclick="startOrder('sell')">SELL</button></div>
<div id="confirmBox" style="display:none"><p id="confirmText"></p><input id="confirmPin" type="password" inputmode="numeric" maxlength="4" placeholder="Enter PIN"><div class="row"><button class="yellow" onclick="confirmOrder()">CONFIRM</button><button onclick="cancelOrder()">CANCEL</button></div></div>
<hr>
<h3>Send Mescoin</h3>
<input id="toPhone" placeholder="To Phone - must have account"><input id="sendMes" type="number" placeholder="MES to send"><input id="sendPin" type="password" inputmode="numeric" maxlength="4" placeholder="Your PIN"><button class="yellow" onclick="sendCoin()">SEND</button>
<p id="msg2"></p><button onclick="location.reload()">Logout</button></div>
<script>
let myPhone="",orderId="";
function $(i){return document.getElementById(i)}
async function post(url,body){let r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}
async function signup(){let d=await post('/api/signup',{name:$('name').value,phone:$('phone').value,pin:$('pin').value});$('msg').innerText=d.msg;if(d.success){myPhone=d.user.phone;show(d.user);}}
async function login(){let d=await post('/api/login',{phone:$('phone').value,pin:$('pin').value});$('msg').innerText=d.msg;if(d.success){myPhone=d.user.phone;show(d.user);}}
async function sendCoin(){let d=await post('/api/send',{fromPhone:myPhone,toPhone:$('toPhone').value,coins:parseFloat($('sendMes').value),pin:$('sendPin').value});$('msg2').innerText=d.msg;$('sendPin').value='';if(d.success)show(d.user);}
async function startOrder(type){let d=await post('/api/order/create',{phone:myPhone,type:type,amount:$('amt').value});if(!d.success){$('msg2').innerText=d.msg;return;}orderId=d.orderId;$('confirmText').innerText=d.text;$('confirmBox').style.display='block';$('msg2').innerText='';}
async function confirmOrder(){let d=await post('/api/order/confirm',{orderId:orderId,phone:myPhone,pin:$('confirmPin').value});$('msg2').innerText=d.msg;$('confirmPin').value='';if(d.success){$('confirmBox').style.display='none';$('amt').value='';show(d.user);}}
function cancelOrder(){orderId="";$('confirmPin').value='';$('confirmBox').style.display='none';}
function show(u){$('loginPage').style.display='none';$('appPage').style.display='block';$('uName').innerText=u.name;$('bal').innerText=u.balance;$('coins').innerText=u.coins;}
</script></body></html>`;

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
  users[phone] = { name, phone, pin: hashPin(pin), coins: 0, balance: 1000 };
  res.json({ success: true, msg: "Account Created! Bonus 1000 KSh", user: safe(users[phone]) });
});

app.post('/api/login', (req, res) => {
  const phone = String(req.body.phone || '').trim();
  if (!users[phone]) return res.json({ success: false, msg: "No account. Please CREATE ACCOUNT first" });
  const u = authUser(res, phone, req.body.pin);
  if (!u) return;
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

// ---------- BUY / SELL ORDERS (create, then confirm with PIN) ----------
app.post('/api/order/create', (req, res) => {
  const { phone, type } = req.body;
  const amt = Number(req.body.amount); // buy: KSh, sell: MES
  if (!users[phone]) return res.json({ success: false, msg: "No account" });
  if (!(amt > 0) || !isFinite(amt) || !['buy', 'sell'].includes(type)) return res.json({ success: false, msg: "Invalid order" });

  const ksh = round(type === 'buy' ? amt : amt * PRICE);
  const mes = round(type === 'buy' ? amt / PRICE : amt);
  const u = users[phone];
  if (type === 'buy' && u.balance < ksh) return res.json({ success: false, msg: "Not enough KSh" });
  if (type === 'sell' && u.coins < mes) return res.json({ success: false, msg: "Not enough MES" });

  const id = crypto.randomBytes(16).toString('hex');
  orders[id] = { phone, type, ksh, mes, expires: Date.now() + 120000 };
  const text = type === 'buy'
    ? "Do you want to pay KSh " + ksh + " to Mescoin for " + mes + " MES? Enter your PIN"
    : "Do you want to sell " + mes + " MES to Mescoin for KSh " + ksh + "? Enter your PIN";
  res.json({ success: true, orderId: id, text });
});

app.post('/api/order/confirm', (req, res) => {
  const { orderId, phone, pin } = req.body;
  const o = orders[orderId];
  if (!o || o.phone !== phone) return res.json({ success: false, msg: "Order not found" });
  if (Date.now() > o.expires) { delete orders[orderId]; return res.json({ success: false, msg: "Order expired" }); }
  const u = authUser(res, phone, pin);
  if (!u) return;
  if (o.type === 'buy') {
    if (u.balance < o.ksh) { delete orders[orderId]; return res.json({ success: false, msg: "Not enough KSh" }); }
    u.balance = round(u.balance - o.ksh);
    u.coins = round(u.coins + o.mes);
  } else {
    if (u.coins < o.mes) { delete orders[orderId]; return res.json({ success: false, msg: "Not enough MES" }); }
    u.coins = round(u.coins - o.mes);
    u.balance = round(u.balance + o.ksh);
  }
  delete orders[orderId]; // one-time use
  res.json({ success: true, msg: "Order complete", user: safe(u) });
});

// clean up expired orders every minute
setInterval(() => {
  const now = Date.now();
  for (const id in orders) if (orders[id].expires < now) delete orders[id];
}, 60000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Running on " + PORT));
