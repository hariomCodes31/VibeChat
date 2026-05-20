const express = require("express");

const http = require("http");

const { Server } = require("socket.io");

const app = express();

const server = http.createServer(app);

const io = new Server(server);

app.use(express.static("public"));

const users = {};

io.on("connection", (socket) => {

    console.log("A user connected");

    socket.on("new user", ({ username, room }) => {

        users[socket.id] = {
            username,
            room
        };

        socket.join(room);

        updateUsers(room);

        socket.to(room).emit(
            "system message",
            `${username} joined ${room}`
        );

    });

    socket.on("chat message", (data) => {

        const user = users[socket.id];

        if (user) {

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

            io.to(user.room).emit(
                "system message",
                `${user.username} left ${user.room}`
            );

            delete users[socket.id];

            updateUsers(user.room);

        }

    });

});

function updateUsers(room) {

    const roomUsers =
        Object.values(users)
            .filter(user =>
                user.room === room
            )
            .map(user =>
                user.username
            );

    io.to(room).emit(
        "users list",
        roomUsers
    );

}

server.listen(3000, () => {

    console.log(
        "Server running on port 3000"
    );

});