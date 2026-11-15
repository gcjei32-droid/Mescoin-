const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// Render injects PORT; bind to 0.0.0.0 or the deploy times out.
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('JWT_SECRET not set: logins reset on every restart.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
// An idle-client error must never kill the process.
pool.on('error', (e) => console.error('pg pool error:', e.message));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

let dbReady = false;
async function initDb() {
  for (let i = 1; ; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          coins BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
          created_at TIMESTAMPTZ DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS items (
          id SERIAL PRIMARY KEY,
          seller_id INT NOT NULL REFERENCES users(id),
          buyer_id INT REFERENCES users(id),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          price BIGINT NOT NULL CHECK (price > 0),
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS transactions (
          id SERIAL PRIMARY KEY,
          user_id INT NOT NULL REFERENCES users(id),
          kind TEXT NOT NULL,
          amount BIGINT NOT NULL,
          note TEXT,
          created_at TIMESTAMPTZ DEFAULT now()
        );`);
      dbReady = true;
      console.log('Database ready');
      return;
    } catch (e) {
      console.error(`DB init attempt ${i} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * i)));
    }
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Always answers 200 so Render never restarts you while the DB warms up.
app.get('/healthz', (_req, res) => res.json({ ok: true, db: dbReady }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const needDb = (_req, res, next) => (dbReady ? next() : fail(res, 503, 'Starting up, try again in a moment'));
app.use('/api', needDb);

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch { fail(res, 401, 'Please log in'); }
}
const token = (u) => jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: '7d' });
const toInt = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : NaN);

app.post('/api/register', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return fail(res, 400, 'Username: 3-20 letters, numbers or _');
  if (password.length < 6) return fail(res, 400, 'Password must be at least 6 characters');
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1,$2) RETURNING id, username, coins', [username, hash]);
    res.json({ token: token(rows[0]), user: rows[0] });
  } catch (e) {
    if (e.code === '23505') return fail(res, 409, 'Username already taken');
    throw e;
  }
}));

app.post('/api/login', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [String(req.body.username || '').trim()]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) return fail(res, 401, 'Wrong username or password');
  res.json({ token: token(u), user: { id: u.id, username: u.username, coins: u.coins } });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, coins FROM users WHERE id=$1', [req.user.id]);
  if (!rows[0]) return fail(res, 401, 'Account not found');
  const tx = await pool.query('SELECT kind, amount, note, created_at FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 15', [req.user.id]);
  res.json({ user: rows[0], transactions: tx.rows });
}));

// BUY COINS. Demo only: credits instantly. For real money, add Stripe Checkout
// and credit coins from a verified webhook, never from this endpoint.
app.post('/api/coins/buy', auth, wrap(async (req, res) => {
  const amount = toInt(req.body.amount);
  if (!(amount >= 1 && amount <= 100000)) return fail(res, 400, 'Amount must be 1 to 100,000');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('UPDATE users SET coins = coins + $1 WHERE id=$2 RETURNING coins', [amount, req.user.id]);
    await c.query("INSERT INTO transactions (user_id, kind, amount, note) VALUES ($1,'buy_coins',$2,'Purchased coins')", [req.user.id, amount]);
    await c.query('COMMIT');
    res.json({ coins: rows[0].coins });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}));

// SELL COINS (cash out). Demo only: deducts coins; hook up a payout provider here.
app.post('/api/coins/sell', auth, wrap(async (req, res) => {
  const amount = toInt(req.body.amount);
  if (!(amount >= 1)) return fail(res, 400, 'Enter a valid amount');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows } = await c.query('UPDATE users SET coins = coins - $1 WHERE id=$2 AND coins >= $1 RETURNING coins', [amount, req.user.id]);
    if (!rows[0]) { await c.query('ROLLBACK'); return fail(res, 400, 'Not enough coins'); }
    await c.query("INSERT INTO transactions (user_id, kind, amount, note) VALUES ($1,'sell_coins',$2,'Cashed out coins')", [req.user.id, -amount]);
    await c.query('COMMIT');
    res.json({ coins: rows[0].coins });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}));

// MARKETPLACE
app.get('/api/items', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const { rows } = await pool.query(
    `SELECT i.id, i.title, i.description, i.price, i.status, i.seller_id, u.username AS seller
     FROM items i JOIN users u ON u.id=i.seller_id
     WHERE i.status='active' AND ($1='' OR i.title ILIKE '%'||$1||'%')
     ORDER BY i.id DESC LIMIT 100`, [q]);
  res.json({ items: rows });
}));

app.get('/api/my/items', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, price, status, buyer_id FROM items WHERE seller_id=$1 OR buyer_id=$1 ORDER BY id DESC LIMIT 100`, [req.user.id]);
  res.json({ items: rows.map((r) => ({ ...r, role: r.buyer_id === req.user.id ? 'bought' : 'selling' })) });
}));

app.post('/api/items', auth, wrap(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 100);
  const description = String(req.body.description || '').trim().slice(0, 1000);
  const price = toInt(req.body.price);
  if (title.length < 2) return fail(res, 400, 'Add a title');
  if (!(price >= 1 && price <= 10000000)) return fail(res, 400, 'Price must be at least 1 coin');
  const { rows } = await pool.query(
    'INSERT INTO items (seller_id, title, description, price) VALUES ($1,$2,$3,$4) RETURNING id', [req.user.id, title, description, price]);
  res.json({ id: rows[0].id });
}));

app.delete('/api/items/:id', auth, wrap(async (req, res) => {
  const { rowCount } = await pool.query(
    "UPDATE items SET status='removed' WHERE id=$1 AND seller_id=$2 AND status='active'", [toInt(req.params.id), req.user.id]);
  if (!rowCount) return fail(res, 404, 'Listing not found');
  res.json({ ok: true });
}));

// Atomic purchase: row locks prevent double-buys and overspending.
app.post('/api/items/:id/buy', auth, wrap(async (req, res) => {
  const itemId = toInt(req.params.id);
  if (Number.isNaN(itemId)) return fail(res, 400, 'Bad item');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const it = (await c.query('SELECT * FROM items WHERE id=$1 FOR UPDATE', [itemId])).rows[0];
    if (!it || it.status !== 'active') { await c.query('ROLLBACK'); return fail(res, 409, 'Item is no longer available'); }
    if (it.seller_id === req.user.id) { await c.query('ROLLBACK'); return fail(res, 400, "You can't buy your own listing"); }
    const ids = [req.user.id, it.seller_id].sort((a, b) => a - b); // consistent lock order, no deadlocks
    await c.query('SELECT id FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
    const paid = await c.query('UPDATE users SET coins = coins - $1 WHERE id=$2 AND coins >= $1 RETURNING coins', [it.price, req.user.id]);
    if (!paid.rows[0]) { await c.query('ROLLBACK'); return fail(res, 400, 'Not enough coins. Buy more first.'); }
    await c.query('UPDATE users SET coins = coins + $1 WHERE id=$2', [it.price, it.seller_id]);
    await c.query("UPDATE items SET status='sold', buyer_id=$1 WHERE id=$2", [req.user.id, itemId]);
    await c.query("INSERT INTO transactions (user_id, kind, amount, note) VALUES ($1,'purchase',$2,$3),($4,'sale',$5,$3)",
      [req.user.id, -it.price, it.title, it.seller_id, it.price]);
    await c.query('COMMIT');
    res.json({ coins: paid.rows[0].coins });
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}));

app.use('/api', (_req, res) => fail(res, 404, 'Not found'));
// Last-resort error handler: log it, answer cleanly, keep the process alive.
app.use((err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) fail(res, 500, 'Something went wrong');
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT}`));
server.keepAliveTimeout = 120000; // longer than Render's proxy timeout
server.headersTimeout = 125000;
initDb();

// Render sends SIGTERM on deploy: finish requests, then exit.
process.on('SIGTERM', () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10000).unref();
});
       
