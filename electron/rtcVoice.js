// Simple WebRTC voice messaging using audio tracks (multi-peer support)

class rtcVoice {
	constructor() {
		this.channel = null;
		this.peerConnections = {};
		this.remoteAudioStreams = {};
		this.rtcConfig = {
			iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
		};
		this.localStream = null;

		this.socket = window.socket;

		this._registerSocketEvents();
		// this._initLocalAudio();
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
			this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
		} catch (err) {
			console.error("Could not get local audio:", err);
		}
	}

	_registerSocketEvents() {

		this.socket.on("message", (data) => {
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

	joinChannel(newChannel) {
		newChannel = `voice:${newChannel}`;
		if (newChannel == this.channel) {
			//joining same channel, do nothing.
			return;
		}
		//close all pcs when joining new channel
		Object.values(this.peerConnections).forEach((pc) => {
			if (pc && pc.signalingState !== "closed") {
				pc.close();
			}
		});
		//update record of pcs
		Object.keys(this.peerConnections).forEach((peerId) => {
			delete this.peerConnections[peerId];
			delete this.remoteAudioStreams[peerId];
		});
		if (newChannel === null || newChannel === undefined) {
			//passing null is used to leave channel
			return;
		}
		this.socket.emit("joinChannel", newChannel, this.channel);
		this.channel = newChannel;
		console.log("joined ", this.channel);
	}



	handleOffer(peerId, offer) {
		const pc = new RTCPeerConnection(this.rtcConfig);
		this.peerConnections[peerId] = pc;

		// Add local audio tracks to the connection
		if (this.localStream) {
			this.localStream.getTracks().forEach((track) => {
				pc.addTrack(track, this.localStream);
			});
		}

		pc.ontrack = (event) => {
			this.remoteAudioStreams[peerId] = event.streams[0];
			this._playRemoteAudio(peerId, event.streams[0]);
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

	_playRemoteAudio(peerId, stream) {
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

	sendSignalingMessage(peerId, msg) {
		this.socket.emit("message", this.channel, peerId, {
			from: userId,
			target: peerId,
			msg,
		});
	}
}

// Expose class to window for use in renderer.js or console
window.rtcVoice = rtcVoice;
