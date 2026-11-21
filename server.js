const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

let users = {};

// When user opens link, show index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Create Account
app.post('/api/signup', (req, res) => {
  const { name, phone, pin } = req.body;
  if (users[phone]) return res.json({ success: false, msg: "Account already exists. Please LOGIN" });
  users[phone] = { name, phone, pin, coins: 0, balance: 1000 };
  res.json({ success: true, msg: "Account Created! Bonus 1000 KSh", user: users[phone] });
});

// Login
app.post('/api/login', (req, res) => {
  const { phone, pin } = req.body;
  if (!users[phone]) return res.json({ success: false, msg: "No account. Please CREATE ACCOUNT first" });
  if (users[phone].pin !== pin) return res.json({ success: false, msg: "Wrong PIN" });
  res.json({ success: true, msg: "Welcome " + users[phone].name, user: users[phone] });
});

// Send - Check if receiver exists
app.post('/api/send', (req, res) => {
  const { fromPhone, toPhone, coins } = req.body;
  if (!users[toPhone]) return res.json({ success: false, msg: "❌ " + toPhone + " has NO account. Tell them to create account." });
  if (users[fromPhone].coins < coins) return res.json({ success: false, msg: "Not enough MES" });
  users[fromPhone].coins -= coins;
  users[toPhone].coins += coins;
  res.json({ success: true, msg: "Sent " + coins + " MES to " + users[toPhone].name, user: users[fromPhone] });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Running on " + PORT));
