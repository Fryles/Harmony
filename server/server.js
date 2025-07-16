// IMPORTS
import http from "http";
import express from "express";
import { Server as socketio } from "socket.io";
import cors from "cors";
import sirv from "sirv";
import { JSONFilePreset } from "lowdb/node";
import crypto from "crypto";
import { instrument } from "@socket.io/admin-ui";
import { JSDOM } from "jsdom";
import DOMPurify from "dompurify";

// ENVIRONMENT VARIABLES
const PORT = process.env.PORT || 3000;

// SETUP SERVERS
const app = express();
app.use(express.json(), cors());
const server = http.createServer(app);
const io = new socketio(server, {
	cors: {
		origin: ["https://admin.socket.io"],
		credentials: true,
	},
});
instrument(io, {
	auth: false,
	mode: "development",
});

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
const window = new JSDOM("").window;
const purify = DOMPurify(window);

// AUTHENTICATION MIDDLEWARE
io.use(async (socket, next) => {
	const userId = socket.handshake.auth.userId;
	// Validate userId is a valid UUID (v4)
	const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	if (!uuidV4Regex.test(userId)) {
		return next(new Error("Invalid userId: must be a valid UUID v4"));
	}
	//try session first
	if (db.data.users[userId] && socket.handshake.auth.session) {
		if (
			db.data.users[userId].session === socket.handshake.auth.session &&
			db.data.users[userId].sessionTimestamp &&
			Date.now() - db.data.users[userId].sessionTimestamp < 24 * 60 * 60 * 1000
		) {
			//good auth and session timestamp is within 24 hours
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
			let err = new Error("Account creation limit reached for this IP. Try again later.");
			err.message = "Account creation limit reached for this IP. Try again later.";
			return next(err);
		}
		addUserThrottle[ip].push(now);
		console.log("client registering new user with id", userId);
		let userName = socket.handshake.auth.userName;
		// Sanitize username
		userName = purify.sanitize(userName);
		if (!userName || typeof userName !== "string" || userName.length > 32 || userName.length < 3) {
			let err = new Error("Invalid username");
			err.message = "Invalid username: must be a string between 3 and 32 characters";
			return next(err);
		}

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

let connections = {};
// app.get("/connections", (req, res) => {
// 	res.json(Object.values(connections));
// });

// MESSAGING LOGIC
io.on("connection", (socket) => {
	console.log("User connected with id", socket.id);

	// Handles client ready event, adds peer to connections and sends session token
	socket.on("ready", () => {
		const peerId = socket.handshake.auth.userId;

		if (!peerId) {
			socket.disconnect(true);
		} else {
			if (peerId && peerId in connections) {
				delete connections[peerId];
			}
			console.log(`Added ${peerId} to connections`);

			// Send session token to the peer
			socket.send({
				from: "server",
				target: peerId,
				session: db.data.users[peerId].session,
			});

			// Create new peer
			const newPeer = { socketId: socket.id, peerId };
			// Updates connections object
			connections[peerId] = newPeer;
			// Let all other peers know about new peer
		}
	});

	// Handles joining a channel, notifies peers and sends welcome info
	socket.on("joinChannel", (chnl, old) => {
		if (old) {
			console.log(`${socket.handshake.auth.userId} leaving ${old} and joining ${chnl}`);
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

	// Returns all peerIds in a channel via callback
	socket.on("channelQuery", (chnl, callback) => {
		//get all peers on this voice channel and pass to callback
		//TODO this should probably have some throttle
		const clients = io.sockets.adapter.rooms.get(chnl);

		if (!clients) {
			callback([]);
		} else {
			// Map socket ids to peerIds
			const peerIds = Array.from(clients)
				.map((socketId) => {
					const entry = Object.entries(connections).find(([peerId, conn]) => conn.socketId === socketId);
					return entry ? entry[0] : null;
				})
				.filter(Boolean);
			callback(peerIds);
		}
	});

	// Handles leaving a channel, notifies peers
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

	// Relays a message to a peer in a channel
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

	// Handles peer disconnect, notifies channels and removes from connections
	socket.on("disconnect", () => {
		const disconnectingPeer = Object.values(connections).find((peer) => peer.socketId === socket.id);
		if (disconnectingPeer) {
			console.log("Disconnected", socket.id, "with peerId", disconnectingPeer.peerId);

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

	//friend requests are defined with 5 statuses:
	// add - sender requests to add friend
	// remove - sender requests removal of friend
	// cancelled - the sender has cancelled the request, req should be deleted
	// accepted - the reciever has accepted the request
	// rejected - the reciever has denied the request

	// Handles sending a friend request to another user
	socket.on("friendRequest", async (friend, callback) => {
		//validate friend is not imaginary
		const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		if (!uuidV4Regex.test(friend)) {
			if (callback) callback({ success: false, error: "Invalid userId" });
			return;
		}
		if (!db.data.users[friend]) {
			if (callback) callback({ success: false, error: "UserId does not exist" });
			return;
		}

		const userId = socket.handshake.auth.userId;
		const requests = db.data.requests;

		//check for removal request, if found, remove
		const removalIdx = requests.findIndex((r) => r.from === userId && r.to === friend && r.status === "remove");
		if (removalIdx !== -1) {
			//we have a removal request, so lets remove it before continuing
			requests.splice(removalIdx, 1);
			await db.write();
		}

		// Check for existing outgoing request
		const outgoing = requests.find((r) => r.to === friend && r.from === userId);
		if (outgoing) {
			if (callback) callback({ success: false, error: "Request already sent" });
			return;
		}

		// Check if friend already sent us a request
		const incomingIdx = requests.findIndex((r) => r.to === userId && r.from === friend);
		if (requests[incomingIdx]) {
			// we already have a request for us :D
			db.data.requests[incomingIdx].status = "accepted";
			//respond to socket with accepted req
			socket.emit("friendRequestResponse", db.data.requests[incomingIdx]);
			// Emit friendRequestResponse to other peer if possible
			const toPeer = connections[friend];
			if (toPeer) {
				io.to(toPeer.socketId).emit("friendRequestResponse", db.data.requests[incomingIdx]);
				db.data.requests[incomingIdx].status = "recieved";
			}
			await db.write();
			return;
		}

		// No outgoing or incoming, create new request
		const fr = {
			from: userId,
			fromName: purify.sanitize(db.data.users[userId].name),
			to: friend,
			toName: purify.sanitize(db.data.users[friend].name),
			chat: crypto.randomBytes(24).toString("hex"),
			time: Date.now(),
			status: "add",
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

	// Handles response to a friend request (accept/reject)
	socket.on("friendRequestResponse", async (req) => {
		const userId = socket.handshake.auth.userId;
		const requests = db.data.requests;
		const idx = requests.findIndex((r) => r.from === req.from && r.to === userId);
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

	// Cancels a pending friend request
	socket.on("cancelFriendRequest", async (req) => {
		const userId = socket.handshake.auth.userId;
		const requests = db.data.requests;
		const idx = requests.findIndex(
			(r) => r.from === userId && r.to === req.to && r.chat === req.chat && r.status === "add"
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

	// Removes a friend from the user's friend list, and acks a removal request if it exists
	socket.on("removeFriend", async (friend, callback) => {
		const userId = socket.handshake.auth.userId;
		if (!db.data.users[friend]) {
			if (callback) callback({ success: false, error: "UserId does not exist" });
			return;
		}
		const requests = db.data.requests;

		// Check we have an existing request to remove already out
		const idx = requests.findIndex((r) => r.from === userId && r.to === friend && r.status === "remove");
		if (idx !== -1) {
			// If there is an existing request to remove, do nothing
			if (callback) callback({ success: false, error: "Request to remove friend already exists" });
			return;
		}
		// check if we are acking a removal request
		const ackIdx = requests.findIndex((r) => r.from === friend && r.to === userId && r.status === "remove");
		if (ackIdx !== -1) {
			// If we are acking a removal request, remove it
			const ackRequest = requests[ackIdx];
			requests.splice(ackIdx, 1);
			await db.write();

			if (callback) callback({ success: true, request: ackRequest });

			return;
		}

		// Create a new request to remove friend
		const fr = {
			from: userId,
			fromName: purify.sanitize(db.data.users[userId].name),
			to: friend,
			toName: purify.sanitize(db.data.users[friend].name),
			time: Date.now(),
			status: "remove",
		};

		requests.push(fr);
		await db.write();
		if (callback) callback({ success: true, request: fr });

		// Emit friendRemove to the target peer if possible
		const toPeer = connections[friend];
		if (toPeer) {
			io.to(toPeer.socketId).emit("friendRemove", fr);
		}
		console.log(`Friend request to remove ${friend} sent from ${userId}`);
	});

	// Checks incoming and outgoing friend requests for the user
	socket.on("checkFriendReqs", async (callback) => {
		const userId = socket.handshake.auth.userId;
		const incoming = db.data.requests.filter(
			(r) => r.to === userId && r.status != "recieved" && r.status != "accepted" && r.status != "rejected"
		);
		const outgoing = db.data.requests.filter((r) => r.from === userId && r.status != "recieved");

		callback({ incoming, outgoing });

		//remove any outgoing requests that are accepted or rejected (they are now acked)
		db.data.requests = db.data.requests.filter((r) => r.status !== "accepted" && r.status !== "rejected");
		//set status to "recieved" for future implementation of scheduled deletes
		await db.write();
	});

	// Authenticates a server using name, id, and secret
	socket.on("serverAuth", async (name, id, secret, callback) => {
		const servers = db.data.servers || {};
		if (callback && servers[name] && servers[name].id === id && servers[name].secret === secret) {
			//good auth
			callback(servers[name]);
		} else {
			//fail
			callback(false);
		}
	});

	// Queries servers by name, returns matches via callback
	socket.on("serverQuery", async (name, exact, callback) => {
		if (!name || !name.trim()) {
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
			//search based on contains, w/ and w/o spaces
			matches = Object.values(servers).filter(
				(s) =>
					s.name.toLowerCase().includes(name) ||
					s.name.toLowerCase().replace(/\s/g, "").includes(name) ||
					s.name.toLowerCase().includes(name.replace(/\s/g, "")) ||
					s.name.toLowerCase().replace(/\s/g, "").includes(name.replace(/\s/g, ""))
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

	// Registers a new server with provided details
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
		const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		const id = server?.id;
		let name = server?.name;
		// Sanitize and trim server name
		name = purify.sanitize(name);
		name = name.trim();
		if (!id || !uuidV4Regex.test(id)) {
			if (callback) callback({ success: false, error: "Invalid server id" });
			return;
		}
		if (!name || typeof name !== "string" || name.length > 32 || name.length < 3) {
			if (callback) callback({ success: false, error: "Invalid server name" });
			return;
		}
		// Check if server name already exists in any capitalization
		if (Object.values(db.data.servers || {}).some((s) => s.name.toLowerCase() === name.toLowerCase())) {
			if (callback) callback({ success: false, error: "Server name already exists" });
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

	// Set user name/password
	socket.on("setUser", async (userPrefs, callback) => {
		const socketUserId = socket.handshake.auth.userId;
		const socketSecret = socket.handshake.auth.secret;
		const user = db.data.users[userPrefs.id];
		const userId = userPrefs.id;
		if (!user) {
			if (callback) callback({ success: false, error: "User not found" });
			return;
		}
		//ensure socket user is updating their own user and has correct secret
		if (userId !== socketUserId || user.secret !== socketSecret) {
			console.log(userId, socketUserId, user.secret, socketSecret);

			if (callback) callback({ success: false, error: "Bad auth silly" });
			return;
		}
		//update info

		await db.update(({ users }) => {
			users[userId].secret = userPrefs.secret || user.secret; // allow updating secret
			// Sanitize name before updating
			users[userId].name = userPrefs.name ? purify.sanitize(userPrefs.name) : user.name;
		});
		if (callback) callback({ success: true });
	});

	// gets username by userId
	socket.on("getUsername", (userId, callback) => {
		if (!userId || !db.data.users[userId]) {
			if (callback) callback(false);
			return;
		}
		const user = db.data.users[userId];
		if (callback) callback(user.name);
	});

	// Stores a message in the server's message history
	socket.on("serverMessage", async (serverId, message, callback) => {
		const userId = socket.handshake.auth.userId;
		if (!userId || !db.data.users[userId]) {
			if (callback) callback({ success: false, error: "User not authenticated" });
			return;
		}
		if (callback && typeof callback !== "function") {
			console.error("Callback must be a function");
			return;
		}
		// Validate serverId and message
		if (!serverId || typeof serverId !== "string") {
			if (callback) callback({ success: false, error: "Invalid server id" });
			return;
		}
		const servers = db.data.servers || {};
		const server = Object.values(servers).find((s) => s.id === serverId);
		if (!server) {
			if (callback) callback({ success: false, error: "Server not found" });
			return;
		}
		// make sure user is in the channel
		if (!socket.rooms.has("chat:" + server.secret)) {
			if (callback)
				callback({
					success: false,
					error: "User not in server channel",
				});
			return;
		}
		if (!server.options?.serverStoredMessaging) {
			if (callback) callback({ success: false, error: "Server does not support stored messaging" });
			return;
		}
		// Basic message validation
		if (
			!message ||
			typeof message !== "object" ||
			typeof message.content !== "string" ||
			message.content.length === 0 ||
			message.type !== "text" ||
			message.content.length > 1000 ||
			!message.content.trim()
		) {
			if (callback) callback({ success: false, error: "Invalid message" });
			return;
		}

		// Remove channel before storing message
		const { channel, ...messageWithoutChannel } = message;
		messageWithoutChannel.content = message.content;
		server.messages.push(messageWithoutChannel);
		await db.write();

		if (callback) callback({ success: true });
	});

	// Retrieves server messages after a given timestamp
	socket.on("getServerMessages", async (serverId, since, callback) => {
		const userId = socket.handshake.auth.userId;
		if (!userId || !db.data.users[userId]) {
			if (callback) callback({ success: false, error: "User not authenticated" });
			return;
		}
		const servers = db.data.servers || {};
		const server = Object.values(servers).find((s) => s.id === serverId);
		if (!server) {
			if (callback) callback({ success: false, error: "Server not found" });
			return;
		}
		// make sure user is in the channel
		if (!socket.rooms.has("chat:" + server.secret)) {
			if (callback)
				callback({
					success: false,
					error: "User not in server channel",
				});
			return;
		}
		if (!server.options?.serverStoredMessaging) {
			if (callback) callback({ success: false, error: "Server does not support stored messaging" });
			return;
		}
		const sinceTimestamp = Number(since) || 0;
		const messages = (server.messages || []).filter((msg) => msg.timestamp && msg.timestamp > sinceTimestamp);

		if (callback) callback({ success: true, messages: messages });
	});
});

// SERVE STATIC FILES
app.use(sirv("public"));

// RUN APP
server.listen(PORT, console.log(`Listening on PORT ${PORT}`));

//util for fake server id to avoid exposing unlisted servers when running exact server query
// basitly it maps a server name to unique id that cannot be guessed
function generateUuidBySeed(seedString) {
	//add per server session salt to hash to stop guessing of fake uuids
	seedString = `${seedString}${pepper}`;
	//Enumerating unlisted servers is still possible between server restarts
	//TODO make pepper a ENV maybe??
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

function purifyConfig() {
	// allowed URI schemes
	const allowlist = ["http", "https", "tel", "mailto", "hrmny"];

	// build fitting regex for uri
	const regex = RegExp("^(" + allowlist.join("|") + "):", "i");
	const MDconfig = {
		ALLOWED_TAGS: [
			"p",
			"#text",
			"a",
			"h1",
			"h2",
			"h3",
			"h4",
			"h5",
			"h6",
			"br",
			"u",
			"b",
			"i",
			"img",
			"ol",
			"ul",
			"li",
			"hr",
			"blockquote",
			"pre",
			"code",
		],
		ALLOWED_ATTR: ["href", "src", "color"],
		KEEP_CONTENT: false,
	};

	DOMPurify.setConfig(MDconfig);

	// Map to store original content for <code> nodes
	const codeContents = new WeakMap();

	DOMPurify.addHook("beforeSanitizeElements", (node) => {
		if (node.nodeName === "CODE") {
			codeContents.set(node, node.innerHTML);
			console.log(node.innerHTML);
		}
	});

	// Step 2: After DOMPurify finishes, restore raw content as plain text (not HTML!)
	DOMPurify.addHook("afterSanitizeElements", (node) => {
		if (node.nodeName === "CODE" && codeContents.has(node)) {
			const original = codeContents.get(node);
			node.textContent = original;
			codeContents.delete(node); // Clean up
		}
	});

	DOMPurify.addHook("afterSanitizeAttributes", function (node) {
		//LINK TARGET SANITIZAITON
		// set all elements owning target to target=_blank
		if ("target" in node) {
			node.setAttribute("target", "_blank");
		}

		//stop referrers
		if (node.hasAttribute("target")) {
			node.setAttribute("rel", "noopener noreferrer");
		}

		// set non-HTML/MathML links to xlink:show=new
		if (!node.hasAttribute("target") && (node.hasAttribute("xlink:href") || node.hasAttribute("href"))) {
			node.setAttribute("xlink:show", "new");
		}

		//PROTOCOL SANITIZATION
		// build an anchor to map URLs to
		const anchor = document.createElement("a");

		// check all href attributes for validity
		if (node.hasAttribute("href")) {
			let href = node.getAttribute("href");
			// default to https:// if no protocol is present
			if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href)) {
				href = "https://" + href;
				node.setAttribute("href", href);
			}
			anchor.href = href;
			if (anchor.protocol && !anchor.protocol.match(regex)) {
				node.removeAttribute("href");
			}
		}
		// check all action attributes for validity
		if (node.hasAttribute("action")) {
			anchor.href = node.getAttribute("action");
			if (anchor.protocol && !anchor.protocol.match(regex)) {
				node.removeAttribute("action");
			}
		}
		// check all xlink:href attributes for validity
		if (node.hasAttribute("xlink:href")) {
			anchor.href = node.getAttribute("xlink:href");
			if (anchor.protocol && !anchor.protocol.match(regex)) {
				node.removeAttribute("xlink:href");
			}
		}
	});

	console.log("DOMPurify configured");
}
