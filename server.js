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
#detail{background:#262626;padding:14px;border-radius:12px;margin-top:10px;border:1px solid #FFD700}
#note{color:#FFD700;min-height:20px}
.top{display:flex;justify-content:space-between;align-items:center}
#profBtn{width:42px;height:42px;padding:0;border-radius:50%;background:#FFD700;color:#000;font-size:18px;margin:0}
.tag{color:#aaa;font-size:13px}
</style></head><body><h1>🪙 MESCOIN</h1>

<div id="loginPage" class="card"><h2>Welcome</h2>
<input id="name" placeholder="Your Name"><input id="phone" placeholder="Phone e.g 0722000000"><input id="pin" type="password" inputmode="numeric" maxlength="4" placeholder="4-digit PIN e.g 1234">
<button class="yellow" onclick="signup()">CREATE ACCOUNT</button><button class="green" onclick="login()">LOGIN</button><p id="msg"></p></div>

<div id="appPage" class="card" style="display:none">
<div class="top"><h3>Hello <span id="uName"></span></h3><button id="profBtn" onclick="openProfile()">?</button></div>
<p>Balance: KSh <b id="bal">0</b> | Coins: <b id="coins">0</b> MES</p>
<p id="note"></p>

<div id="homeView">
<div class="row"><button class="yellow" onclick="openMarket('buy')">BUY</button><button class="green" onclick="openMarket('sell')">SELL</button></div>
<button class="grey" onclick="openMine()">MY ORDERS</button>
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

<div id="profileView" style="display:none">
<button class="grey" onclick="go('home')">← Back</button>
<h3 id="pName"></h3><p class="tag" id="pPhone"></p>
<p class="tag">To deposit: send M-Pesa to ${PAY_NUMBER}, then enter the amount and the M-Pesa code below. Your balance is credited after approval. Withdrawals are sent to your phone number after approval.</p>
<input id="wAmt" type="number" placeholder="Amount in KSh">
<input id="wRef" placeholder="M-Pesa code (deposit only)">
<input id="wPin" type="password" inputmode="numeric" maxlength="4" placeholder="Your PIN">
<div class="row"><button class="green" onclick="deposit()">DEPOSIT</button><button class="red" onclick="withdraw()">WITHDRAW</button></div>
<h3>My requests</h3><div id="wList"></div>
<div id="adminBox" style="display:none"><hr><h3>Pending requests (admin)</h3>
<button class="grey" onclick="loadAdmin()">LOAD PENDING (enter PIN above)</button><div id="adminList"></div></div>
</div>

<div id="mineView" style="display:none">
<button class="grey" onclick="go('home')">← Back</button>
<h3>My open orders</h3>
<input id="cPin" type="password" inputmode="numeric" maxlength="4" placeholder="Your PIN (to cancel an order)">
<div id="mineList"></div>
</div>
</div>

<script>
let myPhone="",mode="",cur=null,isAdmin=false;
function $(i){return document.getElementById(i)}
function el(tag,text,cls){let e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function note(t){$('note').innerText=t||'';}
async function post(url,body){let r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}
function go(v){['home','market','mine','profile'].forEach(x=>{$(x+'View').style.display=(x===v)?'block':'none';});$('wPin').value='';note('');}
function show(u){$('uName').innerText=u.name;$('profBtn').innerText=(u.name||'?').charAt(0).toUpperCase();$('bal').innerText=u.balance;$('coins').innerText=u.coins;}
function enter(u){myPhone=u.phone;isAdmin=!!u.isAdmin;$('loginPage').style.display='none';$('appPage').style.display='block';show(u);go('home');}

async function signup(){let d=await post('/api/signup',{name:$('name').value,phone:$('phone').value,pin:$('pin').value});$('msg').innerText=d.msg;if(d.success)enter(d.user);}
async function login(){let d=await post('/api/login',{phone:$('phone').value,pin:$('pin').value});$('msg').innerText=d.msg;if(d.success)enter(d.user);}
async function sendCoin(){let d=await post('/api/send',{fromPhone:myPhone,toPhone:$('toPhone').value,coins:parseFloat($('sendMes').value),pin:$('sendPin').value});note(d.msg);$('sendPin').value='';if(d.success)show(d.user);}

// ----- ORDER PAGE -----
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

// ----- PROFILE / WALLET -----
async function openProfile(){
  go('profile');
  $('pName').innerText=$('uName').innerText;$('pPhone').innerText=myPhone;
  $('wAmt').value='';$('wRef').value='';$('adminList').innerHTML='';
  $('adminBox').style.display=isAdmin?'block':'none';
  await loadWallet();
}
async function loadWallet(){
  let d=await post('/api/wallet/mine',{phone:myPhone});
  let box=$('wList');box.innerHTML='';
  if(!d.requests.length){box.appendChild(el('p','No requests yet.'));return;}
  d.requests.forEach(r=>{
    let c=el('div','','ord');
    c.appendChild(el('b',r.type.toUpperCase()+' KSh '+r.amount));
    c.appendChild(el('div',r.status,'tag'));
    box.appendChild(c);
  });
}
async function deposit(){
  let d=await post('/api/wallet/deposit',{phone:myPhone,amount:$('wAmt').value,ref:$('wRef').value,pin:$('wPin').value});
  note(d.msg);$('wPin').value='';
  if(d.success){$('wAmt').value='';$('wRef').value='';loadWallet();}
}
async function withdraw(){
  let d=await post('/api/wallet/withdraw',{phone:myPhone,amount:$('wAmt').value,pin:$('wPin').value});
  note(d.msg);$('wPin').value='';
  if(d.success){show(d.user);$('wAmt').value='';loadWallet();}
}
async function loadAdmin(){
  let d=await post('/api/wallet/pending',{phone:myPhone,pin:$('wPin').value});
  let box=$('adminList');box.innerHTML='';
  if(!d.success){note(d.msg);return;}
  if(!d.requests.length){box.appendChild(el('p','Nothing pending.'));return;}
  d.requests.forEach(r=>{
    let c=el('div','','ord');
    c.appendChild(el('b',r.type.toUpperCase()+' KSh '+r.amount));
    c.appendChild(el('div',r.name+' ('+r.phone+')'+(r.ref?' code: '+r.ref:'')));
    let row=el('div','','row');
    let a=el('button','APPROVE','green');a.onclick=()=>resolveReq(r.id,'approve');
    let x=el('button','REJECT','red');x.onclick=()=>resolveReq(r.id,'reject');
    row.appendChild(a);row.appendChild(x);c.appendChild(row);
    box.appendChild(c);
  });
}
async function resolveReq(id,action){
  let d=await post('/api/wallet/resolve',{phone:myPhone,pin:$('wPin').value,id:id,action:action});
  note(d.msg);
  if(d.success){show(d.user);loadAdmin();loadWallet();}
}

// ----- MY ORDERS -----
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
app.post('/api/market/pos
