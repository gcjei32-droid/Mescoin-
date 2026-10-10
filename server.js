const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;
const SECRET = process.env.JWT_SECRET || "mescoin-2026";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.json());

process.on('unhandledRejection', e => console.log('Handled:', e.message));
process.on('uncaughtException', e => console.log('Handled:', e.message));

app.listen(PORT, '0.0.0.0', () => console.log("MESCOIN LIVE " + PORT));

(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, full_name TEXT, phone TEXT, mes_account TEXT, password TEXT, kes_balance DECIMAL DEFAULT 1000, mes_balance DECIMAL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS price_table (id INTEGER PRIMARY KEY, current_price DECIMAL DEFAULT 2.0)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), type TEXT, amount DECIMAL, price DECIMAL, total DECIMAL, from_account TEXT, to_account TEXT, created_at TIMESTAMP DEFAULT NOW())`);
    await pool.query(`INSERT INTO price_table (id, current_price) VALUES (1, 2.0) ON CONFLICT (id) DO NOTHING`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mes_account TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS from_account TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS to_account TEXT`).catch(()=>{});
    console.log("MESCOIN Ready with SEND - DB Fixed");
  } catch (e) {
    console.log("DB warning: " + e.message);
  }
})();

function auth(req, res, next) {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(t, SECRET); next(); } catch { return res.status(401).json({ error: "Invalid token" }); }
}

app.get('/api/price', async (req, res) => {
  const r = await pool.query('SELECT current_price FROM price_table WHERE id=1');
  res.json({ price: parseFloat(r.rows[0].current_price) });
});

app.post('/api/signup', async (req, res) => {
  try {
    const { full_name, phone, password } = req.body;
    if (!full_name ||!phone ||!password) return res.status(400).json({ error: "Name, Mobile and Password required" });
    const hash = await bcrypt.hash(password, 10);
    const mesAcc = "MES" + Math.floor(100000 + Math.random() * 900000);
    const r = await pool.query('INSERT INTO users(full_name, phone, mes_account, password, kes_balance, mes_balance) VALUES($1,$2,$3,$4,1000,10) RETURNING id, full_name, phone, mes_account, kes_balance, mes_balance', [full_name, phone, mesAcc, hash]);
    const token = jwt.sign({ id: r.rows[0].id }, SECRET);
    res.json({ token, user: r.rows[0] });
  } catch (e) { res.status(400).json({ error: "Mobile already registered" }); }
});

app.post('/api/login', async (req, res) => {
  const r = await pool.query('SELECT * FROM users WHERE phone=$1 OR mes_account=$1', [req.body.login_id]);
  if (!r.rows.length) return res.status(400).json({ error: "Account not found" });
  const ok = await bcrypt.compare(req.body.password, r.rows[0].password);
  if (!ok) return res.status(400).json({ error: "Wrong password" });
  const token = jwt.sign({ id: r.rows[0].id }, SECRET);
  res.json({ token, user: r.rows[0] });
});

app.get('/api/me', auth, async (req, res) => {
  const r = await pool.query('SELECT id, full_name, phone, mes_account, kes_balance, mes_balance FROM users WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
});
app.get('/api/orders', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id]);
  res.json(r.rows);
});

app.post('/api/trade', auth, async (req, res) => {
  const { type, amount } = req.body;
  const priceR = await pool.query('SELECT current_price FROM price_table WHERE id=1');
  const price = parseFloat(priceR.rows[0].current_price);
  const userR = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
  let user = userR.rows[0];
  if (type === 'buy') {
    const cost = amount * price;
    if (parseFloat(user.kes_balance) < cost) return res.status(400).json({ error: "Not enough KES" });
    await pool.query('UPDATE users SET kes_balance=kes_balance-$1, mes_balance=mes_balance+$2 WHERE id=$3', [cost, amount, req.user.id]);
    await pool.query('INSERT INTO orders(user_id,type,amount,price,total) VALUES($1,$2,$3,$4,$5)', [req.user.id, 'BUY', amount, price, cost]);
  } else {
    if (parseFloat(user.mes_balance) < amount) return res.status(400).json({ error: "Not enough MES" });
    const gain = amount * price;
    await pool.query('UPDATE users SET kes_balance=kes_balance+$1, mes_balance=mes_balance-$2 WHERE id=$3', [gain, amount, req.user.id]);
    await pool.query('INSERT INTO orders(user_id,type,amount,price,total) VALUES($1,$2,$3,$4,$5)', [req.user.id, 'SELL', amount, price, gain]);
  }
  const updated = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
  res.json({ success: true, user: updated.rows[0] });
});

app.post('/api/send', auth, async (req, res) => {
  const { to_account, amount } = req.body;
  const amt = parseFloat(amount);
  if (!to_account ||!amt || amt <= 0) return res.status(400).json({ error: "Enter account and valid amount" });
  const senderR = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
  const sender = senderR.rows[0];
  if (parseFloat(sender.mes_balance) < amt) return res.status(400).json({ error: "Not enough MES" });
  if (sender.mes_account === to_account.toUpperCase()) return res.status(400).json({ error: "Cannot send to yourself" });
  const receiverR = await pool.query('SELECT * FROM users WHERE mes_account=$1', [to_account.toUpperCase()]);
  if (receiverR.rows.length === 0) return res.status(400).json({ error: "Account not found" });
  const receiver = receiverR.rows[0];
  await pool.query('BEGIN');
  try {
    await pool.query('UPDATE users SET mes_balance=mes_balance-$1 WHERE id=$2', [amt, sender.id]);
    await pool.query('UPDATE users SET mes_balance=mes_balance+$1 WHERE id=$2', [amt, receiver.id]);
    await pool.query('INSERT INTO orders(user_id,type,amount,price,total,from_account,to_account) VALUES($1,$2,$3,$4,$5,$6,$7)', [sender.id, 'SEND', amt, 0, amt, sender.mes_account, receiver.mes_account]);
    await pool.query('INSERT INTO orders(user_id,type,amount,price,total,from_account,to_account) VALUES($1,$2,$3,$4,$5,$6,$7)', [receiver.id, 'RECEIVED', amt, 0, amt, sender.mes_account, receiver.mes_account]);
    await pool.query('COMMIT');
  } catch (e) { await pool.query('ROLLBACK'); return res.status(500).json({ error: "Transfer failed" }); }
  const updatedSender = await pool.query('SELECT * FROM users WHERE id=$1', [sender.id]);
  res.json({ success: true, message: "Sent " + amt + " MES to " + receiver.full_name, user: updatedSender.rows[0] });
});

app.get('/', (req, res) => { res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>MESCOIN</title><style>body{font-family:system-ui;max-width:430px;margin:auto;padding:16px;background:#f0fdf4}input,button{width:100%;padding:13px;margin:6px 0;border-radius:10px;border:1px solid #ddd;box-sizing:border-box}button{background:#16a34a;color:#fff;border:none;font-weight:bold}label{font-size:12px;font-weight:bold}.card{background:#fff;padding:16px;border-radius:14px;margin:10px 0;box-shadow:0 2px 8px rgba(0,0,0,.06)}h1{color:#16a34a;text-align:center}</style></head><body><h1>MESCOIN</h1><p style="text-align:center">Send MES by Account Number - LIVE</p><div class="card">Price: <b id="price">...</b> KES | My MES: <b id="top_mes">-</b></div><div id="auth" class="card"><label>Full Name</label><input id="full_name"><label>Mobile</label><input id="phone"><label>Password</label><input id="password" type="password"><button onclick="signup()">SIGN UP (1000 KES + 10 MES Free)</button><hr><label>Mobile OR MES Account</label><input id="login_id"><label>Password</label><input id="login_password" type="password"><button onclick="login()" style="background:#111">LOGIN</button><p id="msg" style="color:red"></p></div><div id="dash" style="display:none"><div class="card"><b id="p_name"></b><br>Mobile: <span id="p_phone"></span><br>Account: <b id="acc" style="color:#16a34a;font-size:20px"></b><br><br>KES: <b id="kes"></b> | MES: <b id="mes"></b></div><div class="card"><h3>Send MES</h3><input id="to_account" placeholder="MES123456"><input id="send_amt" type="number" placeholder="Amount"><button onclick="sendMes()" style="background:#2563eb">SEND MESCOIN</button></div><div class="card"><h3>Buy/Sell</h3><input id="amt" type="number" placeholder="Amount"><button onclick="trade('buy')">BUY</button><button onclick="trade('sell')" style="background:#dc2626">SELL</button></div><div class="card"><h3>History</h3><table id="orders"></table><button onclick="logout()" style="background:#333">Logout</button></div></div><script>let token=localStorage.getItem('mes_token')||null;async function loadPrice(){let r=await fetch('/api/price');let d=await r.json();document.getElementById('price').innerText=d.price;}loadPrice();async function signup(){let r=await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({full_name:document.getElementById('full_name').value,phone:document.getElementById('phone').value,password:document.getElementById('password').value})});let d=await r.json();if(d.error){document.getElementById('msg').innerText=d.error;return;}token=d.token;localStorage.setItem('mes_token',token);showDash(d.user);}async function login(){let r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login_id:document.getElementById('login_id').value,password:document.getElementById('login_password').value})});let d=await r.json();if(d.error){document.getElementById('msg').innerText=d.error;return;}token=d.token;localStorage.setItem('mes_token',token);showDash(d.user);}function showDash(u){document.getElementById('auth').style.display='none';document.getElementById('dash').style.display='block';document.getElementById('p_name').innerText=u.full_name;document.getElementById('p_phone').innerText=u.phone;document.getElementById('acc').innerText=u.mes_account;document.getElementById('kes').innerText=u.kes_balance;document.getElementById('mes').innerText=u.mes_balance;document.getElementById('top_mes').innerText=u.mes_balance;loadOrders();}async function loadOrders(){let r=await fetch('/api/orders',{headers:{Authorization:'Bearer '+token}});let list=await r.json();let h='<tr><th>Type</th><th>Amt</th><th>To</th></tr>';list.forEach(o=>{let other=o.type==='SEND'?o.to_account:o.type==='RECEIVED'?o.from_account:'';h+='<tr><td>'+o.type+'</td><td>'+o.amount+'</td><td>'+(other||'-')+'</td></tr>';});document.getElementById('orders').innerHTML=h;}async function trade(type){let a=parseFloat(document.getElementById('amt').value);if(!a)return alert('Enter amount');let r=await fetch('/api/trade',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({type,amount:a})});let d=await r.json();if(d.error)return alert(d.error);document.getElementById('kes').innerText=d.user.kes_balance;document.getElementById('mes').innerText=d.user.mes_balance;document.getElementById('top_mes').innerText=d.user.mes_balance;loadOrders();}async function sendMes(){let to=document.getElementById('to_account').value.trim().toUpperCase();let amt=parseFloat(document.getElementById('send_amt').value);if(!to||!amt){alert('Enter account and amount');return;}if(!confirm('Send '+amt+' MES to '+to+'?'))return;let r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({to_account:to,amount:amt})});let d=await r.json();if(d.error){alert(d.error);return;}alert(d.message);document.getElementById('kes').innerText=d.user.kes_balance;document.getElementById('mes').innerText=d.user.mes_balance;document.getElementById('top_mes').innerText=d.user.mes_balance;loadOrders();document.getElementById('to_account').value='';document.getElementById('send_amt').value='';}function logout(){localStorage.removeItem('mes_token');token=null;document.getElementById('auth').style.display='block';document.getElementById('dash').style.display='none';}(async()=>{if(token){let r=await fetch('/api/me',{headers:{Authorization:'Bearer '+token}});if(r.ok){let u=await r.json();showDash(u);}}})();</script></body></html>`); });
