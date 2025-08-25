const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// These will be read from Render's secure environment variables later
const AGORA_APP_ID = process.env.AGORA_APP_ID || "8454e16feb51442c838fcd6b704cbf83";
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || "3c51b67f49ed48859b19513f33240054";

let waitingUsers = [];

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);
    const userId = socket.handshake.query.userId;

    socket.on('find_match', () => {
        console.log(`User ${userId} is looking for a match.`);
        if (!waitingUsers.some(user => user.userId === userId)) {
            waitingUsers.push({ id: socket.id, userId: userId });
        }

        if (waitingUsers.length >= 2) {
            const user1 = waitingUsers.shift();
            const user2 = waitingUsers.shift();
            const channelName = `channel_${Date.now()}`;

            io.to(user1.id).emit('match_found', { channelName: channelName, remoteUserId: user2.userId });
            io.to(user2.id).emit('match_found', { channelName: channelName, remoteUserId: user1.userId });
            console.log(`Matched ${user1.userId} and ${user2.userId} in channel ${channelName}`);
        }
    });

    socket.on('cancel_search', () => {
        waitingUsers = waitingUsers.filter(user => user.userId !== userId);
        console.log(`User ${userId} cancelled search.`);
    });

    socket.on('disconnect', () => {
        waitingUsers = waitingUsers.filter(user => user.userId !== userId);
        console.log('A user disconnected:', socket.id);
    });
});

app.get('/agora/token', (req, res) => {
    const channelName = req.query.channelName;
    const uid = parseInt(req.query.uid) || 0;
    const role = RtcRole.PUBLISHER;
    const expireTime = 3600; // 1 hour
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpireTime = currentTime + expireTime;

    if (!channelName || !AGORA_APP_ID || !AGORA_APP_CERTIFICATE) {
        return res.status(400).json({ 'error': 'channelName, appId, and certificate are required' });
    }

    const token = RtcTokenBuilder.buildTokenWithUid(
        AGORA_APP_ID,
        AGORA_APP_CERTIFICATE,
        channelName,
        uid,
        role,
        privilegeExpireTime
    );
    return res.json({ 'token': token });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));