// Simple WebRTC text messaging using DataChannels (multi-peer support)

class rtcChat {
	constructor(userId) {
		this.userId = userId;
		this.channel = null;
		this.peerConnections = {};
		this.dataChannels = {};
		this.rtcConfig = {
			iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
		};

		this.socket = io("ws://localhost:3030", {
			auth: { token: "SIGNALING123" },
		});

		this._registerSocketEvents();
	}

	_registerSocketEvents() {
		this.socket.on("peers", (data) => {
			data.peers.forEach((peerId) => {
				if (peerId !== this.userId && !this.peerConnections[peerId]) {
					this.startChatConnection(peerId);
				}
			});
		});

		this.socket.on("message", (data) => {
			console.log(data);
			if (!data.msg || !data.from) return;
			const peerId = data.from;
			switch (data.msg.type) {
				case "offer":
					this.handleOffer(peerId, data.msg.offer);
					break;
				case "candidate":
					this.handleCandidate(peerId, data.msg.candidate);
					break;
				case "answer":
					this.handleAnswer(peerId, data.msg.answer);
					break;
			}
		});

		this.socket.on("uniquenessError", (e) => {
			console.log(e);
		});
	}

	initRTCChat() {
		this.socket.emit("ready", this.userId);
	}

	joinChannel(newChannel) {
		Object.values(this.peerConnections).forEach((pc) => {
			if (pc && pc.signalingState !== "closed") {
				pc.close();
			}
		});
		Object.keys(this.peerConnections).forEach((peerId) => {
			delete this.peerConnections[peerId];
			delete this.dataChannels[peerId];
		});
		if (newChannel === null || newChannel === undefined) {
			console.log("bad channel");
			return;
		}
		this.socket.emit("joinChannel", newChannel, this.channel);
		this.channel = newChannel;
		console.log("joined ", this.channel);
	}

	startChatConnection(peerId) {
		console.log("connecting to: ", peerId);
		const pc = new RTCPeerConnection(this.rtcConfig);
		this.peerConnections[peerId] = pc;

		const dc = pc.createDataChannel("chat");
		this.dataChannels[peerId] = dc;
		this.setupDataChannel(peerId, dc);

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				this.sendSignalingMessage(peerId, {
					type: "candidate",
					candidate: event.candidate,
				});
			}
		};

		pc.createOffer()
			.then((offer) => pc.setLocalDescription(offer))
			.then(() => {
				this.sendSignalingMessage(peerId, {
					type: "offer",
					offer: pc.localDescription,
				});
			});
	}

	handleOffer(peerId, offer) {
		const pc = new RTCPeerConnection(this.rtcConfig);
		this.peerConnections[peerId] = pc;

		pc.ondatachannel = (event) => {
			this.dataChannels[peerId] = event.channel;
			this.setupDataChannel(peerId, event.channel);
		};

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				this.sendSignalingMessage(peerId, {
					type: "candidate",
					candidate: event.candidate,
				});
			}
		};

		pc.setRemoteDescription(new RTCSessionDescription(offer))
			.then(() => pc.createAnswer())
			.then((answer) => pc.setLocalDescription(answer))
			.then(() => {
				this.sendSignalingMessage(peerId, {
					type: "answer",
					answer: pc.localDescription,
				});
			});
	}

	handleAnswer(peerId, answer) {
		const pc = this.peerConnections[peerId];
		if (pc) {
			pc.setRemoteDescription(new RTCSessionDescription(answer));
		}
	}

	handleCandidate(peerId, candidate) {
		const pc = this.peerConnections[peerId];
		if (pc) {
			pc.addIceCandidate(new RTCIceCandidate(candidate));
		}
	}

	sendMessage(text) {
		Object.keys(this.peerConnections).forEach((peerId) => {
			if (peerId !== this.userId) {
				const dc = this.dataChannels[peerId];
				if (dc && dc.readyState === "open") {
					dc.send(text);
				} else {
					console.log(`message not sent to ${peerId}`);
				}
			}
		});
	}

	setupDataChannel(peerId, dc) {
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

	sendSignalingMessage(peerId, msg) {
		this.socket.emit("message", this.channel, peerId, {
			from: this.userId,
			target: peerId,
			msg,
		});
	}
}
