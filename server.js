const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// --- DATABASE saved in file so accounts don't disappear ---
let DB_FILE = path.join(__dirname, 'db.json');
let db = { users: {}, goods: [], price: 125.50 };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE));
function save(){ fs.writeFileSync(DB_FILE, JSON.stringify(db)); }

// Add some goods at start if empty
if(db.goods.length===0){
  db.goods=[
    {id:1, title:"2kg Maize Flour", price:5, seller:"mescoin", phone:"0722000000", img:"🌽"},
    {id:2, title:"1L Milk", price:2, seller:"mama mboga", phone:"0722111222", img:"🥛"},
    {id:3, title:"Airtime 100", price:1, seller:"mescoin", phone:"0722000000", img:"📱"},
  ]; save();
}

app.get('/', (req,res)=> res.sendFile(path.join(__dirname,'index.html')));

// SIGN UP - server creates account
app.post('/api/signup', (req,res)=>{
  const {name, phone, pin} = req.body;
  if(!name||!phone||!pin) return res.json({success:false,msg:"Fill all"});
  if(db.users[phone]) return res.json({success:false,msg:"Account already exists, Login"});
  db.users[phone]={name, phone, pin, balance:1000, coins:0}; // New user gets 1000 KSh bonus
  save();
  res.json({success:true, msg:"Account created! You got 1000 KSh bonus", user:db.users[phone]});
});

// LOGIN
app.post('/api/login', (req,res)=>{
  const {phone, pin} = req.body;
  let u = db.users[phone];
  if(!u) return res.json({success:false,msg:"No account with this phone. Sign Up first"});
  if(u.pin!==pin) return res.json({success:false,msg:"Wrong PIN"});
  res.json({success:true, user:u});
});

// GET PRICE
app.get('/api/price', (req,res)=>{
  db.price += (Math.random()-0.45)*2; save();
  res.json({price:db.price});
});

// BUY MESCOIN
app.post('/api/buy', (req,res)=>{
  const {phone, ksh} = req.body;
  let u=db.users[phone]; if(!u) return res.json({success:false,msg:"Login first"});
  if(ksh>u.balance) return res.json({success:false,msg:"Not enough KSh"});
  let coins = ksh/db.price;
  u.balance-=ksh; u.coins+=coins; save();
  res.json({success:true,msg:`Bought ${coins.toFixed(2)} MES`, user:u});
});

// SELL MESCOIN
app.post('/api/sell', (req,res)=>{
  const {phone, coins} = req.body;
  let u=db.users[phone]; if(!u) return res.json({success:false,msg:"Login first"});
  if(coins>u.coins) return res.json({success:false,msg:"Not enough MES"});
  let ksh = coins*db.price;
  u.coins-=coins; u.balance+=ksh; save();
  res.json({success:true,msg:`Sold for KSh ${ksh.toFixed(0)}`, user:u});
});

// SEND - ONLY TO EXISTING ACCOUNT
app.post('/api/send', (req,res)=>{
  const {fromPhone, toPhone, coins} = req.body;
  let sender=db.users[fromPhone];
  let receiver=db.users[toPhone];
  if(!receiver) return res.json({success:false,msg:"❌ This number has NO Mescoin account. Ask them to Sign Up first."});
  if(!sender) return res.json({success:false,msg:"Login first"});
  if(coins>sender.coins) return res.json({success:false,msg:"Not enough MES"});
  sender.coins-=coins; receiver.coins+=coins; save();
  res.json({success:true,msg:`Sent ${coins} MES to ${receiver.name} (${toPhone})`, user:sender});
});

// MARKETPLACE - List goods
app.get('/api/goods', (req,res)=> res.json(db.goods));

// MARKETPLACE - Add good
app.post('/api/goods', (req,res)=>{
  const {title, price, seller, phone} = req.body;
  let g={id:Date.now(), title, price:parseFloat(price), seller, phone, img:"🛒"};
  db.goods.unshift(g); save(); res.json({success:true, goods:db.goods});
});

// MARKETPLACE - Buy good with MES
app.post('/api/buy-good', (req,res)=>{
  const {phone, id} = req.body;
  let u=db.users[phone]; let g=db.goods.find(x=>x.id==id);
  if(!g) return res.json({success:false,msg:"Good not found"});
  if(u.coins < g.price) return res.json({success:false,msg:"Not enough MES. Buy MES first"});
  // Check seller exists
  let sellerUser = db.users[g.phone];
  u.coins-=g.price;
  if(sellerUser) sellerUser.coins+=g.price;
  db.goods=db.goods.filter(x=>x.id!=id); save();
  res.json({success:true,msg:`You bought ${g.title} for ${g.price} MES`, user:u});
});

app.get('*', (req,res)=> res.sendFile(path.join(__dirname,'index.html')));
const PORT=process.env.PORT||10000;
app.listen(PORT, ()=>console.log('Mescoin Live '+PORT));
