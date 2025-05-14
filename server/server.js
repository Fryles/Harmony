// IMPORTS
const http = require("http");
const express = require("express");
const socketio = require("socket.io");
const cors = require("cors");
const sirv = require("sirv");

// ENVIRONMENT VARIABLES
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || "SIGNALING123";

// SETUP SERVERS
const app = express();
app.use(express.json(), cors());
const server = http.createServer(app);
const io = socketio(server, { cors: {} });

// AUTHENTICATION MIDDLEWARE
io.use((socket, next) => {
	const token = socket.handshake.auth.token;
	//TODO add lookups here to match userId and secret in DB
	if (token === TOKEN) {
		next();
	} else {
		console.log("bad auth");
		next(new Error("Authentication error"));
	}
});

// API ENDPOINT TO DISPLAY THE CONNECTION TO THE SIGNALING SERVER
let connections = {};
app.get("/connections", (req, res) => {
	res.json(Object.values(connections));
});

// MESSAGING LOGIC
io.on("connection", (socket) => {
	console.log("User connected with id", socket.id);

	socket.on("ready", (peerId) => {
		// Make sure that the hostname is unique, if the hostname is already in connections, send an error and disconnect
		if (peerId in connections || peerId === null) {
			socket.emit("uniquenessError", {
				message: `${peerId} is already connected to the signalling server. Please change your peer ID and try again.`,
			});
			socket.disconnect(true);
		} else {
			console.log(`Added ${peerId} to connections`);
			// Let new peer know about all exisiting peers

			socket.send({
				from: "all",
				target: peerId,
				payload: {
					action: "open",
					connections: Object.values(connections),
					bePolite: false,
				},
			});

			// Create new peer
			const newPeer = { socketId: socket.id, peerId };
			// Updates connections object
			connections[peerId] = newPeer;
			// Let all other peers know about new peer
			socket.broadcast.emit("message", {
				from: peerId,
				target: "all",
				payload: { action: "open", connections: [newPeer], bePolite: true },
			});
			// send connections object with an array containing the only new peer and make all exisiting peers polite.
		}
	});

	socket.on("joinChannel", (chnl, old) => {
		if (old) {
			console.log(
				`${socket.handshake.auth.userId} leaving ${old} and joining ${chnl}`
			);
			socket.leave(old);
		} else {
			console.log(`${socket.handshake.auth.userId} joining ${chnl}`);
		}
		socket.join(chnl);
		const peersInChannel = [];
		for (const peerId in connections) {
			const peerSocket = io.sockets.sockets.get(connections[peerId].socketId);
			if (peerSocket && peerSocket.rooms.has(chnl)) {
				peersInChannel.push(peerId);
			}
		}
		const newPeer = socket.handshake.auth.userId;
		//tell new user what peers to start RTC negotiation with
		socket.emit("welcome", {
			from: "server",
			channel: chnl,
			target: socket.id,
			peers: peersInChannel,
		});
		//Tell existing peers about new peer
		socket.to(chnl).emit("peerJoin", {
			from: newPeer,
			channel: chnl,
			target: chnl,
		});
	});

	socket.on("leaveChannel", (chnl) => {
		console.log(`${socket.handshake.auth.userId} leaving channel ${chnl}`);
		const leftPeer = socket.handshake.auth.userId;
		socket.leave(chnl);
		//send message to still connected channel members to cease connection w/ peer
		socket.to(chnl).emit("peerLeave", {
			from: leftPeer,
			channel: chnl,
			target: chnl,
		});
	});

	socket.on("message", (channel, peerId, message) => {
		// Check if the target peer is in the channel before sending the message
		const targetPeer = connections[peerId];
		message.channel = channel;
		if (targetPeer) {
			const targetSocket = io.sockets.sockets.get(targetPeer.socketId);
			if (targetSocket && targetSocket.rooms.has(channel)) {
				io.to(targetPeer.socketId).emit("message", message);
			} else {
				console.log(`Peer ${peerId} is not in channel ${channel}`);
			}
		} else {
			console.log(`Peer ${peerId} not found`);
		}
	});

	socket.on("directMessage", (message) => {
		// Send message to a specific targeted peer
		if (message === null || message === undefined) {
			console.log(`Bad dm message`);
		}
		const { target } = message.to;
		const targetPeer = connections[target];
		if (targetPeer) {
			io.to(targetPeer.socketId).emit("message", { ...message });
		} else {
			console.log(`Target ${target} not found`);
		}
	});

	socket.on("disconnect", () => {
		const disconnectingPeer = Object.values(connections).find(
			(peer) => peer.socketId === socket.id
		);
		if (disconnectingPeer) {
			console.log(
				"Disconnected",
				socket.id,
				"with peerId",
				disconnectingPeer.peerId
			);

			// Emit peerLeave for each channel the peer is part of
			const socketRooms = socket.rooms;
			// socket.rooms is a Set including the socket.id itself, so skip that
			for (const room of socketRooms) {
				if (room !== socket.id) {
					socket.to(room).emit("peerLeave", {
						from: disconnectingPeer.peerId,
						channel: room,
						target: room,
					});
				}
			}

			// Make all peers close their peer channels
			socket.broadcast.emit("message", {
				from: disconnectingPeer.peerId,
				target: "all",
				payload: {
					action: "close",
					message: "Peer has left the signaling server",
				},
			});
			// remove disconnecting peer from connections
			delete connections[disconnectingPeer.peerId];
		} else {
			console.log(socket.id, "has disconnected");
		}
	});
});

// SERVE STATIC FILES
app.use(sirv("public"));

// RUN APP
server.listen(PORT, console.log(`Listening on PORT ${PORT}`));
