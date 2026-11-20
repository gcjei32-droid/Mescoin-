const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

// Fake Database - in memory
let users = {};
let price = 125.50;
let history = [];

// Home - open app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Get Price - for app to know price
app.get('/api/price', (req, res) => {
  // Price moves like real coin
  price += (Math.random() - 0.45) * 2;
  res.json({ price: price.toFixed(2), name: "MESCOIN" });
});

// Buy Coin
app.post('/api/buy', (req, res) => {
  const { phone, amount } = req.body;
  const coins = amount / price;
  history.push({ type: 'BUY', phone, amount, coins, time: new Date() });
  res.json({ success: true, message: `Bought ${coins.toFixed(2)} MES`, coins });
});

// Sell Coin
app.post('/api/sell', (req, res) => {
  const { phone, amount } = req.body;
  const coins = amount / price;
  history.push({ type: 'SELL', phone, amount, coins, time: new Date() });
  res.json({ success: true, message: `Sold ${coins.toFixed(2)} MES`, coins });
});

// Send Coin
app.post('/api/send', (req, res) => {
  const { from, to, amount } = req.body;
  history.push({ type: 'SEND', from, to, amount, time: new Date() });
  res.json({ success: true, message: `Sent ${amount} MES to ${to}` });
});

// History
app.get('/api/history', (req, res) => {
  res.json(history);
});

// Render needs this port
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Mescoin running on port ' + PORT);
});
