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
                    console.log(`SUCCESS: Call record saved to Firestore with ID: ${docRef.id}`);
                })
                .catch(error => {
                    console.error("ERROR: Failed to save call record:", error);
                });
            
            // The match_found event is now simpler, it does not send the callId
            io.to(user1.id).emit('match_found', { channelName: channelName, remoteUserId: user2.userId });
            io.to(user2.id).emit('match_found', { channelName: channelName, remoteUserId: user1.userId });
            
            console.log(`SUCCESS: Matched ${user1.userId} and ${user2.userId} in channel ${channelName}`);
            console.log('Queue after match:', waitingUsers.map(u => u.userId));
        } else {
            console.log('Not enough users to match. Waiting...');
        }
    });
    
    // --- NEW, SMARTER EVENT LISTENER FOR WHEN A CALL ENDS ---
    socket.on('end_call', async ({ durationInSeconds }) => {
        if (userId && durationInSeconds != null) {
            console.log(`--- 'end_call' event received from userId: ${userId} with duration: ${durationInSeconds}s ---`);
            const db = admin.firestore();
            try {
                // Find the most recent call for this user that hasn't been updated yet
                const querySnapshot = await db.collection('calls')
                    .where('participants', 'array-contains', userId)
                    .where('durationInSeconds', '==', null)
                    .orderBy('createdAt', 'desc')
                    .limit(1)
                    .get();

                if (!querySnapshot.empty) {
                    const callDoc = querySnapshot.docs[0];
                    await callDoc.ref.update({ durationInSeconds: durationInSeconds });
                    console.log(`SUCCESS: Updated call ${callDoc.id} with duration.`);
                } else {
                    console.log(`WARNING: Could not find a matching open call to update for userId: ${userId}`);
                }
            } catch (error) {
                console.error(`ERROR: Failed to update call for userId ${userId}:`, error);
            }
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
    // This function remains the same
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