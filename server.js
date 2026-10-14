const express = require('express');
const fs = require('fs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const app = express();
app.use(cors());
app.use(express.json());

const SECRET = 'mescoin-secret-2026';
const DB_FILE = fs.existsSync('/data')? '/data/database.json' : './database.json';

function calculateHash(prev_hash, timestamp, transactions, nonce){
  return crypto.createHash('sha256').update(prev_hash + timestamp + JSON.stringify(transactions) + nonce).digest('hex');
}
function createGenesisBlock(){
  let timestamp = new Date().toISOString();
  let transactions = [{from: "GENESIS", to: "NETWORK", amount: 0, note: "Genesis Block"}];
  let prev_hash = "0";
  let nonce = 0;
  let hash = calculateHash(prev_hash, timestamp, transactions, nonce);
  return {index:0, prev_hash, timestamp, transactions, nonce, hash};
}
function getLastBlock(){ return blockchain[blockchain.length-1]; }
function mineBlock(transactions){
  let prevBlock = getLastBlock();
  let index = prevBlock.index + 1;
  let timestamp = new Date().toISOString();
  let prev_hash = prevBlock.hash;
  let nonce = 0;
  let hash = "";
  do{
    nonce++;
    hash = calculateHash(prev_hash, timestamp, transactions, nonce);
  } while(!hash.startsWith("00"));
  return {index, prev_hash, timestamp, transactions, nonce, hash};
}
function isChainValid(chain){
  for(let i=1;i<chain.length;i++){
    let curr = chain[i];
    let prev = chain[i-1];
    if(curr.prev_hash!== prev.hash) return false;
    if(curr.hash!== calculateHash(curr.prev_hash, curr.timestamp, curr.transactions, curr.nonce)) return false;
    if(!curr.hash.startsWith("00")) return false;
  }
  return true;
}
function getBalanceFromChain(mes_account){
  let balance = 0;
  let acc = mes_account.toUpperCase();
  for(let block of blockchain){
    for(let tx of block.transactions){
      if(tx.to && tx.to.toUpperCase() === acc) balance += Number(tx.amount);
      if(tx.from && tx.from.toUpperCase() === acc) balance -= Number(tx.amount);
    }
  }
  return balance;
}
function addToBlockchain(transactions){
  let newBlock = mineBlock(transactions);
  blockchain.push(newBlock);
  save();
  return newBlock;
}

function loadDB(){
  if(!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({users:[], orders:[], trades:[], blockchain:[createGenesisBlock()]}));
  let raw = JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
  if(!raw.blockchain || raw.blockchain.length===0){
    raw.blockchain = [createGenesisBlock()];
  }
  return raw;
}
function saveDB(d){ fs.writeFileSync(DB_FILE, JSON.stringify(d,null,2)); }
let db=loadDB();
let users=db.users||[];
let orders=db.orders||[];
let trades=db.trades||[];
let blockchain=db.blockchain||[createGenesisBlock()];
function save(){ saveDB({users,orders,trades,blockchain}); }

const FOUNDER_PHONE = "254768871831";
const FOUNDER_AMOUNT = 100000000;
function cleanPhone(p){ return (p||'').toString().replace(/\D/g,'').slice(-10); }

(function fundFounderOnBoot(){
  try{
    let founder = users.find(u => cleanPhone(u.phone) === cleanPhone(FOUNDER_PHONE));
    if(founder){
      let already = blockchain.some(b => b.transactions.some(tx => tx.to === founder.mes_account && tx.from === "GENESIS_BANK_100M"));
      if(!already){
        founder.mes_balance = FOUNDER_AMOUNT;
        let block = mineBlock([{from:"GENESIS_BANK_100M", to: founder.mes_account, amount: FOUNDER_AMOUNT, note:"Founder 100M allocation"}]);
        blockchain.push(block);
        saveDB({users,orders,trades,blockchain});
        console.log("FOUNDER 100M FUNDED: "+founder.mes_account);
      }
    }
  }catch(e){ console.log("Founder boot error", e.message); }
})();

function auth(req,res,next){
  try{
    let t=req.headers.authorization?.split(' ')[1];
    let dec=jwt.verify(t,SECRET);
    req.user=users.find(u=>u.id===dec.id);
    if(!req.user) return res.status(401).json({error:'User not found'});
    next();
  }catch{ return res.status(401).json({error:'Invalid token'}); }
}

app.get('/api/price', (req,res)=>res.json({price:2}));
app.get('/api/blockchain', (req,res)=>{
  res.json({length: blockchain.length, valid: isChainValid(blockchain), chain: blockchain.slice(-10).reverse()});
});
app.get('/api/blockchain/balance/:account', (req,res)=>{
  let bal = getBalanceFromChain(req.params.account);
  res.json({account: req.params.account, blockchain_balance: bal, chain_length: blockchain.length});
});

app.post('/api/signup', (req,res)=>{
  let {full_name, phone, password}=req.body;
  if(!full_name||!phone||!password) return res.status(400).json({error:'All required'});
  let cp=cleanPhone(phone);
  if(users.find(u=>cleanPhone(u.phone)===cp)) return res.status(400).json({error:'Mobile already registered - click LOGIN'});
  let user={id:Date.now().toString(), full_name:full_name.trim(), phone:cp, password, mes_account:'MES'+Math.floor(100000+Math.random()*900000), kes_balance:0, mes_balance:0};
  if(cleanPhone(phone) === cleanPhone(FOUNDER_PHONE)){
    user.mes_balance = FOUNDER_AMOUNT;
  }
  users.push(user);
  if(user.mes_balance === FOUNDER_AMOUNT){
    let block = mineBlock([{from:"GENESIS_BANK_100M", to: user.mes_account, amount: FOUNDER_AMOUNT, note:"Founder 100M on signup"}]);
    blockchain.push(block);
  } else {
    addToBlockchain([{from:"GENESIS", to:user.mes_account, amount:0, note:"Account created "+user.full_name}]);
  }
  save();
  let token=jwt.sign({id:user.id},SECRET);
  res.json({token,user});
});
app.post('/api/login', (req,res)=>{
  let {login_id,password}=req.body;
  let cp=cleanPhone(login_id); let up=login_id.toString().trim().toUpperCase();
  let u=users.find(x=>cleanPhone(x.phone)===cp || x.mes_account.toUpperCase()===up);
  if(!u) return res.status(400).json({error:'Account not found'});
  if(u.password!==password) return res.status(400).json({error:'Wrong password'});
  let token=jwt.sign({id:u.id},SECRET);
  res.json({token,user:u});
});
app.get('/api/me', auth, (req,res)=>{
  let chainBal = getBalanceFromChain(req.user.mes_account);
  res.json({...req.user, blockchain_balance: chainBal});
});
app.get('/api/orders', auth, (req,res)=>{
  let list=orders.filter(o=>o.userId===req.user.id).slice(-20).reverse();
  res.json(list);
});

// FIXED MARKET - NOW SHOWS PHONE + MES ACCOUNT FOR CONTACT
app.get('/api/market', (req,res)=>{
  function enrich(o){
    let u=users.find(x=>x.id===o.userId);
    return {
      id:o.id,
      type:o.type,
      amount:o.amount,
      status:o.status,
      date:o.date,
      full_name: u? u.full_name : 'Unknown',
      phone: u? u.phone : '',
      mes_account: u? u.mes_account : '',
      kes: o.amount * 2
    };
  }
  res.json({
    buys:orders.filter(o=>o.type==='BUY'&&o.status==='PENDING').map(enrich).slice(-30).reverse(),
    sells:orders.filter(o=>o.type==='SELL'&&o.status==='PENDING').map(enrich).slice(-30).reverse(),
    matched:orders.filter(o=>o.status==='MATCHED').map(enrich).slice(-20).reverse()
  });
});

// CANCEL ORDER - RETURNS MES
app.post('/api/order/cancel/:id', auth, (req,res)=>{
  let o=orders.find(x=>x.id==req.params.id && x.userId===req.user.id);
  if(!o) return res.status(404).json({error:'Order not found'});
  if(o.status==='COMPLETED') return res.status(400).json({error:'Already completed'});
  if(o.type==='SELL' && (o.status==='PENDING'||o.status==='MATCHED')) req.user.mes_balance+=o.amount;
  o.status='CANCELLED';
  if(o.matchedWith){ let other=orders.find(x=>x.id==o.matchedWith); if(other) other.status='CANCELLED'; }
  save();
  res.json({message:'Cancelled, MES returned if SELL', user:req.user});
});

// COMPLETE AFTER YOU EXCHANGE OFFLINE
app.post('/api/order/complete/:id', auth, (req,res)=>{
  let order=orders.find(o=>o.id==req.params.id);
  if(!order) return res.status(404).json({error:'Order not found'});
  if(order.status!=='MATCHED') return res.status(400).json({error:'Not matched yet'});
  let sellOrder=order.type==='SELL'?order:orders.find(o=>o.id===order.matchedWith);
  let buyOrder=order.type==='BUY'?order:orders.find(o=>o.id===order.matchedWith);
  if(!sellOrder||!buyOrder) return res.status(400).json({error:'Pair not found'});
  let seller=users.find(u=>u.id===sellOrder.userId);
  let buyer=users.find(u=>u.id===buyOrder.userId);
  sellOrder.status='COMPLETED';
  buyOrder.status='COMPLETED';
  if(buyer) buyer.mes_balance+=sellOrder.amount;
  if(seller) seller.kes_balance+=sellOrder.amount*2;
  trades.push({id:Date.now(), amount:sellOrder.amount, kes:sellOrder.amount*2, date:new Date()});
  addToBlockchain([{from: seller.mes_account, to: buyer.mes_account, amount: sellOrder.amount, kes: sellOrder.amount*2, note: "P2P TRADE "+sellOrder.id}]);
  save();
  res.json({message:'Trade completed! MES released', user:req.user});
});

// REMOVED DARAJA - NO STK POPUP - JUST POST ORDER AND MATCH
app.post('/api/order/buy', auth, (req,res)=>{
  let {amount}=req.body; amount=parseFloat(amount);
  if(!amount) return res.status(400).json({error:'Enter amount'});
  let sellMatch=orders.find(o=>o.type==='SELL'&&o.status==='PENDING'&&o.userId!==req.user.id&&cleanPhone(users.find(u=>u.id===o.userId)?.phone)!==cleanPhone(req.user.phone)&&o.amount===amount);
  let buyOrder={id:Date.now().toString(), userId:req.user.id, type:'BUY', amount, price:2, status: sellMatch?'MATCHED':'PENDING', matchedWith: sellMatch?sellMatch.id:null, date:new Date()};
  orders.push(buyOrder);
  if(sellMatch){
    sellMatch.status='MATCHED';
    sellMatch.matchedWith=buyOrder.id;
  }
  save();
  if(sellMatch){
    let seller=users.find(u=>u.id===sellMatch.userId);
    return res.json({message:'MATCHED! Seller: '+seller.full_name+' Phone: 0'+seller.phone+' MES: '+seller.mes_account+' - Call him to send '+ (amount*2) +' KES via normal Mpesa, then click Complete', user:req.user});
  }
  res.json({message:'Buy order saved - Visible to all sellers now. Wait for seller to call you', user:req.user});
});

app.post('/api/order/sell', auth, (req,res)=>{
  let {amount}=req.body; amount=parseFloat(amount);
  if(req.user.mes_balance < amount) return res.status(400).json({error:'Not enough MES'});
  let buyMatch=orders.find(o=>o.type==='BUY'&&o.status==='PENDING'&&o.userId!==req.user.id&&cleanPhone(users.find(u=>u.id===o.userId)?.phone)!==cleanPhone(req.user.phone)&&o.amount===amount);
  req.user.mes_balance-=amount;
  let sellOrder={id:Date.now().toString(), userId:req.user.id, type:'SELL', amount, price:2, status: buyMatch?'MATCHED':'PENDING', matchedWith: buyMatch?buyMatch.id:null, date:new Date()};
  orders.push(sellOrder);
  if(buyMatch){
    buyMatch.status='MATCHED';
    buyMatch.matchedWith=sellOrder.id;
  }
  save();
  if(buyMatch){
    let buyer=users.find(u=>u.id===buyMatch.userId);
    return res.json({message:'MATCHED! Buyer: '+buyer.full_name+' Phone: 0'+buyer.phone+' MES: '+buyer.mes_account+' - Wait for him to send KES', user:req.user});
  }
  res.json({message:'Sell order saved, MES locked. Visible to all buyers now', user:req.user});
});

app.post('/api/send', auth, (req,res)=>{
  let {to_account, amount}=req.body; amount=parseFloat(amount);
  if(!to_account) return res.status(400).json({error:'Enter receiver'});
  to_account=to_account.trim().toUpperCase();
  if(req.user.mes_balance<amount) return res.status(400).json({error:'Not enough MES'});
  let receiver=users.find(u=>u.mes_account.toUpperCase()===to_account || cleanPhone(u.phone)===cleanPhone(to_account));
  if(!receiver) return res.status(400).json({error:'Receiver not found - use MES account or phone'});
  if(receiver.id===req.user.id) return res.status(400).json({error:'Cannot send to self'});
  req.user.mes_balance-=amount; receiver.mes_balance+=amount;
  orders.push({id:Date.now(), userId:req.user.id, type:'SEND', amount, to_account, date:new Date()});
  addToBlockchain([{from: req.user.mes_account, to: to_account, amount: amount, note: "Direct SEND"}]);
  save();
  res.json({message:'Sent '+amount+' to '+to_account, user:req.user});
});

app.get('/', (req,res)=>{
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>MESCOIN</title><style>body{font-family:system-ui;max-width:430px;margin:auto;padding:12px;background:#f0fdf4}input,button{width:100%;padding:13px;margin:6px 0;border-radius:10px;border:1px solid #ddd;box-sizing:border-box;font-size:15px}button{background:#16a34a;color:#fff;border:none;font-weight:bold;cursor:pointer}.card{background:#fff;padding:14px;border-radius:14px;margin:10px 0;box-shadow:0 2px 8px rgba(0,0,0,.06)}h1{color:#16a34a;text-align:center}.order{background:#f8fafc;border:1px solid #e2e8f0;padding:10px;border-radius:10px;margin:6px 0}</style></head><body><h1>MESCOIN P2P + 100M</h1><p style="text-align:center">Price 2 KES | No MPESA Popup | Direct Contact</p><div class="card">My MES: <b id="top_mes">-</b> | KES: <b id="top_kes">-</b> | Chain: <b id="chain_len">-</b></div><div id="auth" class="card"><b>CREATE ACCOUNT</b><input id="full_name" placeholder="Full Name"><input id="phone" placeholder="Mobile 0768..."><input id="password" type="password" placeholder="Password"><button onclick="signup()">SIGN UP</button><hr><b>LOGIN</b><input id="login_id" placeholder="Mobile or MES Account"><input id="login_password" type="password" placeholder="Password"><button onclick="login()" style="background:#111">LOGIN</button><p id="msg" style="color:red"></p></div><div id="dash" style="display:none"><div class="card" style="background:#dcfce7"><b id="p_name"></b><br>Mobile: <span id="p_phone"></span><br>MES: <b id="acc" style="font-size:20px;color:#16a34a"></b><br><br>KES: <b id="kes"></b><br>MES: <b id="mes"></b><br>Chain Bal: <b id="chain_bal"></b></div><div class="card"><h3>Blockchain</h3><div id="blockchain" style="font-size:11px;max-height:200px;overflow:auto;background:#111;color:#0f0;padding:8px;border-radius:8px"></div><button onclick="loadChain()" style="background:#333">Refresh Chain</button></div><div class="card" style="border:2px solid #2563eb"><h3>LIVE P2P MARKET - Contact Each Other</h3><b>BUY ORDERS - People who WANT MES (Call to SELL to them):</b><div id="market_buys"></div><hr><b>SELL ORDERS - People who HAVE MES (Call to BUY from them):</b><div id="market_sells"></div><br><button onclick="loadMarket()" style="background:#2563eb">Refresh Market</button></div><div class="card" style="border:2px solid #16a34a"><h3>BUY</h3><input id="buy_amt" type="number" placeholder="Amount"><button onclick="buyOrder()">BUY ORDER - No Popup</button></div><div class="card" style="border:2px solid #dc2626"><h3>SELL</h3><input id="sell_amt" type="number" placeholder="Amount"><button onclick="sellOrder()" style="background:#dc2626">SELL ORDER - No Popup</button></div><div class="card"><h3>Send MES</h3><input id="to_account" placeholder="Receiver MES... or 07..."><input id="send_amt" type="number" placeholder="Amount"><button onclick="sendMes()" style="background:#2563eb">SEND NOW</button></div><div class="card"><h3>History</h3><table id="orders" style="width:100%;font-size:12px"></table><br><button onclick="logout()" style="background:#333">Logout</button></div></div><script>let token=localStorage.getItem('mes_token')||null;function goToDashboard(u){document.getElementById('auth').style.display='none';document.getElementById('dash').style.display='block';document.getElementById('p_name').innerText=u.full_name;document.getElementById('p_phone').innerText=u.phone;document.getElementById('acc').innerText=u.mes_account;document.getElementById('kes').innerText=u.kes_balance;document.getElementById('mes').innerText=u.mes_balance;document.getElementById('top_mes').innerText=u.mes_balance;document.getElementById('top_kes').innerText=u.kes_balance;if(u.blockchain_balance!==undefined)document.getElementById('chain_bal').innerText=u.blockchain_balance;loadOrders();loadMarket();loadChain();}async function signup(){let r=await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({full_name:document.getElementById('full_name').value,phone:document.getElementById('phone').value,password:document.getElementById('password').value})});let d=await r.json();if(d.error){document.getElementById('msg').innerText=d.error;return;}token=d.token;localStorage.setItem('mes_token',token);goToDashboard(d.user);}async function login(){let r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login_id:document.getElementById('login_id').value,password:document.getElementById('login_password').value})});let d=await r.json();if(d.error){document.getElementById('msg').innerText=d.error;return;}token=d.token;localStorage.setItem('mes_token',token);goToDashboard(d.user);}async function loadOrders(){let r=await fetch('/api/orders',{headers:{Authorization:'Bearer '+token}});let list=await r.json();let h='<tr><th>Type</th><th>Amt</th><th>Status</th><th>Action</th></tr>';list.forEach(function(o){let col=o.status==='COMPLETED'?'green':o.status==='MATCHED'?'orange':'gray';let btn='';if(o.status==='PENDING') btn='<button onclick="cancelOrder(\\''+o.id+'\\')" style="background:red;padding:3px;width:auto;font-size:11px">Cancel</button>';else if(o.status==='MATCHED') btn='<button onclick="completeOrder(\\''+o.id+'\\')" style="background:green;padding:3px;width:auto;font-size:11px">Complete</button>';h+='<tr><td>'+o.type+'</td><td>'+o.amount+'</td><td><span style="color:'+col+'">'+(o.status||'-')+'</span></td><td>'+btn+'</td></tr>';});document.getElementById('orders').innerHTML=h;}async function cancelOrder(id){if(!confirm('Cancel order?'))return;let r=await fetch('/api/order/cancel/'+id,{method:'POST',headers:{Authorization:'Bearer '+token}});let d=await r.json();alert(d.message||d.error);let mr=await fetch('/api/me',{headers:{Authorization:'Bearer '+token}});if(mr.ok)goToDashboard(await mr.json());}async function completeOrder(id){if(!confirm('Confirm you exchanged money offline?'))return;let r=await fetch('/api/order/complete/'+id,{method:'POST',headers:{Authorization:'Bearer '+token}});let d=await r.json();alert(d.message||d.error);let mr=await fetch('/api/me',{headers:{Authorization:'Bearer '+token}});if(mr.ok)goToDashboard(await mr.json());}async function loadMarket(){let r=await fetch('/api/market');let d=await r.json();let hb='';if(d.buys.length===0) hb='No buy orders'; else d.buys.forEach(function(o){hb+='<div class="order"><b>'+o.full_name+'</b> WANTS '+o.amount+' MES<br>Pay: '+o.kes+' KES<br>Phone: <a href="tel:0'+o.phone+'">0'+o.phone+'</a><br>MES: '+o.mes_account+'<br><small>'+new Date(o.date).toLocaleString()+'</small></div>';});document.getElementById('market_buys').innerHTML=hb;let hs='';if(d.sells.length===0) hs='No sell orders'; else d.sells.forEach(function(o){hs+='<div class="order"><b>'+o.full_name+'</b> SELLS '+o.amount+' MES<br>For: '+o.kes+' KES<br>Phone: <a href="tel:0'+o.phone+'">0'+o.phone+'</a><br>MES: '+o.mes_account+'<br><small>'+new Date(o.date).toLocaleString()+'</small></div>';});document.getElementById('market_sells').innerHTML=hs;}async function loadChain(){let r=await fetch('/api/blockchain');let d=await r.json();document.getElementById('chain_len').innerText=d.length;let h='Valid: '+d.valid+' | Blocks: '+d.length+'<br><br>';d.chain.forEach(function(b){h+='Block #'+b.index+' Hash:'+b.hash.slice(0,12)+'... Tx:'+b.transactions.length+'<br>';});document.getElementById('blockchain').innerHTML=h;}async function buyOrder(){let a=document.getElementById('buy_amt').value;let r=await fetch('/api/order/buy',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount:a})});let d=await r.json();alert(d.message||d.error);let mr=await fetch('/api/me',{headers:{Authorization:'Bearer '+token}});if(mr.ok)goToDashboard(await mr.json());loadMarket();}async function sellOrder(){let a=document.getElementById('sell_amt').value;let r=await fetch('/api/order/sell',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+toke
