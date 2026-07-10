const express = require("express");

const http = require("http");

const { Server } = require("socket.io");

const app = express();

const server = http.createServer(app);

const io = new Server(server);

app.use(express.static("public"));

const users = {};

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
    socket.on("new user", ({ username, room, avatar }) => {

        users[socket.id] = {
            username,
            avatar: avatar || '👾',
            room,
            isAdmin: false   // admin is set only via create-room
        };

        socket.join(room);

        updateUsers(room);

        socket.to(room).emit(
            "system message",
            `${username} joined the room`
        );

    });

    /* ---- Create a new room (admin flow) ---- */
    socket.on("create-room", ({ username, avatar, roomName, roomType }) => {

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
            // Default permissions (Feature 12 — admin can toggle)
            permissions: {
                allowImages:      true,
                allowFiles:       true,
                allowReply:       true,
                allowReactions:   true,
                allowEmoji:       true,
                allowPolls:       false,
                allowVoice:       false,
                allowScreenShare: false,
                allowInviteLinks: true
            }
        };

        // Register the creator as admin
        users[socket.id] = {
            username,
            avatar: avatar || '👾',
            room:    code,
            isAdmin: true
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
    socket.on('join-room-request', ({ username, avatar, code }) => {

        const room = rooms[code];

        // Room must exist
        if (!room) {
            socket.emit('join-error', {
                message: 'Room not found. Check the code and try again.'
            });
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
            users[socket.id] = { username, avatar: avatar || '👾', room: code, isAdmin: false };
            socket.join(code);
            socket.emit('join-approved', { code, name: room.name });
            socket.to(code).emit('system message', `${username} joined the room`);
            updateUsers(code);
            return;
        }

        // Approval / Private: add to pending list
        const requestEntry = { socketId: socket.id, username, avatar: avatar || '👾' };
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
            isAdmin:  false
        };

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

        const user = users[socket.id];

        if (user) {

            // Server-side mute check — blocks messages from muted sockets
            const room = rooms[user.room];
            if (room && room.mutedUsers.has(socket.id)) {
                socket.emit('you-are-muted');
                return;
            }

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

    socket.on("disconnect", () => {

        const user = users[socket.id];

        if (user) {

            const roomCode = user.room;
            const wasAdmin = user.isAdmin;

            io.to(roomCode).emit("system message", `${user.username} left the room`);
            delete users[socket.id];

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

server.listen(3000, () => {

    console.log("Server running on port 3000");

});