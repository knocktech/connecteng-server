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

// Track active direct calls: Key=CallerUserID, Value=TargetUserID
const activeCalls = new Map();

const db = admin.firestore();

// --- HELPER: Send FCM Notification ---
async function sendFcmMessage(targetUserId, dataPayload) {
    try {
        const userDoc = await db.collection('users').doc(targetUserId).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            const fcmToken = userData.fcmToken;

            if (fcmToken) {
                const message = {
                    token: fcmToken,
                    data: dataPayload,
                    android: { priority: 'high', ttl: 0 }
                };
                await admin.messaging().send(message);
                console.log(`FCM (${dataPayload.type}) sent to ${targetUserId}`);
            } else {
                console.log(`No FCM token for ${targetUserId}`);
            }
        }
    } catch (error) {
        console.error(`Failed to send FCM to ${targetUserId}:`, error);
    }
}

io.on('connection', (socket) => {
    const userId = socket.handshake.query.userId;
    console.log(`A user connected: ${socket.id} (UID: ${userId})`);

    if (userId) {
        userSocketMap.set(userId, socket.id);
    }

    // --- DIRECT CALL SIGNALING ---

    socket.on('send_call_invite', async (data) => {
        const { targetUserId, channelName, token, callerId, callerName, targetUid } = data;
        
        // Track call for cancellation
        activeCalls.set(callerId, targetUserId);

        console.log(`Direct Call: ${callerId} -> ${targetUserId}`);

        const targetSocketId = userSocketMap.get(targetUserId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('incoming_call', {
                channelName, token, callerId, callerName, targetUid
            });
        }

        // Always Send FCM (Wake up)
        await sendFcmMessage(targetUserId, {
            type: 'call',
            channelName: String(channelName),
            token: String(token),
            callerId: String(callerId),
            callerName: String(callerName || "Unknown"),
            targetUid: String(targetUid || "0")
        });
    });

    socket.on('decline_call', (data) => {
        const { callerId } = data;
        // Clean up tracking (B declined A, so A is no longer calling B)
        activeCalls.delete(callerId);

        const callerSocketId = userSocketMap.get(callerId);
        if (callerSocketId) {
            io.to(callerSocketId).emit('call_rejected');
        }
    });

    socket.on('cancel_call', async (data) => {
         const { targetUserId } = data;
         activeCalls.delete(userId); 
         
         const targetSocketId = userSocketMap.get(targetUserId);
         if (targetSocketId) {
             io.to(targetSocketId).emit('call_ended');
         }

         await sendFcmMessage(targetUserId, {
             type: 'cancel_call',
             callerId: String(userId)
         });
    });

    // --- RANDOM MATCH SIGNALING ---
    socket.on('find_match', async (data) => {
        const genderPreference = data ? data.genderPreference : "Anyone";
        if (!userId) return;

        try {
            const userADoc = await db.collection('users').doc(userId).get();
            if (!userADoc.exists) return;
            const userAData = userADoc.data();

            const userA = {
                id: socket.id,
                userId: userId,
                gender: userAData.gender,
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
                
                await db.collection('calls').add({
                    participants: [userA.userId, matchedUser.userId],
                    channelName: channelName,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    durationInSeconds: null
                });

                io.to(userA.id).emit('match_found', { channelName: channelName, remoteUserId: matchedUser.userId });
                io.to(matchedUser.id).emit('match_found', { channelName: channelName, remoteUserId: userA.userId });
            } else {
                if (!waitingUsers.some(user => user.userId === userA.userId)) {
                    waitingUsers.push(userA);
                }
            }
        } catch (error) {
            console.error(error);
        }
    });

    socket.on('end_call', async ({ durationInSeconds }) => {
        // ✅ FIXED: Check if this was an active ringing call and Cancel it if needed
        if (activeCalls.has(userId)) {
            const targetUserId = activeCalls.get(userId);
            console.log(`User ${userId} ended ringing call to ${targetUserId}. Sending FCM Cancel.`);
            
            // Send FCM Cancel to stop the phone from ringing
            await sendFcmMessage(targetUserId, {
                type: 'cancel_call',
                callerId: String(userId)
            });
            
            // Notify Socket if available
            const targetSocketId = userSocketMap.get(targetUserId);
            if (targetSocketId) {
                io.to(targetSocketId).emit('call_ended');
            }

            activeCalls.delete(userId);
        }

        if (userId && durationInSeconds != null) {
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
                }
            } catch (error) {
                console.error(error);
            }
        }
    });

    socket.on('cancel_search', () => {
        waitingUsers = waitingUsers.filter(user => user.id !== socket.id);
    });

    socket.on('disconnect', async () => {
        waitingUsers = waitingUsers.filter(user => user.id !== socket.id);
        
        // Handle disconnect during ringing
        if (userId && activeCalls.has(userId)) {
            const targetUserId = activeCalls.get(userId);
            console.log(`Caller ${userId} disconnected. Cancelling call to ${targetUserId}`);
            
            const targetSocketId = userSocketMap.get(targetUserId);
            if (targetSocketId) {
                io.to(targetSocketId).emit('call_ended');
            }

            await sendFcmMessage(targetUserId, {
                type: 'cancel_call',
                callerId: String(userId)
            });

            activeCalls.delete(userId);
        }

        if (userId) {
            userSocketMap.delete(userId);
        }
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