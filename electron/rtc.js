// Simple WebRTC text messaging using DataChannels (multi-peer support)

class rtcInterface {
	constructor() {
		this.signalingChannel = null; //channel we are currently signaling on
		//This is only changed for new connections
		this.mediaChannel = null; //channel for video/voice
		this.peerConnections = {};
		this.remoteAudioStreams = {};
		this.dataChannels = {};
		this.rtcConfig = {
			iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
		};
		this.localAudioStream = null;
		this.socket = window.socket;

		this._registerSocketEvents();
	}

	_registerSocketEvents() {
		this.socket.on("peers", (data) => {
			console.log(data);

			// Extract type from data.channel (format: "type:channelName")
			const [type] = data.channel ? data.channel.split(":") : [null];
			data.peers.forEach((peerId) => {
				if (peerId !== userId) {
					if (type == "voice") {
						this.startVoiceConnection(peerId);
					} else if (type == "chat") {
						this.startChatConnection(peerId);
					} else if (type == "video") {
					} else {
						console.warn(
							"bad typed channel coming back from server... its confused."
						);
					}
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

	voiceMute() {
		let e = document.getElementById("voice-mute").querySelector("i");
		e.classList.toggle("fa-microphone");
		e.classList.toggle("fa-microphone-slash");
		if (this.localAudioStream) {
			this.localAudioStream.getAudioTracks().forEach((track) => {
				track.enabled = !e.classList.contains("fa-microphone-slash");
			});
		}
	}

	voiceRing(channel) {
		//Use established chat: channel passed to send a vc request
	}

	async _initLocalAudio() {
		try {
			// Try to get the preferred audio input device from prefs.json (if available)
			let deviceId = null;
			if (localPrefs && localPrefs.devices.audioInputDevice) {
				const audioInputDevices = localPrefs.devices.audioInputDevices;
				const preferredDevice = localPrefs.devices.audioInputDevice
					? localPrefs.devices.audioInputDevices.deviceId
					: audioInputDevices[0].deviceId; // Use the first device as preferred
				deviceId = preferredDevice;
			} else {
				//no device in prefs, alert user
				alert("Could not get audio input, please double check your settings.");
			}
			const constraints = {
				audio: deviceId ? { deviceId: { exact: deviceId } } : true,
				video: false,
			};
			this.localAudioStream = await navigator.mediaDevices.getUserMedia(
				constraints
			);
		} catch (err) {
			console.error("Could not get local audio:", err);
		}
	}

	joinChannel(newChannel, type) {
		if (newChannel === null || newChannel === undefined) {
			console.error("bad channel");
			return;
		}
		if (type != "chat" && type != "voice" && type != "video") {
			console.error(
				`Client attempted to join channel ${newChannel} with invalid type ${type}`
			);
		}
		newChannel = `${type}:${newChannel}`;
		if (newChannel == this.signalingChannel) {
			//joining same channel, do nothing.
			return;
		}
		// if joining a voice/video channel, stop all stream connections to any voice/video channels
		if (type === "voice" || type === "video") {
			Object.keys(this.peerConnections).forEach((peerId) => {
				const pc = this.peerConnections[peerId];
				if (
					pc &&
					pc.channels &&
					pc.channels.some(
						(ch) => ch.startsWith("voice:") || ch.startsWith("video:")
					)
				) {
					if (this.remoteAudioStreams[peerId]) {
						delete this.remoteAudioStreams[peerId];
						// Remove the voice/video channel from this peer
						this.peerConnections[peerId].channels = this.peerConnections[
							peerId
						].channels.filter(
							(ch) => !(ch.startsWith("voice:") || ch.startsWith("video:"))
						);
					}
					// If there is no more channels, remove pc
					if (!pc.channels || pc.channels.length === 0) {
						if (pc.signalingState !== "closed") {
							pc.close();
						}
						delete this.peerConnections[peerId];
					}
				}
			});
		}
		this.signalingChannel = newChannel; //set signalingchannel before we start connection process
		this.socket.emit("joinChannel", newChannel);
		console.log("joined ", this.signalingChannel);
	}

	startVoiceConnection(peerId) {
		const pc = new RTCPeerConnection(this.rtcConfig);
		// Add channels property as an array to track channel membership
		pc.channels = pc.channels || [];
		if (!pc.channels.includes(this.signalingChannel)) {
			pc.channels.push(this.signalingChannel);
		}
		this.peerConnections[peerId] = pc;

		// Add local audio tracks to the connection
		if (this.localAudioStream) {
			this.localAudioStream.getTracks().forEach((track) => {
				pc.addTrack(track, this.localAudioStream);
			});
		}

		pc.ontrack = (event) => {
			this.remoteAudioStreams[peerId] = event.streams[0];
			this._playRemoteAudio(peerId, event.streams[0]);
		};

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				this.sendSignalingMessage(this.signalingChannel, peerId, {
					type: "candidate",
					candidate: event.candidate,
				});
			}
		};

		pc.createOffer()
			.then((offer) => pc.setLocalDescription(offer))
			.then(() => {
				this.sendSignalingMessage(this.signalingChannel, peerId, {
					type: "offer",
					offer: pc.localDescription,
				});
			});
	}

	startChatConnection(peerId) {
		const pc = this.peerConnections[peerId]
			? this.peerConnections[peerId]
			: new RTCPeerConnection(this.rtcConfig);
		// Add channels property as an array to track channel membership
		pc.channels = pc.channels || [];
		if (!pc.channels.includes(this.signalingChannel)) {
			pc.channels.push(this.signalingChannel);
		}
		if (!this.peerConnections[peerId]) {
			this.peerConnections[peerId] = pc;
		}
		if (this.dataChannels[peerId]) {
			//already have dataChannel connection... return
			console.log("Chat - Attempted to connect to existing peer");
			return;
		}

		console.log("Chat - Connecting to: ", peerId);
		const dc = pc.createDataChannel(`chat:${peerId}`);
		this.dataChannels[peerId] = dc;
		this.setupDataChannel(peerId, dc);

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				this.sendSignalingMessage(this.signalingChannel, peerId, {
					type: "candidate",
					candidate: event.candidate,
				});
			}
		};

		pc.createOffer()
			.then((offer) => pc.setLocalDescription(offer))
			.then(() => {
				this.sendSignalingMessage(this.signalingChannel, peerId, {
					type: "offer",
					offer: pc.localDescription,
				});
			});
	}

	handleOffer(peerId, offer) {
		const pc = new RTCPeerConnection(this.rtcConfig);
		// Add channels property as an array to track channel membership
		pc.channels = pc.channels || [];
		if (!pc.channels.includes(this.signalingChannel)) {
			pc.channels.push(this.signalingChannel);
		}
		this.peerConnections[peerId] = pc;

		pc.ondatachannel = (event) => {
			this.dataChannels[peerId] = event.channel;
			this.setupDataChannel(peerId, event.channel);
		};

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				this.sendSignalingMessage(this.signalingChannel, peerId, {
					type: "candidate",
					candidate: event.candidate,
				});
			}
		};

		pc.setRemoteDescription(new RTCSessionDescription(offer))
			.then(() => pc.createAnswer())
			.then((answer) => pc.setLocalDescription(answer))
			.then(() => {
				this.sendSignalingMessage(this.signalingChannel, peerId, {
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

	sendMessage(msg) {
		//send message to peers in specified channel
		Object.keys(this.peerConnections).forEach((peerId) => {
			if (peerId !== userId) {
				const dc = this.dataChannels[peerId];
				if (dc && dc.readyState === "open") {
					dc.send(JSON.stringify(msg));
				} else {
					console.log(`message not sent to ${peerId}`);
				}
			}
		});
	}

	setupDataChannel(peerId, dc) {
		const dcChannel = this.signalingChannel;
		dc.onopen = () => {
			console.log(`Data channel: ${dcChannel} open with ${peerId}`);
		};
		dc.onclose = () => {
			console.log(`Data channel: ${dcChannel} closed with ${peerId}`);
			if (this.peerConnections[peerId]) {
				const pc = this.peerConnections[peerId];
				if (pc.channels) {
					pc.channels = pc.channels.filter((ch) => ch !== dcChannel);
				}
				// If no channels left, close and remove the peer connection
				if (!pc.channels || pc.channels.length === 0) {
					if (pc.signalingState !== "closed") {
						pc.close();
					}
					delete this.peerConnections[peerId];
				}
			}
			if (this.dataChannels[peerId]) {
				delete this.dataChannels[peerId];
			}
		};
		dc.onmessage = (event) => {
			event = JSON.parse(event.data);
			//bad overhead using parse for a log
			console.log(
				`Received message from ${peerId} on channel ${event.channel}:`,
				event.content
			);
			if (event.voiceRing) {
				//special param for starting vc, display ring/voice ui
			} else if (event.videoRing) {
				//special param for starting vc, display ring/video ui
			} else {
				window.rcvChat(event, peerId);
			}
		};
	}

	sendSignalingMessage(channel, peerId, msg) {
		this.socket.emit("message", channel, peerId, {
			from: userId,
			target: peerId,
			msg,
		});
	}
}
