// IMPORTS
import http from "http";
import express from "express";
import { Server as socketio } from "socket.io";
import cors from "cors";
import sirv from "sirv";
import { JSONFilePreset } from "lowdb/node";
import crypto from "crypto";

// ENVIRONMENT VARIABLES
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || "SIGNALING123";

// SETUP SERVERS
const app = express();
app.use(express.json(), cors());
const server = http.createServer(app);
const io = new socketio(server, { cors: {} });

// DB
const db = await JSONFilePreset("db.json", {
	requests: [],
	users: {},
	ips: {},
	servers: {},
});

//friend requests used to store pending requests that have not been accepted/denied
//friend requests, {id: [{from,fromName,secret,timestamp}...]}
//await db.update(({ requests }) => (requests[id].push({from,fromName,secret,timestamp})));

//users holds auth/reg data for our... users
//users, {id: { name, secret, session, sessionTimestamp }}

//ips keeps fraud account registering in check. only 420 accountRegisters per IP
//ips, ip: numRegs

//servers stores data for lookup, admin privs (pwd change, etc.), and message history (if enabled on creation)
//servers, {key:[{msgObj}...]}

// AUTHENTICATION MIDDLEWARE
io.use(async (socket, next) => {
	const userId = socket.handshake.auth.userId;
	// Validate userId is a valid UUID (v4)
	const uuidV4Regex =
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	if (!uuidV4Regex.test(userId)) {
		return next(new Error("Invalid userId: must be a valid UUID v4"));
	}
	//try session first
	if (db.data.users[userId] && socket.handshake.auth.session) {
		if (db.data.users[userId].session === socket.handshake.auth.session) {
			//good session auth
			//TODO: Check session timestamp to see if session expired
			console.log("client logged in with session token");
			return next();
		} else {
			//sent bad session, continue with auth
			console.log("client sent incorrect session");
		}
	}

	const secret = socket.handshake.auth.secret;

	const sessionToken = crypto.randomBytes(16).toString("hex");
	const sessionTimestamp = Date.now();
	if (db.data.users[userId] && db.data.users[userId].secret === secret) {
		//this userID exists and has correct secret, give session token
		await db.update(({ users }) => {
			users[userId].session = sessionToken;
			users[userId].sessionTimestamp = sessionTimestamp;
		});
		console.log("client logged in, sending session w/ ready");
		return next();
	} else if (!db.data.users[userId]) {
		//TODO add username validation
		const userName = socket.handshake.auth.userName;
		//no user for this id, registering and giving token
		await db.update(
			({ users }) =>
				(users[userId] = {
					name: userName,
					secret: secret,
					session: sessionToken,
					sessionTimestamp: sessionTimestamp,
				})
		);
		console.log("client registered, sending session w/ ready");
		return next();
	} else {
		//failed auth for existing user...
		console.log("client failed auth for existing user");

		return next(new Error("Authentication failed: invalid secret for userId"));
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

	socket.on("ready", () => {
		const peerId = socket.handshake.auth.userId;

		if (!peerId) {
			socket.disconnect(true);
		} else {
			if (peerId && peerId in connections) {
				delete connections[peerId];
			}
			console.log(`Added ${peerId} to connections`);

			socket.send({
				from: "server",
				target: peerId,
				session: db.data.users[peerId].session,
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

	//friend requests are tracked with 5 statuses:
	//awaiting - first pushed to server
	//cancelled - the sender has cancelled the request, req can be deleted
	//accepted - the reciever has accepted the request
	//rejected - the reciever has denied the request
	//recieved - the sender has acked the response - req can be deleted

	socket.on("friendRequest", async (friend, callback) => {
		//validate friend is not imaginary
		const uuidV4Regex =
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		if (!uuidV4Regex.test(friend)) {
			if (callback) callback({ success: false, error: "Invalid userId" });
			return;
		}
		if (!db.data.users[friend]) {
			if (callback)
				callback({ success: false, error: "UserId does not exist" });
			return;
		}

		const userId = socket.handshake.auth.userId;
		const requests = db.data.requests;

		// Check for existing outgoing request
		const outgoing = requests.find((r) => r.to === friend && r.from === userId);
		if (outgoing) {
			if (callback) callback({ success: false, error: "Request already sent" });
			return;
		}

		// Check for incoming request (reverse)
		const incomingIdx = requests.findIndex(
			(r) => r.to === userId && r.from === friend
		);
		if (requests[incomingIdx]) {
			// we already have a request for us :D
			db.data.requests[incomingIdx].status = "accepted";

			// Emit friendRequestResponse to both peers if possible
			const toPeer = connections[friend];
			if (toPeer) {
				io.to(toPeer.socketId).emit(
					"friendRequestResponse",
					db.data.requests[incomingIdx]
				);
				db.data.requests[incomingIdx].status = "recieved";
			}
			//respond with accepted req
			socket.emit("friendRequestResponse", db.data.requests[incomingIdx]);
			await db.write();
			return;
		}

		// No outgoing or incoming, create new request
		const fr = {
			from: userId,
			fromName: db.data.users[userId].name,
			to: friend,
			toName: db.data.users[friend].name,
			chat: crypto.randomBytes(24).toString("hex"),
			time: Date.now(),
			status: "awaiting",
		};

		db.data.requests.push(fr);
		await db.write();
		if (callback) callback(fr);

		// Emit friendRequest to the target peer if possible
		const toPeer = connections[friend];
		if (toPeer) {
			io.to(toPeer.socketId).emit("friendRequest", fr);
		}
	});

	socket.on("friendRequestResponse", async (req) => {
		const userId = socket.handshake.auth.userId;
		const requests = db.data.requests;
		const idx = requests.findIndex(
			(r) => r.from === req.from && r.to === userId
		);
		if (idx !== -1) {
			if (req.status === "accepted") {
				requests[idx].status = "accepted";
			} else if (req.status === "rejected") {
				requests[idx].status = "rejected";
			} else {
				//invalid status for response
				console.log("Invalid status for friend request response");
				return;
			}
			//see if the sender is online
			const sender = connections[req.from];
			if (sender) {
				//send the sender the response
				io.to(sender.socketId).emit("friendRequestResponse", req);
				requests[idx].status = "recieved";
				//remove request
				requests.splice(idx, 1);
				await db.write();
			} else {
				//sender is offline, just update the request
				await db.write();
			}
		} else {
		}
	});

	socket.on("checkFriendReqs", async (callback) => {
		const userId = socket.handshake.auth.userId;
		const incoming = db.data.requests.filter(
			(r) => r.to === userId && r.status != "recieved"
		);
		const outgoing = db.data.requests.filter(
			(r) => r.from === userId && r.status != "recieved"
		);

		//since we are sending client their outgoing requests, any accepted/rejected should be updated to recieved
		let updated = false;
		for (const req of outgoing) {
			if (req.status === "accepted" || req.status === "rejected") {
				req.status = "BUHHUG";
				updated = true;
			}
		}
		if (updated) {
			await db.write();
		}
		callback({ incoming, outgoing });
	});

	socket.on("serverQuery", async (server, callback) => {});

	socket.on("cancelFriendRequest", async (req) => {
		const userId = socket.handshake.auth.userId;
		const requests = db.data.requests;
		const idx = requests.findIndex(
			(r) =>
				r.from === userId &&
				r.to === req.to &&
				r.chat === req.chat &&
				r.status === "awaiting"
		);
		if (idx !== -1) {
			requests.splice(idx, 1);
			await db.write();
			// Emit friendRequestCancelled to the target peer if possible
			const toPeer = connections[req.to];
			if (toPeer) {
				req.status = "cancelled";
				io.to(toPeer.socketId).emit("friendRequestResponse", req);
			}
		} else {
			console.log("Request not found or already accepted/rejected");
		}
	});

	socket.on("changePass", async (newSecret, callback) => {
		const userId = socket.handshake.auth.userId;
		const oldSecret = socket.handshake.auth.secret;
		const user = db.data.users[userId];
		if (!user) {
			if (callback) callback({ success: false, error: "User not found" });
			return;
		}
		if (user.secret !== oldSecret) {
			if (callback) callback({ success: false, error: "Secret incorrect" });
			return;
		}
		await db.update(({ users }) => {
			users[userId].secret = newSecret;
		});
		if (callback) callback({ success: true });
	});
});

// SERVE STATIC FILES
app.use(sirv("public"));

// RUN APP
server.listen(PORT, console.log(`Listening on PORT ${PORT}`));
