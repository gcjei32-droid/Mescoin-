const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

const HOST_PHONE = '0768871831';
const BONUS_MES = 100000000;
let users = {}, orders = {}, trades = {}, sessions = {};

const round = n => Math.round(n * 100) / 100;
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(String(pin), salt, 32), Buffer.from(hash, 'hex'));
}
const safe = u => ({ name: u.name, phone: u.phone, coins: round(u.coins), isHost: u.phone === HOST_PHONE });
function giveBonus(u) {
  if (u.phone === HOST_PHONE && !u.bonusGiven) {
    u.coins = round(u.coins + BONUS_MES);
    u.bonusGiven = true;
  }
}
const mask = p => p.slice(0, 4) + '***' + p.slice(-3);

// ---------- PIN lockout + sessions ----------
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
function newSession(phone) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { phone, exp: Date.now() + 12 * 3600 * 1000 };
  return token;
}
function sessionUser(req, res) {
  const s = sessions[String(req.body.token || '')];
  if (s && Date.now() > s.exp) delete sessions[req.body.token];
  const u = s && Date.now() <= s.exp && users[s.phone];
  if (!u) { res.json({ success: false, auth: true, msg: "Session expired. Please login again." }); return null; }
  return u;
}
function pinUser(req, res) {
  const u = sessionUser(req, res);
  if (!u) return null;
  if (locked(u.phone)) { res.json({ success: false, msg: "Too many wrong PINs. Try again in 5 minutes" }); return null; }
  if (!checkPin(String(req.body.pin || ''), u.pin)) { fail(u.phone); res.json({ success: false, msg: "Wrong PIN" }); return null; }
  delete attempts[u.phone];
  return u;
}

// ---------- trade helpers ----------
const OPEN = ['active', 'paid', 'disputed'];
const isHost = u => u.phone === HOST_PHONE;
const isParty = (t, u) => u.phone === t.seller || u.phone === t.buyer;
const canSee = (t, u) => isParty(t, u) || (isHost(u) && !!t.report);
function addMsg(t, from, text) {
  const name = from === 'system' ? 'System' : (from === HOST_PHONE ? 'Host' : users[from].name);
  t.messages.push({ from, name, text, time: Date.now() });
  if (t.messages.length > 300) t.messages.shift();
}
function tradeView(t, me) {
  return {
    id: t.id, status: t.status, mes: t.mes, price: t.price, ksh: t.ksh,
    open: OPEN.includes(t.status),
    role: me.phone === t.seller ? 'seller' : me.phone === t.buyer ? 'buyer' : 'host',
    seller: { name: users[t.seller].name, phone: t.seller },
    buyer: { name: users[t.buyer].name, phone: t.buyer },
    report: t.report ? { by: users[t.report.by].name, reason: t.report.reason } : null,
    messages: t.messages.map(m => ({ mine: m.from === me.phone, system: m.from === 'system', name: m.name, text: m.text }))
  };
}
function tradeSummary(t, me) {
  const role = me.phone === t.seller ? 'seller' : me.phone === t.buyer ? 'buyer' : 'host';
  return {
    id: t.id, status: t.status, mes: t.mes, ksh: t.ksh, role,
    seller: users[t.seller].name, buyer: users[t.buyer].name,
    reason: t.report ? t.report.reason : ''
  };
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
.box{background:#262626;padding:12px;border-radius:12px;margin:8px 0;border:1px solid #333}
#detail{background:#262626;padding:14px;border-radius:12px;margin-top:10px;border:1px solid #FFD700}
#note{color:#FFD700;min-height:20px}
#chat{background:#111;height:240px;overflow-y:auto;padding:8px;border-radius:10px;margin:8px 0}
.msg{margin:6px 0;padding:8px 10px;border-radius:10px;max-width:80%;background:#333;word-wrap:break-word}
.msg small{display:block;color:#aaa;font-size:11px}
.msg.mine{background:#FFD700;color:#000;margin-left:auto}
.msg.mine small{color:#555}
.msg.sys{background:none;color:#aaa;text-align:center;max-width:100%;font-size:13px}
</style></head><body><h1>🪙 MESCOIN</h1>
<div id="loginPage" class="card"><h2>Welcome</h2>
<input id="name" placeholder="Your Name"><input id="phone" placeholder="Phone e.g 0722000000"><input id="pin" type="password" inputmode="numeric" maxlength="4" placeholder="4-digit PIN e.g 1234">
<button class="yellow" onclick="signup()">CREATE ACCOUNT</button><button class="green" onclick="login()">LOGIN</button><p id="msg"></p></div>
<div id="appPage" class="card" style="display:none">
<h3>Hello <span id="uName"></span></h3>
<p>Coins: <b id="coins">0</b> MES</p>
<p id="note"></p>
<div id="homeView">
<div class="row"><button class="yellow" onclick="openMarket('buy')">BUY</button><button class="green" onclick="openMarket('sell')">SELL</button></div>
<button class="grey" onclick="openMine()">MY ORDERS &amp; TRADES</button>
<button id="hostBtn" class="red" style="display:none" onclick="openHost()">🛡️ HOST: DISPUTES</button>
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
<div class="row"><button class="yellow" onclick="acceptOrder()">START TRADE</button><button class="grey" onclick="closeDetail()">CANCEL</button></div>
</div>
<hr><h3 id="postTitle"></h3>
<input id="pMes" type="number" placeholder="Amount of MES">
<input id="pPrice" type="number" placeholder="Price per 1 MES in KSh">
<input id="pPin" type="password" inputmode="numeric" maxlength="4" placeholder="Your PIN">
<button class="yellow" onclick="postOrder()">POST ORDER</button>
</div>
<div id="mineView" style="display:none">
<button class="grey" onclick="go('home')">← Back</button>
<h3>My trades</h3>
<div id="tradeList"></div>
<h3>My open orders</h3>
<input id="cPin" type="password" inputmode="numeric" maxlength="4" placeholder="Your PIN (to cancel an order)">
<div id="mineList"></div>
</div>
<div id="tradeView" style="display:none">
<button class="grey" onclick="tradeBack()">← Back</button>
<h3 id="tTitle"></h3>
<div id="tInfo" class="box"></div>
<p id="tStatus" style="color:#FFD700"></p>
<p id="tHelp"></p>
<div id="chat"></div>
<div id="chatRow" class="row"><input id="chatInput" maxlength="300" placeholder="Type a message..."><button class="yellow" style="width:90px" onclick="sendChat()">SEND</button></div>
<input id="tPin" type="password" inputmode="numeric" maxlength="4" placeholder="Your PIN" style="display:none">
<div id="tActions"></div>
</div>
<div id="hostView" style="display:none">
<button class="grey" onclick="go('home')">← Back</button>
<h3>Reported trades</h3>
<div id="hostList"></div>
</div>
</div>
<script>
let token="",me=null,mode="",cur=null,curTrade=null,timer=null,lastCount=-1,lastKey="",lastRole="";
const STATUS={active:'⏳ Waiting for buyer to pay',paid:'💬 Buyer says PAID - seller must check M-Pesa and release',disputed:'⚠️ Reported - host is reviewing',completed:'✅ Completed',cancelled:'Cancelled',resolved_release:'✅ Host released MES to buyer',resolved_refund:'↩️ Host refunded MES to seller'};
function $(i){return document.getElementById(i)}
function el(tag,text,cls){let e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function btn(text,cls,fn){let b=el('button',text,cls);b.onclick=fn;return b;}
function note(t){$('note').innerText=t||'';}
async function post(url,body){body.token=token;let r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});let d=await r.json();if(d.auth){alert(d.msg);location.reload();}return d;}
function stopPoll(){if(timer){clearInterval(timer);timer=null;}}
function go(v){stopPoll();if(v!=='trade')curTrade=null;['home','market','mine','trade','host'].forEach(x=>{$(x+'View').style.display=(x===v)?'block':'none';});note('');}
function show(u){me=u;$('uName').innerText=u.name;$('coins').innerText=u.coins;$('hostBtn').style.display=u.isHost?'block':'none';}
function enter(d){token=d.token;$('loginPage').style.display='none';$('appPage').style.display='block';show(d.user);go('home');}
async function signup(){let d=await post('/api/signup',{name:$('name').value,phone:$('phone').value,pin:$('pin').value});$('msg').innerText=d.msg;if(d.success)enter(d);}
async function login(){let d=await post('/api/login',{phone:$('phone').value,pin:$('pin').value});$('msg').innerText=d.msg;if(d.success)enter(d);}
async function sendCoin(){let d=await post('/api/send',{toPhone:$('toPhone').value,coins:parseFloat($('sendMes').value),pin:$('sendPin').value});note(d.msg);$('sendPin').value='';if(d.success)show(d.user);}

async function openMarket(m){
  mode=m;
  $('mTitle').innerText=(m==='buy')?'Buy MES - pick a seller':'Sell MES - pick a buyer';
  $('postTitle').innerText=(m==='buy')?'Or post your own BUY order':'Or post your own SELL order';
  closeDetail();go('market');await loadMarket();
}
async function loadMarket(){
  let d=await post('/api/market/list',{type:(mode==='buy')?'sell':'buy'});
  let box=$('list');box.innerHTML='';
  if(!d.orders||!d.orders.length){box.appendChild(el('p','No orders yet. Post one below.'));return;}
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
    ?'Buy '+o.mes+' MES from '+o.ownerName+' for KSh '+o.ksh+'. A chat will open. You pay the seller by M-Pesa, then tap I HAVE PAID. Enter your PIN to start.'
    :'Sell '+o.mes+' MES to '+o.ownerName+' for KSh '+o.ksh+'. Your '+o.mes+' MES will be locked until the buyer pays and you release it. Enter your PIN to start.';
  $('acceptPin').value='';$('detail').style.display='block';
}
function closeDetail(){cur=null;$('acceptPin').value='';$('detail').style.display='none';}
async function acceptOrder(){
  if(!cur)return;
  let d=await post('/api/market/accept',{orderId:cur.id,pin:$('acceptPin').value});
  note(d.msg);$('acceptPin').value='';
  if(d.success){show(d.user);closeDetail();openTrade(d.tradeId);return;}
  if(d.refresh){closeDetail();loadMarket();}
}
async function postOrder(){
  let d=await post('/api/market/post',{type:mode,mes:$('pMes').value,price:$('pPrice').value,pin:$('pPin').value});
  note(d.msg);$('pPin').value='';
  if(d.success){show(d.user);$('pMes').value='';$('pPrice').value='';}
}

async function openMine(){go('mine');$('cPin').value='';await loadMine();}
async function loadMine(){
  let t=await post('/api/trade/mine',{});
  let tb=$('tradeList');tb.innerHTML='';
  if(!t.trades||!t.trades.length){tb.appendChild(el('p','No trades yet.'));}
  else t.trades.forEach(x=>{
    let c=el('div','','ord');
    c.appendChild(el('b',(x.role==='seller'?'Selling ':'Buying ')+x.mes+' MES'));
    c.appendChild(el('div','KSh '+x.ksh+' - '+(x.role==='seller'?'buyer: '+x.buyer:'seller: '+x.seller)));
    c.appendChild(el('small',STATUS[x.status]||x.status));
    c.onclick=()=>openTrade(x.id);
    tb.appendChild(c);
  });
  let d=await post('/api/market/mine',{});
  let box=$('mineList');box.innerHTML='';
  if(!d.orders||!d.orders.length){box.appendChild(el('p','You have no open orders.'));return;}
  d.orders.forEach(o=>{
    let c=el('div','','box');
    c.appendChild(el('b',(o.type==='sell'?'SELL ':'BUY ')+o.mes+' MES'));
    c.appendChild(el('div','@ KSh '+o.price+' each = KSh '+o.ksh));
    c.appendChild(btn('CANCEL ORDER','red',()=>cancelOrder(o.id)));
    box.appendChild(c);
  });
}
async function cancelOrder(id){
  let d=await post('/api/market/cancel',{orderId:id,pin:$('cPin').value});
  note(d.msg);$('cPin').value='';
  if(d.success){show(d.user);}
  if(d.success||d.refresh)loadMine();
}

async function openHost(){
  go('host');
  let d=await post('/api/trade/mine',{});
  let box=$('hostList');box.innerHTML='';
  if(!d.disputes||!d.disputes.length){box.appendChild(el('p','No reported trades.'));return;}
  d.disputes.forEach(x=>{
    let c=el('div','','ord');
    c.appendChild(el('b',x.mes+' MES / KSh '+x.ksh));
    c.appendChild(el('div','Seller: '+x.seller+' | Buyer: '+x.buyer));
    c.appendChild(el('small','Report: '+x.reason));
    c.onclick=()=>openTrade(x.id);
    box.appendChild(c);
  });
}

async function openTrade(id){
  curTrade=id;lastCount=-1;lastKey="";
  go('trade');
  $('chat').innerHTML='';$('tPin').value='';
  await refreshTrade();
  timer=setInterval(refreshTrade,3000);
}
function tradeBack(){if(me&&me.isHost&&lastRole==='host')openHost();else openMine();}
async function refreshTrade(){
  if(!curTrade)return;
  let d=await post('/api/trade/get',{tradeId:curTrade});
  if(!d.success){note(d.msg);stopPoll();return;}
  renderTrade(d.trade);
}
function renderTrade(t){
  lastRole=t.role;
  $('tTitle').innerText=t.mes+' MES for KSh '+t.ksh;
  let info=$('tInfo');info.innerHTML='';
  info.appendChild(el('div','Seller: '+t.seller.name+' ('+t.seller.phone+')'));
  info.appendChild(el('div','Buyer: '+t.buyer.name+' ('+t.buyer.phone+')'));
  info.appendChild(el('div','Price: KSh '+t.price+' per MES'));
  info.appendChild(el('div','You are: '+t.role.toUpperCase()));
  if(t.report)info.appendChild(el('div','🚨 Report by '+t.report.by+': '+t.report.reason));
  $('tStatus').innerText=STATUS[t.status]||t.status;
  let help='';
  if(t.open&&t.role==='buyer')help='Pay KSh '+t.ksh+' to the seller by M-Pesa ('+t.seller.phone+' or the number they give you in chat), then tap I HAVE PAID.';
  if(t.open&&t.role==='seller')help='Your MES is locked. Release it ONLY after you see the M-Pesa payment of KSh '+t.ksh+'.';
  if(t.open&&t.role==='host')help='Read the chat, then release the MES to the buyer or refund it to the seller.';
  $('tHelp').innerText=help;
  if(t.messages.length!==lastCount){
    lastCount=t.messages.length;
    let ch=$('chat');ch.innerHTML='';
    t.messages.forEach(m=>{
      let b=el('div','','msg'+(m.system?' sys':(m.mine?' mine':'')));
      if(!m.system)b.appendChild(el('small',m.mine?'You':m.name));
      b.appendChild(el('span',m.text));
      ch.appendChild(b);
    });
    ch.scrollTop=ch.scrollHeight;
  }
  $('chatRow').style.display=t.open?'flex':'none';
  let key=t.status+t.role;
  if(key!==lastKey){lastKey=key;buildActions(t);}
}
function buildActions(t){
  let box=$('tActions');box.innerHTML='';let needPin=false;
  if(t.role==='buyer'&&t.status==='active'){
    box.appendChild(btn('✅ I HAVE PAID','green',()=>tradeDo('/api/trade/paid',{})));
    box.appendChild(btn('CANCEL TRADE','grey',()=>{if(confirm('Cancel this trade?'))tradeDo('/api/trade/cancel',{});}));
  }
  if(t.role==='seller'&&(t.status==='active'||t.status==='paid')){
    needPin=true;
    box.appendChild(btn('🔓 RELEASE '+t.mes+' MES TO BUYER','yellow',()=>{if(confirm('Release '+t.mes+' MES? Only do this after you received KSh '+t.ksh+'.'))tradeDo('/api/trade/release',{pin:$('tPin').value});}));
  }
  if((t.role==='buyer'||t.role==='seller')&&(t.status==='active'||t.status==='paid')){
    box.appendChild(btn('🚨 REPORT PROBLEM / CHEATING','red',reportTrade));
  }
  if(t.role==='host'&&t.status==='disputed'){
    needPin=true;
    box.appendChild(btn('RELEASE MES TO BUYER','green',()=>{if(confirm('Release MES to the buyer?'))tradeDo('/api/trade/resolve',{action:'release',pin:$('tPin').value});}));
    box.appendChild(btn('REFUND MES TO SELLER','yellow',()=>{if(confirm('Refund MES to the seller?'))tradeDo('/api/trade/resolve',{action:'refund',pin:$('tPin').value});}));
  }
  $('tPin').style.display=needPin?'block':'none';
}
async function tradeDo(path,extra){
  extra.tradeId=curTrade;
  let d=await post(path,extra);
  note(d.msg);$('tPin').value='';
  if(d.user)show(d.user);
  lastKey="";await refreshTrade();
}
function reportTrade(){
  let r=prompt('What happened? (e.g. I paid but seller did not release / buyer says paid but I got nothing)');
  if(!r||r.trim().length<3)return;
  tradeDo('/api/trade/report',{reason:r.trim()});
}
async function sendChat(){
  let t=$('chatInput').value.trim();if(!t)return;
  $('chatInput').value='';
  let d=await post('/api/trade/chat',{tradeId:curTrade,text:t});
  if(!d.success)note(d.msg);
  refreshTrade();
}
</script></body></html>`;
  app.get('/', (req, res) => res.send(HTML));

// ---------- accounts ----------
app.post('/api/signup', (req, res) => {
  let { name, phone, pin } = req.body;
  name = String(name || '').trim(); phone = String(phone || '').trim(); pin = String(pin || '');
  if (name.length < 2 || name.length > 40) return res.json({ success: false, msg: "Enter a valid name" });
  if (!/^\d{9,13}$/.test(phone)) return res.json({ success: false, msg: "Enter a valid phone number" });
  if (!/^\d{4}$/.test(pin)) return res.json({ success: false, msg: "PIN must be 4 digits" });
  if (users[phone]) return res.json({ success: false, msg: "Account already exists. Please LOGIN" });
  users[phone] = { name, phone, pin: hashPin(pin), coins: 0 };
  giveBonus(users[phone]);
  res.json({ success: true, msg: phone === HOST_PHONE ? "Account Created! Bonus added" : "Account Created!", user: safe(users[phone]), token: newSession(phone) });
});

app.post('/api/login', (req, res) => {
  const phone = String(req.body.phone || '').trim();
  if (!users[phone]) return res.json({ success: false, msg: "No account. Please CREATE ACCOUNT first" });
  const u = authUser(res, phone, req.body.pin);
  if (!u) return;
  giveBonus(u);
  res.json({ success: true, msg: "Welcome " + u.name, user: safe(u), token: newSession(phone) });
});

app.post('/api/send', (req, res) => {
  const toPhone = String(req.body.toPhone || '').trim();
  const coins = Number(req.body.coins);
  if (!(coins > 0) || !isFinite(coins)) return res.json({ success: false, msg: "Invalid amount" });
  const from = pinUser(req, res);
  if (!from) return;
  if (from.phone === toPhone) return res.json({ success: false, msg: "You can't send to yourself" });
  if (!users[toPhone]) return res.json({ success: false, msg: "❌ " + toPhone + " has NO account. Tell them to create account." });
  if (from.coins < coins) return res.json({ success: false, msg: "Not enough MES" });
  from.coins = round(from.coins - coins);
  users[toPhone].coins = round(users[toPhone].coins + coins);
  res.json({ success: true, msg: "Sent " + coins + " MES to " + users[toPhone].name, user: safe(from) });
});

// ---------- market ----------
app.post('/api/market/post', (req, res) => {
  const { type } = req.body;
  const mes = round(Number(req.body.mes)), price = round(Number(req.body.price));
  if (!['buy', 'sell'].includes(type)) return res.json({ success: false, msg: "Invalid order type" });
  if (!(mes > 0) || !(price > 0) || mes > 1e9 || price > 1e6) return res.json({ success: false, msg: "Enter a valid amount and price" });
  const ksh = round(mes * price);
  if (!(ksh > 0)) return res.json({ success: false, msg: "Order too small" });
  const u = pinUser(req, res);
  if (!u) return;
  if (type === 'sell') {
    if (u.coins < mes) return res.json({ success: false, msg: "Not enough MES" });
    u.coins = round(u.coins - mes);
  }
  const id = crypto.randomBytes(8).toString('hex');
  orders[id] = { id, owner: u.phone, type, mes, price, ksh, status: 'open', created: Date.now() };
  res.json({
    success: true,
    msg: type === 'sell'
      ? "Order posted. Your " + mes + " MES is locked until someone accepts or you cancel."
      : "Buy order posted. When a seller accepts, a chat will open and you pay them by M-Pesa.",
    user: safe(u)
  });
});

app.post('/api/market/list', (req, res) => {
  const u = sessionUser(req, res);
  if (!u) return;
  const type = req.body.type;
  if (!['buy', 'sell'].includes(type)) return res.json({ orders: [] });
  const list = Object.values(orders)
    .filter(o => o.status === 'open' && o.type === type && o.owner !== u.phone)
    .sort((a, b) => b.created - a.created).slice(0, 50)
    .map(o => ({ id: o.id, ownerName: users[o.owner].name, ownerPhone: mask(o.owner), type: o.type, mes: o.mes, price: o.price, ksh: o.ksh }));
  res.json({ orders: list });
});

app.post('/api/market/accept', (req, res) => {
  const o = orders[req.body.orderId];
  if (!o || o.status !== 'open') return res.json({ success: false, refresh: true, msg: "Order no longer available" });
  const taker = pinUser(req, res);
  if (!taker) return;
  if (o.status !== 'open') return res.json({ success: false, refresh: true, msg: "Order no longer available" });
  if (o.owner === taker.phone) return res.json({ success: false, msg: "You can't accept your own order" });
  const owner = users[o.owner];
  let seller, buyer;
  if (o.type === 'sell') {
    seller = owner; buyer = taker;               // seller's MES already locked in the order
  } else {
    seller = taker; buyer = owner;
    if (taker.coins < o.mes) return res.json({ success: false, msg: "Not enough MES" });
    taker.coins = round(taker.coins - o.mes);    // lock seller's MES now
  }
  o.status = 'in_trade';
  const id = crypto.randomBytes(8).toString('hex');
  const t = { id, orderId: o.id, seller: seller.phone, buyer: buyer.phone, mes: o.mes, price: o.price, ksh: o.ksh, status: 'active', messages: [], created: Date.now() };
  trades[id] = t;
  addMsg(t, 'system', "Trade started. " + o.mes + " MES is locked in escrow. Buyer: pay KSh " + o.ksh + " to the seller by M-Pesa, then tap I HAVE PAID. Seller: release only after you receive the money.");
  res.json({ success: true, msg: "Trade started", tradeId: id, user: safe(taker) });
});

app.post('/api/market/mine', (req, res) => {
  const u = sessionUser(req, res);
  if (!u) return;
  const list = Object.values(orders)
    .filter(o => o.status === 'open' && o.owner === u.phone)
    .sort((a, b) => b.created - a.created)
    .map(o => ({ id: o.id, type: o.type, mes: o.mes, price: o.price, ksh: o.ksh }));
  res.json({ orders: list });
});

app.post('/api/market/cancel', (req, res) => {
  const o = orders[req.body.orderId];
  const u = pinUser(req, res);
  if (!u) return;
  if (!o || o.status !== 'open' || o.owner !== u.phone) return res.json({ success: false, refresh: true, msg: "Order not found" });
  if (o.type === 'sell') u.coins = round(u.coins + o.mes);
  o.status = 'cancelled';
  res.json({ success: true, msg: "Order cancelled." + (o.type === 'sell' ? " MES returned." : ""), user: safe(u) });
});

// ---------- trades ----------
app.post('/api/trade/mine', (req, res) => {
  const u = sessionUser(req, res);
  if (!u) return;
  const mine = Object.values(trades)
    .filter(t => isParty(t, u))
    .sort((a, b) => b.created - a.created).slice(0, 30)
    .map(t => tradeSummary(t, u));
  const disputes = isHost(u)
    ? Object.values(trades).filter(t => t.status === 'disputed').sort((a, b) => b.created - a.created).map(t => tradeSummary(t, u))
    : [];
  res.json({ trades: mine, disputes });
});

app.post('/api/trade/get', (req, res) => {
  const u = sessionUser(req, res);
  if (!u) return;
  const t = trades[req.body.tradeId];
  if (!t || !canSee(t, u)) return res.json({ success: false, msg: "Trade not found" });
  res.json({ success: true, trade: tradeView(t, u) });
});

app.post('/api/trade/chat', (req, res) => {
  const u = sessionUser(req, res);
  if (!u) return;
  const t = trades[req.body.tradeId];
  if (!t || !canSee(t, u)) return res.json({ success: false, msg: "Trade not found" });
  if (!OPEN.includes(t.status)) return res.json({ success: false, msg: "Trade is closed" });
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.json({ success: false, msg: "Empty message" });
  addMsg(t, u.phone, text);
  res.json({ success: true });
});

app.post('/api/trade/paid', (req, res) => {
  const u = sessionUser(req, res);
  if (!u) return;
  const t = trades[req.body.tradeId];
  if (!t || u.phone !== t.buyer) return res.json({ success: false, msg: "Only the buyer can do this" });
  if (t.status !== 'active') return res.json({ success: false, msg: "Not available now" });
  t.status = 'paid';
  addMsg(t, 'system', users[t.buyer].name + " says they paid KSh " + t.ksh + ". Seller: check your M-Pesa, then release the MES with your PIN.");
  res.json({ success: true, msg: "Marked as paid. Wait for the seller to release." });
});

app.post('/api/trade/release', (req, res) => {
  const t = trades[req.body.tradeId];
  if (!t) return res.json({ success: false, msg: "Trade not found" });
  const u = pinUser(req, res);
  if (!u) return;
  if (u.phone !== t.seller) return res.json({ success: false, msg: "Only the seller can release MES" });
  if (!['active', 'paid'].includes(t.status)) return res.json({ success: false, msg: "Trade is not open" });
  const buyer = users[t.buyer];
  buyer.coins = round(buyer.coins + t.mes);
  t.status = 'completed';
  orders[t.orderId].status = 'done';
  addMsg(t, 'system', "✅ Seller released " + t.mes + " MES to the buyer. Trade complete.");
  res.json({ success: true, msg: "Released " + t.mes + " MES to " + buyer.name, user: safe(u) });
});

app.post('/api/trade/cancel', (req, res) => {
  const u = sessionUser(req, res);
  if (!u) return;
  const t = trades[req.body.tradeId];
  if (!t || u.phone !== t.buyer) return res.json({ success: false, msg: "Only the buyer can cancel" });
  if (t.status !== 'active') return res.json({ success: false, msg: "Can't cancel now. Use REPORT if there is a problem." });
  const seller = users[t.seller];
  seller.coins = round(seller.coins + t.mes);
  t.status = 'cancelled';
  orders[t.orderId].status = 'cancelled';
  addMsg(t, 'system', "Buyer cancelled the trade. MES returned to the seller.");
  res.json({ success: true, msg: "Trade cancelled" });
});

app.post('/api/trade/report', (req, res) => {
  const u = sessionUser(req, res);
  if (!u) return;
  const t = trades[req.body.tradeId];
  if (!t || !isParty(t, u)) return res.json({ success: false, msg: "Trade not found" });
  if (!['active', 'paid'].includes(t.status)) return res.json({ success: false, msg: "Can't report this trade now" });
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (reason.length < 3) return res.json({ success: false, msg: "Please explain what happened" });
  t.status = 'disputed';
  t.report = { by: u.phone, reason, time: Date.now() };
  addMsg(t, 'system', "🚨 " + u.name + " reported a problem: \"" + reason + "\". The host (" + HOST_PHONE + ") will review this chat and decide. MES stays locked until then.");
  res.json({ success: true, msg: "Reported to the host. They will review and help." });
});

app.post('/api/trade/resolve', (req, res) => {
  const t = trades[req.body.tradeId];
  if (!t) return res.json({ success: false, msg: "Trade not found" });
  const u = pinUser(req, res);
  if (!u) return;
  if (!isHost(u)) return res.json({ success: false, msg: "Only the host can resolve disputes" });
  if (isParty(t, u)) return res.json({ success: false, msg: "You are part of this trade, so you can't resolve it" });
  if (t.status !== 'disputed') return res.json({ success: false, msg: "Not a reported trade" });
  if (req.body.action === 'release') {
    users[t.buyer].coins = round(users[t.buyer].coins + t.mes);
    t.status = 'resolved_release';
    addMsg(t, 'system', "✅ Host released " + t.mes + " MES to the buyer.");
  } else if (req.body.action === 'refund') {
    users[t.seller].coins = round(users[t.seller].coins + t.mes);
    t.status = 'resolved_refund';
    addMsg(t, 'system', "↩️ Host refunded " + t.mes + " MES to the seller.");
  } else {
    return res.json({ success: false, msg: "Invalid action" });
  }
  orders[t.orderId].status = 'done';
  res.json({ success: true, msg: "Dispute resolved", user: safe(u) });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Running on " + PORT));
