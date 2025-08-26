const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",  // Allow connections from any origin
    methods: ["GET", "POST"]
  }
});

const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_PRIMARY_CERTIFICATE = process.env.AGORA_PRIMARY_CERTIFICATE;

let waitingUsers = [];

io.on('connection', (socket) => {
    console.log(`A user connected: ${socket.id}`);
    const userId = socket.handshake.query.userId;

    socket.on('find_match', () => {
        console.log(`--- 'find_match' event received from userId: ${userId} ---`);
        
        if (!waitingUsers.some(user => user.userId === userId)) {
            waitingUsers.push({ id: socket.id, userId: userId });
            console.log(`User ${userId} ADDED to queue.`);
        } else {
            console.log(`User ${userId} was already in the queue.`);
        }
        
        console.log(`Current queue size: ${waitingUsers.length}`);
        console.log('Current queue contents:', waitingUsers.map(u => u.userId));

        if (waitingUsers.length >= 2) {
            console.log("MATCHING TWO USERS...");
            const user1 = waitingUsers.shift();
            const user2 = waitingUsers.shift();
            
            const channelName = `channel_${Date.now()}`;

            io.to(user1.id).emit('match_found', { channelName: channelName, remoteUserId: user2.userId });
            io.to(user2.id).emit('match_found', { channelName: channelName, remoteUserId: user1.userId });
            
            console.log(`SUCCESS: Matched ${user1.userId} and ${user2.userId} in channel ${channelName}`);
            console.log('Queue after match:', waitingUsers.map(u => u.userId));
        } else {
            console.log('Not enough users to match. Waiting...');
        }
    });

    socket.on('cancel_search', () => {
        waitingUsers = waitingUsers.filter(user => user.id !== socket.id);
        console.log(`User ${userId} cancelled search. Queue size: ${waitingUsers.length}`);
    });

    socket.on('disconnect', () => {
        waitingUsers = waitingUsers.filter(user => user.id !== socket.id);
        console.log(`A user disconnected: ${socket.id}. Queue size: ${waitingUsers.length}`);
    });
});

app.get('/agora/token', (req, res) => {
    const channelName = req.query.channelName;
    const uid = parseInt(req.query.uid) || 0;
    const role = RtcRole.PUBLISHER;
    const expireTime = 3600; // 1 hour
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpireTime = currentTime + expireTime;

    if (!channelName || !AGORA_APP_ID || !AGORA_PRIMARY_CERTIFICATE) {
        return res.status(400).json({ 'error': 'channelName, appId, and certificate are required' });
    }

    const token = RtcTokenBuilder.buildTokenWithUid(
    AGORA_APP_ID,
    AGORA_PRIMARY_CERTIFICATE, // <-- Change it to this
    channelName,
    uid,
    role,
    privilegeExpireTime
);
    return res.json({ 'token': token });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));