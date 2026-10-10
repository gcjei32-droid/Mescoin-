const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;
const SECRET = process.env.JWT_SECRET || "mescoin-secret-2026";

// YOUR DATABASE - uses env variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CREATE TABLES
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      mes_account TEXT UNIQUE NOT NULL,
      kes_balance DECIMAL DEFAULT 10000,
      mes_balance DECIMAL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      type TEXT NOT NULL,
      amount DECIMAL NOT NULL,
      price DECIMAL NOT NULL,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS price_table (
      id INTEGER PRIMARY KEY,
      current_price DECIMAL DEFAULT 2.0
    );
    INSERT INTO price_table (id, current_price) VALUES (1, 2.0) ON CONFLICT (id) DO NOTHING;
  `);
  console.log("Postgres connected & tables ready");
}
initDB();

function auth(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({error: "No token"});
  try {
    const decoded = jwt.verify(token.replace('Bearer ',''), SECRET);
    req.user = decoded;
    next();
  } catch(e){ res.status(401).json({error: "Invalid token"}) }
}

// SIGNUP - email phone password -> creates mes account
app.post('/api/signup', async (req, res) => {
  const { email, phone, password } = req.body;
  if(!email ||!phone ||!password) return res.status(400).json({error:"All fields required"});
  try {
    const hash = await bcrypt.hash(password, 10);
    const mesAccount = "MES" + Date.now().toString().slice(-8) + Math.floor(Math.random()*9000+1000);
    const result = await pool.query(
      `INSERT INTO users (email, phone, password, mes_account) VALUES ($1,$2,$3,$4) RETURNING id`,
      [email, phone, hash, mesAccount]
    );
    const token = jwt.sign({id: result.rows[0].id, email}, SECRET);
    res.json({token, mesAccount, message:"Account created successfully"});
  } catch(err) {
    res.status(400).json({error:"Email or phone already exists"});
  }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query(`SELECT * FROM users WHERE email=$1`, [email]);
  if(result.rows.length === 0) return res.status(400).json({error:"User not found"});
  const user = result.rows[0];
  const ok = await bcrypt.compare(password, user.password);
  if(!ok) return res.status(400).json({error:"Wrong password"});
  const token = jwt.sign({id: user.id, email: user.email}, SECRET);
  res.json({token, mesAccount: user.mes_account});
});

// PROFILE
app.get('/api/profile', auth, async (req, res) => {
  const result = await pool.query(`SELECT id,email,phone,mes_account,kes_balance,mes_balance FROM users WHERE id=$1`, [req.user.id]);
  res.json(result.rows[0]);
});

// PRICE - starts at 2 KES
app.get('/api/price', async (req, res) => {
  const result = await pool.query(`SELECT current_price FROM price_table WHERE id=1`);
  res.json({price: parseFloat(result.rows[0].current_price)});
});

// MATCHING ENGINE - price goes up when buy > sell
async function matchOrders(newOrder) {
  let priceRes = await pool.query(`SELECT current_price FROM price_table WHERE id=1`);
  let currentPrice = parseFloat(priceRes.rows[0].current_price);

  const oppositeType = newOrder.type === 'buy'? 'sell' : 'buy';
  const query = oppositeType === 'sell'
   ? `SELECT * FROM orders WHERE type='sell' AND status='open' AND price <= $1 ORDER BY price ASC, created_at ASC`
    : `SELECT * FROM orders WHERE type='buy' AND status='open' AND price >= $1 ORDER BY price DESC, created_at ASC`;

  const matches = await pool.query(query, [newOrder.price]);

  if(matches.rows.length === 0){
    if(newOrder.type === 'buy'){
      const totalSellRes = await pool.query(`SELECT SUM(amount) as total FROM orders WHERE type='sell' AND status='open'`);
      const totalSell = parseFloat(totalSellRes.rows[0].total || 0);
      if(newOrder.amount > totalSell){
        const increase = (newOrder.amount / 1000000) * 0.05;
        currentPrice = currentPrice * (1 + increase);
        await pool.query(`UPDATE price_table SET current_price=$1 WHERE id=1`, [currentPrice]);
      }
    }
    return currentPrice;
  }

  let remaining = newOrder.amount;
  for(let m of matches.rows){
    if(remaining <=0) break;
    const tradeAmount = Math.min(remaining, parseFloat(m.amount));
    const tradePrice = parseFloat(m.price);

    if(newOrder.type === 'buy'){
      const cost = tradeAmount * tradePrice;
      await pool.query(`UPDATE users SET kes_balance=kes_balance-$1, mes_balance=mes_balance+$2 WHERE id=$3`, [cost, tradeAmount, newOrder.user_id]);
      await pool.query(`UPDATE users SET kes_balance=kes_balance+$1, mes_balance=mes_balance-$2 WHERE id=$3`, [cost, tradeAmount, m.user_id]);
    } else {
      const cost = tradeAmount * parseFloat(newOrder.price);
      await pool.query(`UPDATE users SET kes_balance=kes_balance+$1, mes_balance=mes_balance-$2 WHERE id=$3`, [cost, tradeAmount, newOrder.user_id]);
      await pool.query(`UPDATE users SET kes_balance=kes_balance-$1, mes_balance=mes_balance+$2 WHERE id=$3`, [cost, tradeAmount, m.user_id]);
    }

    remaining -= tradeAmount;
    const newMAmount = parseFloat(m.amount) - tradeAmount;
    if(newMAmount <= 0.00001){
      await pool.query(`UPDATE orders SET status='completed' WHERE id=$1`, [m.id]);
    } else {
      await pool.query(`UPDATE orders SET amount=$1 WHERE id=$2`, [newMAmount, m.id]);
    }
  }

  if(remaining > 0.00001){
    await pool.query(`UPDATE orders SET amount=$1 WHERE id=$2`, [remaining, newOrder.id]);
  } else {
    await pool.query(`UPDATE orders SET status='completed' WHERE id=$1`, [newOrder.id]);
  }

  if(newOrder.type === 'buy'){
    currentPrice = currentPrice * 1.01;
    await pool.query(`UPDATE price_table SET current_price=$1 WHERE id=1`, [currentPrice]);
  }

  return currentPrice;
}

// BUY
app.post('/api/buy', auth, async (req, res) => {
  const { amount, price } = req.body;
  const result = await pool.query(`INSERT INTO orders (user_id, type, amount, price) VALUES ($1,'buy',$2,$3) RETURNING id`, [req.user.id, amount, price]);
  const newPrice = await matchOrders({id: result.rows[0].id, user_id: req.user.id, type:'buy', amount, price});
  res.json({message:"Buy order placed & matched", newPrice});
});

// SELL
app.post('/api/sell', auth, async (req, res) => {
  const { amount, price } = req.body;
  const userRes = await pool.query(`SELECT mes_balance FROM users WHERE id=$1`, [req.user.id]);
  if(parseFloat(userRes.rows[0].mes_balance) < parseFloat(amount)) return res.status(400).json({error:"Not enough MES"});
  const result = await pool.query(`INSERT INTO orders (user_id, type, amount, price) VALUES ($1,'sell',$2,$3) RETURNING id`, [req.user.id, amount, price]);
  const newPrice = await matchOrders({id: result.rows[0].id, user_id: req.user.id, type:'sell', amount, price});
  res.json({message:"Sell order placed & matched", newPrice});
});

app.get('/api/orders', async (req,res)=>{
  const r = await pool.query(`SELECT * FROM orders WHERE status='open' ORDER BY created_at DESC LIMIT 50`);
  res.json(r.rows);
});

app.get('/api/myorders', auth, async (req,res)=>{
  const r = await pool.query(`SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC`, [req.user.id]);
  res.json(r.rows);
});

app.get('*', (req,res)=> res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', ()=> console.log(`MesCoin running on ${PORT} with Postgres`));
