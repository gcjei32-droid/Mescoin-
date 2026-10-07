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
app.use(express.json());

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

    pool.on("error", (err) => {
        console.error("Database error:", err.message);
    });

    console.log("DATABASE_URL found.");
} else {
    console.log("WARNING: DATABASE_URL is not set.");
}

// ======================================================
// CREATE DATABASE TABLES
// ======================================================

async function setupDatabase() {
    if (!pool) {
        console.log("Database setup skipped because DATABASE_URL is missing.");
        return;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(150) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                mes_balance NUMERIC(20,8) DEFAULT 100,
                cash_balance NUMERIC(20,2) DEFAULT 1000,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                type VARCHAR(10) NOT NULL,
                amount NUMERIC(20,8) NOT NULL,
                price NUMERIC(20,8) NOT NULL,
                status VARCHAR(20) DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                token TEXT UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("Database tables are ready.");
    } catch (error) {
        console.error("Database setup failed:", error.message);
    }
}

// ======================================================
// MESCOIN SETTINGS
// ======================================================

let mescoinPrice = 1.00;

// ======================================================
// PASSWORD FUNCTIONS
// ======================================================

function hashPassword(password) {
    return crypto
        .createHash("sha256")
        .update(password)
        .digest("hex");
}

function createToken() {
    return crypto.randomBytes(32).toString("hex");
}

// ======================================================
// AUTHENTICATION MIDDLEWARE
// ======================================================

async function authenticate(req, res, next) {
    if (!pool) {
        return res.status(500).json({
            success: false,
            message: "Database is not connected."
        });
    }

    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({
            success: false,
            message: "Please sign in."
        });
    }

    const token = authHeader.replace("Bearer ", "").trim();

    if (!token) {
        return res.status(401).json({
            success: false,
            message: "Invalid login token."
        });
    }

    try {
        const result = await pool.query(
            `
            SELECT users.*
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token = $1
            `,
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Session expired. Please sign in again."
            });
        }

        req.user = result.rows[0];

        next();

    } catch (error) {
        console.error("Authentication error:", error);

        res.status(500).json({
            success: false,
            message: "Authentication failed."
        });
    }
}

// ======================================================
// SERVER STATUS
// ======================================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        status: "online",
        message: "MesCoin server is running!",
        price: mescoinPrice,
        database: pool ? "configured" : "not configured"
    });
});

app.get("/api/status", async (req, res) => {

    let databaseStatus = "not connected";

    if (pool) {
        try {
            await pool.query("SELECT 1");
            databaseStatus = "connected";
        } catch (error) {
            databaseStatus = "error";
        }
    }

    res.json({
        success: true,
        status: "online",
        message: "MesCoin server is connected",
        price: mescoinPrice,
        database: databaseStatus,
        time: new Date().toISOString()
    });
});

// ======================================================
// SIGN UP
// ======================================================

app.post("/api/signup", async (req, res) => {

    if (!pool) {
        return res.status(500).json({
            success: false,
            message: "Database is not connected."
        });
    }

    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({
            success: false,
            message: "Username, email and password are required."
        });
    }

    if (password.length < 6) {
        return res.status(400).json({
            success: false,
            message: "Password must contain at least 6 characters."
        });
    }

    try {

        const existing = await pool.query(
            `
            SELECT id
            FROM users
            WHERE username = $1 OR email = $2
            `,
            [username, email]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: "Username or email already exists."
            });
        }

        const passwordHash = hashPassword(password);

        const result = await pool.query(
            `
            INSERT INTO users
            (username, email, password_hash, mes_balance, cash_balance)
            VALUES ($1, $2, $3, 100, 1000)
            RETURNING id, username, email, mes_balance, cash_balance, created_at
            `,
            [username, email, passwordHash]
        );

        const user = result.rows[0];

        const token = createToken();

        await pool.query(
            `
            INSERT INTO sessions
            (user_id, token)
            VALUES ($1, $2)
            `,
            [user.id, token]
        );

        res.json({
            success: true,
            message: "Account created successfully.",
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                mesBalance: Number(user.mes_balance),
                cashBalance: Number(user.cash_balance)
            }
        });

    } catch (error) {

        console.error("Signup error:", error);

        res.status(500).json({
            success: false,
            message: "Could not create account."
        });
    }
});

// ======================================================
// LOGIN
// ======================================================

app.post("/api/login", async (req, res) => {

    if (!pool) {
        return res.status(500).json({
            success: false,
            message: "Database is not connected."
        });
    }

    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({
            success: false,
            message: "Email and password are required."
        });
    }

    try {

        const passwordHash = hashPassword(password);

        const result = await pool.query(
            `
            SELECT *
            FROM users
            WHERE email = $1
            `,
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        const user = result.rows[0];

        if (user.password_hash !== passwordHash) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password."
            });
        }

        const token = createToken();

        await pool.query(
            `
            INSERT INTO sessions
            (user_id, token)
            VALUES ($1, $2)
            `,
            [user.id, token]
        );

        res.json({
            success: true,
            message: "Login successful.",
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                mesBalance: Number(user.mes_balance),
                cashBalance: Number(user.cash_balance)
            }
        });

    } catch (error) {

        console.error("Login error:", error);

        res.status(500).json({
            success: false,
            message: "Login failed."
        });
    }
});

// ======================================================
// LOGOUT
// ======================================================

app.post("/api/logout", authenticate, async (req, res) => {

    const token = req.headers.authorization
        .replace("Bearer ", "")
        .trim();

    try {

        await pool.query(
            `
            DELETE FROM sessions
            WHERE token = $1
            `,
            [token]
        );

        res.json({
            success: true,
            message: "Logged out successfully."
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            message: "Logout failed."
        });
    }
});

// ======================================================
// ACCOUNT INFORMATION
// ======================================================

app.get("/api/account", authenticate, async (req, res) => {

    res.json({
        success: true,
        user: {
            id: req.user.id,
            username: req.user.username,
            email: req.user.email,
            mesBalance: Number(req.user.mes_balance),
            cashBalance: Number(req.user.cash_balance)
        }
    });
});

// ======================================================
// BUY MESCOIN
// ======================================================

app.post("/api/buy", authenticate, async (req, res) => {

    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid amount."
        });
    }

    const totalCost = amount * mescoinPrice;

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        const userResult = await client.query(
            `
            SELECT *
            FROM users
            WHERE id = $1
            FOR UPDATE
            `,
            [req.user.id]
        );

        const user = userResult.rows[0];

        if (Number(user.cash_balance) < totalCost) {

            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message: "Insufficient cash balance."
            });
        }

        const newCash =
            Number(user.cash_balance) - totalCost;

        const newMes =
            Number(user.mes_balance) + amount;

        await client.query(
            `
            UPDATE users
            SET cash_balance = $1,
                mes_balance = $2
            WHERE id = $3
            `,
            [newCash, newMes, req.user.id]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            action: "buy",
            amount,
            price: mescoinPrice,
            total: totalCost,
            mesBalance: newMes,
            cashBalance: newCash,
            message: "MesCoin purchased successfully."
        });

    } catch (error) {

        await client.query("ROLLBACK");

        console.error("Buy error:", error);

        res.status(500).json({
            success: false,
            message: "Buy transaction failed."
        });

    } finally {
        client.release();
    }
});

// ======================================================
// SELL MESCOIN
// ======================================================

app.post("/api/sell", authenticate, async (req, res) => {

    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            success: false,
            message: "Enter a valid amount."
        });
    }

    const client = await pool.connect();

    try {

        await client.query("BEGIN");

        const userResult = await client.query(
            `
            SELECT *
            FROM users
            WHERE id = $1
            FOR UPDATE
            `,
            [req.user.id]
        );

        const user = userResult.rows[0];

        if (Number(user.mes_balance) < amount) {

            await client.query("ROLLBACK");

            return res.status(400).json({
                success: false,
                message: "Insufficient MesCoin balance."
            });
        }

        const moneyReceived =
            amount * mescoinPrice;

        const newMes =
            Number(user.mes_balance) - amount;

        const newCash =
            Number(user.cash_balance) + moneyReceived;

        await client.query(
            `
            UPDATE users
            SET mes_balance = $1,
                cash_balance = $2
            WHERE id = $3
            `,
            [newMes, newCash, req.user.id]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            action: "sell",
            amount,
            price: mescoinPrice,
            total: moneyReceived,
            mesBalance: newMes,
            cashBalance: newCash,
            message: "MesCoin sold successfully."
        });

    } catch (error) {

        await client.query("ROLLBACK");

        console.error("Sell error:", error);

        res.status(500).json({
            success: false,
            message: "Sell transaction failed."
        });

    } finally {
        client.release();
    }
});

// ======================================================
// CREATE MARKETPLACE ORDER
// ======================================================

app.post("/api/orders", authenticate, async (req, res) => {

    const { type, amount, price } = req.body;

    const orderAmount = Number(amount);
    const orderPrice = Number(price);

    if (!["buy", "sell"].includes(type)) {
        return res.status(400).json({
            success: false,
            message: "Order type must be buy or sell."
        });
    }

    if (
        !Number.isFinite(orderAmount) ||
        orderAmount <= 0 ||
        !Number.isFinite(orderPrice) ||
        orderPrice <= 0
    ) {
        return res.status(400).json({
            success: false,
            message: "Invalid order information."
        });
    }

    try {

        const result = await pool.query(
            `
            INSERT INTO orders
            (user_id, type, amount, price, status)
            VALUES ($1, $2, $3, $4, 'open')
            RETURNING *
            `,
            [
                req.user.id,
                type,
                orderAmount,
                orderPrice
            ]
        );

        res.json({
            success: true,
            message: "Order created successfully.",
            order: result.rows[0]
        });

    } catch (error) {

        console.error("Order error:", error);

        res.status(500).json({
            success: false,
            message: "Could not create order."
        });
    }
});

// ======================================================
// GET OPEN MARKETPLACE ORDERS
// ======================================================

app.get("/api/orders", async (req, res) => {

    if (!pool) {
        return res.status(500).json({
            success: false,
            message: "Database is not connected."
        });
    }

    try {

        const result = await pool.query(
            `
            SELECT
                orders.id,
                orders.type,
                orders.amount,
                orders.price,
                orders.status,
                orders.created_at,
                users.username
            FROM orders
            JOIN users
            ON users.id = orders.user_id
            WHERE orders.status = 'open'
            ORDER BY orders.created_at DESC
            `
        );

        res.json({
            success: true,
            orders: result.rows
        });

    } catch (error) {

        console.error("Orders error:", error);

        res.status(500).json({
            success: false,
            message: "Could not load orders."
        });
    }
});

// ======================================================
// CLOSE / CANCEL ORDER
// ======================================================

app.delete("/api/orders/:id", authenticate, async (req, res) => {

    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId)) {
        return res.status(400).json({
            success: false,
            message: "Invalid order ID."
        });
    }

    try {

        const result = await pool.query(
            `
            UPDATE orders
            SET status = 'cancelled'
            WHERE id = $1
            AND user_id = $2
            AND status = 'open'
            RETURNING *
            `,
            [orderId, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Order not found or already closed."
            });
        }

        res.json({
            success: true,
            message: "Order cancelled.",
            order: result.rows[0]
        });

    } catch (error) {

        console.error("Cancel order error:", error);

        res.status(500).json({
            success: false,
            message: "Could not cancel order."
        });
    }
});

// ======================================================
// PRICE
// ======================================================

app.get("/api/price", (req, res) => {

    res.json({
        success: true,
        currency: "MES",
        price: mescoinPrice
    });
});

// ======================================================
// CHANGE PRICE
// ======================================================

app.post("/api/price", (req, res) => {

    const price = Number(req.body.price);

    if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({
            success: false,
            message: "Invalid price."
        });
    }

    mescoinPrice = price;

    res.json({
        success: true,
        price: mescoinPrice,
        message: "MesCoin price updated."
    });
});

// ====
