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

//throttles/security
const pepper = Math.round(Math.random() * 420);
console.log("pepper: ", pepper);
const addServerThrottle = {};
const addUserThrottle = {};

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
		// Limit account creation per IP
		const ip = socket.handshake.address;
		const now = Date.now();
		const DAY = 24 * 60 * 60 * 1000;
		if (!addUserThrottle[ip]) {
			addUserThrottle[ip] = [];
		}
		// Remove timestamps older than 24 hours
		addUserThrottle[ip] = addUserThrottle[ip].filter((ts) => now - ts < DAY);
		if (addUserThrottle[ip].length >= 4) {
			console.log("Account creation limit reached for IP:", ip);
			let err = new Error(
				"Account creation limit reached for this IP. Try again later."
			);
			err.message =
				"Account creation limit reached for this IP. Try again later.";
			return next(err);
		}
		addUserThrottle[ip].push(now);

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

	socket.on("serverAuth", async (name, id, secret, callback) => {
		const servers = db.data.servers || {};
		if (
			callback &&
			servers[name] &&
			servers[name].id === id &&
			servers[name].secret === secret
		) {
			//good auth
			callback(servers[name]);
		} else {
			//fail
			callback(false);
		}
	});

	socket.on("serverQuery", async (name, exact, callback) => {
		if (!name) {
			if (callback) callback([]);
			return;
		}
		var matches;
		const servers = db.data.servers || {};
		if (exact) {
			matches = Object.values(servers).filter((s) => s.name === name);
			if (matches.length === 0) {
				matches = [
					{
						name: name,
						id: generateUuidBySeed(name),
					},
				];
			}
		} else {
			name = name.toLowerCase();
			matches = Object.values(servers).filter((s) =>
				s.name.toLowerCase().includes(name)
			);
			//filter matches to only open servers
			matches = matches.filter((s) => {
				if (!s.options.serverUnlisted) {
					return s;
				}
			});
		}

		// Map matches to only return name and id
		matches = matches.map((s) => ({ name: s.name, id: s.id }));

		if (callback) callback(matches);
	});

	socket.on("registerServer", async (server, callback) => {
		const userId = socket.handshake.auth.userId;
		const now = Date.now();

		if (
			addServerThrottle[userId] &&
			now - addServerThrottle[userId] < 6 * 60 * 60 * 1000 // 6 hours
		) {
			if (callback)
				callback({
					success: false,
					error: "You can only create a server once every 6 hours.",
				});
			return;
		}

		//takes name, id, secret, and options object
		const uuidV4Regex =
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		const id = server?.id;
		let name = server?.name;
		if (!id || !uuidV4Regex.test(id)) {
			if (callback) callback({ success: false, error: "Invalid server id" });
			return;
		}
		if (
			!name ||
			typeof name !== "string" ||
			name.length > 32 ||
			name.length < 3
		) {
			if (callback) callback({ success: false, error: "Invalid server name" });
			return;
		}
		// Sanitize name: trim, collapse spaces, limit length, remove special chars/emojis/accented chars
		name = name
			.normalize("NFD") // decompose accented chars
			.replace(/[\u0300-\u036f]/g, "") // remove accents
			.replace(/[^\x20-\x7E]/g, "") // remove non-ASCII (emojis, symbols)
			.replace(/[^a-zA-Z0-9 ]/g, "") // remove special chars except space
			.trim()
			.replace(/\s+/g, " ")
			.slice(0, 32);

		if (name.length === 0 || name.length > 32 || name.length < 3) {
			if (callback) callback({ success: false, error: "Invalid server name" });
			return;
		}

		// Check if server id already exists
		if (db.data.servers[name]) {
			if (callback)
				callback({ success: false, error: "Server name already exists" });
			return;
		}

		const safeServer = {
			name: name,
			id: id,
			secret: server.secret,
			options: {
				serverOpen: server.options.serverOpen,
				serverUnlisted: server.options.serverUnlisted,
				serverStoredMessaging: server.options.serverStoredMessaging,
			},
			admin: userId,
			messages: [],
		};
		db.data.servers[name] = safeServer;
		await db.write();

		addServerThrottle[userId] = now;
		if (callback) callback({ success: true, server: safeServer });
	});

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

//util for fake server id
function generateUuidBySeed(seedString) {
	//add per server session salt to hash to stop guessing of fake uuids
	seedString = `${seedString}${pepper}`;
	//Enumerating unlisted servers is still possible between server restarts
	//TODO make pepper a ENV maybe
	const hash = crypto.createHash("sha256").update(seedString).digest("hex");

	// UUID version 4 consists of 32 hexadecimal digits in the form:
	// 8-4-4-4-12 (total 36 characters including hyphens)

	const uuid = [
		hash.substring(0, 8),
		hash.substring(8, 12),
		"4" + hash.substring(12, 15), // Set the version to 4
		"8" + hash.substring(15, 18), // Set the variant to 8 (RFC 4122)
		hash.substring(18, 30),
	].join("-");

	return uuid;
}
