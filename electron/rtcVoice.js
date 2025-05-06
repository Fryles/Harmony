var voiceChannel = null;
// Maps to store peer connections and audio streams by peerId
const peerConnections = {};
const remoteAudioStreams = {};

let localStream = null;

function initRTC() {
	navigator.mediaDevices
		.getUserMedia({ audio: true, video: false })
		.then((stream) => {
			localStream = stream;
			socket.emit("ready", userId);
		})
		.catch((err) => {
			console.error("Could not get local audio:", err);
		});
}

function joinChannel(newChannel) {
	Object.values(peerConnections).forEach((pc) => {
		if (pc && pc.signalingState !== "closed") {
			pc.close();
		}
	});
	Object.keys(peerConnections).forEach((peerId) => {
		delete peerConnections[peerId];
		delete remoteAudioStreams[peerId];
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
			startVoiceConnection(peerId);
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
function startVoiceConnection(peerId) {
	console.log("connecting to: ", peerId);
	const pc = new RTCPeerConnection(rtcConfig);
	peerConnections[peerId] = pc;

	// Add local audio tracks to the connection
	if (localStream) {
		localStream.getTracks().forEach((track) => {
			pc.addTrack(track, localStream);
		});
	}

	pc.ontrack = (event) => {
		console.log(`Received remote audio from ${peerId}`);
		remoteAudioStreams[peerId] = event.streams[0];
		playRemoteAudio(peerId, event.streams[0]);
	};

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

	// Add local audio tracks to the connection
	if (localStream) {
		localStream.getTracks().forEach((track) => {
			pc.addTrack(track, localStream);
		});
	}

	pc.ontrack = (event) => {
		console.log(`Received remote audio from ${peerId}`);
		remoteAudioStreams[peerId] = event.streams[0];
		playRemoteAudio(peerId, event.streams[0]);
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

// Play remote audio stream for a peer
function playRemoteAudio(peerId, stream) {
	let audioElem = document.getElementById(`remote-audio-${peerId}`);
	if (!audioElem) {
		audioElem = document.createElement("audio");
		audioElem.id = `remote-audio-${peerId}`;
		audioElem.autoplay = true;
		audioElem.style.display = "none";
		document.body.appendChild(audioElem);
	}
	audioElem.srcObject = stream;
}

// Send a dummy message to all connected peers (optional, for signaling only)
function sendMessage(text) {
	console.log("Voice mode: sendMessage is not used for audio.");
}

// Set up handlers for a data channel (not used in voice)
function setupDataChannel(peerId, dc) {
	// Not used for voice
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
window.RTCVoice = {
	initRTC,
	joinChannel,
	startVoiceConnection,
	handleOffer,
	handleAnswer,
	handleCandidate,
	sendMessage,
};
