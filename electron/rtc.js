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
		this.ring = null;
		this.ringTimeout = 10000;
		this._lastCallVoice = 0;

		this._registerSocketEvents();
	}

	_registerSocketEvents() {
		this.socket.on("welcome", (data) => {
			//ran after we join a new channel
			console.log("Welcome: ", data);
			data.peers = data.peers.filter((peerId) => peerId !== selfId);
			// Extract type from data.channel (format: "type:channelName")
			const [type] = data.channel ? data.channel.split(":") : [null];
			//if type is a voice or video channel, check for peer count
			if (type == "voice" && data.peers.length == 0) {
				//no peers on join, start a ring
				this.voiceRing(data.channel);
				return;
			}

			data.peers.forEach((peerId) => {
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
			});
		});

		this.socket.on("peerJoin", (data) => {
			const newPeer = data.from;
			console.log("New peer joined: ", newPeer);
			//add channel to peer
			const pc = this.peerConnections[newPeer];
			if (pc) {
				pc.channels = pc.channels || [];
				if (!pc.channels.includes(data.channel)) {
					pc.channels.push(data.channel);
				}
			}
			//if peer is joining on a voice channel, add to voice ui
			const [type] = data.channel ? data.channel.split(":") : [null];
			if (type === "voice") {
				if (this.ring) {
					//joining during ring... stop ring
					this.voiceRingEnd();
				}
				addVoiceUser(newPeer);
			}
		});

		this.socket.on("peerLeave", (data) => {
			//ran when a peer on a channel leaves

			//remove channel from this peer
			const peerId = data.peer;
			if (this.peerConnections[peerId]) {
				const pc = this.peerConnections[peerId];
				if (pc.channels) {
					pc.channels = pc.channels.filter((ch) => ch !== data.channel);
				}
				// // If no channels left (unlikely since chats always open)
				// if (!pc.channels || pc.channels.length === 0) {
				// 	if (pc.signalingState !== "closed") {
				// 		pc.close();
				// 	}
				// 	delete this.peerConnections[peerId];
				// }
			}
			//if voice channel, remove from ui

			const [type] = data.channel ? data.channel.split(":") : [null];

			console.log(type);

			if (type === "voice") {
				removeVoiceUser(data.from);
			}
		});

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

	callVoice(channel) {
		const now = Date.now();
		if (now - this._lastCallVoice < 500) {
			console.warn("callVoice throttled");
			return;
		}
		this._lastCallVoice = now;
		//this is ran on call btn click, we must dynamically decide if this means we need to hangup, call, or join
		if (this.mediaChannel && this.mediaChannel.startsWith("voice:")) {
			// Already in a voice call, hang up
			this.VoiceHangup();
			return;
			//TODO add case for video
		} else if (this.ring && this.ring.type == "incoming voice") {
			// Incoming ring, pick up
			this.voiceJoin(this.ring.channel);
			return;
		} else {
			// Not in a call, not ringing, start/join voice channel
			if (channel && !this.ring && !this.mediaChannel) {
				this.preRing(channel);
			} else {
				console.warn("No current channel to join for voice call.");
			}
		}
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

	VoiceHangup() {
		if (this.localAudioStream) {
			this.localAudioStream.getTracks().forEach((track) => {
				track.stop();
			});
			this.localAudioStream = null;
		}
		if (this.mediaChannel) {
			this.leaveChannel(this.mediaChannel);
		} else {
			console.warn("attempted to hang up vc with no set mediaChannel");
		}
		Object.keys(this.peerConnections).forEach((peerId) => {
			if (this.remoteAudioStreams[peerId]) {
				this.remoteAudioStreams[peerId].getTracks().forEach((track) => {
					track.stop();
				});
				this.remoteAudioStreams[peerId] = null;
				delete this.remoteAudioStreams[peerId];
			}
		});
		this.remoteAudioStreams = {};
		if (this.ring) {
			this.voiceRingEnd(); //stop ring if we are ending it early
			this.ring = null;
		}
		removeVoiceUser(selfId);
		document.getElementById("voice-call").classList.remove("pickup");
		document.getElementById("voice-call").classList.add("has-text-primary");
		document.getElementById("voice-call").classList.remove("has-text-danger");
		//send courtesy dataChannel message to remove yourself for any chat only peers
		const msg = {
			timestamp: Date.now(),
			user: selfId,
			content: "",
			channel: this.mediaChannel,
			type: "voiceLeave",
		};
		console.log(`Sending voiceLeave on ${this.mediaChannel}`);
		this.sendMessage(msg, setChannelType(this.mediaChannel, "chat"));

		this.mediaChannel = null;
	}

	voiceRingEnd(toRemove) {
		//param is optional to remove all users from ui
		if (this.ring) {
			this.ring.audio.pause();
			this.ring.audio.currentTime = 0;
			this.ring.audio = null;
			clearTimeout(this.ring.timeout);
			this.ring = null;
		}
		if (toRemove) {
			removeVoiceUser(toRemove);
		}
		document.getElementById("voice-call").classList.remove("pickup");
		document.getElementById("voice-list").classList.remove("ringing");
		document.getElementById("voice-call").classList.remove("ringing");
	}

	async voiceJoin(channel) {
		if (!this.localAudioStream) {
			await this._initLocalAudio();
		}
		if (this.ring && this.ring.type == "incoming voice") {
			//stop any existing incoming ring
			this.voiceRingEnd();
		}
		//change color of call button and stop anims
		document.getElementById("voice-list").classList.remove("ringing");
		document.getElementById("voice-call").classList.remove("ringing");
		document.getElementById("voice-call").classList.remove("pickup");
		document.getElementById("voice-call").classList.remove("has-text-primary");
		document.getElementById("voice-call").classList.add("has-text-danger");
		//add ourselves to ui
		addVoiceUser(selfId);
		this.joinChannel(channel);
	}

	preRing(channel) {
		//stop any existing ring
		this.voiceRingEnd();

		//now we wait for a peer response from server, which calls voiceRing if we are alone
		this.voiceJoin(setChannelType(channel, "voice"));
	}

	voiceRing(channel) {
		//ran if we joined a voice channel and got no peers
		//Use established chat: channel passed to send a vc request
		if (this.mediaChannel != channel) {
			//ringing on a channel that were not in SHOULD NOT HAPPEN
			console.error(
				"Attempted to ring on channel we are not in. Was preRing called?"
			);
			return;
		}
		if (this.ring) {
			//already a ring, ignore this new one
			console.log("Already ringing, ignoring new ring");
			return;
		}
		if (!channel.startsWith("voice:")) {
			console.error("Attempted to ring on a non voice channel");
			return;
		}
		const msg = {
			timestamp: Date.now(),
			user: selfId,
			content: "",
			channel: channel,
			type: "voiceRing",
		};
		console.log(`Sending voiceRing on ${setChannelType(channel, "chat")}`);
		this.sendMessage(msg, setChannelType(channel, "chat"));
		this.ring = {
			type: "outgoing voice",
			audio: new Audio("ring.m4a"),
			from: selfId,
			channel: channel,
		};
		this.ring.audio.loop = true;
		this.ring.audio.volume = localPrefs.settings.ringVolume
			? localPrefs.settings.ringVolume
			: 0.7;
		this.ring.audio.play();
		//add ourselves to the ui and play anims
		document.getElementById("voice-call").classList.remove("pickup");
		document.getElementById("voice-list").classList.add("ringing");
		document.getElementById("voice-call").classList.add("ringing");
		//set timeout for ring end
		this.ring.timeout = setTimeout(() => {
			if (this.ring) {
				this.voiceRingEnd();
			}
		}, this.ringTimeout);
	}

	gotRing(msg) {
		console.log(`Received voiceRing on ${msg.channel} from ${msg.user}`);
		if (this.ring) {
			//already a ring, ignore this new one
			console.log("Already ringing, ignoring new ring");
			return;
		}
		this.ring = {
			type: "incoming voice",
			audio: new Audio("ring.m4a"),
			from: msg.user,
			channel: setChannelType(msg.channel, "voice"),
		};
		if (this.mediaChannel && this.mediaChannel == msg.channel) {
			//already in the call that is being rung... race cond maybe?
			this.voiceJoin(this.mediaChannel);
			return;
		} else if (this.mediaChannel) {
			return;
			//already in a vc, handle later
		}
		this.ring.audio.loop = true;
		this.ring.audio.volume = localPrefs.settings.ringVolume
			? localPrefs.settings.ringVolume
			: 0.7;
		this.ring.audio.play();
		//add our caller to the ui and play anims
		document.getElementById("voice-list").classList.add("ringing");
		document.getElementById("voice-call").classList.add("ringing");
		document.getElementById("voice-call").classList.add("pickup");
		addVoiceUser(msg.user);
		//set timeout for ring end
		this.ring.timeout = setTimeout(() => {
			if (this.ring && this.mediaChannel != this.ring.channel) {
				this.voiceRingEnd();
			}
		}, this.ringTimeout);
	}

	joinChannel(newChannel) {
		// Validate newChannel (format: type:base)
		if (newChannel === null || newChannel === undefined) {
			console.error("bad channel");
			return;
		}
		if (typeof newChannel !== "string") {
			console.error("Channel must be a string");
			console.log(newChannel);
			return;
		}
		const [type, base] = newChannel.split(":");
		if (!type || !base || base.length === 0) {
			console.error(
				"Invalid channel format. Must be type:base with non-empty base."
			);
			return;
		}
		if (type !== "chat" && type !== "voice" && type !== "video") {
			console.error(
				`Client attempted to join channel ${newChannel} with invalid type ${type}`
			);
			return;
		}
		if (newChannel == this.mediaChannel) {
			//joining same channel, do nothing.
			return;
		}
		// if joining a voice/video channel, stop all stream connections to any voice/video channels
		if (type === "voice" || type === "video") {
			if (this.mediaChannel) {
				this.VoiceHangup();
			}
			this.mediaChannel = newChannel;
		}
		this.signalingChannel = newChannel; //set signalingchannel before we start connection process
		this.socket.emit("joinChannel", newChannel);
		console.log("joined ", this.signalingChannel);
	}

	leaveChannel(channel) {
		const [type] = channel ? channel.split(":") : [null];
		if (this.localAudioStream && type == "voice") {
			this.localAudioStream.getTracks().forEach((track) => {
				track.stop();
			});
			this.localAudioStream = null;
		}
		this.socket.emit("leaveChannel", channel);
		console.log("left ", this.signalingChannel);
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
		} else {
			console.warn("No local audio when joining voice connection");
		}

		pc.ontrack = (event) => {
			this.remoteAudioStreams[peerId] = event.streams[0];
			this._playRemoteAudio(peerId, event.streams[0]);
			// Optionally, visualize remote audio:
			attachAudioVisualizer(this.remoteAudioStreams[peerId]);
		};

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				this.sendSignalingMessage(this.signalingChannel, peerId, {
					type: "candidate",
					candidate: event.candidate,
				});
			}
		};

		// Create and send an SDP offer to start the voice RTC connection
		pc.createOffer({ offerToReceiveAudio: true })
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

	sendMessage(msg, channel) {
		//send message to peers in specified channel
		Object.keys(this.peerConnections).forEach((peerId) => {
			if (
				peerId !== selfId &&
				this.peerConnections[peerId].channels &&
				this.peerConnections[peerId].channels.includes(channel)
			) {
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
			switch (event.type) {
				case "voiceRing":
					this.gotRing(event);
					break;
				case "voiceLeave":
					if (this.ring && this.ring.channel == event.channel) {
						//voiceLeave on a ringing channel. Assume hangup
						this.voiceRingEnd(event.user);
					} else {
						//remove from ui & channel
					}
				case "videoRing":
					//special param for starting vc, display ring/video ui
					break;
				default:
					window.rcvChat(event, peerId);
					break;
			}
		};
	}

	sendSignalingMessage(channel, peerId, msg) {
		this.socket.emit("message", channel, peerId, {
			from: selfId,
			target: peerId,
			msg,
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

		// If the offer is for audio (voice), add local audio tracks
		if (offer.sdp && offer.sdp.includes("m=audio")) {
			if (this.localAudioStream) {
				this.localAudioStream.getTracks().forEach((track) => {
					pc.addTrack(track, this.localAudioStream);
				});
			} else {
				console.warn("No local audio when handling voice offer");
			}
		}

		pc.ondatachannel = (event) => {
			this.dataChannels[peerId] = event.channel;
			this.setupDataChannel(peerId, event.channel);
		};

		pc.ontrack = (event) => {
			this.remoteAudioStreams[peerId] = event.streams[0];
			this._playRemoteAudio(peerId, event.streams[0]);
			// Optionally, visualize remote audio:
			attachAudioVisualizer(this.remoteAudioStreams[peerId]);
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

	_playRemoteAudio(peerId, stream) {
		// Create or reuse an <audio> element for this peer
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

	async _initLocalAudio() {
		try {
			// Try to get the preferred audio input device from prefs.json (if available)
			let deviceId = null;
			if (localPrefs && localPrefs.devices.audioInputDevice) {
				const audioInputDevices = localPrefs.devices.audioInputDevices;
				const preferredDevice = localPrefs.devices.audioInputDevice
					? localPrefs.devices.audioInputDevice.deviceId
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
}

function setChannelType(channel, type) {
	if (type != "chat" && type != "voice" && type != "video") {
		console.error(
			`Attempted to set channel ${channel} with invalid type ${type}`
		);
	}
	let base = channel.split(":")[1];
	if (base) {
		return `${type}:${base}`;
	} else {
		console.error("Attempted to set type on invalid channel: ", channel);
	}
}

function addVoiceUser(userId) {
	//add specified user to ui
	const voiceUser = document.createElement("div");
	voiceUser.classList.add("voice-prof");
	//name in bubble can only be 5 chars
	let name = userLookup(userId);
	name = name.nick ? name.nick : name.name;

	if (name.includes(" ") && name.length > 5) {
		//split two part name into two 2 char initials
		name = name.split(" ");
		name = name[0].substring(0, 2) + " " + name[1].substring(0, 2);
	} else if (name.length > 5) {
		name = name.substring(0, 5);
	}
	voiceUser.innerHTML = name;
	voiceUser.id = userId;
	voiceUser.onclick = function (e) {};
	document.getElementById("voice-list").appendChild(voiceUser);
	//add talking animation
	if (userId == selfId) visualizeBorderWithAudio(rtc.localAudioStream, userId);
}
function removeVoiceUser(userId) {
	const voiceUser = document.getElementById(userId);
	if (voiceUser && voiceUser.parentNode) {
		voiceUser.parentNode.removeChild(voiceUser);
	}
}
