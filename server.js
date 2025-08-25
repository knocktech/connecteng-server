const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const AGORA_APP_ID = process.env.AGORA_APP_ID;
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

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
    // ... (This part is unchanged and correct)
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));