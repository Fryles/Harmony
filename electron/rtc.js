// Simple WebRTC text messaging using DataChannels (multi-peer support)
const socket = io("ws://localhost:3030", {
	auth: {
		token: "SIGNALING123",
	},
});
var channel = null;
// Maps to store peer connections and data channels by peerId
const peerConnections = {};
const dataChannels = {};

function initRTC() {
	socket.emit("ready", userId);
}

function joinChannel(newChannel) {
	Object.values(peerConnections).forEach((pc) => {
		if (pc && pc.signalingState !== "closed") {
			pc.close();
		}
	});
	Object.keys(peerConnections).forEach((peerId) => {
		delete peerConnections[peerId];
		delete dataChannels[peerId];
	});
	if (newChannel === null || newChannel === undefined) {
		console.log("bad channel");
		return;
	}
	//this also leaves the old channel
	socket.emit("joinChannel", newChannel, channel);
	channel = newChannel;
	console.log("joined ", channel);
}

socket.on("peers", (data) => {
	//this is run after we join a new channel
	//data.peers contains all peers in channel (including self)
	data.peers.forEach((peerId) => {
		if (peerId !== userId && !peerConnections[peerId]) {
			startChatConnection(peerId);
		}
	});
});

socket.on("message", (data) => {
	console.log(data);
	if (!data.msg || !data.from) return;
	const peerId = data.from;
	switch (data.msg.type) {
		case "offer":
			handleOffer(peerId, data.msg.offer);
			break;
		case "candidate":
			handleCandidate(peerId, data.msg.candidate);
			break;
		case "answer":
			handleAnswer(peerId, data.msg.answer);
			break;
	}
});

const rtcConfig = {
	iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// Start a connection as initiator (caller) to a specific peer
function startChatConnection(peerId) {
	console.log("connecting to: ", peerId);
	const pc = new RTCPeerConnection(rtcConfig);
	peerConnections[peerId] = pc;

	// Create data channel for text messages
	const dc = pc.createDataChannel("chat");
	dataChannels[peerId] = dc;
	setupDataChannel(peerId, dc);

	pc.onicecandidate = (event) => {
		if (event.candidate) {
			sendSignalingMessage(peerId, {
				type: "candidate",
				candidate: event.candidate,
			});
		}
	};

	pc.createOffer()
		.then((offer) => pc.setLocalDescription(offer))
		.then(() => {
			sendSignalingMessage(peerId, {
				type: "offer",
				offer: pc.localDescription,
			});
		});
}

// Handle incoming offer (callee)
function handleOffer(peerId, offer) {
	const pc = new RTCPeerConnection(rtcConfig);
	peerConnections[peerId] = pc;

	pc.ondatachannel = (event) => {
		dataChannels[peerId] = event.channel;
		setupDataChannel(peerId, event.channel);
	};

	pc.onicecandidate = (event) => {
		if (event.candidate) {
			sendSignalingMessage(peerId, {
				type: "candidate",
				candidate: event.candidate,
			});
		}
	};

	pc.setRemoteDescription(new RTCSessionDescription(offer))
		.then(() => pc.createAnswer())
		.then((answer) => pc.setLocalDescription(answer))
		.then(() => {
			sendSignalingMessage(peerId, {
				type: "answer",
				answer: pc.localDescription,
			});
		});
}

// Handle incoming answer (initiator)
function handleAnswer(peerId, answer) {
	const pc = peerConnections[peerId];
	if (pc) {
		pc.setRemoteDescription(new RTCSessionDescription(answer));
	}
}

// Handle incoming ICE candidate
function handleCandidate(peerId, candidate) {
	const pc = peerConnections[peerId];
	if (pc) {
		pc.addIceCandidate(new RTCIceCandidate(candidate));
	}
}

// Send a text message to all connected peers
function sendMessage(text) {
	Object.keys(peerConnections).forEach((peerId) => {
		if (peerId !== userId) {
			const dc = dataChannels[peerId];
			if (dc && dc.readyState === "open") {
				dc.send(text);
			} else {
				console.log(`message not sent to ${peerId}`);
			}
		}
	});
}

// Set up handlers for a data channel
function setupDataChannel(peerId, dc) {
	dc.onopen = () => {
		console.log(`Data channel open with ${peerId}`);
	};
	dc.onclose = () => {
		console.log(`Data channel closed with ${peerId}`);
	};
	dc.onmessage = (event) => {
		console.log(`Received message from ${peerId}:`, event.data);
		window.rcvChat(event.data, peerId);
	};
}

function sendSignalingMessage(peerId, msg) {
	socket.emit("message", channel, peerId, {
		from: userId,
		target: peerId,
		msg,
	});
}

socket.on("uniquenessError", (e) => {
	console.log(e);
});

// Expose functions to window for use in renderer.js or console
window.RTC = {
	initRTC,
	joinChannel,
	startChatConnection,
	handleOffer,
	handleAnswer,
	handleCandidate,
	sendMessage,
};
