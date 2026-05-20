const socket = io();

const form =
    document.getElementById("chat-form");

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

let joined = false;

form.addEventListener("submit", (e) => {

    e.preventDefault();

    const username =
        usernameInput.value.trim();

    const message =
        messageInput.value.trim();

    const room =
        roomSelect.value;

    if (!joined && username) {

        socket.emit("new user", {
            username,
            room
        });

        joined = true;

        usernameInput.disabled = true;

        roomSelect.disabled = true;

    }

    if (username && message) {

        const timestamp =
            new Date().toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit"
            });

        socket.emit("chat message", {
            username,
            message,
            timestamp
        });

        addMessage(
            username,
            message,
            timestamp,
            true
        );

        messageInput.value = "";

    }

});

messageInput.addEventListener("input", () => {

    const username =
        usernameInput.value.trim();

    if (username) {

        socket.emit(
            "typing",
            username
        );

    }

});

socket.on("chat message", (data) => {

    const myUsername =
        usernameInput.value.trim();

    if (data.username !== myUsername) {

        addMessage(
            data.username,
            data.message,
            data.timestamp,
            false
        );

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

socket.on("users list", (users) => {

    usersList.innerHTML = "";

    usersTitle.textContent =
        `Online Users (${users.length})`;

    users.forEach((user) => {

        const li =
            document.createElement("li");

        li.textContent = user;

        usersList.appendChild(li);

    });

});

socket.on("load messages", (messagesData) => {

    messages.innerHTML = "";

    messagesData.forEach((msg) => {

        const myUsername =
            usernameInput.value.trim();

        addMessage(
            msg.username,
            msg.message,
            msg.timestamp,
            msg.username === myUsername
        );

    });

});

function addMessage(
    username,
    message,
    timestamp,
    isMine
) {

    const item =
        document.createElement("div");

    item.classList.add("message");

    if (isMine) {

        item.classList.add(
            "my-message"
        );

    } else {

        item.classList.add(
            "other-message"
        );

    }

    const avatar =
        username.charAt(0).toUpperCase();

    item.innerHTML = `

        <div class="message-top">

            <div class="avatar">
                ${avatar}
            </div>

            <div>

                <strong>${username}</strong>

                <div>${message}</div>

                <div class="timestamp">
                    ${timestamp}
                </div>

            </div>

        </div>

    `;

    messages.appendChild(item);

    messages.scrollTop =
        messages.scrollHeight;

} {

    const item =
        document.createElement("div");

    item.classList.add("message");

    if (isMine) {

        item.classList.add(
            "my-message"
        );

    } else {

        item.classList.add(
            "other-message"
        );

    }

    item.innerHTML = `
        <strong>${username}</strong>
        <div>${message}</div>
        <div class="timestamp">
            ${timestamp}
        </div>
    `;

    messages.appendChild(item);

    messages.scrollTop =
        messages.scrollHeight;

}
function addEmoji(emoji) {

    messageInput.value += emoji;

    messageInput.focus();

}