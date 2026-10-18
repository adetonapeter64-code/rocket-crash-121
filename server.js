// server.js - FIXED for Render + Paystack + Rocket Crash Game
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*", methods: ["GET","POST"] } 
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve ALL static files - this fixes Cannot GET /
app.use(express.static(path.join(__dirname)));
app.use(express.static(path.join(__dirname, 'public')));

// IMPORTANT: Root route
app.get('/', (req, res) => {
  // Try to find index.html in multiple places
  const possiblePaths = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'crash-game.html'),
    path.join(__dirname, 'public', 'crash-game.html')
  ];
  
  for (let p of possiblePaths) {
    try {
      const fs = require('fs');
      if (fs.existsSync(p)) {
        return res.sendFile(p);
      }
    } catch(e) {}
  }
  // If no file found, show help message
  res.send(`
    <h1>Rocket Crash Game Server Running!</h1>
    <p>But index.html not found.</p>
    <p>Please rename your game file to <b>index.html</b> and push to GitHub.</p>
    <p>Files in dir: ${require('fs').readdirSync(__dirname).join(', ')}</p>
  `);
});

// --- DATABASE (In-Memory for now) ---
let users = {}; 
let withdrawals = [];
let gameState = { 
  phase: 'WAITING', 
  multiplier: 1.00, 
  crashPoint: 0, 
  bets: [],
  history: [2.5, 1.2, 8.3, 1.00, 3.1]
};

function generateCrashPoint() {
  const e = Math.random();
  if (e < 0.05) return 1.00;
  return parseFloat(Math.max(1.00, (0.95 / e)).toFixed(2));
}

function startRound() {
  gameState.crashPoint = generateCrashPoint();
  gameState.multiplier = 1.00;
  gameState.phase = 'FLYING';
  gameState.bets = [];
  io.emit('round_start', { time: Date.now() });
  
  let interval = setInterval(() => {
    if (gameState.phase !== 'FLYING') { clearInterval(interval); return; }
    gameState.multiplier = parseFloat((gameState.multiplier + 0.015 + gameState.multiplier*0.015).toFixed(2));
    io.emit('multiplier', gameState.multiplier);
    
    if (gameState.multiplier >= gameState.crashPoint) {
      gameState.phase = 'CRASHED';
      gameState.history.unshift(gameState.crashPoint);
      if(gameState.history.length > 20) gameState.history.pop();
      io.emit('crashed', { crashPoint: gameState.crashPoint });
      clearInterval(interval);
      setTimeout(startRound, 5000);
    }
  }, 100);
}

// --- API ROUTES ---

// Get balance
app.get('/api/balance/:userId', (req, res) => {
  const user = users[req.params.userId] || { balance: 0, bonusUsed: false };
  res.json(user);
});

// Verify Paystack deposit
app.post('/api/verify-deposit', async (req, res) => {
  const { reference, userId } = req.body;
  console.log('Verifying:', reference, userId);
  
  try {
    const secret = process.env.PAYSTACK_SECRET;
    if (secret && secret.startsWith('sk_')) {
      const verify = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${secret}` }
      });
      if (verify.data.data.status === 'success') {
        const amount = verify.data.data.amount / 100;
        if (!users[userId]) users[userId] = { balance: 0, bonusUsed: false };
        users[userId].balance += amount;
        if (!users[userId].bonusUsed) {
          users[userId].balance += 50; // ₦50 bonus
          users[userId].bonusUsed = true;
        }
        return res.json({ success: true, balance: users[userId].balance, amount });
      }
    }
  } catch (e) {
    console.log('Paystack verify failed, using test mode:', e.message);
  }
  
  // TEST MODE FALLBACK (if no Paystack keys yet)
  if (!users[userId]) users[userId] = { balance: 0, bonusUsed: false };
  users[userId].balance += 500; // test ₦500 credit
  if (!users[userId].bonusUsed) {
    users[userId].balance += 50;
    users[userId].bonusUsed = true;
  }
  res.json({ success: true, balance: users[userId].balance, testMode: true, msg: 'Test credit added - Add PAYSTACK_SECRET to use real payments' });
});

// Withdraw request
app.post('/api/withdraw', (req, res) => {
  const { userId, amount, bank, account, name } = req.body;
  const amt = parseFloat(amount);
  if (!users[userId] || users[userId].balance < amt) {
    return res.json({ success: false, msg: 'Insufficient balance' });
  }
  if (amt < 1000) return res.json({ success: false, msg: 'Min withdrawal ₦1000' });
  
  users[userId].balance -= amt;
  const wd = { id: Date.now(), userId, amount: amt, bank, account, name, status: 'PENDING', date: new Date().toISOString() };
  withdrawals.push(wd);
  console.log('NEW WITHDRAWAL REQUEST:', wd);
  res.json({ success: true, msg: 'Withdrawal pending - Admin will pay in 24h', balance: users[userId].balance });
});

// Admin view withdrawals
app.get('/api/admin/withdrawals', (req, res) => {
  res.json(withdrawals);
});

app.get('/api/history', (req, res) => {
  res.json(gameState.history);
});

// Socket.io
io.on('connection', (socket) => {
  console.log('User connected');
  socket.emit('state', gameState);
  socket.emit('history', gameState.history);
  
  socket.on('place_bet', (data) => {
    if (gameState.phase === 'FLYING') {
      gameState.bets.push(data);
      io.emit('new_bet', data);
    }
  });
  
  socket.on('cashout', (data) => {
    io.emit('player_cashout', data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startRound();
});
