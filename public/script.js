const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
});

// Persistent session token stored in sessionStorage
let sessionToken = sessionStorage.getItem('vibe_session_token');
if (!sessionToken) {
    sessionToken = 'token_' + Math.random().toString(36).slice(2, 9);
    sessionStorage.setItem('vibe_session_token', sessionToken);
}

// Queue system to ensure emits work even if socket disconnected
function safeEmit(event, data) {
    if (socket.connected) {
        socket.emit(event, data);
    } else {
        console.log(`Socket disconnected. Queueing event "${event}"...`);
        socket.once('connect', () => {
            console.log(`Socket connected. Processing queued event "${event}"...`);
            socket.emit(event, data);
        });
        socket.connect();
    }
}

// Force re-connect when returning to the tab (safeguard for Android suspend mode)
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        if (!socket.connected) {
            console.log("Tab is visible but socket is disconnected. Forcing socket connection...");
            socket.connect();
        }
    }
});


/* ============================================================
   HAMBURGER SIDEBAR DRAWER — mobile only
   Toggles .drawer-open on .sidebar and .active on backdrop
============================================================ */
(function initDrawer() {
    const hamburger = document.getElementById('hamburger-btn');
    const sidebar   = document.querySelector('.sidebar');
    const backdrop  = document.getElementById('sidebar-backdrop');

    if (!hamburger || !sidebar || !backdrop) return;

    function openDrawer() {
        sidebar.classList.add('drawer-open');
        backdrop.classList.add('active');
        backdrop.style.display = 'block';
        hamburger.setAttribute('aria-expanded', 'true');
    }

    function closeDrawer() {
        sidebar.classList.remove('drawer-open');
        backdrop.classList.remove('active');
        hamburger.setAttribute('aria-expanded', 'false');
        // Hide backdrop after CSS transition finishes
        setTimeout(() => { backdrop.style.display = 'none'; }, 320);
    }

    hamburger.addEventListener('click', () => {
        const isOpen = sidebar.classList.contains('drawer-open');
        isOpen ? closeDrawer() : openDrawer();
    });

    // Tapping the dark backdrop closes the drawer
    backdrop.addEventListener('click', closeDrawer);

    // Close drawer automatically when screen grows past mobile breakpoint
    window.addEventListener('resize', () => {
        if (window.innerWidth > 768) closeDrawer();
    });
}());


/* ============================================================
   MODULE-LEVEL STATE
   Set by the landing page before entering the chat.
   Used throughout to identify the current user and room.
============================================================ */
let currentUsername = '';
let currentAvatar   = '👾';  // default avatar
let currentRoom     = '';    // room name / code
let isRoomAdmin     = false; // whether this client is the room admin
let isMuted         = false; // whether this client is currently muted
let joined = false;          // has the socket joined the room yet?


const form =
    document.getElementById("chat-form");

// Hidden legacy elements (kept in DOM for compatibility, not shown)
const usernameInput =
    document.getElementById("username-input");

const messageInput =
    document.getElementById("message-input");

const roomSelect =
    document.getElementById("room-select");

const messages =
    document.getElementById("messages");

const typingStatus =
    document.getElementById("typing-status");

const usersList =
    document.getElementById("users");

const usersTitle =
    document.getElementById("users-title");

form.addEventListener("submit", (e) => {

    e.preventDefault();

    // Client-side mute guard (server also validates)
    if (isMuted) {
        showToast('🔇 You are muted and cannot send messages.');
        messageInput.value = '';
        return;
    }

    // Use module-level state instead of reading disabled DOM inputs
    const username = currentUsername;
    const message  = messageInput.value.trim();
    const room     = currentRoom;

    if (!joined && username) {

        safeEmit("new user", { username, room, sessionToken });

        joined = true;

    }

    if (username && message) {

        const timestamp = new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit"
        });

        const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

        const payload = {
            username,
            message,
            timestamp,
            messageId: msgId
        };

        if (replyingTo) {
            payload.replyTo = replyingTo;
        }

        safeEmit("chat message", payload);

        addMessage(username, message, timestamp, true, {
            replyTo: replyingTo,
            messageId: msgId
        });

        clearReplyTo();

        messageInput.value = "";

    }


});



messageInput.addEventListener("input", () => {

    // Emit typing event using current session username
    if (currentUsername) {
        socket.emit("typing", currentUsername);
    }

});


// Automatically rejoin if we reconnect or connect
socket.on('connect', () => {
    console.log("Socket connected! ID:", socket.id);
    if (joined && currentUsername && currentRoom) {
        console.log("Session active. Attempting rejoin for", currentUsername, "in room", currentRoom);
        socket.emit("rejoin", {
            username: currentUsername,
            room: currentRoom,
            sessionToken: sessionToken
        });
    }
});

// Rejoin succeeded
socket.on("rejoined-successfully", () => {
    console.log("Session rejoined and restored successfully.");
});

// Rejoin failed (grace period expired), rejoin clean
socket.on("rejoin-failed", () => {
    console.log("Session rejoin failed. Rejoining cleanly...");
    if (joined && currentUsername && currentRoom) {
        socket.emit("new user", {
            username: currentUsername,
            room: currentRoom,
            avatar: currentAvatar,
            sessionToken: sessionToken
        });
    }
});


socket.on("chat message", (data) => {
    console.log('[Socket] Client received "chat message":', {
        username: data.username,
        message: data.message,
        hasImage: !!data.image,
        imageLength: data.image ? data.image.length : 0,
        hasFile: !!data.file,
        hasVideo: !!data.video
    });

    // Only render messages from OTHER users (we already rendered ours locally)
    if (data.username !== currentUsername) {
        addMessage(data.username, data.message, data.timestamp, false, {
            replyTo:   data.replyTo,
            messageId: data.messageId,
            sticker:   data.sticker,
            image:     data.image,
            file:      data.file,
            video:     data.video
        });
    }

});




socket.on("typing", (msg) => {

    typingStatus.textContent = msg;

    setTimeout(() => {

        typingStatus.textContent = "";

    }, 1000);

});

socket.on("system message", (msg) => {

    const item =
        document.createElement("div");

    item.classList.add(
        "system-message"
    );

    item.textContent = msg;

    messages.appendChild(item);

});

socket.on("users list", (userList) => {

    usersList.innerHTML = "";
    usersTitle.textContent = `Online Users (${userList.length})`;

    userList.forEach((user) => {

        const li = document.createElement("li");

        // Support both legacy string format and new rich object format
        const name      = typeof user === 'string' ? user : user.username;
        const avatar    = typeof user === 'object' ? (user.avatar  || '👾')  : '👾';
        const isAdmin   = typeof user === 'object' && user.isAdmin;
        const isMutedU  = typeof user === 'object' && user.isMuted;
        const socketId  = typeof user === 'object' ? user.socketId : null;
        const isMe      = socketId === socket.id;

        // Admin sees mute/kick/transfer buttons for every non-admin, non-self user
        const showActions = isRoomAdmin && !isAdmin && !isMe;

        // Pick prefix indicator
        let prefix = '🟢 ';
        if (isAdmin)  prefix = '👑 ';
        if (isMutedU) prefix = '🔇 ';

        li.innerHTML = `
            <span class="user-avatar-sm">${avatar}</span>
            <span class="user-name${isAdmin ? ' is-admin' : ''}${isMutedU ? ' is-muted' : ''}">
                ${prefix}${name}${isMe ? ' <em style="opacity:.45;font-size:11px">(you)</em>' : ''}
            </span>
            ${showActions ? `
                <div class="user-actions">
                    <button class="btn-user-action btn-mute-user"
                            data-socket-id="${socketId}"
                            data-muted="${isMutedU}"
                            title="${isMutedU ? 'Unmute' : 'Mute'} ${name}">
                        ${isMutedU ? '🔊' : '🔇'}
                    </button>
                    <button class="btn-user-action btn-transfer-admin"
                            data-socket-id="${socketId}"
                            title="Make ${name} the admin">
                        👑
                    </button>
                    <button class="btn-user-action btn-kick-user"
                            data-socket-id="${socketId}"
                            title="Kick ${name}">
                        🚫
                    </button>
                </div>
            ` : ''}
        `;

        // Wire up action buttons
        if (showActions) {
            // Mute / Unmute
            li.querySelector('.btn-mute-user').addEventListener('click', () => {
                const event = isMutedU ? 'unmute-user' : 'mute-user';
                socket.emit(event, { targetSocketId: socketId, code: currentRoom });
            });

            // Transfer admin (Feature 8)
            li.querySelector('.btn-transfer-admin').addEventListener('click', () => {
                if (window.confirm(`Make "${name}" the room admin? You will lose your admin role.`)) {
                    socket.emit('transfer-admin', { targetSocketId: socketId, code: currentRoom });
                }
            });

            // Kick with a confirmation prompt
            li.querySelector('.btn-kick-user').addEventListener('click', () => {
                if (window.confirm(`Kick "${name}" from the room?`)) {
                    socket.emit('kick-user', { targetSocketId: socketId, code: currentRoom });
                }
            });
        }

        usersList.appendChild(li);

    });

});


/* ---- kicked: admin removed us from the room ---- */
socket.on('kicked', ({ message }) => {

    const chatApp      = document.getElementById('chat-app');
    const landingScreen = document.getElementById('landing-screen');
    const errEl        = document.getElementById('landing-error');

    if (chatApp)       chatApp.style.display       = 'none';
    if (landingScreen) landingScreen.style.display = 'flex';

    if (errEl) {
        errEl.textContent = '🚫 ' + message;
        errEl.classList.remove('hidden');
    }

    // Reset all state
    currentUsername = '';
    currentRoom     = '';
    isRoomAdmin     = false;
    isMuted         = false;
    joined          = false;

    // Clear chat messages for next session
    if (messages) messages.innerHTML = '';
    if (usersList) usersList.innerHTML = '';
    if (usersTitle) usersTitle.textContent = 'Online Users (0)';

    // Hide admin panel
    showAdminPanel(false);

    // Hide room info bar
    const roomInfoBar = document.getElementById('room-info-bar');
    if (roomInfoBar) roomInfoBar.classList.add('hidden');

});

/* ---- muted: admin has muted us ---- */
socket.on('muted', ({ message }) => {

    isMuted = true;

    const banner = document.getElementById('muted-banner');
    if (banner) banner.classList.remove('hidden');

    if (messageInput) {
        messageInput.disabled   = true;
        messageInput.placeholder = '🔇 You are muted...';
    }

    showToast('🔇 ' + message);

});

/* ---- unmuted: admin has unmuted us ---- */
socket.on('unmuted', () => {

    isMuted = false;

    const banner = document.getElementById('muted-banner');
    if (banner) banner.classList.add('hidden');

    if (messageInput) {
        messageInput.disabled    = false;
        messageInput.placeholder = 'Type a message...';
    }

    showToast('🔊 You have been unmuted!');

});

/* ---- you-are-muted: server-side fallback when muted user tries to send ---- */
socket.on('you-are-muted', () => {

    showToast('🔇 You are muted and cannot send messages.');
    if (messageInput) messageInput.value = '';

});

/* ---- Feature 7: room-lock-changed ---- */
socket.on('room-lock-changed', ({ locked }) => {

    const lockBtn  = document.getElementById('btn-lock-room');
    const lockIcon = document.getElementById('room-lock-icon');

    if (lockBtn) {
        lockBtn.textContent    = locked ? '🔓 Unlock Room' : '🔒 Lock Room';
        lockBtn.dataset.locked = locked ? 'true' : 'false';
    }
    if (lockIcon) lockIcon.textContent = locked ? '🔒' : '';

});

/* ---- Feature 8 + 9: you-are-admin (transfer or auto-assign) ---- */
socket.on('you-are-admin', ({ code, name }) => {

    isRoomAdmin = true;
    currentRoom = code;
    isMuted     = false;

    // Clear muted state if we were muted before promotion
    const banner = document.getElementById('muted-banner');
    if (banner) banner.classList.add('hidden');
    if (messageInput) {
        messageInput.disabled    = false;
        messageInput.placeholder = 'Type a message...';
    }

    showAdminPanel(true);
    showRoomInfo(name, code, true);
    showToast('👑 You are now the room admin!');

    // Wire up admin controls (may be new to this session)
    initAdminControls(code);

});

/* ---- Feature 8: admin-transferred (we lost admin) ---- */
socket.on('admin-transferred', () => {

    isRoomAdmin = false;
    showAdminPanel(false);
    showToast('👑 Admin role transferred.');

});

/* ---- Feature 10: room-closed ---- */
socket.on('room-closed', ({ message }) => {

    const chatApp      = document.getElementById('chat-app');
    const landingScreen = document.getElementById('landing-screen');
    const errEl        = document.getElementById('landing-error');

    if (chatApp)       chatApp.style.display       = 'none';
    if (landingScreen) landingScreen.style.display = 'flex';
    if (errEl) { errEl.textContent = '🚪 ' + message; errEl.classList.remove('hidden'); }

    // Reset all state
    currentUsername = '';
    currentRoom     = '';
    isRoomAdmin     = false;
    isMuted         = false;
    joined          = false;
    replyingTo      = null;

    if (messages)   messages.innerHTML   = '';
    if (usersList)  usersList.innerHTML  = '';
    if (usersTitle) usersTitle.textContent = 'Online Users (0)';

    showAdminPanel(false);
    const roomInfoBar = document.getElementById('room-info-bar');
    if (roomInfoBar) roomInfoBar.classList.add('hidden');

});

/* ---- Feature 12: permissions-updated ---- */
socket.on('permissions-updated', (perms) => {

    currentPermissions = perms;
    updatePermissionToggles(perms);

});

/* ---- Feature 14: reaction-updated ---- */
socket.on('reaction-updated', ({ messageId, reactions }) => {

    updateMessageReactions(messageId, reactions);

});

/* ---- join-approved: direct join for public rooms ---- */
socket.on('join-approved', ({ code, name }) => {

    currentRoom = code;
    isRoomAdmin = false;
    joined      = true;

    const landingScreen = document.getElementById('landing-screen');
    const chatApp       = document.getElementById('chat-app');
    if (landingScreen) landingScreen.style.display = 'none';
    if (chatApp)       chatApp.style.display = 'block';

    showRoomInfo(name, code, false);
    showToast('✅ Joined the room!');
    if (messageInput) messageInput.focus();

    // Request notification permission on first join
    requestNotificationPermission();

});

socket.on("load messages", (messagesData) => {

    messages.innerHTML = "";

    messagesData.forEach((msg) => {
        addMessage(
            msg.username,
            msg.message,
            msg.timestamp,
            msg.username === currentUsername  // use state var, not DOM read
        );
    });

});


/* ============================================================
   addMessage(username, message, timestamp, isMine, opts)
   opts: { replyTo: { username, text }, messageId }
   Renders a chat message bubble with reply quote, reaction
   area, emoji picker, and reply button.
============================================================ */
function addMessage(username, message, timestamp, isMine, opts = {}) {

    const item = document.createElement('div');
    item.classList.add('message');
    item.classList.add(isMine ? 'my-message' : 'other-message');
    if (opts.sticker) {
        item.classList.add('sticker-message');
    }
    if (opts.image) {
        item.classList.add('image-message');
    }
    if (opts.video) {
        item.classList.add('video-message');
    }


    // Stable unique ID for reactions
    const msgId = opts.messageId || (Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    item.dataset.messageId = msgId;

    const avatar    = username.charAt(0).toUpperCase();
    const replyHTML = opts.replyTo
        ? `<span class="reply-quote" data-target-id="${opts.replyTo.messageId}">↩ ${opts.replyTo.username}: ${opts.replyTo.text.slice(0,60)}</span>`
        : '';


    let contentHTML = opts.sticker
        ? `<img class="sticker-img" src="${opts.sticker}" alt="Sticker">`
        : `<div>${message}</div>`;

    if (opts.image) {
        contentHTML = `
            <div class="shared-image-wrapper">
                <img class="shared-img" src="${opts.image}" alt="Shared Image">
            </div>
        `;
    } else if (opts.video) {
        const sizeFormatted = formatFileSize(opts.video.filesize);
        
        let durationFormatted = '';
        if (opts.video.duration) {
            const secs = Math.floor(opts.video.duration);
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            const s = secs % 60;
            if (h > 0) {
                durationFormatted = `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
            } else {
                durationFormatted = `${m}:${s < 10 ? '0' : ''}${s}`;
            }
            durationFormatted = `<span class="video-duration-tag" style="position: absolute; bottom: 8px; right: 8px; background: rgba(0, 0, 0, 0.7); color: white; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; pointer-events: none; z-index: 2;">${durationFormatted}</span>`;
        }

        const posterAttr = opts.video.thumbnailUrl ? `poster="${opts.video.thumbnailUrl}"` : '';

        contentHTML = `
            <div class="video-share-card">
                <div class="video-player-wrapper" style="position: relative; width: 100%; border-radius: 12px 12px 0 0; overflow: hidden; background: #000;">
                    <video class="shared-video" controls playsinline preload="metadata" ${posterAttr} style="display: block; width: 100%; max-height: 270px; object-fit: contain;">
                        <source src="${opts.video.url}" type="${opts.video.mimeType || 'video/mp4'}">
                        Your browser does not support the video tag.
                    </video>
                    ${durationFormatted}
                </div>
                <div class="video-share-info">
                    <div class="video-share-meta">
                        <span class="video-share-name" title="${opts.video.filename}">${opts.video.filename}</span>
                        <span class="video-share-size">${sizeFormatted}</span>
                    </div>
                    <a class="btn-video-download" href="${opts.video.url}" download="${opts.video.filename}">📥 Download</a>
                </div>
            </div>
        `;
    } else if (opts.file) {
        const sizeFormatted = formatFileSize(opts.file.size);
        contentHTML = `
            <div class="file-share-card">
                <span class="file-share-icon">📄</span>
                <div class="file-share-info">
                    <span class="file-share-name" title="${opts.file.name}">${opts.file.name}</span>
                    <span class="file-share-size">${sizeFormatted}</span>
                </div>
                <a class="btn-file-download" href="${opts.file.data}" download="${opts.file.name}">Download</a>
            </div>
        `;
    }


    const avatarHTML = opts.sticker
        ? ''
        : `<div class="avatar">${avatar}</div>`;

    item.innerHTML = `
        <div class="message-top">
            ${avatarHTML}
            <div>
                <strong>${username}</strong>
                ${replyHTML}
                ${contentHTML}
                <div class="timestamp">${timestamp}</div>
            </div>
        </div>

        <div class="message-reactions"></div>
        <!-- Emoji picker (hover) -->
        <div class="emoji-picker">
            <button class="emoji-btn" data-emoji="👍">👍</button>
            <button class="emoji-btn" data-emoji="❤️">❤️</button>
            <button class="emoji-btn" data-emoji="😂">😂</button>
            <button class="emoji-btn" data-emoji="😮">😮</button>
            <button class="emoji-btn" data-emoji="🔥">🔥</button>
            <button class="emoji-btn" data-emoji="👏">👏</button>
        </div>
        <!-- Reply button (hover) -->
        <button class="btn-reply-msg" title="Reply">↩ Reply</button>
    `;


    // Emoji picker: send reaction to server
    item.querySelectorAll('.emoji-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            socket.emit('add-reaction', {
                messageId: msgId,
                emoji:     btn.dataset.emoji,
                code:      currentRoom
            });
        });
    });

    // Reply button: set reply state and show indicator
    item.querySelector('.btn-reply-msg').addEventListener('click', () => {
        setReplyTo(msgId, username, message);
    });

    // Scroll to original message when clicking reply quote
    if (opts.replyTo) {
        const replyQuoteEl = item.querySelector('.reply-quote');
        if (replyQuoteEl) {
            replyQuoteEl.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetId = replyQuoteEl.dataset.targetId;
                const targetMsg = document.querySelector(`[data-message-id="${targetId}"]`);
                if (targetMsg) {
                    targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    targetMsg.classList.add('reply-highlight');
                    setTimeout(() => {
                        targetMsg.classList.remove('reply-highlight');
                    }, 1500);
                } else {
                    showToast('🔍 Original message not found in this session');
                }
            });
            replyQuoteEl.style.cursor = 'pointer';
        }
    }


    // Scroll to bottom when sticker loads; show error fallback if decoding fails
    const imgEl = item.querySelector('.sticker-img');
    if (imgEl) {
        imgEl.onload = () => {
            messages.scrollTop = messages.scrollHeight;
        };
        imgEl.onerror = () => {
            const errSpan = document.createElement('span');
            errSpan.style.color = '#ff6b6b';
            errSpan.style.fontSize = '12px';
            errSpan.style.fontStyle = 'italic';
            errSpan.style.display = 'block';
            errSpan.style.marginTop = '6px';
            errSpan.textContent = '⚠️ Failed to load sticker';
            imgEl.replaceWith(errSpan);
            messages.scrollTop = messages.scrollHeight;
        };
    }

    // Lightbox image preview triggers
    if (opts.image) {
        const wrapper = item.querySelector('.shared-image-wrapper');
        if (wrapper) {
            wrapper.addEventListener('click', () => {
                const lightbox = document.getElementById('image-lightbox-modal');
                const lightboxImg = document.getElementById('lightbox-img');
                if (lightbox && lightboxImg) {
                    lightboxImg.src = opts.image;
                    lightbox.classList.remove('hidden');
                }
            });
        }

        const sharedImg = item.querySelector('.shared-img');
        if (sharedImg) {
            sharedImg.onload = () => {
                console.log(`[Image Render] Image loaded successfully in DOM: msgId=${msgId}`);
                messages.scrollTop = messages.scrollHeight;
            };
            sharedImg.onerror = () => {
                console.error(`[Image Render] Failed to load image in DOM: msgId=${msgId}`);
                const errSpan = document.createElement('span');
                errSpan.style.color = '#ff6b6b';
                errSpan.style.fontSize = '12px';
                errSpan.style.fontStyle = 'italic';
                errSpan.style.display = 'block';
                errSpan.style.marginTop = '6px';
                errSpan.textContent = '⚠️ Failed to load image';
                sharedImg.replaceWith(errSpan);
                messages.scrollTop = messages.scrollHeight;
            };
        }
    }

    if (opts.video) {
        const sharedVideo = item.querySelector('.shared-video');
        if (sharedVideo) {
            sharedVideo.addEventListener('loadeddata', () => {
                console.log(`[Video Render] Video loaded data successfully in DOM: msgId=${msgId}`);
                messages.scrollTop = messages.scrollHeight;
            });
            sharedVideo.addEventListener('error', (e) => {
                console.error(`[Video Render] Failed to load video in DOM: msgId=${msgId}`, e);
                const errSpan = document.createElement('span');
                errSpan.className = 'video-load-error';
                errSpan.style.color = '#ff6b6b';
                errSpan.style.fontSize = '12px';
                errSpan.style.fontStyle = 'italic';
                errSpan.style.display = 'block';
                errSpan.style.marginTop = '6px';
                errSpan.textContent = '⚠️ Video format or codec not supported by your browser';
                sharedVideo.replaceWith(errSpan);
                messages.scrollTop = messages.scrollHeight;
            });
        }
    }



    messages.appendChild(item);

    messages.scrollTop = messages.scrollHeight;

    // Feature 15: browser notification if tab is not active
    if (!isMine && document.hidden && notificationsEnabled) {
        new Notification(`VibeChat — ${username}`, {
            body: message.slice(0, 80),
            icon: '/favicon.ico'
        });
    }

}  // end addMessage


function addEmoji(emoji) {

    messageInput.value += emoji;

    messageInput.focus();

}

/* ============================================================
   showRoomInfo(name, code, isAdmin)
   Populates and reveals the room info bar in the chat header.
   Wires up copy-code and copy-link buttons.
============================================================ */
function showRoomInfo(name, code, isAdmin) {
    const bar       = document.getElementById('room-info-bar');
    const nameEl    = document.getElementById('room-name-display');
    const codeEl    = document.getElementById('room-code-badge');
    const btnCode   = document.getElementById('btn-copy-code');
    const btnLink   = document.getElementById('btn-copy-link');

    if (!bar) return;

    nameEl.textContent = name;
    codeEl.textContent = code;
    bar.classList.remove('hidden');

    // Copy room code to clipboard
    btnCode.addEventListener('click', () => {
        navigator.clipboard.writeText(code)
            .then(() => showToast('📋 Room code copied!'))
            .catch(() => showToast(code)); // fallback: show code in toast
    });

    // Copy full invite link to clipboard
    btnLink.addEventListener('click', () => {
        const url = `${window.location.origin}/?room=${code}`;
        navigator.clipboard.writeText(url)
            .then(() => showToast('🔗 Invite link copied!'))
            .catch(() => showToast(url));
    });
}

/* ============================================================
   showToast(message)
   Briefly shows a floating notification at the bottom of screen.
   Creates the toast element on first call.
============================================================ */
let toastTimer = null;
function showToast(message) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

/* ---- room-created: server confirmed room creation ---- */
socket.on('room-created', ({ code, name }) => {

    currentRoom  = code;
    isRoomAdmin  = true;
    joined       = true;  // prevent form-submit from re-emitting new-user

    const landingScreen = document.getElementById('landing-screen');
    const chatApp       = document.getElementById('chat-app');
    if (landingScreen) landingScreen.style.display = 'none';
    if (chatApp)       chatApp.style.display = 'block';

    showRoomInfo(name, code, true /* isAdmin */);
    showAdminPanel(true);          // reveal the admin panel in sidebar

    if (messageInput) messageInput.focus();

});

/* ---- waiting-approval: server placed us in the pending queue ---- */
socket.on('waiting-approval', ({ roomName, code }) => {

    // Remember which room we're pending for (needed for cancel)
    currentRoom = code;

    // Hide landing, show waiting screen
    const landingScreen  = document.getElementById('landing-screen');
    const waitingScreen  = document.getElementById('waiting-screen');
    const waitingNameEl  = document.getElementById('waiting-room-name');
    const cancelBtn      = document.getElementById('btn-cancel-wait');

    if (landingScreen) landingScreen.style.display = 'none';
    if (waitingScreen) waitingScreen.style.display  = 'flex';
    if (waitingNameEl) waitingNameEl.textContent    = roomName;

    // Cancel button: emit cancel-join-request and go back to landing
    if (cancelBtn) {
        cancelBtn.onclick = () => {
            socket.emit('cancel-join-request', { code });
            waitingScreen.style.display = 'none';
            if (landingScreen) landingScreen.style.display = 'flex';

            // Re-enable join button if user goes back
            const joinBtn = document.getElementById('btn-join-confirm');
            if (joinBtn) {
                joinBtn.disabled    = false;
                joinBtn.textContent = '🚪 Enter Room';
            }
            currentRoom = '';
        };
    }

});

/* ---- approved: admin accepted our join request ---- */
socket.on('approved', ({ code, name }) => {

    const waitingScreen = document.getElementById('waiting-screen');
    const chatApp       = document.getElementById('chat-app');

    currentRoom  = code;
    isRoomAdmin  = false;
    joined       = true;

    if (waitingScreen) waitingScreen.style.display = 'none';
    if (chatApp)       chatApp.style.display = 'block';

    showRoomInfo(name, code, false /* not admin */);
    showToast('✅ You have been approved!');

    if (messageInput) messageInput.focus();

});

/* ---- rejected: admin declined our join request ---- */
socket.on('rejected', ({ message }) => {

    const waitingScreen = document.getElementById('waiting-screen');
    const landingScreen = document.getElementById('landing-screen');
    const errEl         = document.getElementById('landing-error');

    // Return to landing and show the rejection message
    if (waitingScreen) waitingScreen.style.display = 'none';
    if (landingScreen) landingScreen.style.display = 'flex';

    if (errEl) {
        errEl.textContent = '❌ ' + message;
        errEl.classList.remove('hidden');
    }

    // Re-enable join button
    const joinBtn = document.getElementById('btn-join-confirm');
    if (joinBtn) {
        joinBtn.disabled    = false;
        joinBtn.textContent = '🚪 Enter Room';
    }

    currentRoom = '';

});

/* ---- pending-request: admin receives a new join request ---- */
socket.on('pending-request', ({ socketId, username, avatar }) => {

    if (!isRoomAdmin) return;  // safety guard
    addPendingCard(socketId, username, avatar);

});

/* ---- request-cancelled: a pending user cancelled or disconnected ---- */
socket.on('request-cancelled', ({ socketId }) => {

    removePendingCard(socketId);

});

/* ============================================================
   showAdminPanel(visible)
   Shows or hides the admin panel in the sidebar.
   Called when the current user is the room creator.
============================================================ */
function showAdminPanel(visible) {
    const panel = document.getElementById('admin-panel');
    if (!panel) return;
    if (visible) {
        panel.classList.remove('hidden');
        // Wire up controls every time panel is shown
        initAdminControls(currentRoom);
    } else {
        panel.classList.add('hidden');
    }
}

/* ============================================================
   initAdminControls(code)
   Wires up the lock, close, permission, and transfer-admin
   buttons in the admin panel. Safe to call multiple times
   (uses replaceWith to avoid duplicate listeners).
============================================================ */
function initAdminControls(code) {

    /* Lock Room */
    const lockBtnOld = document.getElementById('btn-lock-room');
    if (lockBtnOld) {
        const lockBtn = lockBtnOld.cloneNode(true);
        lockBtnOld.replaceWith(lockBtn);
        lockBtn.addEventListener('click', () => {
            socket.emit('lock-room', { code: currentRoom });
        });
    }

    /* Close Room */
    const closeBtnOld = document.getElementById('btn-close-room');
    if (closeBtnOld) {
        const closeBtn = closeBtnOld.cloneNode(true);
        closeBtnOld.replaceWith(closeBtn);
        closeBtn.addEventListener('click', () => {
            if (window.confirm('Are you sure you want to close this room? All members will be removed.')) {
                socket.emit('close-room', { code: currentRoom });
            }
        });
    }

    /* Permission toggles */
    const permReply = document.getElementById('perm-reply');
    if (permReply) {
        permReply.addEventListener('change', () => {
            socket.emit('update-permissions', {
                code:        currentRoom,
                permissions: { allowReply: permReply.checked }
            });
        });
    }

    const permReactions = document.getElementById('perm-reactions');
    if (permReactions) {
        permReactions.addEventListener('change', () => {
            socket.emit('update-permissions', {
                code:        currentRoom,
                permissions: { allowReactions: permReactions.checked }
            });
        });
    }

}

/* ============================================================
   addPendingCard(socketId, username, avatar)
   Creates a pending-request card in the admin panel with
   Accept and Reject buttons. Called when admin receives a
   'pending-request' socket event.
============================================================ */
function addPendingCard(socketId, username, avatar) {
    const pendingSection = document.getElementById('pending-section');
    const pendingList    = document.getElementById('pending-list');
    if (!pendingSection || !pendingList) return;

    // Reveal the pending section
    pendingSection.classList.remove('hidden');

    // Build the card
    const li = document.createElement('li');
    li.classList.add('pending-item');
    li.dataset.socketId = socketId;

    li.innerHTML = `
        <span class="pending-avatar">${avatar}</span>
        <span class="pending-name">${username}</span>
        <div class="pending-actions">
            <button class="btn-approve" title="Accept ${username}">\u2713 Accept</button>
            <button class="btn-reject"  title="Reject ${username}">\u2715 Reject</button>
        </div>
    `;

    // Accept button
    li.querySelector('.btn-approve').addEventListener('click', () => {
        socket.emit('approve-user', { targetSocketId: socketId, code: currentRoom });
        removePendingCard(socketId);
    });

    // Reject button
    li.querySelector('.btn-reject').addEventListener('click', () => {
        socket.emit('reject-user', { targetSocketId: socketId, code: currentRoom });
        removePendingCard(socketId);
    });

    pendingList.appendChild(li);

    // Toast to draw admin's attention
    showToast(`\ud83d\udd14 ${username} wants to join!`);
}

/* ============================================================
   removePendingCard(socketId)
   Removes a pending card after accept/reject/cancel/disconnect.
   Hides the section header if no cards remain.
============================================================ */
function removePendingCard(socketId) {
    const pendingList = document.getElementById('pending-list');
    if (!pendingList) return;

    const card = pendingList.querySelector(`[data-socket-id="${socketId}"]`);
    if (card) card.remove();

    // Hide section header when queue is empty
    if (pendingList.children.length === 0) {
        const pendingSection = document.getElementById('pending-section');
        if (pendingSection) pendingSection.classList.add('hidden');
    }
}

/* ============================================================
   updateMessageReactions(messageId, reactions)
   Rebuilds the reaction pill row for a specific message.
============================================================ */
function updateMessageReactions(messageId, reactions) {
    const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!msgEl) return;

    const rxnArea = msgEl.querySelector('.message-reactions');
    if (!rxnArea) return;

    rxnArea.innerHTML = '';

    Object.entries(reactions).forEach(([emoji, { count }]) => {
        if (count <= 0) return;
        const pill = document.createElement('span');
        pill.classList.add('reaction-pill');
        pill.innerHTML = `${emoji} <span class="reaction-count">${count}</span>`;
        pill.title = `React with ${emoji}`;
        pill.addEventListener('click', () => {
            socket.emit('add-reaction', {
                messageId,
                emoji,
                code: currentRoom
            });
        });
        rxnArea.appendChild(pill);
    });
}

/* ============================================================
   updatePermissionToggles(perms)
   Syncs the admin panel checkboxes with latest permissions.
============================================================ */
function updatePermissionToggles(perms) {
    const permReply     = document.getElementById('perm-reply');
    const permReactions = document.getElementById('perm-reactions');
    if (permReply)     permReply.checked     = perms.allowReply     !== false;
    if (permReactions) permReactions.checked = perms.allowReactions !== false;
}

/* ============================================================
   Reply state & indicator
   replyingTo: null | { messageId, username, text }
============================================================ */
let replyingTo          = null;
let notificationsEnabled = false;

function setReplyTo(messageId, username, text) {
    replyingTo = { messageId, username, text };
    const indicator = document.getElementById('reply-indicator');
    const preview   = document.getElementById('reply-preview');
    if (indicator) indicator.classList.remove('hidden');
    if (preview)   preview.textContent = `${username}: ${text.slice(0, 60)}`;
    if (messageInput) messageInput.focus();
}

function clearReplyTo() {
    replyingTo = null;
    const indicator = document.getElementById('reply-indicator');
    if (indicator) indicator.classList.add('hidden');
}

// Cancel reply button
const cancelReplyBtn = document.getElementById('btn-cancel-reply');
if (cancelReplyBtn) cancelReplyBtn.addEventListener('click', clearReplyTo);

/* ============================================================
   Feature 15: Browser Notifications
============================================================ */
function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().then(perm => {
            notificationsEnabled = perm === 'granted';
        });
    } else if (Notification.permission === 'granted') {
        notificationsEnabled = true;
    }
}

/* ============================================================
   LANDING PAGE CONTROLLER
   Controls the landing screen: avatar selection, sub-forms,
   username validation, and transitioning into the chat app.
============================================================ */
(function initLanding() {

    // --- Element refs ---
    const landingScreen  = document.getElementById('landing-screen');
    const chatApp        = document.getElementById('chat-app');
    const landingError   = document.getElementById('landing-error');
    const landingUsernameEl = document.getElementById('landing-username');
    const avatarGrid     = document.getElementById('avatar-grid');

    // Action buttons
    const btnCreateRoom  = document.getElementById('btn-create-room');
    const btnJoinRoom    = document.getElementById('btn-join-room');
    const btnCreateConfirm = document.getElementById('btn-create-confirm');
    const btnCreateBack  = document.getElementById('btn-create-back');
    const btnJoinConfirm = document.getElementById('btn-join-confirm');
    const btnJoinBack    = document.getElementById('btn-join-back');

    // Sub-forms
    const landingActions   = document.getElementById('landing-actions');
    const createRoomForm   = document.getElementById('create-room-form');
    const joinRoomForm     = document.getElementById('join-room-form');
    const roomNameInput    = document.getElementById('room-name-input');
    const roomCodeInput    = document.getElementById('room-code-input');

    // --- Avatar selection ---
    avatarGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('.avatar-option');
        if (!btn) return;
        // Deselect previous
        avatarGrid.querySelectorAll('.avatar-option').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        currentAvatar = btn.dataset.emoji;  // store in module state
    });

    // --- Show error helper ---
    function showError(msg) {
        landingError.textContent = msg;
        landingError.classList.remove('hidden');
    }

    function clearError() {
        landingError.textContent = '';
        landingError.classList.add('hidden');
    }

    // --- Validate username before advancing to sub-forms ---
    function getValidUsername() {
        const val = landingUsernameEl.value.trim();
        if (!val) {
            showError('Please enter a username first.');
            landingUsernameEl.focus();
            return null;
        }
        if (val.length < 2) {
            showError('Username must be at least 2 characters.');
            landingUsernameEl.focus();
            return null;
        }
        clearError();
        return val;
    }

    // --- Toggle between main actions and sub-forms ---
    function showSubForm(formEl) {
        landingActions.classList.add('hidden');
        createRoomForm.classList.add('hidden');
        joinRoomForm.classList.add('hidden');
        formEl.classList.remove('hidden');
    }

    function showMainActions() {
        createRoomForm.classList.add('hidden');
        joinRoomForm.classList.add('hidden');
        landingActions.classList.remove('hidden');
        clearError();
    }

    // --- Create Room button ---
    btnCreateRoom.addEventListener('click', () => {
        if (!getValidUsername()) return;
        showSubForm(createRoomForm);
        roomNameInput.focus();
    });

    btnCreateBack.addEventListener('click', showMainActions);

    // --- Join Room button ---
    btnJoinRoom.addEventListener('click', () => {
        if (!getValidUsername()) return;
        showSubForm(joinRoomForm);
        // Pre-fill room code if ?room= is in URL (invite link support)
        const params = new URLSearchParams(window.location.search);
        if (params.get('room')) {
            roomCodeInput.value = params.get('room').toUpperCase();
        }
        roomCodeInput.focus();
    });

    btnJoinBack.addEventListener('click', showMainActions);

    /* --------------------------------------------------------
       transitionToChat(username, room, roomName, isAdmin)
       Pure UI helper: updates module state and switches the
       view from landing to chat. Does NOT emit any socket events.
    -------------------------------------------------------- */
    function transitionToChat(username, room, roomName, isAdmin) {
        currentUsername = username;
        currentRoom     = room;
        joined          = true;

        landingScreen.style.display = 'none';
        chatApp.style.display = 'block';

        showRoomInfo(roomName || room, room, isAdmin);

        if (messageInput) messageInput.focus();
    }

    /* --------------------------------------------------------
       enterChat(username, room)
       Used when a direct join is needed (emits new-user to
       server then calls transitionToChat). Kept for any legacy
       path that bypasses join-room-request.
    -------------------------------------------------------- */
    function enterChat(username, room) {
        safeEmit('new user', { username, room, avatar: currentAvatar, sessionToken });
        transitionToChat(username, room, room, false);
    }


    // --- Confirm Create Room (now emits create-room to server for code generation) ---
    btnCreateConfirm.addEventListener('click', () => {
        const username = getValidUsername();
        if (!username) return;

        const roomName = roomNameInput.value.trim();
        if (!roomName) {
            showError('Please enter a room name.');
            roomNameInput.focus();
            return;
        }

        // Store username now; room code comes back in room-created event
        currentUsername = username;

        // Read selected room type
        const activeTypeBtn = document.querySelector('.rt-btn.active');
        const roomType = activeTypeBtn ? activeTypeBtn.dataset.type : 'approval';

        // Emit to server — server generates code, emits room-created back
        safeEmit('create-room', {
            username,
            avatar:   currentAvatar,
            roomName,
            roomType,
            sessionToken
        });
    });


    // Allow Enter key in room name field
    roomNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnCreateConfirm.click();
    });

    // --- Confirm Join Room (emits join-room-request, waits for join-approved/join-error) ---
    btnJoinConfirm.addEventListener('click', () => {
        const username = getValidUsername();
        if (!username) return;

        const code = roomCodeInput.value.trim().toUpperCase();
        if (!code) {
            showError('Please enter a room code.');
            roomCodeInput.focus();
            return;
        }

        // Show loading state on the button
        btnJoinConfirm.disabled = true;
        btnJoinConfirm.textContent = 'Joining...';
        clearError();

        // Store username now — room info comes back in join-approved
        currentUsername = username;

        // Emit validated join request to server
        safeEmit('join-room-request', {
            username,
            avatar: currentAvatar,
            code,
            sessionToken
        });
    });


    // Allow Enter key in room code field
    roomCodeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnJoinConfirm.click();
    });

    // Allow Enter key on username field to advance
    landingUsernameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') btnCreateRoom.click();
    });

    // Room type selector (Feature 11)
    const roomTypeSelector = document.getElementById('room-type-selector');
    if (roomTypeSelector) {
        roomTypeSelector.addEventListener('click', (e) => {
            const btn = e.target.closest('.rt-btn');
            if (!btn) return;
            roomTypeSelector.querySelectorAll('.rt-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    }

}());

/* ============================================================
   Module-level permissions state
   Tracks latest room permissions for client-side gating.
============================================================ */
let currentPermissions = {
    allowReply:     true,
    allowReactions: true,
    allowImages:    true,
    allowFiles:     true,
    allowEmoji:     true
};

/* ============================================================
   Feature 8: Transfer Admin — added to user list buttons
   (rendered inside the users list socket listener above)
   The emit is triggered by clicking a crown button —
   injected via the users list renderer extension below.
============================================================ */



/* ============================================================
   FEATURE: CUSTOM STICKERS (Version 1)
   Manages image validation, Cropper.js modal setup, preview,
   compression, and Socket.IO real-time transmission.
============================================================ */
(function initCustomStickers() {
    const btnSticker = document.getElementById('btn-sticker-picker');
    const fileInput  = document.getElementById('sticker-file-input');

    if (!btnSticker || !fileInput) return;

    // Click trigger for file input (one listener bound)
    btnSticker.addEventListener('click', () => {
        fileInput.click();
    });

    // File selection handler
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (validateStickerFile(file)) {
            openStickerCropper(file);
        } else {
            fileInput.value = ''; // Reset input on validation failure
        }
    });

    // Validate image rules
    function validateStickerFile(file) {
        // Max size: 10 MB
        const maxSize = 10 * 1024 * 1024;
        if (file.size > maxSize) {
            showToast('❌ File size exceeds 10 MB limit.');
            return false;
        }

        const name = file.name.toLowerCase();
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
        const rejectedExtensions = ['.gif', '.svg', '.exe', '.bat', '.cmd', '.dll', '.sh', '.js'];

        const hasAllowed = allowedExtensions.some(ext => name.endsWith(ext));
        const hasRejected = rejectedExtensions.some(ext => name.endsWith(ext));

        if (hasRejected || !hasAllowed) {
            showToast('❌ Invalid format. Only JPG, JPEG, PNG, and WebP are allowed.');
            return false;
        }

        const allowedMime = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (!allowedMime.includes(file.type)) {
            showToast('❌ Invalid image format. Select a valid JPG, PNG, or WebP.');
            return false;
        }

        return true;
    }

    let cropperInstance = null;
    let sourceObjectURL = null;

    // Load image via Object URL and open Cropper modal
    function openStickerCropper(file) {
        // Clean up previous Object URL if any
        if (sourceObjectURL) {
            URL.revokeObjectURL(sourceObjectURL);
            sourceObjectURL = null;
        }

        sourceObjectURL = URL.createObjectURL(file);
        const cropModal = document.getElementById('sticker-crop-modal');
        const cropImage = document.getElementById('sticker-crop-image');

        cropImage.src = sourceObjectURL;
        cropModal.classList.remove('hidden');

        // Revoke the object URL after image loads/fails to free memory
        cropImage.onload = () => {
            if (sourceObjectURL) {
                URL.revokeObjectURL(sourceObjectURL);
                sourceObjectURL = null;
            }
        };

        cropImage.onerror = () => {
            showToast('❌ Failed to decode image.');
            closeStickerCropper();
        };

        if (cropperInstance) {
            cropperInstance.destroy();
            cropperInstance = null;
        }

        // Initialize Cropper.js (simple square, allow zoom/pan/move)
        cropperInstance = new Cropper(cropImage, {
            aspectRatio: 1,
            viewMode: 1,
            dragMode: 'move',
            autoCropArea: 0.8,
            restore: false,
            guides: false,
            center: true,
            highlight: false,
            cropBoxMovable: true,
            cropBoxResizable: true,
            toggleDragModeOnDblclick: false,
            zoomable: true,
            rotatable: false,
            scalable: false
        });
    }

    function closeStickerCropper() {
        document.getElementById('sticker-crop-modal').classList.add('hidden');
        fileInput.value = '';
        if (sourceObjectURL) {
            URL.revokeObjectURL(sourceObjectURL);
            sourceObjectURL = null;
        }
        if (cropperInstance) {
            cropperInstance.destroy();
            cropperInstance = null;
        }
    }

    // Cancel Crop button listener
    document.getElementById('btn-crop-cancel').addEventListener('click', closeStickerCropper);

    // Confirm Crop button listener (performs resize, compression, and WebP check)
    document.getElementById('btn-crop-confirm').addEventListener('click', () => {
        if (!cropperInstance) return;

        const canvas = cropperInstance.getCroppedCanvas({
            width: 512,
            height: 512,
            imageSmoothingEnabled: true,
            imageSmoothingQuality: 'high'
        });

        if (!canvas) {
            showToast('❌ Failed to crop image.');
            return;
        }

        // Check if WebP is supported by verifying the generated output signature
        let mimeType = 'image/webp';
        let quality = 0.85;
        let dataUrl = canvas.toDataURL(mimeType, quality);

        if (!dataUrl.startsWith('data:image/webp')) {
            mimeType = 'image/png';
            dataUrl = canvas.toDataURL(mimeType);
        }

        // Transmit size check: max 250 KB
        let sizeBytes = Math.round((dataUrl.length - 22) * 3 / 4);

        if (sizeBytes > 250 * 1024 && mimeType === 'image/webp') {
            quality = 0.6;
            dataUrl = canvas.toDataURL(mimeType, quality);
            sizeBytes = Math.round((dataUrl.length - 22) * 3 / 4);
        }

        // Secondary fallback to scale down resolution if file remains > 250 KB
        if (sizeBytes > 250 * 1024) {
            const shrink = document.createElement('canvas');
            shrink.width = 384;
            shrink.height = 384;
            const ctx = shrink.getContext('2d');
            ctx.drawImage(canvas, 0, 0, 384, 384);
            dataUrl = shrink.toDataURL(mimeType, 0.7);
            sizeBytes = Math.round((dataUrl.length - 22) * 3 / 4);
        }

        if (sizeBytes > 250 * 1024) {
            showToast('❌ Failed to compress sticker below 250 KB.');
            closeStickerCropper();
            return;
        }

        // Transition to preview screen
        const previewModal = document.getElementById('sticker-preview-modal');
        const previewImg   = document.getElementById('sticker-preview-img');

        previewImg.src = dataUrl;
        previewModal.classList.remove('hidden');

        // Hide crop modal and clean up cropper and object URLs
        document.getElementById('sticker-crop-modal').classList.add('hidden');
        if (sourceObjectURL) {
            URL.revokeObjectURL(sourceObjectURL);
            sourceObjectURL = null;
        }
        if (cropperInstance) {
            cropperInstance.destroy();
            cropperInstance = null;
        }
    });

    // Cancel Preview button listener
    document.getElementById('btn-preview-cancel').addEventListener('click', () => {
        document.getElementById('sticker-preview-modal').classList.add('hidden');
        fileInput.value = '';
    });

    // Send Preview button listener (transmits via Socket.IO)
    document.getElementById('btn-preview-send').addEventListener('click', () => {
        const previewImg = document.getElementById('sticker-preview-img');
        const dataUrl = previewImg.src;

        if (!dataUrl) return;

        const sizeBytes = Math.round((dataUrl.length - 22) * 3 / 4);
        if (sizeBytes > 250 * 1024) {
            showToast('❌ Sticker file size is too large (max 250 KB).');
            return;
        }

        const timestamp = new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit"
        });

        const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

        const payload = {
            username:  currentUsername,
            message:   '[Sticker]',
            sticker:   dataUrl,
            timestamp: timestamp,
            messageId: msgId
        };

        // Attach reply state if present
        if (replyingTo) {
            payload.replyTo = replyingTo;
            setTimeout(clearReplyTo, 50);
        }

        // Send to server
        safeEmit('chat message', payload);


        // Render locally instantly
        addMessage(currentUsername, '[Sticker]', timestamp, true, {
            replyTo:   payload.replyTo,
            messageId: msgId,
            sticker:   dataUrl
        });

        // Hide modal and clear input
        document.getElementById('sticker-preview-modal').classList.add('hidden');
        fileInput.value = '';
    });

}());

/* ============================================================
   FEATURE: IMAGE & FILE SHARING (Version 1)
   Manages drag-and-drop actions, attachment selection, validation,
   file progress indicator, and Base64 Socket.IO transfer.
============================================================ */

// Format file sizes into readable units
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}




// Helper function to extract video duration client-side and immediately revoke Object URL to prevent leaks
function getVideoDuration(file) {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        
        const objectUrl = URL.createObjectURL(file);
        video.src = objectUrl;
        
        video.onloadedmetadata = () => {
            const duration = video.duration;
            URL.revokeObjectURL(objectUrl);
            resolve(duration);
        };
        
        video.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(0);
        };
    });
}

// Helper function to generate video thumbnail client-side and immediately revoke Object URL
function generateVideoThumbnail(file) {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        
        const objectUrl = URL.createObjectURL(file);
        video.src = objectUrl;
        
        video.onloadeddata = () => {
            video.currentTime = Math.min(1, video.duration / 2 || 0.1);
        };
        
        video.onseeked = () => {
            try {
                const canvas = document.createElement('canvas');
                const maxThumbDim = 240;
                let width = video.videoWidth;
                let height = video.videoHeight;
                if (width > height) {
                    if (width > maxThumbDim) {
                        height = Math.round((height * maxThumbDim) / width);
                        width = maxThumbDim;
                    }
                } else {
                    if (height > maxThumbDim) {
                        width = Math.round((width * maxThumbDim) / height);
                        height = maxThumbDim;
                    }
                }
                
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, width, height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                URL.revokeObjectURL(objectUrl);
                resolve(dataUrl);
            } catch (err) {
                console.error('[Thumbnail generation error]:', err);
                URL.revokeObjectURL(objectUrl);
                resolve('');
            }
        };
        
        video.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            resolve('');
        };
    });
}

(function initImageAndFileSharing() {
    const btnAttachment = document.getElementById('btn-attachment-picker');
    const attachmentInput = document.getElementById('attachment-file-input');

    if (!btnAttachment || !attachmentInput) return;

    let currentUploadXhr = null;

    // Click trigger for file input
    btnAttachment.addEventListener('click', () => {
        if (currentUploadXhr) return; // ignore picker clicks while active upload
        attachmentInput.click();
    });

    // Native file picker selection handler
    attachmentInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        handleAttachmentFile(file);
    });

    // Drag and Drop support
    const chatContainer = document.querySelector('.chat-container');
    const dragOverlay = document.getElementById('drag-drop-overlay');

    if (chatContainer && dragOverlay) {
        let dragCounter = 0;

        chatContainer.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            dragOverlay.classList.remove('hidden');
        });

        chatContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        chatContainer.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter === 0) {
                dragOverlay.classList.add('hidden');
            }
        });

        chatContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            dragCounter = 0;
            dragOverlay.classList.add('hidden');

            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                handleAttachmentFile(files[0]);
            }
        });
    }

    // Attachment validation rule checks
    function validateAttachment(file) {
        const name = file.name.toLowerCase();
        const isVideo = file.type.startsWith('video/') || ['.mp4', '.webm', '.mov', '.mkv', '.avi'].some(ext => name.endsWith(ext));

        if (isVideo) {
            const maxVideoSize = 100 * 1024 * 1024; // 100 MB
            if (file.size > maxVideoSize) {
                showToast('❌ Video size exceeds 100 MB limit.');
                return false;
            }
        } else {
            const maxSize = 10 * 1024 * 1024; // 10 MB
            if (file.size > maxSize) {
                showToast('❌ File size exceeds 10 MB limit.');
                return false;
            }

            const allowedExtensions = [
                '.jpg', '.jpeg', '.png', '.webp',
                '.pdf', '.docx', '.pptx', '.xlsx', '.txt', '.zip'
            ];

            const hasAllowed = allowedExtensions.some(ext => name.endsWith(ext));
            if (!hasAllowed) {
                showToast('❌ Format not supported. Select an image (JPG, PNG, WebP) or file (PDF, DOCX, PPTX, XLSX, TXT, ZIP).');
                return false;
            }
        }

        return true;
    }

    // Helper to lock and unlock input UI during active uploads
    function setUploadsUIState(uploading) {
        btnAttachment.disabled = uploading;
        attachmentInput.disabled = uploading;
        const chatSendBtn = document.getElementById('btn-chat-send');
        const msgInput = document.getElementById('message-input');
        if (chatSendBtn) chatSendBtn.disabled = uploading;
        if (msgInput) msgInput.disabled = uploading;
    }

    // HTTP Video Upload operation using XMLHttpRequest
    function performVideoUpload(file, duration, thumbnailUrl) {
        const xhr = new XMLHttpRequest();
        currentUploadXhr = xhr;
        setUploadsUIState(true);

        const progressFill = document.getElementById('upload-progress-fill');
        const progressContainer = document.getElementById('upload-progress-container');
        const progressLabel = document.getElementById('upload-progress-label');
        const cancelBtn = document.getElementById('btn-cancel-upload');

        if (progressLabel) progressLabel.textContent = `Preparing video...`;
        if (progressContainer) progressContainer.classList.remove('hidden');
        if (progressFill) progressFill.style.width = '0%';
        if (cancelBtn) cancelBtn.style.display = 'inline-block';

        let startTime = Date.now();

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                if (progressFill) progressFill.style.width = pct + '%';

                // Calculate speed
                const elapsedSeconds = (Date.now() - startTime) / 1000;
                let speedText = '';
                if (elapsedSeconds > 0) {
                    const bytesPerSecond = e.loaded / elapsedSeconds;
                    const mbps = (bytesPerSecond / (1024 * 1024)).toFixed(1);
                    speedText = ` (${mbps} MB/s)`;
                }

                if (progressLabel) {
                    if (pct < 100) {
                        progressLabel.textContent = `Uploading "${file.name}"... ${pct}%${speedText}`;
                    } else {
                        progressLabel.textContent = `Processing video on server...`;
                    }
                }
            }
        };

        xhr.onload = () => {
            currentUploadXhr = null;
            setUploadsUIState(false);
            if (cancelBtn) cancelBtn.style.display = 'none';

            if (xhr.status >= 200 && xhr.status < 300) {
                if (progressLabel) progressLabel.textContent = `Upload Complete!`;
                if (progressFill) progressFill.style.width = '100%';
                setTimeout(() => {
                    if (progressContainer) progressContainer.classList.add('hidden');
                }, 800);

                try {
                    const response = JSON.parse(xhr.responseText);
                    if (response.success) {
                        const timestamp = new Date().toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit"
                        });
                        const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

                        const payload = {
                            username: currentUsername,
                            timestamp: timestamp,
                            messageId: msgId,
                            message: `[Video] ${file.name}`,
                            video: {
                                url: response.url,
                                filename: response.filename,
                                filesize: response.filesize,
                                mimeType: response.mimeType,
                                duration: duration,
                                thumbnailUrl: thumbnailUrl
                            }
                        };

                        const addMsgOpts = {
                            messageId: msgId,
                            video: payload.video
                        };

                        if (replyingTo) {
                            payload.replyTo = replyingTo;
                            addMsgOpts.replyTo = replyingTo;
                            setTimeout(clearReplyTo, 50);
                        }

                        // Emit metadata and render locally
                        safeEmit('chat message', payload);
                        addMessage(currentUsername, payload.message, timestamp, true, addMsgOpts);
                    } else {
                        handleUploadFailure(file, duration, thumbnailUrl, response.error || 'Server error.');
                    }
                } catch (err) {
                    console.error('[Upload Parse Error]:', err);
                    handleUploadFailure(file, duration, thumbnailUrl, 'Invalid response format.');
                }
            } else {
                let errorMsg = 'Server responded with status code ' + xhr.status;
                try {
                    const res = JSON.parse(xhr.responseText);
                    if (res.error) errorMsg = res.error;
                } catch (e) {}
                handleUploadFailure(file, duration, thumbnailUrl, errorMsg);
            }

            attachmentInput.value = '';
        };

        xhr.onerror = () => {
            currentUploadXhr = null;
            setUploadsUIState(false);
            if (cancelBtn) cancelBtn.style.display = 'none';
            handleUploadFailure(file, duration, thumbnailUrl, 'Network connection interrupted.');
            attachmentInput.value = '';
        };

        xhr.onabort = () => {
            currentUploadXhr = null;
            setUploadsUIState(false);
            if (cancelBtn) cancelBtn.style.display = 'none';
            if (progressContainer) progressContainer.classList.add('hidden');
            showToast('⚠️ Video upload cancelled.');
            attachmentInput.value = '';
        };

        const formData = new FormData();
        formData.append('video', file);
        formData.append('roomCode', currentRoom);
        formData.append('sessionToken', sessionToken);
        formData.append('username', currentUsername);

        xhr.open('POST', '/upload-video', true);
        xhr.send(formData);
    }

    // Handles retry prompt on failure
    function handleUploadFailure(file, duration, thumbnailUrl, reason) {
        const progressContainer = document.getElementById('upload-progress-container');
        if (progressContainer) progressContainer.classList.add('hidden');

        showToast(`❌ Video upload failed: ${reason}`);

        const retry = confirm(`Video upload failed: ${reason}\nWould you like to try uploading "${file.name}" again?`);
        if (retry) {
            performVideoUpload(file, duration, thumbnailUrl);
        }
    }

    // HTTP Image Upload operation using XMLHttpRequest
    function performImageUpload(file) {
        const xhr = new XMLHttpRequest();
        currentUploadXhr = xhr;
        setUploadsUIState(true);

        const progressFill = document.getElementById('upload-progress-fill');
        const progressContainer = document.getElementById('upload-progress-container');
        const progressLabel = document.getElementById('upload-progress-label');
        const cancelBtn = document.getElementById('btn-cancel-upload');

        if (progressLabel) progressLabel.textContent = `Preparing image...`;
        if (progressContainer) progressContainer.classList.remove('hidden');
        if (progressFill) progressFill.style.width = '0%';
        if (cancelBtn) cancelBtn.style.display = 'inline-block';

        let startTime = Date.now();

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                if (progressFill) progressFill.style.width = pct + '%';

                // Calculate speed
                const elapsedSeconds = (Date.now() - startTime) / 1000;
                let speedText = '';
                if (elapsedSeconds > 0) {
                    const bytesPerSecond = e.loaded / elapsedSeconds;
                    const mbps = (bytesPerSecond / (1024 * 1024)).toFixed(1);
                    speedText = ` (${mbps} MB/s)`;
                }

                if (progressLabel) {
                    if (pct < 100) {
                        progressLabel.textContent = `Uploading "${file.name}"... ${pct}%${speedText}`;
                    } else {
                        progressLabel.textContent = `Processing image on server...`;
                    }
                }
            }
        };

        xhr.onload = () => {
            currentUploadXhr = null;
            setUploadsUIState(false);
            if (cancelBtn) cancelBtn.style.display = 'none';

            if (xhr.status >= 200 && xhr.status < 300) {
                if (progressLabel) progressLabel.textContent = `Upload Complete!`;
                if (progressFill) progressFill.style.width = '100%';
                setTimeout(() => {
                    if (progressContainer) progressContainer.classList.add('hidden');
                }, 800);

                try {
                    const response = JSON.parse(xhr.responseText);
                    if (response.success) {
                        const timestamp = new Date().toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit"
                        });
                        const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

                        const payload = {
                            username: currentUsername,
                            timestamp: timestamp,
                            messageId: msgId,
                            message: `[Image]`,
                            image: response.url
                        };

                        const addMsgOpts = {
                            messageId: msgId,
                            image: response.url
                        };

                        if (replyingTo) {
                            payload.replyTo = replyingTo;
                            addMsgOpts.replyTo = replyingTo;
                            setTimeout(clearReplyTo, 50);
                        }

                        // Emit metadata and render locally
                        safeEmit('chat message', payload);
                        addMessage(currentUsername, payload.message, timestamp, true, addMsgOpts);
                    } else {
                        handleImageUploadFailure(file, response.error || 'Server error.');
                    }
                } catch (err) {
                    console.error('[Upload Parse Error]:', err);
                    handleImageUploadFailure(file, 'Invalid response format.');
                }
            } else {
                let errorMsg = 'Server responded with status code ' + xhr.status;
                try {
                    const res = JSON.parse(xhr.responseText);
                    if (res.error) errorMsg = res.error;
                } catch (e) {}
                handleImageUploadFailure(file, errorMsg);
            }

            attachmentInput.value = '';
        };

        xhr.onerror = () => {
            currentUploadXhr = null;
            setUploadsUIState(false);
            if (cancelBtn) cancelBtn.style.display = 'none';
            handleImageUploadFailure(file, 'Network connection interrupted.');
            attachmentInput.value = '';
        };

        xhr.onabort = () => {
            currentUploadXhr = null;
            setUploadsUIState(false);
            if (cancelBtn) cancelBtn.style.display = 'none';
            if (progressContainer) progressContainer.classList.add('hidden');
            showToast('⚠️ Image upload cancelled.');
            attachmentInput.value = '';
        };

        const formData = new FormData();
        formData.append('video', file); // Use 'video' field name to match what backend multer expects
        formData.append('roomCode', currentRoom);
        formData.append('sessionToken', sessionToken);
        formData.append('username', currentUsername);

        xhr.open('POST', '/upload-video', true);
        xhr.send(formData);
    }

    function handleImageUploadFailure(file, reason) {
        const progressContainer = document.getElementById('upload-progress-container');
        if (progressContainer) progressContainer.classList.add('hidden');

        showToast(`❌ Image upload failed: ${reason}`);

        const retry = confirm(`Image upload failed: ${reason}\nWould you like to try uploading "${file.name}" again?`);
        if (retry) {
            performImageUpload(file);
        }
    }

    // Hook up Cancel button listener
    const cancelBtnEl = document.getElementById('btn-cancel-upload');
    if (cancelBtnEl) {
        cancelBtnEl.addEventListener('click', () => {
            if (currentUploadXhr) {
                currentUploadXhr.abort();
            }
        });
    }

    // Handles reading the file, updating progress bar, and emitting to Socket.IO
    function handleAttachmentFile(file) {
        if (!validateAttachment(file)) {
            attachmentInput.value = '';
            return;
        }

        const name = file.name.toLowerCase();
        const isVideo = file.type.startsWith('video/') || ['.mp4', '.webm', '.mov', '.mkv', '.avi'].some(ext => name.endsWith(ext));

        if (isVideo) {
            console.log(`[Video Share] Initializing video flow for "${file.name}"...`);
            const progressContainer = document.getElementById('upload-progress-container');
            const progressLabel = document.getElementById('upload-progress-label');
            if (progressContainer) progressContainer.classList.remove('hidden');
            if (progressLabel) progressLabel.textContent = `Preparing video...`;

            getVideoDuration(file).then(duration => {
                generateVideoThumbnail(file).then(thumbnailUrl => {
                    performVideoUpload(file, duration, thumbnailUrl);
                });
            });
            return;
        }

        const isImage = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].some(
            mime => file.type === mime || name.endsWith(mime.split('/')[1])
        );

        if (isImage) {
            console.log(`[Image Share] Initializing image flow for "${file.name}"...`);
            performImageUpload(file);
            return;
        }

        console.log(`[File Share] File selected: name="${file.name}", size=${file.size} bytes, type="${file.type}"`);

        const reader = new FileReader();
        const progressFill = document.getElementById('upload-progress-fill');
        const progressContainer = document.getElementById('upload-progress-container');
        const progressLabel = document.getElementById('upload-progress-label');

        if (progressLabel) progressLabel.textContent = `Sharing "${file.name}"...`;

        reader.onprogress = (e) => {
            if (e.lengthComputable && progressFill) {
                const pct = Math.round((e.loaded / e.total) * 100);
                progressFill.style.width = pct + '%';
            }
        };

        reader.onloadstart = () => {
            console.log('[File Share] FileReader load started.');
            if (progressContainer) progressContainer.classList.remove('hidden');
            if (progressFill) progressFill.style.width = '0%';
        };

        reader.onloadend = () => {
            console.log('[File Share] FileReader load ended.');
            setTimeout(() => {
                if (progressContainer) progressContainer.classList.add('hidden');
                if (progressFill) progressFill.style.width = '0%';
            }, 800);
        };

        reader.onerror = (err) => {
            console.error('[File Share] FileReader error:', err);
        };

        reader.onload = function (eData) {
            const dataUrl = eData.target.result;
            console.log(`[File Share] FileReader success. Base64 length: ${dataUrl.length}`);

            const isImage = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].some(
                mime => file.type === mime || file.name.toLowerCase().endsWith(mime.split('/')[1])
            );

            const timestamp = new Date().toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit"
            });

            const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

            const payload = {
                username:  currentUsername,
                timestamp: timestamp,
                messageId: msgId
            };

            const addMsgOpts = {
                messageId: msgId
            };

            // Attach reply indicators if active
            if (replyingTo) {
                payload.replyTo = replyingTo;
                addMsgOpts.replyTo = replyingTo;
                setTimeout(clearReplyTo, 50);
            }

            if (isImage) {
                payload.message = '[Image]';
                payload.image   = dataUrl;
                addMsgOpts.image = dataUrl;
            } else {
                payload.message = `[File] ${file.name}`;
                payload.file = {
                    name: file.name,
                    size: file.size,
                    data: dataUrl
                };
                addMsgOpts.file = payload.file;
            }

            console.log(`[File Share] Emitting payload via Socket.IO for message ID: ${msgId}`);
            // Emit sharing payload via socket
            safeEmit('chat message', payload);

            // Render local bubble instantly
            addMessage(currentUsername, payload.message, timestamp, true, addMsgOpts);

            // Reset input values
            attachmentInput.value = '';
        };

        reader.readAsDataURL(file);

    }
})();

// Lightbox modal trigger setup
(function initLightbox() {
    const lightbox = document.getElementById('image-lightbox-modal');
    const closeBtn = document.getElementById('btn-lightbox-close');
    if (lightbox) {
        lightbox.addEventListener('click', (e) => {
            if (e.target === lightbox || e.target === closeBtn) {
                lightbox.classList.add('hidden');
                const lightboxImg = document.getElementById('lightbox-img');
                if (lightboxImg) lightboxImg.src = '';
            }
        });
    }
})();

