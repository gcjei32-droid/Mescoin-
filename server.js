const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;
const SECRET = process.env.JWT_SECRET || "mescoin-secret-2026";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE,
    phone TEXT UNIQUE,
    password TEXT,
    mes_account TEXT UNIQUE,
    kes_balance DECIMAL DEFAULT 0,
    mes_balance DECIMAL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS price_table (id INTEGER PRIMARY KEY, current_price DECIMAL DEFAULT 2.0);
  INSERT INTO price_table (id, current_price) VALUES (1, 2.0) ON CONFLICT (id) DO NOTHING;
`).then(()=>console.log("Postgres connected & tables ready")).catch(e=>console.log(e.message));

function auth(req,res,next){
  const token = req.headers.authorization?.split(' ')[1];
  if(!token) return res.status(401).json({error:"No token"});
  try{ req.user = jwt.verify(token, SECRET); next(); } catch{ return res.status(401).json({error:"Invalid token"}); }
}

app.get('/api/price', async (req,res)=>{
  const r = await pool.query('SELECT current_price FROM price_table WHERE id=1');
  res.json({price: parseFloat(r.rows[0].current_price)});
});

app.post('/api/signup', async (req,res)=>{
  const {email, phone, password} = req.body;
  if(!email ||!password) return res.status(400).json({error:"Email and password required"});
  try{
    const hash = await bcrypt.hash(password, 10);
    const mesAcc = "MES" + Math.floor(100000 + Math.random()*900000);
    const result = await pool.query(
      'INSERT INTO users(email, phone, password, mes_account) VALUES($1,$2,$3,$4) RETURNING id, email, mes_account, kes_balance, mes_balance',
      [email, phone, hash, mesAcc]
    );
    const token = jwt.sign({id: result.rows[0].id}, SECRET);
    res.json({token, user: result.rows[0]});
  } catch(e){
    res.status(400).json({error: e.detail || "Email or phone already exists"});
  }
});

app.post('/api/login', async (req,res)=>{
  const {email, password} = req.body;
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  if(r.rows.length===0) return res.status(400).json({error:"User not found"});
  const ok = await bcrypt.compare(password, r.rows[0].password);
  if(!ok) return res.status(400).json({error:"Wrong password"});
  const token = jwt.sign({id: r.rows[0].id}, SECRET);
  res.json({token, user: r.rows[0]});
});

app.get('/api/me', auth, async (req,res)=>{
  const r = await pool.query('SELECT id, email, phone, mes_account, kes_balance, mes_balance FROM users WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
});

app.post('/api/trade', auth, async (req,res)=>{
  const {type, amount} = req.body;
  const priceR = await pool.query('SELECT current_price FROM price_table WHERE id=1');
  const price = parseFloat(priceR.rows[0].current_price);
  const userR = await pool.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
  let user = userR.rows[0];
  if(type==='buy'){
    const cost = amount * price;
    if(parseFloat(user.kes_balance) < cost) return res.status(400).json({error:"Not enough KES - need to deposit"});
    await pool.query('UPDATE users SET kes_balance=kes_balance-$1, mes_balance=mes_balance+$2 WHERE id=$3', [cost, amount, req.user.id]);
  } else {
    if(parseFloat(user.mes_balance) < amount) return res.status(400).json({error:"Not enough MES"});
    const gain = amount * price;
    await pool.query('UPDATE users SET kes_balance=kes_balance+$1, mes_balance=mes_balance-$2 WHERE id=$3', [gain, amount, req.user.id]);
  }
  const updated = await pool.query('SELECT id, email, mes_account, kes_balance, mes_balance FROM users WHERE id=$1', [req.user.id]);
  res.json({success:true, user: updated.rows[0], price});
});

app.get('/', (req,res)=>{
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>MESCOIN</title><style>body{font-family:sans-serif;max-width:400px;margin:auto;padding:20px;background:#f9fafb}input,button{width:100%;padding:12px;margin:6px 0;border-radius:8px;border:1px solid #ccc}button{background:#16a34a;color:#fff;border:none;font-weight:bold;font-size:16px;cursor:pointer}.card{background:#fff;padding:16px;border-radius:12px;margin:12px 0;box-shadow:0 2px 6px rgba(0,0,0,0.1)}</style></head><body><h1 style="color:#16a34a;text-align:center">MESCOIN</h1><div class="card">Price: <b id="price">Loading...</b> KES / MES</div><div id="auth" class="card"><input id="email" placeholder="Email"><input id="phone" placeholder="Phone"><input id="password" type="password" placeholder="Password"><button onclick="signup()">Sign Up</button><button onclick="login()" style="background:#111">Login</button></div><div id="dash" class="card" style="display:none"><p>Account: <b id="acc"></b></p><p>KES: <b id="kes"></b> | MES: <b id="mes"></b></p><input id="amt" type="number" placeholder="Amount of MES"><button onclick="trade('buy')">BUY MES</button><button onclick="trade('sell')" style="background:#dc2626">SELL MES</button><button onclick="logout()" style="background:#666">Logout</button></div><script>let token=null;async function loadPrice(){let r=await fetch('/api/price');let d=await r.json();document.getElementById('price').innerText=d.price}loadPrice();setInterval(loadPrice,5000);async function signup(){let r=await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.value,phone:phone.value,password:password.value})});let d=await r.json();if(d.error)return alert(d.error);token=d.token;showDash(d.user);}async function login(){let r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.value,password:password.value})});let d=await r.json();if(d.error)return alert(d.error);token=d.token;showDash(d.user);}function showDash(u){auth.style.display='none';dash.style.display='block';acc.innerText=u.mes_account;kes.innerText=u.kes_balance;mes.innerText=u.mes_balance}async function trade(type){let amount=parseFloat(document.getElementById('amt').value);if(!amount)return alert('Enter amount');let r=await fetch('/api/trade',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({type,amount})});let d=await r.json();if(d.error)return alert(d.error);alert('Success');kes.innerText=d.user.kes_balance;mes.innerText=d.user.mes_balance;}function logout(){token=null;auth.style.display='block';dash.style.display='none'}</script></body></html>`);
});

console.log("MesCoin running on "+PORT+" with Postgres");
app.listen(PORT,'0.0.0.0');
