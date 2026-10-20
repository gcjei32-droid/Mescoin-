const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '50kb' }));

const DB_FILE = fs.existsSync('/data') ? '/data/database.json' : './database.json';

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(path.dirname(DB_FILE), '.jwt_secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();
const signToken = (id) => jwt.sign({ id }, SECRET, { expiresIn: '7d' });

// --- HTML IN ONE FILE - NO BACKTICK INSIDE, SAFE ---
const INDEX_HTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>MESCOIN P2P</title><style>body{font-family:system-ui;max-width:460px;margin:auto;padding:12px;background:#f0fdf4}input,button{width:100%;padding:13px;margin:6px 0;border-radius:10px;border:1px solid #ddd;box-sizing:border-box}button{background:#16a34a;color:#fff;border:none;font-weight:bold;cursor:pointer}.card{background:#fff;padding:14px;border-radius:14px;margin:10px 0;box-shadow:0 2px 8px rgba(0,0,0,.06)}h1{color:#16a34a;text-align:center}.order{background:#f8fafc;border:1px solid #e2e8f0;padding:10px;border-radius:10px;margin:6px 0}.chat{height:150px;overflow:auto;border:1px solid #ddd;padding:8px;border-radius:8px;background:#fff}</style></head><body><h1>MESCOIN P2P</h1><p style="text-align:center">1 MES = 2 KES | Chat to exchange</p><div class="card">My MES: <b id="top_mes">-</b> | Chain: <b id="chain_len">-</b></div><div id="auth" class="card"><b>CREATE</b><input id="full_name" placeholder="Full Name"><input id="phone" placeholder="Mobile 07..."><input id="password" type="password" placeholder="Password"><input id="founder_code" placeholder="Founder code if founder phone"><button onclick="signup()">SIGN UP</button><hr><b>LOGIN</b><input id="login_id" placeholder="Mobile or MES"><input id="login_password" type="password" placeholder="Password"><button onclick="login()" style="background:#111">LOGIN</button><p id="msg" style="color:red"></p></div><div id="dash" style="display:none"><div class="card" style="background:#dcfce7"><b id="p_name"></b><br>Mobile: <span id="p_phone"></span><br>MES: <b id="acc"></b><br>KES: <b id="kes"></b> | MES: <b id="mes"></b></div><div class="card" style="border:2px solid #2563eb"><h3>LIVE MARKET</h3><b>BUY ORDERS:</b><div id="market_buys"></div><hr><b>SELL ORDERS:</b><div id="market_sells"></div><button onclick="loadMarket()" style="background:#2563eb">Refresh</button></div><div class="card" style="border:2px solid #16a34a"><h3>BUY MES</h3><input id="buy_amt" type="number" placeholder="Amount"><button onclick="buyOrder()">POST BUY - No Popup</button></div><div class="card" style="border:2px solid #dc2626"><h3>SELL MES</h3><input id="sell_amt" type="number" placeholder="Amount"><button onclick="sellOrder()" style="background:#dc2626">POST SELL - No Popup</button></div><div class="card"><h3>My Orders - Chat Here</h3><table id="orders" style="width:100%;font-size:12px"></table><div id="chatBox" style="display:none"><h4>Chat</h4><div id="chatMsgs" class="chat"></div><input id="chatText" placeholder="Type message"><button onclick="sendChat()" style="background:#2563eb">Send</button></div></div><div class="card"><h3>Send MES Direct</h3><input id="to_account" placeholder="MES... or 07..."><input id="send_amt" type="number" placeholder="Amount"><button onclick="sendMes()" style="background:#2563eb">SEND</button></div><div class="card"><button onclick="logout()" style="background:#333">Logout</button></div></div><script>
let token=localStorage.getItem('mes_token')||null;let currentChat=null;
function goToDashboard(u){auth.style.display='none';dash.style.display='block';p_name.innerText=u.full_name;p_phone.innerText=u.phone;acc.innerText=u.mes_account;kes.innerText=u.kes_balance;mes.innerText=u.mes_balance;top_mes.innerText=u.mes_balance;loadOrders();loadMarket();}
async function signup(){let r=await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({full_name:full_name.value,phone:phone.value,password:password.value,founder_code:founder_code.value})});let d=await r.json();if(d.error){msg.innerText=d.error;return;}token=d.token;localStorage.setItem('mes_token',token);goToDashboard(d.user);}
async function login(){let r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login_id:login_id.value,password:login_password.value})});let d=await r.json();if(d.error){msg.innerText=d.error;return;}token=d.token;localStorage.setItem('mes_token',token);goToDashboard(d.user);}
async function loadOrders(){let r=await fetch('/api/orders',{headers:{Authorization:'Bearer '+token}});let list=await r.json();let h='<tr><th>Type</th><th>Amt</th><th>Status</th><th>Action</th></tr>';list.forEach(function(o){let btn='';if(o.status==='PENDING')btn='<button onclick="cancelOrder(\\''+o.id+'\\')" style="background:red;padding:3px;width:auto;font-size:11px">Cancel</button>';else if(o.status==='MATCHED')btn='<button onclick="openChat(\\''+(o.chat_order_id||o.id)+'\\')" style="background:#2563eb;padding:3px;width:auto;font-size:11px">Chat</button> <button onclick="markPaid(\\''+o.id+'\\')" style="background:orange;padding:3px;width:auto;font-size:11px">I Paid</button> <button onclick="completeOrder(\\''+o.id+'\\')" style="background:green;padding:3px;width:auto;font-size:11px">Complete</button> <button onclick="disputeOrder(\\''+o.id+'\\')" style="background:#333;padding:3px;width:auto;font-size:11px">Dispute</button>';else if(o.status==='DISPUTED')btn='Disputed';h+='<tr><td>'+o.type+'</td><td>'+o.amount+'</td><td>'+o.status+'</td><td>'+btn+'</td></tr>';});orders.innerHTML=h;}
async function cancelOrder(id){let r=await fetch('/api/order/cancel/'+id,{method:'POST',headers:{Authorization:'Bearer '+token}});let d=await r.json();alert(d.message||d.error);loadOrders();}
async function markPaid(id){let r=await fetch('/api/order/paid/'+id,{method:'POST',headers:{Authorization:'Bearer '+token}});let d=await r.json();alert(d.message||d.error);loadOrders();}
async function completeOrder(id){let r=await fetch('/api/order/complete/'+id,{method:'POST',headers:{Authorization:'Bearer '+token}});let d=await r.json();alert(d.message||d.error);loadOrders();}
async function disputeOrder(id){if(!confirm('Open dispute?'))return;let r=await fetch('/api/order/dispute/'+id,{method:'POST',headers:{Authorization:'Bearer '+token}});let d=await r.json();alert(d.message||d.error);loadOrders();}
async function openChat(id){currentChat=id;chatBox.style.display='block';loadChat();}
async function loadChat(){if(!currentChat)return;let r=await fetch('/api/chat/'+currentChat,{headers:{Authorization:'Bearer '+token}});let list=await r.json();let h='';list.forEach(function(m){h+='<div><b>'+m.name+':</b> '+m.text+'</div>';});chatMsgs.innerHTML=h;chatMsgs.scrollTop=chatMsgs.scrollHeight;}
async function sendChat(){let t=chatText.value;let r=await fetch('/api/chat/'+currentChat,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({text:t})});chatText.value='';loadChat();}
async function loadMarket(){let r=await fetch('/api/market',{headers:{Authorization:'Bearer '+token}});let d=await r.json();let hb='';if(d.buys.length==0)hb='No buys';else d.buys.forEach(function(o){hb+='<div class="order"><b>'+o.full_name+'</b> WANTS '+o.amount+' MES ('+o.kes+' KES)</div>';});market_buys.innerHTML=hb;let hs='';if(d.sells.length==0)hs='No sells';else d.sells.forEach(function(o){hs+='<div class="order"><b>'+o.full_name+'</b> SELLS '+o.amount+' MES ('+o.kes+' KES)</div>';});market_sells.innerHTML=hs;}
async function buyOrder(){let r=await fetch('/api/order/buy',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount:buy_amt.value})});let d=await r.json();alert(d.message||d.error);loadOrders();loadMarket();}
async function sellOrder(){let r=await fetch('/api/order/sell',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount:sell_amt.value})});let d=await r.json();alert(d.message||d.error);loadOrders();loadMarket();}
async function sendMes(){let r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({to_account:to_account.value,amount:send_amt.value})});let d=await r.json();alert(d.message||d.error);location.reload();}
function logout(){localStorage.removeItem('mes_token');location.reload();}
(async()=>{if(token){let r=await fetch('/api/me',{headers:{Authorization:'Bearer '+token}});if(r.ok)goToDashboard(await r.json());}})();
setInterval(function(){if(token&&currentChat)loadChat();if(token)loadMarket();},4000);
</script></body></html>`;

// Write index.html so / works even if file missing
try { fs.writeFileSync(path.join(__dirname,'index.html'), INDEX_HTML); } catch(e){}

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
  do { nonce++; hash = calculateHash(prev_hash, timestamp, transactions, nonce); } while (!hash.startsWith('00'));
  return { index, prev_hash, timestamp, transactions, nonce, hash };
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
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], orders: [], trades: [], messages: [], blockchain: [createGenesisBlock()] }));
  }
  let raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!raw.blockchain || raw.blockchain.length === 0) raw.blockchain = [createGenesisBlock()];
  return raw;
}
function saveDB(d) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
let db = loadDB();
let users = db.users || [];
let orders = db.orders || [];
let trades = db.trades || [];
let messages = db.messages || [];
let blockchain = db.blockchain || [createGenesisBlock()];
function save() { saveDB({ users, orders, trades, messages, blockchain }); }

const FOUNDER_PHONE = '254768871831';
const FOUNDER_AMOUNT = 100000000;
const FOUNDER_CODE = process.env.FOUNDER_CODE || '';
const ADMIN_PHONE = process.env.ADMIN_PHONE || FOUNDER_PHONE;
function cleanPhone(p) { return (p || '').toString().replace(/\D/g, '').slice(-9); }
const isFounderPhone = (p) => cleanPhone(p) === cleanPhone(FOUNDER_PHONE);
const newId = () => crypto.randomUUID();
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function checkPassword(user, pw) {
  const s = user.password || '';
  if (s.startsWith('scrypt$')) {
    const parts = s.split('$');
    const salt = parts[1]; const h = parts[2];
    const a = crypto.scryptSync(String(pw), salt, 32);
    const b = Buffer.from(h, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (s === pw) { user.password = hashPassword(pw); save(); return true; }
  return false;
}
function safe(u) { const { password, ...rest } = u; return rest; }
function validAmount(a) { return Number.isFinite(a) && a > 0 && a <= 1e9; }
function rateLimit(name, max, windowMs) {
  const hits = {};
  return (req, res, next) => {
    const key = name + '|' + req.ip;
    const now = Date.now();
    hits[key] = (hits[key] || []).filter(t => now - t < windowMs);
    if (hits[key].length >= max) return res.status(429).json({ error: 'Too many attempts' });
    hits[key].push(now);
    next();
  };
}
const loginLimiter = rateLimit('login', 20, 15 * 60 * 1000);
const signupLimiter = rateLimit('signup', 10, 60 * 60 * 1000);

function founderAlreadyFunded(acc) {
  return blockchain.some(b => b.transactions.some(tx => tx.to === acc && tx.from === 'GENESIS_BANK_100M'));
}
function fundFounder(founder) {
  if (founderAlreadyFunded(founder.mes_account)) return;
  founder.mes_balance += FOUNDER_AMOUNT;
  blockchain.push(mineBlock([{ from: 'GENESIS_BANK_100M', to: founder.mes_account, amount: FOUNDER_AMOUNT, note: 'Founder 100M' }]));
  save();
}
(function boot() {
  try {
    let founder = users.find(u => isFounderPhone(u.phone));
    if (founder) fundFounder(founder);
  } catch (e) { console.log('Boot error', e.message); }
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
function adminOnly(req, res, next) {
  if (cleanPhone(req.user.phone) !== cleanPhone(ADMIN_PHONE)) return res.status(403).json({ error: 'Admin only' });
  next();
}
function canSpend(user, amount) {
  return user.mes_balance >= amount;
}
function pairOf(o) { return o.matchedWith ? orders.find(x => String(x.id) === String(o.matchedWith)) : null; }

app.get('/api/price', (req, res) => res.json({ price: 2 }));
app.get('/api/blockchain', (req, res) => {
  res.json({ length: blockchain.length, chain: blockchain.slice(-10).reverse() });
});

app.post('/api/signup', signupLimiter, (req, res) => {
  let { full_name, phone, password, founder_code } = req.body || {};
  if (!full_name || !phone || !password) return res.status(400).json({ error: 'All required' });
  let cp = cleanPhone(phone);
  if (cp.length < 9) return res.status(400).json({ error: 'Enter valid mobile' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
  if (users.find(u => cleanPhone(u.phone) === cp)) return res.status(400).json({ error: 'Mobile already registered - LOGIN' });
  const founder = isFounderPhone(cp);
  if (founder && (!FOUNDER_CODE || founder_code !== FOUNDER_CODE)) {
    return res.status(403).json({ error: 'This number is reserved - need founder code' });
  }
  let user = {
    id: newId(),
    full_name: String(full_name).trim().slice(0, 60),
    phone: cp,
    password: hashPassword(password),
    mes_account: 'MES' + crypto.randomInt(100000, 1000000),
    kes_balance: 0,
    mes_balance: 0
  };
  while (users.some(u => u.mes_account === user.mes_account)) user.mes_account = 'MES' + crypto.randomInt(100000, 1000000);
  users.push(user);
  if (founder) fundFounder(user);
  else addToBlockchain([{ from: 'GENESIS', to: user.mes_account, amount: 0, note: 'Account created ' + user.full_name }]);
  save();
  res.json({ token: signToken(user.id), user: safe(user) });
});

app.post('/api/login', loginLimiter, (req, res) => {
  let { login_id, password } = req.body || {};
  if (!login_id || !password) return res.status(400).json({ error: 'All required' });
  let cp = cleanPhone(login_id);
  let up = String(login_id).trim().toUpperCase();
  let u = users.find(x => (cp.length >= 9 && cleanPhone(x.phone) === cp) || x.mes_account.toUpperCase() === up);
  if (!u || !checkPassword(u, password)) return res.status(400).json({ error: 'Wrong account or password' });
  res.json({ token: signToken(u.id), user: safe(u) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ ...safe(req.user), blockchain_balance: getBalanceFromChain(req.user.mes_account) });
});

app.get('/api/orders', auth, (req, res) => {
  let list = orders.filter(o => o.userId === req.user.id).slice(-20).reverse().map(o => {
    let out = { ...o };
    if ((o.status === 'MATCHED' || o.status === 'DISPUTED') && o.matchedWith) {
      let pair = orders.find(x => String(x.id) === String(o.matchedWith));
      if (pair) {
        let sell = o.type === 'SELL' ? o : pair;
        out.chat_order_id = sell.id;
      }
    }
    return out;
  });
  res.json(list);
});

app.get('/api/market', auth, (req, res) => {
  function enrich(o) {
    let u = users.find(x => x.id === o.userId);
    return { id: o.id, type: o.type, amount: o.amount, status: o.status, date: o.date, full_name: u ? u.full_name : 'Unknown', kes: o.amount * 2 };
  }
  res.json({
    buys: orders.filter(o => o.type === 'BUY' && o.status === 'PENDING').map(enrich).slice(-30).reverse(),
    sells: orders.filter(o => o.type === 'SELL' && o.status === 'PENDING').map(enrich).slice(-30).reverse()
  });
});

app.post('/api/order/cancel/:id', auth, (req, res) => {
  let o = orders.find(x => String(x.id) === req.params.id && x.userId === req.user.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.type !== 'BUY' && o.type !== 'SELL') return res.status(400).json({ error: 'Cannot cancel' });
  if (o.status !== 'PENDING' && o.status !== 'MATCHED') return res.status(400).json({ error: 'Already ' + o.status });
  let pair = pairOf(o);
  if (o.status === 'MATCHED') {
    if (o.paid || (pair && pair.paid)) return res.status(400).json({ error: 'Payment marked as sent - complete or dispute' });
    if (o.type === 'SELL') return res.status(400).json({ error: 'Buyer must cancel matched trade' });
  }
  let toCancel = [o];
  if (pair && pair.status === 'MATCHED') toCancel.push(pair);
  for (let x of toCancel) {
    if (x.type === 'SELL') {
      let owner = users.find(u => u.id === x.userId);
      if (owner) owner.mes_balance += x.amount;
    }
    x.status = 'CANCELLED';
  }
  save();
  res.json({ message: 'Cancelled', user: safe(req.user) });
});

app.post('/api/order/paid/:id', auth, (req, res) => {
  let buy = orders.find(o => String(o.id) === req.params.id && o.userId === req.user.id && o.type === 'BUY');
  if (!buy) return res.status(403).json({ error: 'Only buyer can mark paid' });
  if (buy.status !== 'MATCHED') return res.status(400).json({ error: 'Not matched' });
  let sell = pairOf(buy);
  if (!sell) return res.status(400).json({ error: 'Pair not found' });
  buy.paid = true; sell.paid = true;
  save();
  res.json({ message: 'Marked as paid - seller can now release MES' });
});

app.post('/api/order/dispute/:id', auth, (req, res) => {
  let o = orders.find(x => String(x.id) === req.params.id && x.userId === req.user.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status !== 'MATCHED') return res.status(400).json({ error: 'Only matched can be disputed' });
  let pair = pairOf(o);
  if (!pair) return res.status(400).json({ error: 'Pair not found' });
  o.status = 'DISPUTED'; pair.status = 'DISPUTED';
  save();
  res.json({ message: 'Dispute opened' });
});

app.post('/api/order/complete/:id', auth, (r
