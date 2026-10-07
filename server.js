const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// BASIC SETUP
// ======================================================

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ======================================================
// DATABASE
// ======================================================

let pool = null;

if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });
}

// ======================================================
// PASSWORD FUNCTIONS
// ======================================================

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");

    const hash = crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

    return `${salt}:${hash}`;
}

function checkPassword(password, storedPassword) {
    try {
        const parts = storedPassword.split(":");

        if (parts.length !== 2) {
            return false;
        }

        const salt = parts[0];
        const originalHash = parts[1];

        const hash = crypto
            .scryptSync(password, salt, 64)
            .toString("hex");

        return crypto.timingSafeEqual(
            Buffer.from(hash, "hex"),
            Buffer.from(originalHash, "hex")
        );
    } catch {
        return false;
    }
}

// ======================================================
// DATABASE SETUP
// ======================================================

async function setupDatabase() {
    if (!pool) {
        console.log("DATABASE_URL is not configured.");
        return;
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            mes_balance NUMERIC(20,8) NOT NULL DEFAULT 100,
            cash_balance NUMERIC(20,2) NOT NULL DEFAULT 1000,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            id SERIAL PRIMARY KEY,
            token TEXT UNIQUE NOT NULL,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS trades (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            action TEXT NOT NULL,
            amount NUMERIC(20,8) NOT NULL,
            price NUMERIC(20,8) NOT NULL,
            total NUMERIC(20,2) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS marketplace_orders (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            amount NUMERIC(20,8) NOT NULL,
            price NUMERIC(20,8) NOT NULL,
            status TEXT NOT NULL DEFAULT 'OPEN',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS marketplace_messages (
            id SERIAL PRIMARY KEY,
            order_id INTEGER NOT NULL REFERENCES marketplace_orders(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            message TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log("Database tables ready.");
}

// ======================================================
// AUTH MIDDLEWARE
// ======================================================

async function authenticate(req, res, next) {
    if (!pool) {
        return res.status(500).json({
            success: false,
            message: "Database is not configured on the server."
        });
    }

    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) {
        return res.status(401).json({
            success: false,
            message: "Please login first."
        });
    }

    const token = auth.substring(7);

    try {
        const result = await pool.query(`
            SELECT
                users.id,
                users.name,
                users.email,
                users.mes_balance,
                users.cash_balance
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token = $1
        `, [token]);

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Session expired. Please login again."
            });
        }

        req.user = result.rows[0];
        next();

    } catch (error) {
        console.error(error);

        return res.status(500).json({
            success: false,
            message: "Authentication failed."
        });
    }
}

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/api/status", async (req, res) => {
    let database = "not configured";

    if (pool) {
        try {
            await pool.query("SELECT 1");
            database = "connected";
        } catch {
            database = "error";
        }
    }

    res.json({
        success: true,
        status: "online",
        server: "MesCoin server",
        database,
        time: new Date().toISOString()
    });
});

// ======================================================
// HOME
// ======================================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        status: "online",
        message: "MesCoin server is running"
    });
});

// ======================================================
// CREATE ACCOUNT
// ======================================================

app.post("/api/auth/register", async (req, res) => {
    if (!pool) {
        return res.status(500).json({
            success: false,
            message: "Database is not configured."
        });
    }

    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !email || !password) {
        return res.status(400).json({
            success: false,
            message: "Name, email and password are required."
        });
    }

    if (password.length < 4) {
        return res.status(400).json({
            success: false,
            message: "Password must be at least 4 characters."
        });
    }

    try {
        const existing = await pool.query(
            "SELECT id FROM users WHERE email = $1",
            [email]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: "An account with this email already exists."
            });
        }

        const passwordHash = hashPassword(password);

        const result = await pool.query(`
            INSERT INTO users
            (name, email, password, mes_balance, cash_balance)
            VALUES ($1, $2, $3, 100, 1000)
            RETURNING id, name, email, mes_balance, cash_balance
        `, [
            name,
            email,
            passwordHash
        ]);

        const user = result.rows[0];

        const token = crypto.randomBytes(32).toString("hex");

        await pool.query(`
            INSERT INTO sessions (token, user_id)
            VALUES ($1, $2)
        `, [
            token,
            user.id
        ]);

        return res.status(201).json({
            success: true,
            message: "Account created successfully.",
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                mesBalance: Number(user.mes_balance),
                cashBalance: Number(user.cash_balance)
            }
        });

    } catch (error) {
        console.error("REGISTER ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Could not create account."
        });
    }
});

// ======================================================
// LOGIN
// ======================================================

app.post("/api/auth/login", async (req, res) => {
    if (!pool) {
        return res.status(500).json({
            success: false,
            message: "Database is not configured."
        });
    }

    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: "Email and password are required."
        });
    }

    try {
        const result = await pool.query(
            "SELECT * FROM users WHERE email = $1",
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Incorrect email or password."
            });
        }

        const user = result.rows[0];

        if (!checkPassword(password, user.password)) {
            return res.status(401).json({
                success: false,
                message: "Incorrect email or password."
            });
        }

        const token = crypto.randomBytes(32).toString("hex");

        await pool.query(`
            INSERT INTO sessions (token, user_id)
            VALUES ($1, $2)
        `, [
            token,
            user.id
        ]);

        return res.json({
            success: true,
            message: "Login successful.",
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                mesBalance: Number(user.mes_balance),
                cashBalance: Number(user.cash_balance)
            }
        });

    } catch (error) {
        console.error("LOGIN ERROR:", error);

        return res.status(500).json({
            success: false,
            message: "Login failed."
        });
    }
});

// ======================================================
// LOGOUT
// ======================================================

app.post("/api/auth/logout", authenticate, async (req, res) => {
    const token = req.headers.authorization.substring(7);

    await pool.query(
        "DELETE FROM sessions WHERE token = $1",
        [token]
    );

    res.json({
        success: true,
        message: "Logged out."
    });
});

// ======================================================
// PROFILE / PORTFOLIO
// ======================================================

app.get("/api/me", authenticate, async (req, res) => {
    res.json({
        success: true,
        user: {
            id: req.user.id,
            name: req.user.name,
            email: req.user.email,
            mesBalance: Number(req.user.mes_balance),
            cashBalance: Number(req.user.cash_balance)
        }
    });
});

app.get("/api/portfolio", authenticate, async (req, res) => {
    const price = 1;

    const mesBalance = Number(req.user.mes_balance);
    const cashBalance = Number(req.user.cash_balance);

    res.json({
        success: true,
        portfolio: {
            mesBalance,
            cashBalance,
            mesValue: mesBalance * price,
            totalValue: cashBalance + mesBalance * price
        }
    });
});

// ======================================================
// MARKET PRICE
// ======================================================

let mesPrice = 1.00;

app.get("/api/market", (req, res) => {
    const movement = (Math.random() - 0.5) * 0.04;

    mesPrice += movement;

    if (mesPrice < 0.10) {
        mesPrice = 0.10;
    }

    res.json({
        success: true,
        symbol: "MES",
        price: Number(mesPrice.toFixed(4)),
        time: new Date().toISOString()
    });
});

// ======================================================
// BUY MES
// ======================================================

app.post("/api/trade/buy", authenticate, async (req, res) => {
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid MES amount."
        });
    }

    const price = mesPrice;
    const total = amount * price;

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const locked = await client.query(`
            SELECT *
            FROM users
            WHERE id = $1
            FOR UPDATE
        `, [req.user.id]);

        const user = locked.rows[0];

        if (Number(user.cash_balance) < total) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message: "Insufficient cash balance."
            });
        }

        const updated = await client.query(`
            UPDATE users
            SET
                cash_balance = cash_balance - $1,
                mes_balance = mes_balance + $2
            WHERE id = $3
            RETURNING mes_balance, cash_balance
        `, [
            total,
            amount,
            req.user.id
        ]);

        await client.query(`
            INSERT INTO trades
            (user_id, action, amount, price, total)
            VALUES ($1, 'BUY', $2, $3, $4)
        `, [
            req.user.id,
            amount,
            price,
            total
        ]);

        await client.query("COMMIT");

        res.json({
            success: true,
            message: "Buy successful.",
            action: "BUY",
            amount,
            price,
            total,
            mesBalance: Number(updated.rows[0].mes_balance),
            cashBalance: Number(updated.rows[0].cash_balance)
        });

    } catch (error) {
        await client.query("ROLLBACK");

        console.error("BUY ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Buy failed."
        });

    } finally {
        client.release();
    }
});

// ======================================================
// SELL MES
// ======================================================

app.post("/api/trade/sell", authenticate, async (req, res) => {
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid MES amount."
        });
    }

    const price = mesPrice;
    const total = amount * price;

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const locked = await client.query(`
            SELECT *
            FROM users
            WHERE id = $1
            FOR UPDATE
        `, [req.user.id]);

        const user = locked.rows[0];

        if (Number(user.mes_balance) < amount) {
            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message: "Insufficient MES balance."
            });
        }

        const updated = await client.query(`
            UPDATE users
            SET
                mes_balance = mes_balance - $1,
                cash_balance = cash_balance + $2
            WHERE id = $3
            RETURNING mes_balance, cash_balance
        `, [
            amount,
            total,
            req.user.id
        ]);

        await client.query(`
            INSERT INTO trades
            (user_id, action, amount, price, total)
            VALUES ($1, 'SELL', $2, $3, $4)
        `, [
            req.user.id,
            amount,
            price,
            total
        ]);

        await client.query("COMMIT");

        res.json({
            success: true,
            message: "Sell successful.",
            action: "SELL",
            amount,
            price,
            total,
            mesBalance: Number(updated.rows[0].mes_balance),
            cashBalance: Number(updated.rows[0].cash_balance)
        });

    } catch (error) {
        await client.query("ROLLBACK");

        console.error("SELL ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Sell failed."
        });

    } finally {
        client.release();
    }
});

// ======================================================
// TRADE HISTORY
// ======================================================

app.get("/api/trades", authenticate, async (req, res) => {
    const result = await pool.query(`
        SELECT
            id,
            action,
            amount,
            price,
            total,
            created_at
        FROM trades
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100
    `, [req.user.id]);

    res.json({
        success: true,
        trades: result.rows
    });
});

// ======================================================
// MARKETPLACE - CREATE ORDER
// ======================================================

app.post("/api/marketplace/orders", authenticate, async (req, res) => {
    const type = String(req.body.type || "").toUpperCase();
    const amount = Number(req.body.amount);
    const price = Number(req.body.price);

    if (!["BUY", "SELL"].includes(type)) {
        return res.status(400).json({
            success: false,
            message: "Order type must be BUY or SELL."
        });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid amount."
        });
    }

    if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid price."
        });
    }

    try {
        const result = await pool.query(`
            INSERT INTO marketplace_orders
            (user_id, type, amount, price)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `, [
            req.user.id,
            type,
            amount,
            price
        ]);

        res.status(201).json({
            success: true,
            message: "Marketplace order created.",
            order: result.rows[0]
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Could not create marketplace order."
        });
    }
});

// ======================================================
// MARKETPLACE - LIST ORDERS
// ======================================================

app.get("/api/marketplace/orders", authenticate, async (req, res) => {
    const result = await pool.query(`
        SELECT
            marketplace_orders.id,
            marketplace_orders.type,
            marketplace_orders.amount,
            marketplace_orders.price,
            marketplace_orders.status,
            marketplace_orders.created_at,
            users.name AS seller_name
        FROM marketplace_orders
        JOIN users ON users.id = marketplace_orders.user_id
        WHERE marketplace_orders.status = 'OPEN'
        ORDER BY marketplace_orders.created_at DESC
        LIMIT 100
    `);

    res.json({
        success: true,
        orders: result.rows
    });
});

// =============
