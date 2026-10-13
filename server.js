const express = require('express');
const fs = require('fs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios'); // ADDED FOR MPESA
const app = express();

app.use(cors());
app.use(express.json());

const SECRET = 'mescoin-secret-2026';
const DB_FILE = './database.json';
let PRICE = 2;

// MPESA CONFIG FROM RENDER ENV
const CK = process.env.MPESA_CONSUMER_KEY;
const CS = process.env.MPESA_CONSUMER_SECRET;
const PASSKEY = process.env.MPESA_PASSKEY;
const SHORTCODE = process.env.MPESA_SHORTCODE || '174379';
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL || 'https://mescoin-1.onrender.com/api/mpesa/callback';

// --- DATABASE CODE ---
function loadDB(){
  if(!fs.existsSync(DB_FILE)){
    fs.writeFileSync(DB_FILE, JSON.stringify({users:[], orders:[]}));
  }
  return JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
}
function saveDB(data){
  fs.writeFileSync(DB_FILE, JSON.stringify(data,null,2));
}
let dbData = loadDB();
let users = dbData.users || [];
let orders = dbData.orders || [];
function save(){ saveDB({users, orders}); }

function cleanPhone(p){
  return (p||'').toString().replace(/\D/g,'').slice(-10);
}
function auth(req,res,next){
  try{
    let token = req.headers.authorization?.split(' ')[1];
    if(!token) return res.status(401).json({error:'No token'});
    let decoded = jwt.verify(token, SECRET);
    let user = users.find(u=>u.id===decoded.id);
    if(!user) return res.status(401).json({error:'User not found'});
    req.user = user;
    next();
  }catch(e){ return res.status(401).json({error:'Invalid token'}); }
}

// ================= MPESA DARAJA CODE ADDED =================
async function getMpesaToken(){
  let buff = Buffer.from(`${CK}:${CS}`).toString('base64');
  let r = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',{
    headers:{Authorization:`Basic ${buff}`}
  });
  return r.data.access_token;
}

// User deposits - triggers STK push
app.post('/api/deposit', auth, async (req,res)=>{
  try{
    let {amount} = req.body;
    amount = Math.round(Number(amount));
    if(!amount || amount < 1) return res.status(400).json({error:'Enter amount >=1'});

    if(!CK ||!CS ||!PASSKEY) return res.status(500).json({error:'MPESA keys not set in Render Environment'});

    let token = await getMpesaToken();
    let timestamp = new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
    let password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString('base64');
    let phone254 = '254' + cleanPhone(req.user.phone);

    let stkData = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phone254,
      PartyB: SHORTCODE,
      PhoneNumber: phone254,
      CallBackURL: CALLBACK_URL,
      AccountReference: req.user.mes_account,
      TransactionDesc: "Mescoin Deposit"
    };

    let stkRes = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', stkData, {
      headers:{Authorization:`Bearer ${token}`}
    });

    res.json({message:`STK sent to ${phone254}. Enter M-Pesa PIN`, data:stkRes.data});
  }catch(e){
    console.log(e.response?.data || e.message);
    res.status(500).json({error: e.response?.data?.errorMessage || e.message});
  }
});

// Safaricom calls this after payment
app.post('/api/mpesa/callback', (req,res)=>{
  try{
    let callback = req.body.Body?.stkCallback;
    console.log('MPESA CALLBACK', JSON.stringify(req.body));
    if(callback && callback.ResultCode === 0){
      let items = callback.CallbackMetadata?.Item || [];
      let amount = items.find(i=>i.Name==='Amount')?.Value;
      let mpesaPhone = items.find(i=>i.Name==='PhoneNumber')?.Value;
      // Use AccountReference if present, else phone to find user
      let mesAcc = callback.AccountReference || req.body?.Body?.stkCallback?.MerchantRequestID;

      let user = null;
      if(mesAcc && mesAcc.startsWith('MES')){
        user = users.find(u=>u.mes_account===mesAcc);
      }
      if(!user && mpesaPhone){
        let cp = cleanPhone(mpesaPhone.toString());
        user = users.find(u=> cleanPhone(u.phone)===cp );
      }
      if(user && amount){
        user.kes_balance += Number(amount);
        orders.push({id:Date.now(), userId:user.id, type:'DEPOSIT', amount:Number(amount), mpesaCode: items.find(i=>i.Name==='MpesaReceiptNumber')?.Value, date:new Date()});
        save();
        console.log(`Deposit success: ${amount} to ${user.mes_account}`);
      }
    }
    res.json({ResultCode:0, ResultDesc:"Accepted"});
  }catch(e){
    console.log('Callback error', e.message);
    res.json({ResultCode:0});
  }
});
// ================= END MPESA CODE =================

app.get('/api/price', (req,res)=> res.json({price:PRICE}) );

app.post('/api/signup', (req,res)=>{
  try{
    let {full_name, phone, password} = req.body;
    if(!full_name ||!phone ||!password) return res.status(400).json({error:'Full Name, Mobile and Password required'});
    let cp = cleanPhone(phone);
    if(cp.length < 9) return res.status(400).json({error:'Invalid mobile number'});
    let exists = users.find(u=> cleanPhone(u.phone)===cp );
    if(exists) return res.status(400).json({error:'Mobile already registered - click LOGIN black button'});

    let mes_account = 'MES' + Math.floor(100000 + Math.random()*900000);
    let user = {
      id: Date.now().toString(),
      full_name: full_name.trim(),
      phone: cp,
      password: password,
      mes_account,
      kes_balance: 0,
      mes_balance: 0
    };
    users.push(user);
    save();
    let token = jwt.sign({id:user.id}, SECRET);
    res.json({token, user});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/login', (req,res)=>{
  try{
    let {login_id, password} = req.body;
    if(!login_id ||!password) return res.status(400).json({error:'Enter Mobile/MES and Password'});
    let cp = cleanPhone(login_id);
    let idUpper = login_id.toString().trim().toUpperCase();
    let user = users.find(u=> cleanPhone(u.phone)===cp || u.mes_account.toUpperCase()===idUpper );
    if(!user) return res.status(400).json({error:'Account not found'});
    if(user.password!== password) return res.status(400).json({error:'Wrong password'});
    let token = jwt.sign({id:user.id}, SECRET);
    res.json({token, user});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/me', auth, (req,res)=> res.json(req.user));
app.get('/api/orders', auth, (req,res)=>{
  let list = orders.filter(o=> o.userId===req.user.id || o.to_account===req.user.mes_account).slice(-20).reverse();
  res.json(list);
});

app.post('/api/trade', auth, (req,res)=>{
  let {type, amount} = req.body;
  amount = parseFloat(amount);
  if(!amount || amount<=0) return res.status(400).json({error:'Enter valid amount'});
  if(type==='buy'){
    let cost = amount * PRICE;
    if(req.user.kes_balance < cost) return res.status(400).json({error:'Not enough KES. Deposit via M-Pesa first'});
    req.user.kes_balance -= cost;
    req.user.mes_balance += amount;
    orders.push({id:Date.now(), userId:req.user.id, type:'BUY', amount, date:new Date()});
  }else{
    if(req.user.mes_balance < amount) return res.status(400).json({error:'Not enough MES'});
    req.user.mes_balance -= amount;
    req.user.kes_balance += amount * PRICE;
    orders.push({id:Date.now(), userId:req.user.id, type:'SELL', amount, date:new Date()});
  }
  save();
  res.json({user:req.user});
});

app.post('/api/send', auth, (req,res)=>{
  let {to_account, amount} = req.body;
  amount = parseFloat(amount);
  if(!to_account ||!amount) return res.status(400).json({error:'Enter receiver and amount'});
  to_account = to_account.trim().toUpperCase();
  if(to_account===req.user.mes_account) return res.status(400).json({error:'Cannot send to yourself'});
  if(req.user.mes_balance < amount) return res.status(400).json({error:'Not enough MES'});
  let receiver = users.find(u=> u.mes_account.toUpperCase()===to_account );
  if(!receiver) return res.status(400).json({error:'Receiver account '+to_account+' not found'});
  req.user.mes_balance -= amount;
  receiver.mes_balance += amount;
  orders.push({id:Date.now(), userId:req.user.id, type:'SEND', amount, to_account, date:new Date()});
  orders.push({id:Date.now()+1, userId:receiver.id, type:'RECEIVED', amount, from_account:req.user.mes_account, date:new Date()});
  save();
  res.json({message:'Sent '+amount+' MES to '+to_account, user:req.user});
});

app.get('/api/reset/:phone', (req,res)=>{
  let cp = cleanPhone(req.params.phone);
  let before = users.length;
  users = users.filter(u=> cleanPhone(u.phone)!==cp);
  save();
  res.send(`Deleted ${before - users.length} user(s) with ${cp}. Now you can signup again.`);
});

app.get('/api/debug/users', (req,res)=> res.json(users.map(u=>({name:u.full_name, phone:u.phone, mes:u.mes_account, kes:u.kes_balance, mes_bal:u.mes_balance}))));

app.get('/', (req,res)=>{
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>MESCOIN</title><style>body{font-family:system-ui;max-width:430px;margin:auto;padding:12px;background:#f0fdf4}input,button{width:100%;padding:13px;margin:6px 0;border-radius:10px;border:1px solid #ddd;box-sizing:border-box;font-size:15px}button{background:#16a34a;color:#fff;border:none;font-weight:bold;cursor:pointer}button:disabled{opacity:.5}.card{background:#fff;padding:14px;border-radius:14px;margin:10px 0;box-shadow:0 2px 8px rgba(0,0,0,.06)}h1{color:#16a34a;text-align:center;margin:8px 0}small{color:#666}</style></head><body><h1>MESCOIN</h1><p style="text-align:center;margin:0 0 10px">Send MES by Account Number - LIVE + MPESA</p><div class="card">Price: <b id="price">2</b> KES | My MES: <b id="top_mes">-</b></div><div id="auth" class="card"><b>CREATE ACCOUNT</b><br><small>New here? Use this</small><input id="full_name" placeholder="Full Name"><input id="phone" placeholder="Mobile e.g 0768871831"><input id="password" type="password" placeholder="Password"><button id="btnSignup" onclick="signup()">SIGN UP</button><hr><b>ALREADY HAVE ACCOUNT?</b><br><small>Click LOGIN only, not signup</small><input id="login_id" placeholder="Mobile OR MES Account e.g 768871831 or MES123456"><input id="login_password" type="password" placeholder="Password"><button id="btnLogin" onclick="login()" style="background:#111">LOGIN → DASHBOARD</button><p id="msg" style="color:red;font-size:13px;min-height:18px"></p></div><div id="dash" style="display:none"><div class="card" style="background:#dcfce7"><b id="p_name"></b> ✅<br>Mobile: <span id="p_phone"></span><br>Your MES Account: <b id="acc" style="color:#16a34a;font-size:22px"></b><br><br>KES: <b id="kes"></b><br>MES: <b id="mes"></b></div><div class="card" style="border:2px solid #16a34a"><h3 style="margin:0 0 6px">Deposit KES via M-Pesa</h3><input id="dep_amt" type="number" placeholder="Amount e.g 100"><button onclick="deposit()" style="background:#000">DEPOSIT - STK PUSH</button><small id="dep_msg" style="color:green"></small></div><div class="card"><h3 style="margin:0 0 6px">Send MES</h3><input id="to_account" placeholder="Receiver MES123456"><input id="send_amt" type="number" placeholder="Amount e.g 5"><button onclick="sendMes()" style="background:#2563eb">SEND NOW</button></div><div class="card"><h3 style="margin:0 0 6px">Buy / Sell</h3><input id="amt" type="number" placeholder="Amount"><button onclick="trade('buy')">BUY MES with KES</button><button onclick="trade('sell')" style="background:#dc2626;margin-top:6px">SELL MES to KES</button></div><div class="card"><h3 style="margin:0 0 6px">History</h3><table id="orders" style="width:100%;font-size:12px;border-collapse:collapse"></table><br><button onclick="logout()" style="background:#333">Logout</button></div></div><script>let token=localStorage.getItem('mes_token')||null;async function loadPrice(){try{let r=await fetch('/api/price');let d=await r.json();document.getElementById('price').innerText=d.price;}catch{}}loadPrice();function goToDashboard(user){document.getElementById('auth').style.display='none';document.getElementById('dash').style.display='block';document.getElementById('p_name').innerText=user.full_name;document.getElementById('p_phone').innerText=user.phone;document.getElementById('acc').innerText=user.mes_account;document.getElementById('kes').innerText=user.kes_balance;document.getElementById('mes').innerText=user.mes_balance;document.getElementById('top_mes').innerText=user.mes_balance;document.getElementById('msg').innerText='';loadOrders();window.scrollTo(0,0);}async function signup(){let btn=document.getElementById('btnSignup');btn.innerText='Creating...';btn.disabled=true;document.getElementById('msg').innerText='';try{let r=await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({full_name:document.getElementById('full_name').value.trim(),phone:document.getElementById('phone').value.trim(),password:document.getElementById('password').value})});let d=await r.json();if(d.error){document.getElementById('msg').innerText=d.error;btn.innerText='SIGN UP';btn.disabled=false;return;}token=d.token;localStorage.setItem('mes_token',token);goToDashboard(d.user);}catch(e){document.getElementById('msg').innerText='Network error: '+e.message;}btn.innerText='SIGN UP';btn.disabled=false;}async function login(){let btn=document.getElementById('btnLogin');btn.innerText='Logging in...';btn.disabled=true;document.getElementById('msg').innerText='';try{let r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login_id:document.getElementById('login_id').value.trim(),password:document.getElementById('login_password').value})});let d=await r.json();if(d.error){document.getElementById('msg').innerText=d.error;btn.innerText='LOGIN → DASHBOARD';btn.disabled=false;return;}token=d.token;localStorage.setItem('mes_token',token);goToDashboard(d.user);}catch(e){document.getElementById('msg').innerText='Network error';}btn.innerText='LOGIN → DASHBOARD';btn.disabled=false;}async function loadOrders(){try{let r=await fetch('/api/orders',{headers:{Authorization:'Bearer '+token}});let list=await r.json();let h='<tr><th>Type</th><th>Amt</th><th>To/From</th></tr>';list.forEach(o=>{let other=o.type==='SEND'?o.to_account:o.type==='RECEIVED'?o.from_account:o.type==='DEPOSIT'?'-':'';h+='<tr><td>'+o.type+'</td><td>'+o.amount+'</td><td>'+(other||'-')+'</td></tr>';});document.getElementById('orders').innerHTML=h;}catch{}}async function trade(type){let a=parseFloat(document.getElementById('amt').value);if(!a)return alert('Enter amount');let r=await fetch('/api/trade',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({type,amount:a})});let d=await r.json();if(d.error)return alert(d.error);document.getElementById('kes').innerText=d.user.kes_balance;document.getElementById('mes').innerText=d.user.mes_balance;document.getElementById('top_mes').innerText=d.user.mes_balance;loadOrders();}async function sendMes(){let to=document.getElementById('to_account').value.trim().toUpperCase();let amt=parseFloat(document.getElementById('send_amt').value);if(!to||!amt)return alert('Enter account and amount');if(!confirm('Send '+amt+' MES to '+to+'?'))return;let r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({to_account:to,amount:amt})});let d=await r.json();if(d.error){alert(d.error);return;}alert(d.message);document.getElementById('kes').innerText=d.user.kes_balance;document.getElementById('mes').innerText=d.user.mes_balance;document.getElementById('top_mes').innerText=d.user.mes_balance;loadOrders();document.getElementById('to_account').value='';document.getElementById('send_amt').value='';}async function deposit(){let a=document.getElementById('dep_amt').value;if(!a)return alert('Enter amount');document.getElementById('dep_msg').innerText='Sending STK...';let r=await fetch('/api/deposit',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount:a})});let d=await r.json();if(d.error){alert(d.error);document.getElementById('dep_msg').innerText='';return;}document.getElementById('dep_msg').innerText=d.message+' Check phone. Balance will update after PIN.'; setTimeout(async()=>{let mr=await fetch('/api/me',{headers:{Authorization:'Bearer '+token}});let u=await mr.json();document.getElementById('kes').innerText=u.kes_balance;loadOrders();},5000);}function logout(){localStorage.removeItem('mes_token');token=null;document.getElementById('auth').style.display='block';document.getElementById('dash').style.display='none';}(async()=>{if(token){try{let r=await fetch('/api/me',{headers:{Authorization:'Bearer '+token}});if(r.ok){let u=await r.json();goToDashboard(u);}}catch{}}})();</script></body></html>`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=> console.log('MESCOIN with MPESA running on '+PORT));
