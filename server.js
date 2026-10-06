const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve the frontend if the public folder exists
app.use(express.static(path.join(__dirname, "public")));

// Simple MesCoin data
let mescoinBalance = 100;
let cashBalance = 1000;
let mescoinPrice = 1;

// ===============================
// HOME / SERVER STATUS
// ===============================
app.get("/", (req, res) => {
  res.json({
    success: true,
    status: "online",
    message: "MesCoin server is running!",
    price: mescoinPrice,
    balance: mescoinBalance,
    cash: cashBalance
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
// BALANCE
// ===============================
app.get("/api/balance", (req, res) => {
  res.json({
    success: true,
    mescoin: mescoinBalance,
    cash: cashBalance,
    price: mescoinPrice
  });
});

// ===============================
// BUY MESCOIN
// ===============================
app.post("/api/buy", (req, res) => {
  const amount = Number(req.body.amount);

  if (!amount || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid amount"
    });
  }

  const totalCost = amount * mescoinPrice;

  if (totalCost > cashBalance) {
    return res.status(400).json({
      success: false,
      message: "Insufficient cash balance"
    });
  }

  mescoinBalance += amount;
  cashBalance -= totalCost;

  res.json({
    success: true,
    message: "MesCoin purchased successfully",
    amount: amount,
    price: mescoinPrice,
    total: totalCost,
    mescoin: mescoinBalance,
    cash: cashBalance
  });
});

// ===============================
// SELL MESCOIN
// ===============================
app.post("/api/sell", (req, res) => {
  const amount = Number(req.body.amount);

  if (!amount || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid amount"
    });
  }

  if (amount > mescoinBalance) {
    return res.status(400).json({
      success: false,
      message: "Insufficient MesCoin balance"
    });
  }

  const totalValue = amount * mescoinPrice;

  mescoinBalance -= amount;
  cashBalance += totalValue;

  res.json({
    success: true,
    message: "MesCoin sold successfully",
    amount: amount,
    price: mescoinPrice,
    total: totalValue,
    mescoin: mescoinBalance,
    cash: cashBalance
  });
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MesCoin server running on port ${PORT}`);
});
