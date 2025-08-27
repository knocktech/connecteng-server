const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const admin = require('firebase-admin');

// --- INITIALIZE FIREBASE ADMIN SDK ---
try {
    const serviceAccount = require('./firebase-credentials.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("Firebase Admin SDK initialization failed:", error);
}
// ------------------------------------

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
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

            const callRecord = {
                participants: [user1.userId, user2.userId],
                channelName: channelName,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                durationInSeconds: null // Initialize duration as null
            };

            const db = admin.firestore();
            db.collection('calls').add(callRecord)
                .then(docRef => {
                    const callId = docRef.id;
                    console.log(`SUCCESS: Call record created with ID: ${callId}`);

                    // Send the match event WITH the new callId
                    io.to(user1.id).emit('match_found', { channelName: channelName, remoteUserId: user2.userId, callId: callId });
                    io.to(user2.id).emit('match_found', { channelName: channelName, remoteUserId: user1.userId, callId: callId });

                    console.log(`SUCCESS: Matched ${user1.userId} and ${user2.userId} in channel ${channelName}`);
                })
                .catch(error => {
                    console.error("ERROR: Failed to save initial call record:", error);
                    // Still try to connect the users even if DB save fails
                    io.to(user1.id).emit('match_found', { channelName: channelName, remoteUserId: user2.userId, callId: null });
                    io.to(user2.id).emit('match_found', { channelName: channelName, remoteUserId: user1.userId, callId: null });
                });
        } else {
            console.log('Not enough users to match. Waiting...');
        }
    });
    
    // --- NEW EVENT LISTENER FOR WHEN A CALL ENDS ---
    socket.on('end_call', ({ callId, durationInSeconds }) => {
        if (callId && durationInSeconds != null) {
            console.log(`--- 'end_call' event received for callId: ${callId} with duration: ${durationInSeconds}s ---`);
            const db = admin.firestore();
            db.collection('calls').doc(callId).update({
                durationInSeconds: durationInSeconds
            }).then(() => {
                console.log(`SUCCESS: Updated call ${callId} with duration.`);
            }).catch(error => {
                console.error(`ERROR: Failed to update call ${callId}:`, error);
            });
        }
    });
    // ---------------------------------------------

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
    const expireTime = 3600;
    const currentTime = Math.floor(Date.now() / 1000);
    const privilegeExpireTime = currentTime + expireTime;

    if (!channelName || !AGORA_APP_ID || !AGORA_PRIMARY_CERTIFICATE) {
        return res.status(400).json({ 'error': 'channelName, appId, and certificate are required' });
    }
    const token = RtcTokenBuilder.buildTokenWithUid(
        AGORA_APP_ID,
        AGORA_PRIMARY_CERTIFICATE,
        channelName,
        uid,
        role,
        privilegeExpireTime
    );
    return res.json({ 'token': token });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));