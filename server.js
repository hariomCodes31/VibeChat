const express = require("express");

const http = require("http");

const { Server } = require("socket.io");

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

const app = express();

const server = http.createServer(app);

const io = new Server(server, {
    maxHttpBufferSize: 15e6  // Keep existing socket buffer size unchanged
});

// Configure upload limits
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100 MB

// Ensure uploads folder exists in public directory
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer Storage - Cryptographically unique names to prevent collision, traversal, or overwrites
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        // Cryptographically unique filename
        const uniqueName = crypto.randomBytes(16).toString('hex') + ext;
        cb(null, uniqueName);
    }
});

// File validation filter
const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExtensions = [
        '.mp4', '.webm', '.mov', '.mkv', '.avi',
        '.jpg', '.jpeg', '.png', '.webp'
    ];
    const allowedMimeTypes = [
        'video/mp4', 'video/webm', 'video/ogg', 
        'video/quicktime', 'video/x-matroska', 'video/x-msvideo',
        'image/jpeg', 'image/jpg', 'image/png', 'image/webp'
    ];

    if (allowedExtensions.includes(ext) || allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Format not supported. Allowed: MP4, WEBM, MOV, MKV, AVI, JPG, JPEG, PNG, WEBP'), false);
    }
};

const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_VIDEO_SIZE },
    fileFilter: fileFilter
});

app.use(express.static("public"));

// Helper function to validate video headers/signatures (magic bytes)
// Helper function to validate file headers/signatures (magic bytes) for videos and images
function validateFileSignature(filePath) {
    try {
        const buffer = Buffer.alloc(12);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, 12, 0);
        fs.closeSync(fd);

        const hex = buffer.toString('hex').toUpperCase();

        // 1. WebM / MKV
        if (hex.startsWith('1A45DFA3')) return true;

        // 2. AVI
        if (hex.startsWith('52494646') && hex.substring(16, 24) === '41564920') return true;

        // 3. MP4 / MOV (contains 'ftyp' hex 66747970)
        if (hex.includes('66747970')) return true;

        // 4. QuickTime (MOV) can also start with 'free' or 'mdat'
        if (hex.includes('6D646174') || hex.includes('66726565')) return true;

        // 5. PNG: 89504E470D0A1A0A
        if (hex.startsWith('89504E47')) return true;

        // 6. JPEG/JPG: FFD8FF
        if (hex.startsWith('FFD8FF')) return true;

        // 7. WebP (starts with RIFF '52494646' and has WEBP '57454250' at offset 8)
        if (hex.startsWith('52494646') && hex.substring(16, 24) === '57454250') return true;

        return false;
    } catch (e) {
        console.error('Error verifying file signature:', e);
        return false;
    }
}

// HTTP Video & Image Upload endpoint
app.post('/upload-video', (req, res) => {
    upload.single('video')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, error: 'File size exceeds upload limit (Max: 100 MB for videos).' });
            }
            return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ success: false, error: err.message });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file provided.' });
        }

        const { roomCode, sessionToken, username } = req.body;

        // Security check: parameters must be present
        if (!roomCode || !sessionToken || !username) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, error: 'Missing security validation parameters.' });
        }

        // Security check: room must exist
        const room = rooms[roomCode];
        if (!room) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ success: false, error: 'Target room does not exist.' });
        }

        // Security check: user must be approved in this room
        const isApproved = room.approvedSessions && room.approvedSessions.has(sessionToken);
        if (!isApproved) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(403).json({ success: false, error: 'Unauthorized room access.' });
        }

        // Image validation check: enforce 10 MB limit for images specifically
        const isImage = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(req.file.mimetype) ||
                        ['.jpg', '.jpeg', '.png', '.webp'].some(ext => req.file.filename.toLowerCase().endsWith(ext));
        
        if (isImage && req.file.size > 10 * 1024 * 1024) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, error: 'Image size exceeds 10 MB limit.' });
        }

        // Security check: Verify file magic bytes signature to prevent spoofing
        if (!validateFileSignature(req.file.path)) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, error: 'Invalid file signature. Only real video or image files are allowed.' });
        }

        // Return relative path to static folder file
        res.json({
            success: true,
            url: `/uploads/${req.file.filename}`,
            filename: req.file.originalname,
            filesize: req.file.size,
            mimeType: req.file.mimetype
        });
    });
});

const users = {};
const disconnectTimeouts = {};


/* ============================================================
   ROOMS — in-memory store
   Key: room code (6-char alphanumeric e.g. "A7K9P2")
   Value: room metadata object
============================================================ */
const rooms = {};

/* ----------------------------------------------------------
   generateRoomCode()
   Returns a unique 6-char uppercase alphanumeric string
   that is not already used as a room code.
---------------------------------------------------------- */
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
        code = Array.from({ length: 6 }, () =>
            chars[Math.floor(Math.random() * chars.length)]
        ).join('');
    } while (rooms[code]); // guarantee uniqueness
    return code;
}

io.on("connection", (socket) => {

    console.log("A user connected");

    /* ---- Join existing room directly (used by Join Room flow) ---- */
    socket.on("new user", ({ username, room, avatar, sessionToken }) => {

        users[socket.id] = {
            username,
            avatar: avatar || '👾',
            room,
            isAdmin: false,   // admin is set only via create-room
            sessionToken
        };

        const r = rooms[room];
        if (r && sessionToken) {
            r.approvedSessions.add(sessionToken);
        }

        socket.join(room);

        updateUsers(room);

        socket.to(room).emit(
            "system message",
            `${username} joined the room`
        );

    });

    /* ---- Create a new room (admin flow) ---- */
    socket.on("create-room", ({ username, avatar, roomName, roomType, sessionToken }) => {

        const code = generateRoomCode();

        // Store room metadata
        rooms[code] = {
            name:          roomName,
            code,
            type:          roomType || 'approval', // 'public' | 'approval' | 'private'
            adminSocketId: socket.id,
            locked:        false,
            messages:      [],
            pendingRequests: [],   // { socketId, username, avatar }
            mutedUsers:    new Set(), // Set of muted socket IDs
            reactions:     {},        // { messageId: { emoji: { count, users[] } } }
            approvedSessions: new Set(),
            // Default permissions (Feature 12 — admin can toggle)
            permissions: {
                allowImages:      true,
                allowFiles:       true,
                allowReply:       true,
                allowReactions:   true,
                allowEmoji:       true,
                allowPolls:       false,
                allowScreenShare: false,

                allowInviteLinks: true
            }
        };

        if (sessionToken) {
            rooms[code].approvedSessions.add(sessionToken);
        }

        // Register the creator as admin
        users[socket.id] = {
            username,
            avatar: avatar || '👾',
            room:    code,
            isAdmin: true,
            sessionToken
        };

        socket.join(code);

        // Send the generated code back to the creator only
        socket.emit("room-created", {
            code,
            name: roomName
        });

        // Announce + update sidebar
        io.to(code).emit("system message", `${username} created the room`);
        updateUsers(code);

    });


    /* ---- Join Room via code — puts user in waiting room for admin approval ---- */
    socket.on('join-room-request', ({ username, avatar, code, sessionToken }) => {

        const room = rooms[code];

        // Room must exist
        if (!room) {
            socket.emit('join-error', {
                message: 'Room not found. Check the code and try again.'
            });
            return;
        }

        // Check if session was already approved in this room (reconnection safety)
        if (sessionToken && room.approvedSessions && room.approvedSessions.has(sessionToken)) {
            users[socket.id] = {
                username,
                avatar: avatar || '👾',
                room:    code,
                isAdmin: false,
                sessionToken
            };
            socket.join(code);
            socket.emit('approved', { code, name: room.name });
            socket.to(code).emit('system message', `${username} joined the room`);
            updateUsers(code);
            return;
        }

        // Room must not be locked
        if (room.locked) {
            socket.emit('join-error', {
                message: 'This room is currently locked by the admin.'
            });
            return;
        }

        // Check if already pending (duplicate request guard)
        const alreadyPending = room.pendingRequests
            .some(r => r.socketId === socket.id);
        if (alreadyPending) return;

        /* -- Feature 11: Public rooms skip the waiting room -- */
        if (room.type === 'public') {
            users[socket.id] = { username, avatar: avatar || '👾', room: code, isAdmin: false, sessionToken };
            if (sessionToken) {
                room.approvedSessions.add(sessionToken);
            }
            socket.join(code);
            socket.emit('join-approved', { code, name: room.name });
            socket.to(code).emit('system message', `${username} joined the room`);
            updateUsers(code);
            return;
        }

        // Approval / Private: add to pending list
        const requestEntry = { socketId: socket.id, username, avatar: avatar || '👾', sessionToken };
        room.pendingRequests.push(requestEntry);

        // Tell the requester to sit tight
        socket.emit('waiting-approval', { roomName: room.name, code });

        // Notify the admin of the new request
        io.to(room.adminSocketId).emit('pending-request', requestEntry);

    });

    /* ---- Admin approves a pending user ---- */
    socket.on('approve-user', ({ targetSocketId, code }) => {

        const room = rooms[code];

        // Only the admin can approve
        if (!room || room.adminSocketId !== socket.id) return;

        // Find the pending entry
        const idx = room.pendingRequests
            .findIndex(r => r.socketId === targetSocketId);
        if (idx === -1) return;  // already handled or disconnected

        const pending = room.pendingRequests.splice(idx, 1)[0];

        // The requesting socket may have disconnected while waiting
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (!targetSocket) return;

        // Register the newly approved user
        users[targetSocketId] = {
            username: pending.username,
            avatar:   pending.avatar,
            room:     code,
            isAdmin:  false,
            sessionToken: pending.sessionToken
        };

        if (pending.sessionToken) {
            room.approvedSessions.add(pending.sessionToken);
        }

        targetSocket.join(code);

        // Confirm approval to the waiting user
        targetSocket.emit('approved', { code, name: room.name });

        // Broadcast join message to the room
        io.to(code).emit('system message',
            `${pending.username} joined the room`);

        updateUsers(code);

    });


    /* ---- Admin rejects a pending user ---- */
    socket.on('reject-user', ({ targetSocketId, code }) => {

        const room = rooms[code];

        // Only the admin can reject
        if (!room || room.adminSocketId !== socket.id) return;

        // Remove from pending list
        room.pendingRequests = room.pendingRequests
            .filter(r => r.socketId !== targetSocketId);

        // Notify the rejected socket
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            targetSocket.emit('rejected', {
                message: 'Admin declined your request.'
            });
        }

    });

    /* ---- User cancels their own pending join request ---- */
    socket.on('cancel-join-request', ({ code }) => {

        const room = rooms[code];
        if (!room) return;

        // Remove from pending
        room.pendingRequests = room.pendingRequests
            .filter(r => r.socketId !== socket.id);

        // Notify admin so they can remove the card from their panel
        io.to(room.adminSocketId).emit('request-cancelled', {
            socketId: socket.id
        });

    });


    /* ---- Admin kicks a user from the room ---- */
    socket.on('kick-user', ({ targetSocketId, code }) => {

        const room = rooms[code];
        if (!room || room.adminSocketId !== socket.id) return;

        const targetSocket = io.sockets.sockets.get(targetSocketId);
        const targetUser   = users[targetSocketId];
        const username     = targetUser ? targetUser.username : 'Unknown';

        // Remove user's mute status (clean up)
        room.mutedUsers.delete(targetSocketId);

        // Notify the kicked socket first, then clean up
        if (targetSocket) {
            targetSocket.emit('kicked', { message: 'You were kicked from the room by the admin.' });
            targetSocket.leave(code);
        }

        delete users[targetSocketId];

        io.to(code).emit('system message', `${username} was kicked from the room`);
        updateUsers(code);

    });

    /* ---- Feature 7: Lock / Unlock Room ---- */
    socket.on('lock-room', ({ code }) => {

        const room = rooms[code];
        if (!room || room.adminSocketId !== socket.id) return;

        room.locked = !room.locked;

        io.to(code).emit('room-lock-changed', { locked: room.locked });
        io.to(code).emit('system message',
            room.locked ? '🔒 Room has been locked.' : '🔓 Room has been unlocked.');

    });

    /* ---- Feature 8: Transfer Admin Role ---- */
    socket.on('transfer-admin', ({ targetSocketId, code }) => {

        const room = rooms[code];
        if (!room || room.adminSocketId !== socket.id) return;
        if (!users[targetSocketId] || users[targetSocketId].room !== code) return;

        const oldAdminId   = room.adminSocketId;
        const newAdminName = users[targetSocketId].username;

        // Demote old admin
        users[oldAdminId].isAdmin = false;

        // Promote new admin
        users[targetSocketId].isAdmin  = true;
        rooms[code].adminSocketId      = targetSocketId;
        rooms[code].mutedUsers.delete(targetSocketId); // unmute if was muted

        // Notify both parties
        socket.emit('admin-transferred');
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) targetSocket.emit('you-are-admin', { code, name: room.name });

        io.to(code).emit('system message', `👑 ${newAdminName} is now the room admin.`);
        updateUsers(code);

    });

    /* ---- Feature 10: Close Room (admin) ---- */
    socket.on('close-room', ({ code }) => {

        const room = rooms[code];
        if (!room || room.adminSocketId !== socket.id) return;

        // Notify all members before cleanup
        io.to(code).emit('room-closed', { message: 'The admin has closed this room.' });

        // Remove all users belonging to this room
        Object.keys(users).forEach(id => {
            if (users[id] && users[id].room === code) delete users[id];
        });

        delete rooms[code];
        console.log(`Room ${code} closed by admin.`);

    });

    /* ---- Feature 12: Update Room Permissions ---- */
    socket.on('update-permissions', ({ code, permissions }) => {

        const room = rooms[code];
        if (!room || room.adminSocketId !== socket.id) return;

        const allowedKeys = ['allowReply', 'allowReactions', 'allowImages', 'allowFiles', 'allowEmoji'];
        allowedKeys.forEach(key => {
            if (typeof permissions[key] === 'boolean') room.permissions[key] = permissions[key];
        });

        io.to(code).emit('permissions-updated', room.permissions);

    });

    /* ---- Feature 14: Toggle Message Reaction ---- */
    socket.on('add-reaction', ({ messageId, emoji, code }) => {

        const room = rooms[code];
        if (!room) return;
        if (!room.permissions.allowReactions) {
            socket.emit('reaction-denied');
            return;
        }

        if (!room.reactions[messageId]) room.reactions[messageId] = {};
        if (!room.reactions[messageId][emoji]) {
            room.reactions[messageId][emoji] = { count: 0, users: [] };
        }

        const rxn      = room.reactions[messageId][emoji];
        const userIdx  = rxn.users.indexOf(socket.id);

        if (userIdx === -1) {
            // Add reaction
            rxn.count++;
            rxn.users.push(socket.id);
        } else {
            // Toggle off
            rxn.count--;
            rxn.users.splice(userIdx, 1);
            if (rxn.count === 0) delete room.reactions[messageId][emoji];
        }

        io.to(code).emit('reaction-updated', {
            messageId,
            reactions: room.reactions[messageId] || {}
        });

    });


    /* ---- Admin mutes a user (blocks their chat messages) ---- */
    socket.on('mute-user', ({ targetSocketId, code }) => {

        const room = rooms[code];
        if (!room || room.adminSocketId !== socket.id) return;

        room.mutedUsers.add(targetSocketId);

        const targetUser = users[targetSocketId];
        const username   = targetUser ? targetUser.username : 'Unknown';

        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            targetSocket.emit('muted', { message: 'You have been muted by the admin.' });
        }

        updateUsers(code);
        io.to(code).emit('system message', `${username} was muted`);

    });

    /* ---- Admin unmutes a user ---- */
    socket.on('unmute-user', ({ targetSocketId, code }) => {

        const room = rooms[code];
        if (!room || room.adminSocketId !== socket.id) return;

        room.mutedUsers.delete(targetSocketId);

        const targetUser = users[targetSocketId];
        const username   = targetUser ? targetUser.username : 'Unknown';

        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            targetSocket.emit('unmuted');
        }

        updateUsers(code);
        io.to(code).emit('system message', `${username} was unmuted`);

    });


    socket.on("chat message", (data) => {
        console.log('[Server Socket] Received "chat message" from client:', {
            username: data.username,
            message: data.message,
            hasImage: !!data.image,
            imageLength: data.image ? data.image.length : 0,
            hasFile: !!data.file,
            fileSize: data.file ? data.file.size : 0,
            hasVideo: !!data.video,
            videoSize: data.video ? data.video.filesize : 0
        });


        const user = users[socket.id];

        if (user) {

            // Server-side mute check — blocks messages from muted sockets
            const room = rooms[user.room];
            if (room && room.mutedUsers.has(socket.id)) {
                socket.emit('you-are-muted');
                return;
            }

            console.log(`[Server Socket] Broadcasting "chat message" to room ${user.room}`);
            io.to(user.room).emit(
                "chat message",
                data
            );

        }

    });


    socket.on("typing", (username) => {

        const user = users[socket.id];

        if (user) {

            socket.to(user.room).emit(
                "typing",
                `${username} is typing...`
            );

        }

    });

    socket.on("rejoin", ({ username, room, sessionToken }) => {
        const oldSocketId = Object.keys(users).find(id => {
            const u = users[id];
            return u.room === room && u.username === username && u.sessionToken === sessionToken;
        });

        if (oldSocketId) {
            // Cancel the disconnect timeout
            if (disconnectTimeouts[oldSocketId]) {
                clearTimeout(disconnectTimeouts[oldSocketId]);
                delete disconnectTimeouts[oldSocketId];
            }

            // Transfer user session to new socket.id
            users[socket.id] = users[oldSocketId];
            if (oldSocketId !== socket.id) {
                delete users[oldSocketId];
            }

            // Update admin ID if needed
            const r = rooms[room];
            if (r && r.adminSocketId === oldSocketId) {
                r.adminSocketId = socket.id;
            }

            socket.join(room);
            updateUsers(room);

            console.log(`User ${username} rejoined room ${room} successfully (Session restored)`);
            socket.emit("rejoined-successfully");
        } else {
            console.log(`Rejoin failed for user ${username} in room ${room} (expired or not found)`);
            socket.emit("rejoin-failed");
        }
    });

    socket.on("disconnect", () => {

        const user = users[socket.id];

        if (user) {
            const roomCode = user.room;
            const socketId = socket.id;

            // Start a grace period of 10 seconds before clean up to allow reconnecting
            disconnectTimeouts[socketId] = setTimeout(() => {
                cleanupUserSession(socketId, user);
                delete disconnectTimeouts[socketId];
            }, 10000);

        } else {

            // Socket was in a pending state (never fully joined)
            // Remove from any pending lists and notify admins
            Object.values(rooms).forEach(room => {
                const wasInPending = room.pendingRequests
                    .some(r => r.socketId === socket.id);

                if (wasInPending) {
                    room.pendingRequests = room.pendingRequests
                        .filter(r => r.socketId !== socket.id);

                    io.to(room.adminSocketId).emit('request-cancelled', {
                        socketId: socket.id
                    });
                }
            });

        }

    });


});

/* ============================================================
   updateUsers(room)
   Emits a rich user-list to every socket in the room.
   Each entry: { socketId, username, avatar, isAdmin, isMuted }
   The client uses isAdmin for the crown icon and isMuted for 🔇.
============================================================ */
function updateUsers(room) {

    const mutedSet  = rooms[room] ? rooms[room].mutedUsers : new Set();

    const roomUsers = Object.entries(users)
        .filter(([, u]) => u.room === room)
        .map(([id, u]) => ({
            socketId: id,
            username: u.username,
            avatar:   u.avatar   || '👾',
            isAdmin:  u.isAdmin  || false,
            isMuted:  mutedSet.has(id)
        }));

    io.to(room).emit("users list", roomUsers);

}

function cleanupUserSession(socketId, user) {
    if (!user) return;
    const roomCode = user.room;
    const wasAdmin = user.isAdmin;

    // Check if the user has already reconnected on another socket ID
    // If they did, their username is still present in users with a different socket.id
    const hasReconnected = Object.entries(users).some(([id, u]) => {
        return u.room === roomCode && u.username === user.username && u.sessionToken === user.sessionToken;
    });
    if (hasReconnected) {
        console.log(`Grace period expired for ${user.username}, but session was already restored on a new socket.`);
        return;
    }

    io.to(roomCode).emit("system message", `${user.username} left the room`);
    delete users[socketId];

    // Find remaining members in this room
    const remaining = Object.entries(users)
        .filter(([, u]) => u.room === roomCode);

    if (remaining.length === 0) {
        // Room is now empty — delete it
        if (rooms[roomCode]) {
            delete rooms[roomCode];
            console.log(`Room ${roomCode} deleted (empty)`);
        }
    } else if (wasAdmin && rooms[roomCode]) {
        /* ---- Feature 9: Auto-Admin Reassignment ---- */
        const [newAdminId, newAdminUser] = remaining[0];

        newAdminUser.isAdmin = true;
        rooms[roomCode].adminSocketId = newAdminId;
        rooms[roomCode].mutedUsers.delete(newAdminId); // auto-unmute new admin

        const newAdminSocket = io.sockets.sockets.get(newAdminId);
        if (newAdminSocket) {
            newAdminSocket.emit('you-are-admin', {
                code: roomCode,
                name: rooms[roomCode].name
            });
        }

        io.to(roomCode).emit('system message',
            `👑 ${newAdminUser.username} is now the room admin.`);

        updateUsers(roomCode);
    } else {
        updateUsers(roomCode);
    }
}


const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
