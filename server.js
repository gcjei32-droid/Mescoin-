const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const HOST_PHONE = String(process.env.HOST_PHONE || '').trim();
const BONUS_MES = 100000000;
if (!HOST_PHONE) console.warn('HOST_PHONE is not set: there will be no host account');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is missing'); process.exit(1); }

const dbUrl = process.env.DATABASE_URL;
let dbHost = '';
try { dbHost = new URL(dbUrl).hostname; } catch (e) { console.error('DATABASE_URL is not a valid URL'); process.exit(1); }
console.log('Connecting to DB host:', dbHost);
const pool = new Pool({
  connectionString: dbUrl,
  connectionTimeoutMillis: 10000,
  // Render's internal host has no dots, so it needs no SSL. Any other host does.
  ssl: dbHost.includes('.') ? { rejectUnauthorized: false } : false
});
pool.on('error', e => console.error('pool error', e.message));

const n = Number;
const round = x => Math.round(x * 100) / 100;
const q = (sql, p) => pool.query(sql, p);
const isHost = u => !!HOST_PHONE && u.phone === HOST_PHONE;
const safe = u => ({ name: u.name, phone: u.phone, coins: round(n(u.coins)), isHost: isHost(u) });
const mask = p => p.slice(0, 4) + '***' + p.slice(-3);

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY, name TEXT NOT NULL, pin TEXT NOT NULL,
      coins NUMERIC(24,2) NOT NULL DEFAULT 0 CHECK (coins >= 0),
      bonus_given BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, phone TEXT NOT NULL, exp BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, owner_phone TEXT NOT NULL, type TEXT NOT NULL,
      mes NUMERIC(24,2) NOT NULL, price NUMERIC(24,2) NOT NULL, ksh NUMERIC(24,2) NOT NULL,
      status TEXT NOT NULL, created BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY, order_id TEXT NOT NULL, seller TEXT NOT NULL, buyer TEXT NOT NULL,
      mes NUMERIC(24,2) NOT NULL, price NUMERIC(24,2) NOT NULL, ksh NUMERIC(24,2) NOT NULL,
      status TEXT NOT NULL, report_by TEXT, report_reason TEXT, created BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY, trade_id TEXT NOT NULL, sender TEXT NOT NULL,
      name TEXT NOT NULL, body TEXT NOT NULL, created BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_trade ON messages(trade_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, type);
  `);
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { c.release(); }
}
async function lockUsers(c, phones) {
  const r = await c.query('SELECT * FROM users WHERE phone = ANY($1) ORDER BY phone FOR UPDATE', [[...new Set(phones)]]);
  const m = {};
  r.rows.forEach(x => { m[x.phone] = x; });
  return m;
}
async function addMsg(c, tid, from, text) {
  let name = 'System';
  if (from !== 'system') {
    if (HOST_PHONE && from === HOST_PHONE) name = 'Host';
    else {
      const r = await c.query('SELECT name FROM users WHERE phone=$1', [from]);
      name = r.rows[0] ? r.rows[0].name : from;
    }
  }
  await c.query('INSERT INTO messages(trade_id,sender,name,body,created) VALUES($1,$2,$3,$4,$5)', [tid, from, name, text, Date.now()]);
}

// ---------- PIN hashing ----------
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(crypto.scryptSync(String(pin), salt, 32), Buffer.from(hash, 'hex'));
}

// ---------- PIN lockout + sessions ----------
const attempts = {};
const locked = p => attempts[p] && attempts[p].until && Date.now() < attempts[p].until;
function fail(p) {
  const a = attempts[p] || (attempts[p] = { n: 0, until: 0 });
  a.n++;
  if (a.n >= 5) { a.until = Date.now() + 300000; a.n = 0; }
}
async function authUser(res, phone, pin) {
  const r = await q('SELECT * FROM users WHERE phone=$1', [phone]);
  const u = r.rows[0];
  if (!u) { res.json({ success: false, msg: "No account" }); return null; }
  if (locked(phone)) { res.json({ success: false, msg: "Too many wrong PINs. Try again in 5 minutes" }); return null; }
  if (!checkPin(String(pin || ''), u.pin)) { fail(phone); res.json({ success: false, msg: "Wrong PIN" }); return null; }
  delete attempts[phone];
  return u;
}
async function newSession(phone) {
  const token = crypto.randomBytes(24).toString('hex');
  await q('INSERT INTO sessions(token,phone,exp) VALUES($1,$2,$3)', [token, phone, Date.now() + 12 * 3600 * 1000]);
  q('DELETE FROM sessions WHERE exp < $1', [Date.now()]).catch(() => {});
  return token;
}
async function sessionUser(req, res) {
  const r = await q('SELECT u.* FROM sessions s JOIN users u ON u.phone=s.phone WHERE s.token=$1 AND s.exp>$2',
    [String(req.body.token || ''), Date.now()]);
  if (!r.rows[0]) { res.json({ success: false, auth: true, msg: "Session expired. Please login again." }); return null; }
  return r.rows[0];
}
async function pinUser(req, res) {
  const u = await sessionUser(req, res);
  if (!u) return null;
  if (locked(u.phone)) { res.json({ success: false, msg: "Too many wrong PINs. Try again in 5 minutes" }); return null; }
  if (!checkPin(String(req.body.pin || ''), u.pin)) { fail(u.phone); res.json({ success: false, msg: "Wrong PIN" }); return null; }
  delete attempts[u.phone];
  return u;
}

const route = (p, fn) => app.post(p, (req, res) => {
  fn(req, res).catch(e => {
    console.error(p, e);
    if (!res.headersSent) res.json({ success: false, msg: "Server error. Try again." });
  });
});

// ---------- trade helpers ----------
const OPEN = ['active', 'paid', 'disputed'];
const isParty = (t, u) => u.phone === t.seller || u.phone === t.buyer;
const canSee = (t, u) => isParty(t, u) || (isHost(u) && !!t.report_reason);
const roleOf = (t, u) => u.phone === t.seller ? 'seller' : u.phone === t.buyer ? 'buyer' : 'host';
async function loadTrade(id) {
  const r = await q(`SELECT t.*, s.name AS seller_name, b.name AS buyer_name FROM trades t
    JOIN users s ON s.phone=t.seller JOIN users b ON b.phone=t.buyer WHERE t.id=$1`, [String(id || '')]);
  return r.rows[0];
}
function tradeSummary(t, me) {
  return {
    id: t.id, status: t.status, mes: n(t.mes), ksh: n(t.ksh), role: roleOf(t, me),
    seller: t.seller_name, buyer: t.buyer_name, reason: t.report_reason || ''
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
  renderTrade(d.trade);}
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
</script></body></html>
`;
app.get('/', (req, res) => res.send(HTML));

// ---------- accounts ----------
route('/api/signup', async (req, res) => {
  let { name, phone, pin } = req.body;
  name = String(name || '').trim(); phone = String(phone || '').trim(); pin = String(pin || '');
  if (name.length < 2 || name.length > 40) return res.json({ success: false, msg: "Enter a valid name" });
  if (!/^\d{9,13}$/.test(phone)) return res.json({ success: false, msg: "Enter a valid phone number" });
  if (!/^\d{4}$/.test(pin)) return res.json({ success: false, msg: "PIN must be 4 digits" });
  const host = !!HOST_PHONE && phone === HOST_PHONE;
  const r = await q(`INSERT INTO users(phone,name,pin,coins,bonus_given) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (phone) DO NOTHING RETURNING *`, [phone, name, hashPin(pin), host ? BONUS_MES : 0, host]);
  if (!r.rows[0]) return res.json({ success: false, msg: "Account already exists. Please LOGIN" });
  res.json({ success: true, msg: host ? "Account Created! Bonus added" : "Account Created!", user: safe(r.rows[0]), token: await newSession(phone) });
});

route('/api/login', async (req, res) => {
  const phone = String(req.body.phone || '').trim();
  const ex = await q('SELECT 1 FROM users WHERE phone=$1', [phone]);
  if (!ex.rows[0]) return res.json({ success: false, msg: "No account. Please CREATE ACCOUNT first" });
  let u = await authUser(res, phone, req.body.pin);
  if (!u) return;
  if (HOST_PHONE && phone === HOST_PHONE) {
    const b = await q('UPDATE users SET coins=coins+$1, bonus_given=true WHERE phone=$2 AND bonus_given=false RETURNING *', [BONUS_MES, phone]);
    if (b.rows[0]) u = b.rows[0];
  }
  res.json({ success: true, msg: "Welcome " + u.name, user: safe(u), token: await newSession(phone) });
});

route('/api/send', async (req, res) => {
  const toPhone = String(req.body.toPhone || '').trim();
  const coins = round(Number(req.body.coins));
  if (!(coins > 0) || !isFinite(coins) || coins > 1e12) return res.json({ success: false, msg: "Invalid amount" });
  const from = await pinUser(req, res);
  if (!from) return;
  if (from.phone === toPhone) return res.json({ success: false, msg: "You can't send to yourself" });
  const out = await tx(async c => {
    const m = await lockUsers(c, [from.phone, toPhone]);
    const to = m[toPhone], f = m[from.phone];
    if (!to) return { success: false, msg: "❌ " + toPhone + " has NO account. Tell them to create account." };
    if (n(f.coins) < coins) return { success: false, msg: "Not enough MES" };
    const r = await c.query('UPDATE users SET coins=coins-$1 WHERE phone=$2 RETURNING *', [coins, from.phone]);
    await c.query('UPDATE users SET coins=coins+$1 WHERE phone=$2', [coins, toPhone]);
    return { success: true, msg: "Sent " + coins + " MES to " + to.name, user: safe(r.rows[0]) };
  });
  res.json(out);
});

// ---------- market ----------
route('/api/market/post', async (req, res) => {
  const { type } = req.body;
  const mes = round(Number(req.body.mes)), price = round(Number(req.body.price));
  if (!['buy', 'sell'].includes(type)) return res.json({ success: false, msg: "Invalid order type" });
  if (!(mes > 0) || !(price > 0) || mes > 1e9 || price > 1e6) return res.json({ success: false, msg: "Enter a valid amount and price" });
  const ksh = round(mes * price);
  if (!(ksh > 0)) return res.json({ success: false, msg: "Order too small" });
  const u = await pinUser(req, res);
  if (!u) return;
  const out = await tx(async c => {
    const m = await lockUsers(c, [u.phone]);
    let cur = m[u.phone];
    if (type === 'sell') {
      if (n(cur.coins) < mes) return { success: false, msg: "Not enough MES" };
      cur = (await c.query('UPDATE users SET coins=coins-$1 WHERE phone=$2 RETURNING *', [mes, u.phone])).rows[0];
    }
    await c.query('INSERT INTO orders(id,owner_phone,type,mes,price,ksh,status,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [crypto.randomBytes(8).toString('hex'), u.phone, type, mes, price, ksh, 'open', Date.now()]);
    return {
      success: true,
      msg: type === 'sell'
        ? "Order posted. Your " + mes + " MES is locked until someone accepts or you cancel."
        : "Buy order posted. When a seller accepts, a chat will open and you pay them by M-Pesa.",
      user: safe(cur)
    };
  });
  res.json(out);
});

route('/api/market/list', async (req, res) => {
  const u = await sessionUser(req, res);
  if (!u) return;
  const type = req.body.type;
  if (!['buy', 'sell'].includes(type)) return res.json({ orders: [] });
  const r = await q(`SELECT o.*, w.name AS owner_name FROM orders o JOIN users w ON w.phone=o.owner_phone
    WHERE o.status='open' AND o.type=$1 AND o.owner_phone<>$2 ORDER BY o.created DESC LIMIT 50`, [type, u.phone]);
  res.json({ orders: r.rows.map(o => ({ id: o.id, ownerName: o.owner_name, ownerPhone: mask(o.owner_phone), type: o.type, mes: n(o.mes), price: n(o.price), ksh: n(o.ksh) })) });
});

route('/api/market/accept', async (req, res) => {
  const taker = await pinUser(req, res);
  if (!taker) return;
  const out = await tx(async c => {
    const orr = await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [String(req.body.orderId || '')]);
    const o = orr.rows[0];
    if (!o || o.status !== 'open') return { success: false, refresh: true, msg: "Order no longer available" };
    if (o.owner_phone === taker.phone) return { success: false, msg: "You can't accept your own order" };
    const m = await lockUsers(c, [o.owner_phone, taker.phone]);
    let seller, buyer, takerRow = m[taker.phone];
    if (o.type === 'sell') {
      seller = o.owner_phone; buyer = taker.phone;           // MES already locked in the order
    } else {
      seller = taker.phone; buyer = o.owner_phone;
      if (n(takerRow.coins) < n(o.mes)) return { success: false, msg: "Not enough MES" };
      takerRow = (await c.query('UPDATE users SET coins=coins-$1 WHERE phone=$2 RETURNING *', [o.mes, taker.phone])).rows[0];
    }
    await c.query("UPDATE orders SET status='in_trade' WHERE id=$1", [o.id]);
    const id = crypto.randomBytes(8).toString('hex');
    await c.query(`INSERT INTO trades(id,order_id,seller,buyer,mes,price,ksh,status,created) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
      [id, o.id, seller, buyer, o.mes, o.price, o.ksh, Date.now()]);
    await addMsg(c, id, 'system', "Trade started. " + n(o.mes) + " MES is locked in escrow. Buyer: pay KSh " + n(o.ksh) + " to the seller by M-Pesa, then tap I HAVE PAID. Seller: release only after you receive the money.");
    return { success: true, msg: "Trade started", tradeId: id, user: safe(takerRow) };
  });
  res.json(out);
});

route('/api/market/mine', async (req, res) => {
  const u = await sessionUser(req, res);
  if (!u) return;
  const r = await q("SELECT * FROM orders WHERE status='open' AND owner_phone=$1 ORDER BY created DESC", [u.phone]);
  res.json({ orders: r.rows.map(o => ({ id: o.id, type: o.type, mes: n(o.mes), price: n(o.price), ksh: n(o.ksh) })) });
});

route('/api/market/cancel', async (req, res) => {
  const u = await pinUser(req, res);
  if (!u) return;
  const out = await tx(async c => {
    const orr = await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [String(req.body.orderId || '')]);
    const o = orr.rows[0];
    if (!o || o.status !== 'open' || o.owner_phone !== u.phone) return { success: false, refresh: true, msg: "Order not found" };
    await lockUsers(c, [u.phone]);
    let cur = (await c.query('SELECT * FROM users WHERE phone=$1', [u.phone])).rows[0];
    if (o.type === 'sell') cur = (await c.query('UPDATE users SET coins=coins+$1 WHERE phone=$2 RETURNING *', [o.mes, u.phone])).rows[0];
    await c.query("UPDATE orders SET status='cancelled' WHERE id=$1", [o.id]);
    return { success: true, msg: "Order cancelled." + (o.type === 'sell' ? " MES returned." : ""), user: safe(cur) };
  });
  res.json(out);
});

// ---------- trades ----------
route('/api/trade/mine', async (req, res) => {
  const u = await sessionUser(req, res);
  if (!u) return;
  const base = `SELECT t.*, s.name AS seller_name, b.name AS buyer_name FROM trades t
    JOIN users s ON s.phone=t.seller JOIN users b ON b.phone=t.buyer`;
  const mine = await q(base + ' WHERE t.seller=$1 OR t.buyer=$1 ORDER BY t.created DESC LIMIT 30', [u.phone]);
  let disputes = [];
  if (isHost(u)) {
    const d = await q(base + " WHERE t.status='disputed' ORDER BY t.created DESC");
    disputes = d.rows.map(t => tradeSummary(t, u));
  }
  res.json({ trades: mine.rows.map(t => tradeSummary(t, u)), disputes });
});

route('/api/trade/get', async (req, res) => {
  const u = await sessionUser(req, res);
  if (!u) return;
  const t = await loadTrade(req.body.tradeId);
  if (!t || !canSee(t, u)) return res.json({ success: false, msg: "Trade not found" });
  const ms = await q('SELECT * FROM messages WHERE trade_id=$1 ORDER BY id DESC LIMIT 300', [t.id]);
  const msgs = ms.rows.reverse();
  res.json({
    success: true,
    trade: {
      id: t.id, status: t.status, mes: n(t.mes), price: n(t.price), ksh: n(t.ksh),
      open: OPEN.includes(t.status), role: roleOf(t, u),
      seller: { name: t.seller_name, phone: t.seller },
      buyer: { name: t.buyer_name, phone: t.buyer },
      report: t.report_reason ? { by: t.report_by === t.seller ? t.seller_name : t.buyer_name, reason: t.report_reason } : null,
      messages: msgs.map(m => ({ mine: m.sender === u.phone, system: m.sender === 'system', name: m.name, text: m.body }))
    }
  });
});

route('/api/trade/chat', async (req, res) => {
  const u = await sessionUser(req, res);
  if (!u) return;
  const t = await loadTrade(req.body.tradeId);
  if (!t || !canSee(t, u)) return res.json({ success: false, msg: "Trade not found" });
  if (!OPEN.includes(t.status)) return res.json({ success: false, msg: "Trade is closed" });
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.json({ success: false, msg: "Empty message" });
  const cnt = await q('SELECT COUNT(*) FROM messages WHERE trade_id=$1', [t.id]);
  if (n(cnt.rows[0].count) > 500) return res.json({ success: false, msg: "Chat limit reached" });
  await tx(c => addMsg(c, t.id, u.phone, text));
  res.json({ success: true });
});

route('/api/trade/paid', async (req, res) => {
  const u = await sessionUser(req, res);
  if (!u) return;
  const out = await tx(async c => {
    const tr = await c.query('SELECT * FROM trades WHERE id=$1 FOR UPDATE', [String(req.body.tradeId || '')]);
    const t = tr.rows[0];
    if (!t || u.phone !== t.buyer) return { success: false, msg: "Only the buyer can do this" };
    if (t.status !== 'active') return { success: false, msg: "Not available now" };
    await c.query("UPDATE trades SET status='paid' WHERE id=$1", [t.id]);
    await addMsg(c, t.id, 'system', u.name + " says they paid KSh " + n(t.ksh) + ". Seller: check your M-Pesa, then release the MES with your PIN.");
    return { success: true, msg: "Marked as paid. Wait for the seller to release." };
  });
  res.json(out);
});

route('/api/trade/release', async (req, res) => {
  const u = await pinUser(req, res);
  if (!u) return;
  const out = await tx(async c => {
    const tr = await c.query('SELECT * FROM trades WHERE id=$1 FOR UPDATE', [String(req.body.tradeId || '')]);
    const t = tr.rows[0];
    if (!t) return { success: false, msg: "Trade not found" };
    if (u.phone !== t.seller) return { success: false, msg: "Only the seller can release MES" };
    if (!['active', 'paid'].includes(t.status)) return { success: false, msg: "Trade is not open" };
    const b = await c.query('UPDATE users SET coins=coins+$1 WHERE phone=$2 RETURNING name', [t.mes, t.buyer]);
    await c.query("UPDATE trades SET status='completed' WHERE id=$1", [t.id]);
    await c.query("UPDATE orders SET status='done' WHERE id=$1", [t.order_id]);
    await addMsg(c, t.id, 'system', "✅ Seller released " + n(t.mes) + " MES to the buyer. Trade complete.");
    const me = (await c.query('SELECT * FROM users WHERE phone=$1', [u.phone])).rows[0];
    return { success: true, msg: "Released " + n(t.mes) + " MES to " + b.rows[0].name, user: safe(me) };
  });
  res.json(out);
});

route('/api/trade/cancel', async (req, res) => {
  const u = await sessionUser(req, res);
  if (!u) return;
  const out = await tx(async c => {
    const tr = await c.query('SELECT * FROM trades WHERE id=$1 FOR UPDATE', [String(req.body.tradeId || '')]);
    const t = tr.rows[0];
    if (!t || u.phone !== t.buyer) return { success: false, msg: "Only the buyer can cancel" };
    if (t.status !== 'active') return { success: false, msg: "Can't cancel now. Use REPORT if there is a problem." };
    await c.query('UPDATE users SET coins=coins+$1 WHERE phone=$2', [t.mes, t.seller]);
    await c.query("UPDATE trades SET status='cancelled' WHERE id=$1", [t.id]);
    await c.query("UPDATE orders SET status='cancelled' WHERE id=$1", [t.order_id]);
    await addMsg(c, t.id, 'system', "Buyer cancelled the trade. MES returned to the seller.");
    return { success: true, msg: "Trade cancelled" };
  });
  res.json(out);
});

route('/api/trade/report', async (req, res) => {
  const u = await sessionUser(req, res);
  if (!u) return;
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  const out = await tx(async c => {
    const tr = await c.query('SELECT * FROM trades WHERE id=$1 FOR UPDATE', [String(req.body.tradeId || '')]);
    const t = tr.rows[0];
    if (!t || !isParty(t, u)) return { success: false, msg: "Trade not found" };
    if (!['active', 'paid'].includes(t.status)) return { success: false, msg: "Can't report this trade now" };
    if (reason.length < 3) return { success: false, msg: "Please explain what happened" };
    await c.query("UPDATE trades SET status='disputed', report_by=$1, report_reason=$2 WHERE id=$3", [u.phone, reason, t.id]);
    await addMsg(c, t.id, 'system', "🚨 " + u.name + " reported a problem: \"" + reason + "\". The host will review this chat and decide. MES stays locked until then.");
    return { success: true, msg: "Reported to the host. They will review and help." };
  });
  res.json(out);
});

route('/api/trade/resolve', async (req, res) => {
  const u = await pinUser(req, res);
  if (!u) return;
  if (!isHost(u)) return res.json({ success: false, msg: "Only the host can resolve disputes" });
  const action = req.body.action;
  if (!['release', 'refund'].includes(action)) return res.json({ success: false, msg: "Invalid action" });
  const out = await tx(async c => {
    const tr = await c.query('SELECT * FROM trades WHERE id=$1 FOR UPDATE', [String(req.body.tradeId || '')]);
    const t = tr.rows[0];
    if (!t) return { success: false, msg: "Trade not found" };
    if (isParty(t, u)) return { success: false, msg: "You are part of this trade, so you can't resolve it" };
    if (t.status !== 'disputed') return { success: false, msg: "Not a reported trade" };
    if (action === 'release') {
      await c.query('UPDATE users SET coins=coins+$1 WHERE phone=$2', [t.mes, t.buyer]);
      await c.query("UPDATE trades SET status='resolved_release' WHERE id=$1", [t.id]);
      await addMsg(c, t.id, 'system', "✅ Host released " + n(t.mes) + " MES to the buyer.");
    } else {
      await c.query('UPDATE users SET coins=coins+$1 WHERE phone=$2', [t.mes, t.seller]);
      await c.query("UPDATE trades SET status='resolved_refund' WHERE id=$1", [t.id]);
      await addMsg(c, t.id, 'system', "↩️ Host refunded " + n(t.mes) + " MES to the seller.");
    }
    await c.query("UPDATE orders SET status='done' WHERE id=$1", [t.order_id]);
    return { success: true, msg: "Dispute resolved", user: safe(u) };
  });
  res.json(out);
});

const PORT = process.env.PORT || 10000;
initDb()
  .then(() => app.listen(PORT, () => console.log("Running on " + PORT)))
  .catch(e => { console.error('DB init failed', e); process.exit(1); });
                                                  
