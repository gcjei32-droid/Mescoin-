const express = require("express"); 
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// BASIC SETUP
// ===============================

app.use(cors());
app.use(express.json());

// Serve frontend if public folder exists
app.use(express.static(path.join(__dirname, "public")));

// ===============================
// MESCOIN DATA
// ===============================

let mescoinPrice = 1.00;

let users = [];

let orders = [];

let nextUserId = 1;
let nextOrderId = 1;

// ===============================
// HOME
// ===============================

app.get("/", (req, res) => {
    res.json({
        success: true,
        status: "online",
        message: "MesCoin server is running!",
        price: mescoinPrice
    });
});

// ===============================
// SERVER STATUS
// ===============================

app.get("/api/status", (req, res) => {
    res.json({
        success: true,
        status: "online",
        message: "MesCoin server is connected",
        price: mescoinPrice
    });
});

// ===============================
// REGISTER
// ===============================

app.post("/api/register", (req, res) => {

    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({
            success: false,
            message: "Username, email and password are required"
        });
    }

    const existingUser = users.find(
        user => user.email === email
    );

    if (existingUser) {
        return res.status(400).json({
            success: false,
            message: "Email already registered"
        });
    }

    const user = {
        id: nextUserId++,
        username,
        email,
        password,
        mescoin: 0,
        cash: 1000
    };

    users.push(user);

    res.json({
        success: true,
        message: "Account created successfully",
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            mescoin: user.mescoin,
            cash: user.cash
        }
    });
});

// ===============================
// LOGIN
// ===============================

app.post("/api/login", (req, res) => {

    const { email, password } = req.body;

    const user = users.find(
        user =>
            user.email === email &&
            user.password === password
    );

    if (!user) {
        return res.status(401).json({
            success: false,
            message: "Invalid email or password"
        });
    }

    res.json({
        success: true,
        message: "Login successful",
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            mescoin: user.mescoin,
            cash: user.cash
        }
    });
});

// ===============================
// PORTFOLIO
// ===============================

app.get("/api/portfolio/:userId", (req, res) => {

    const user = users.find(
        user => user.id === Number(req.params.userId)
    );

    if (!user) {
        return res.status(404).json({
            success: false,
            message: "User not found"
        });
    }

    const mesValue = user.mescoin * mescoinPrice;

    res.json({
        success: true,
        portfolio: {
            mescoin: user.mescoin,
            cash: user.cash,
            price: mescoinPrice,
            mesValue: mesValue,
            totalValue: user.cash + mesValue
        }
    });
});

// ===============================
// BUY MESCOIN
// ===============================

app.post("/api/buy", (req, res) => {

    const { userId, amount } = req.body;

    const user = users.find(
        user => user.id === Number(userId)
    );

    if (!user) {
        return res.status(404).json({
            success: false,
            message: "User not found"
        });
    }

    const quantity = Number(amount);

    if (!quantity || quantity <= 0) {
        return res.status(400).json({
            success: false,
            message: "Invalid amount"
        });
    }

    const cost = quantity * mescoinPrice;

    if (user.cash < cost) {
        return res.status(400).json({
            success: false,
            message: "Insufficient cash balance"
        });
    }

    user.cash -= cost;
    user.mescoin += quantity;

    res.json({
        success: true,
        message: "MesCoin purchased successfully",
        mescoin: user.mescoin,
        cash: user.cash,
        price: mescoinPrice
    });
});

// ===============================
// SELL MESCOIN
// ===============================

app.post("/api/sell", (req, res) => {

    const { userId, amount } = req.body;

    const user = users.find(
        user => user.id === Number(userId)
    );

    if (!user) {
        return res.status(404).json({
            success: false,
            message: "User not found"
        });
    }

    const quantity = Number(amount);

    if (!quantity || quantity <= 0) {
        return res.status(400).json({
            success: false,
            message: "Invalid amount"
        });
    }

    if (user.mescoin < quantity) {
        return res.status(400).json({
            success: false,
            message: "Insufficient MesCoin balance"
        });
    }

    const value = quantity * mescoinPrice;

    user.mescoin -= quantity;
    user.cash += value;

    res.json({
        success: true,
        message: "MesCoin sold successfully",
        mescoin: user.mescoin,
        cash: user.cash,
        price: mescoinPrice
    });
});

// ===============================
// MARKETPLACE - CREATE ORDER
// ===============================

app.post("/api/orders", (req, res) => {

    const {
        userId,
        type,
        amount,
        price
    } = req.body;

    if (!userId || !type || !amount || !price) {
        return res.status(400).json({
            success: false,
            message: "Missing order information"
        });
    }

    const order = {
        id: nextOrderId++,
        userId: Number(userId),
        type,
        amount: Number(amount),
        price: Number(price),
        status: "open",
        createdAt: new Date().toISOString()
    };

    orders.push(order);

    res.json({
        success: true,
        message: "Order created successfully",
        order
    });
});

// ===============================
// GET MARKETPLACE ORDERS
// ===============================

app.get("/api/orders", (req, res) => {

    res.json({
        success: true,
        orders
    });
});

// ===============================
// SERVER START
// ===============================

app.listen(PORT, "0.0.0.0", () => {

    console.log("=================================");
    console.log("MesCoin server is running");
    console.log("Port:", PORT);
    console.log("Status: ONLINE");
    console.log("=================================");

});
