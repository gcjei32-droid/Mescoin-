const express = require('express');
const fs = require('fs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

const SECRET = 'mescoin-secret-2026';
const DB_FILE = fs.existsSync('/data')? '/data/database.json' : './database.json';

function calculateHash(prev_hash, timestamp, transactions, nonce){
  return crypto.createHash('sha256').update(prev_hash + timestamp + JSON.stringify(transactions) + nonce).digest('hex');
}
function createGenesisBlock(){ let t=new Date().toISOString(); return {index:0, prev_hash:"0", timestamp:t, transactions:[{from:"GENESIS",to:"NETWORK",amount:0}], nonce:0, hash:calculateHash("0",t,[{from:"GENESIS"}],0)}; }
function getLastBlock(){ return blockchain[blockchain.length-1]; }
function mineBlock(transactions){
  let prev=getLastBlock(); let index=prev.index+1; let timestamp=new Date().toISOString(); let prev_hash=prev.hash; let nonce=0; let hash="";
  do{ nonce++; hash=calculateHash(prev_hash,timestamp,transactions,nonce); }while(!hash.startsWith("00"));
  return {index, prev_hash, timestamp, transactions, nonce, hash};
}
function getBalanceFromChain(acc){ let b=0; let A=acc.toUpperCase(); for(let bl of blockchain){ for(let tx of bl.transactions){ if(tx.to&&tx.to.toUpperCase()===A) b+=Number(tx.amount); if(tx.from&&tx.from.toUpperCase()===A) b-=Number(tx.amount); } } return b; }
function addToBlockchain(txs){ let nb=mineBlock(txs); blockchain.push(nb); save(); return nb; }
function loadDB(){ if(!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({users:[], orders:[], trades:[], blockchain:[createGenesisBlock()]})); let raw=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); if(!raw.blockchain||raw.blockchain.length===0) raw.blockchain=[createGenesisBlock()]; return raw; }
function saveDB(d){ fs.writeFileSync(DB_FILE, JSON.stringify(d,null,2)); }
let db=loadDB(); let users=db.users||[]; let orders=db.orders||[]; let trades=db.trades||[]; let blockchain=db.blockchain||[createGenesisBlock()];
function save(){ saveDB({users,orders,trades,blockchain}); }

const FOUNDER_PHONE="0768871831"; const FOUNDER_AMOUNT=100000000;
function cleanPhone(p){ return (p||'').toString().replace(/\D/g,'').replace(/^0/,'').replace(/^254/,''); }
(function(){ try{ let f=users.find(u=>cleanPhone(u.phone)===cleanPhone(FOUNDER_PHONE)); if(f&&f.mes_balance<FOUNDER_AMOUNT){ f.mes_balance=FOUNDER_AMOUNT; blockchain.push(mineBlock([{from:"GENESIS_BANK_100M",to:f.mes_account,amount:FOUNDER_AMOUNT}])); save(); } }catch(e){} })();

function auth(req,res,next){ try{ let t=req.headers.authorization?.split(' ')[1]; let dec=jwt.verify(t,SECRET); req.user=users.find(u=>u.id===dec.id); if(!req.user) return res.status(401).json({error:'User not found'}); next(); }catch{ return res.status(401).json({error:'Invalid token'}); } }

app.get('/api/price',(req,res)=>res.json({price:2}));
app.get('/api/market',(req,res)=>{ function enrich(o){ let u=users.find(x=>x.id===o.userId); return {...o, full_name:u?.full_name||'Unknown', phone:u?.phone||'', mes_account:u?.mes_account||''}; } res.json({buys:orders.filter(o=>o.type==='BUY'&&o.status==='PENDING').map(enrich).slice(-50).reverse(), sells:orders.filter(o=>o.type==='SELL'&&o.status==='PENDING').map(enrich).slice(-50).reverse()}); });
app.post('/api/signup',(req,res)=>{ let {full_name,phone,password}=req.body; if(!full_name||!phone||!password) return res.status(400).json({error:'All required'}); let cp=cleanPhone(phone); if(users.find(u=>cleanPhone(u.phone)===cp)) return res.status(400).json({error:'Mobile already registered'}); let user={id:Date.now().toString(), full_name:full_name.trim(), phone:cp, password, mes_account:'MES'+Math.floor(100000+Math.random()*900000), kes_balance:0, mes_balance:0}; if(cleanPhone(phone)===cleanPhone(FOUNDER_PHONE)) user.mes_balance=FOUNDER_AMOUNT; users.push(user); blockchain.push(mineBlock([{from:"GENESIS",to:user.mes_account,amount:user.mes_balance}])); save(); let token=jwt.sign({id:user.id},SECRET); res.json({token,user}); });
app.post('/api/login',(req,res)=>{ let {login_id,password}=req.body; let cp=cleanPhone(login_id); let up=login_id.toString().trim().toUpperCase(); let u=users.find(x=>cleanPhone(x.phone)===cp || x.mes_account.toUpperCase()===up); if(!u) return res.status(400).json({error:'Account not found'}); if(u.password!==password) return res.status(400).json({error:'Wrong password'}); let token=jwt.sign({id:u.id},SECRET); res.json({token,user:u}); });
app.get('/api/me',auth,(req,res)=>{ res.json({...req.user, blockchain_balance:getBalanceFromChain(req.user.mes_account)}); });
app.get('/api/orders',auth,(req,res)=>{ res.json(orders.filter(o=>o.userId===req.user.id).slice(-30).reverse()); });
app.post('/api/order/cancel/:id',auth,(req,res)=>{ let o=orders.find(x=>x.id==req.params.id && x.userId===req.user.id); if(!o) return res.status(404).json({error:'Not found'}); if(o.status==='COMPLETED') return res.status(400).json({error:'Already completed'}); if(o.type==='SELL'&&(o.status==='PENDING'||o.status==='MATCHED')) req.user.mes_balance+=o.amount; o.status='CANCELLED'; if(o.matchedWith){ let other=orders.find(x=>x.id==o.matchedWith); if(other) other.status='CANCELLED'; } save(); res.json({message:'Cancelled, MES returned', user:req.user}); });
app.post('/api/order/buy',auth,(req,res)=>{ let amount=parseFloat(req.body.amount); if(!amount) return res.status(400).json({error:'Enter amount'}); let sellMatch=orders.find(o=>o.type==='SELL'&&o.status==='PENDING'&&o.userId!==req.user.id&&cleanPhone(users.find(u=>u.id===o.userId)?.phone)!==cleanPhone(req.user.phone)&&o.amount===amount); let buy={id:Date.now().toString(), userId:req.user.id, type:'BUY', amount, price:2, status:sellMatch?'MATCHED':'PENDING', matchedWith:sellMatch?sellMatch.id:null, date:new Date()}; orders.push(buy); if(sellMatch){ sellMatch.status='MATCHED'; sellMatch.matchedWith=buy.id; } save(); if(sellMatch){ let s=users.find(u=>u.id===sellMatch.userId); return res.json({message:'MATCHED with seller '+s.full_name+' Phone: '+s.phone+' MES: '+s.mes_account, user:req.user}); } res.json({message:'Buy order posted! Visible to all sellers', user:req.user}); });
app.post('/api/order/sell',auth,(req,res)=>{ let amount=parseFloat(req.body.amount); if(req.user.mes_balance<amount) return res.status(400).json({error:'Not enough MES'}); let buyMatch=orders.find(o=>o.type==='BUY'&&o.status==='PENDING'&&o.userId!==req.user.id&&cleanPhone(users.find(u=>u.id===o.userId)?.phone)!==cleanPhone(req.user.phone)&&o.amount===amount); req.user.mes_balance-=amount; let sell={id:Date.now().toString(), userId:req.user.id, type:'SELL', amount, price:2, status:buyMatch?'MATCHED':'PENDING', matchedWith:buyMatch?buyMatch.id:null, date:new Date()}; orders.push(sell); if(buyMatch){ buyMatch.status='MATCHED'; buyMatch.matchedWith=sell.id; } save(); if(buyMatch){ let b=users.find(u=>u.id===buyMatch.userId); return res.json({message:'MATCHED with buyer '+b.full_name+' Phone: '+b.phone, user:req.user}); } res.json({message:'Sell order posted! MES locked', user:req.user}); });
app.post('/api/order/complete/:id',auth,(req,res)=>{ let order=orders.find(o=>o.id==req.params.id); if(!order) return res.status(404).json({error:'Not found'}); if(order.status!=='MATCHED') return res.status(400).json({error:'Not matched'}); let sell=order.type==='SELL'?order:orders.find(o=>o.id===order.matchedWith); let buy=order.type==='BUY'?order:orders.find(o=>o.id===order.matchedWith); let seller=users.find(u=>u.id===sell.userId); let buyer=users.find(u=>u.id===buy.userId); sell.status='COMPLETED'; buy.status='COMPLETED'; if(buyer) buyer.mes_balance+=sell.amount; if(seller) seller.kes_balance+=sell.amount*2; addToBlockchain([{from:seller.mes_account,to:buyer.mes_account,amount:sell.amount}]); save(); res.json({message:'Trade completed! MES released', user:req.user}); });
app.post('/api/send',auth,(req,res)=>{ let {to_account,amount}=req.body; amount=parseFloat(amount); let input=to_account.toString().trim().toUpperCase(); let inputPhone=cleanPhone(to_account); if(req.user.mes_balance<amount) return res.status(400).json({error:'Not enough MES'}); let receiver=users.find(u=>u.mes_account.toUpperCase()===input || u.mes_account.toUpperCase()===('MES'+input) || cleanPhone(u.phone)===inputPhone); if(!receiver) return res.status(400).json({error:'Receiver not found'}); if(receiver.id===req.user.id) return res.status(400).json({error:'Cannot self'}); req.user.mes_balance-=amount; receiver.mes_balance+=amount; addToBlockchain([{from:req.user.mes_account,to:receiver.mes_account,amount}]); save(); res.json({message:'Sent '+amount+' to '+receiver.mes_account, user:req.user}); });
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(process.env.PORT||10000,()=>console.log('P2P NO MPESA fixed DB:'+DB_FILE));
