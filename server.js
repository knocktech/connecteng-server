"use strict";

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
// ✅ ADDED: Global map to track which userId belongs to which socket.id
const userSocketMap = new Map(); 

const db = admin.firestore(); // Initialize Firestore instance

io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;
    console.log(`A user connected: ${socket.id} (UID: ${userId})`);

    // ✅ ADDED: Register user in the map upon connection
    if (userId) {
        userSocketMap.set(userId, socket.id);
    }

    // --- ✅ NEW: DIRECT CALL SIGNALING HANDLERS ---

    /**
     * Relays a call invitation from a caller to a specific recipient.
     */
    socket.on('send_call_invite', (data) => {
        const { targetUserId, channelName, token, callerId, callerName } = data;
        console.log(`Direct Call: ${callerId} is inviting ${targetUserId} to ${channelName}`);

        const targetSocketId = userSocketMap.get(targetUserId);
        if (targetSocketId) {
            // Forward the event to User B
            io.to(targetSocketId).emit('incoming_call', {
                channelName,
                token,
                callerId,
                callerName
            });
            console.log(`Signal forwarded to recipient socket: ${targetSocketId}`);
        } else {
            console.log(`Target user ${targetUserId} is currently offline.`);
        }
    });

    /**
     * Relays a rejection signal from the recipient back to the caller.
     */
    socket.on('decline_call', (data) => {
        const { callerId } = data;
        console.log(`Call declined. Notifying caller: ${callerId}`);
        const callerSocketId = userSocketMap.get(callerId);
        if (callerSocketId) {
            io.to(callerSocketId).emit('call_rejected');
        }
    });

    // --- EXISTING 'find_match' HANDLER ---
    socket.on('find_match', async (data) => {
        const genderPreference = data ? data.genderPreference : "Anyone";
        console.log(`--- 'find_match' event from userId: ${userId} with preference: ${genderPreference} ---`);

        if (!userId) {
            console.error("ERROR: find_match event received without a userId.");
            return;
        }

        try {
            const userADoc = await db.collection('users').doc(userId).get();
            if (!userADoc.exists) {
                console.error(`ERROR: User profile not found in Firestore for userId: ${userId}`);
                return;
            }
            const userAData = userADoc.data();
            const userAGender = userAData.gender;

            const userA = {
                id: socket.id,
                userId: userId,
                gender: userAGender,
                genderPreference: genderPreference
            };

            let matchedUser = null;
            let matchIndex = -1;

            for (let i = 0; i < waitingUsers.length; i++) {
                const userB = waitingUsers[i];
                const aLikesB = userA.genderPreference === 'Anyone' || userA.genderPreference === userB.gender;
                const bLikesA = userB.genderPreference === 'Anyone' || userB.genderPreference === userA.gender;

                if (aLikesB && bLikesA) {
                    matchedUser = userB;
                    matchIndex = i;
                    break;
                }
            }

            if (matchedUser) {
                waitingUsers.splice(matchIndex, 1);
                const channelName = `channel_${Date.now()}`;

                const callRecord = {
                    participants: [userA.userId, matchedUser.userId],
                    channelName: channelName,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    durationInSeconds: null
                };

                await db.collection('calls').add(callRecord);
                console.log(`SUCCESS: Call record saved for ${userA.userId} and ${matchedUser.userId}`);

                io.to(userA.id).emit('match_found', { channelName: channelName, remoteUserId: matchedUser.userId });
                io.to(matchedUser.id).emit('match_found', { channelName: channelName, remoteUserId: userA.userId });

                console.log(`SUCCESS: Matched ${userA.userId} (${userA.gender}) with ${matchedUser.userId} (${matchedUser.gender})`);
            } else {
                if (!waitingUsers.some(user => user.userId === userA.userId)) {
                    waitingUsers.push(userA);
                    console.log(`User ${userA.userId} ADDED to queue.`);
                }
            }
        } catch (error) {
            console.error(`ERROR: An error occurred during find_match`, error);
        }
    });
    
    // --- EXISTING 'end_call' HANDLER ---
    socket.on('end_call', async ({ durationInSeconds }) => {
        if (userId && durationInSeconds != null) {
            console.log(`--- 'end_call' event received from userId: ${userId} with duration: ${durationInSeconds}s ---`);
            try {
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
                }
            } catch (error) {
                console.error(`ERROR: Failed to update call for userId ${userId}:`, error);
            }
        }
    });

    socket.on('cancel_search', () => {
        waitingUsers = waitingUsers.filter(user => user.id !== socket.id);
        console.log(`User ${userId} cancelled search.`);
    });

    socket.on('disconnect', () => {
        waitingUsers = waitingUsers.filter(user => user.id !== socket.id);
        
        // ✅ ADDED: Remove user from map on disconnect
        if (userId) {
            userSocketMap.delete(userId);
        }
        
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