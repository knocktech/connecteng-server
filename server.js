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
const userSocketMap = new Map(); 

const db = admin.firestore(); // Initialize Firestore instance

io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;
    console.log(`A user connected: ${socket.id} (UID: ${userId})`);

    if (userId) {
        userSocketMap.set(userId, socket.id);
    }

    // --- DIRECT CALL SIGNALING HANDLERS ---

    /**
     * Relays a call invitation via Socket AND FCM (for background wake-up).
     */
    socket.on('send_call_invite', async (data) => {
        // ✅ ADDED: 'targetUid' to destructuring so it passes through
        const { targetUserId, channelName, token, callerId, callerName, targetUid } = data;
        console.log(`Direct Call: ${callerId} is inviting ${targetUserId} to ${channelName}`);

        // 1. Try Socket (Fastest if app is open)
        const targetSocketId = userSocketMap.get(targetUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('incoming_call', {
                channelName,
                token,
                callerId,
                callerName,
                targetUid // ✅ Pass this to the receiver's socket
            });
            console.log(`Signal forwarded to recipient socket: ${targetSocketId}`);
        } else {
            console.log(`Target user ${targetUserId} is currently offline from Socket.`);
        }

        // 2. ✅ ADDED: ALWAYS Send FCM Notification (Wakes up killed apps)
        try {
            const userDoc = await db.collection('users').doc(targetUserId).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                const fcmToken = userData.fcmToken;

                if (fcmToken) {
                    const message = {
                        token: fcmToken,
                        data: {
                            type: 'call',
                            channelName: String(channelName),
                            token: String(token),
                            callerId: String(callerId),
                            callerName: String(callerName || "Unknown"),
                            targetUid: String(targetUid || "0") // Pass targetUid to FCM too
                        },
                        android: {
                            priority: 'high',
                            ttl: 0 // 0 means "deliver immediately or drop if device completely unreachable"
                        }
                    };

                    await admin.messaging().send(message);
                    console.log(`FCM Wake-up Notification sent to ${targetUserId}`);
                } else {
                    console.log(`No FCM token found for user ${targetUserId}. Cannot send wake-up.`);
                }
            } else {
                console.log(`User ${targetUserId} not found in Firestore.`);
            }
        } catch (error) {
            console.error(`Failed to send FCM to ${targetUserId}:`, error);
        }
    });

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