class rtcInterface {
	constructor() {
		this.signalingChannel = null; //channel we are currently signaling on
		//This is only changed for new connections
		this.mediaChannel = null; //channel for video/voice
		this.peerConnections = {};
		this.peerChannels = {};
		this.remoteAudioStreams = {};
		this.remoteAudioGainNodes = {};
		this.dataChannels = {};
		this.rtcConfig = {
			iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
		};
		this.localAudioStream = null;
		this.unProcessedLocalAudio = null;
		this.socket = window.socket;
		this.ring = null;
		this.ringTimeout = 10000;
		this._lastCallVoice = 0;
		this.inputGainValue = localPrefs.audio.inputGain;
		this.hotMicThresh = localPrefs.audio.hotMicThresh;

		this._registerSocketEvents();
	}

	_registerSocketEvents() {
		if (!window.socket) {
			setTimeout(this._registerSocketEvents, 1000);
		} else if (!this.socket && window.socket) {
			this.socket = window.socket;
		}
		this.socket.on("welcome", (data) => {
			//ran after we join a new channel or rejoin one
			console.log("Welcome: ", data);

			if (this.signalingChannel != data.channel) {
				console.warn("Got welcome on channel we are not signaling on???");
			}

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
				//if not in global userCache, emit to server to get username
				checkUserCache(peerId);
				if (type == "voice") {
					this.startVoiceConnection(peerId);
				} else if (type == "chat") {
					this.startChatConnection(peerId);
				} else if (type == "video") {
				} else {
					console.warn("bad typed channel coming back from server... its confused.");
				}
				//add channel to peer
				this.peerChannels[peerId] = this.peerChannels[peerId] || [];
				if (!this.peerChannels[peerId].includes(data.channel)) {
					this.peerChannels[peerId].push(data.channel);
				}
			});
		});

		this.socket.on("peerJoin", (data) => {
			const newPeer = data.from;
			console.log(`${newPeer} joined channel ${data.channel}`);

			//if not in global userCache, emit to server to get username
			checkUserCache(newPeer);

			//add channel to peer
			this.peerChannels[newPeer] = this.peerChannels[newPeer] || [];
			if (!this.peerChannels[newPeer].includes(data.channel)) {
				this.peerChannels[newPeer].push(data.channel);
			}
			//if peer is joining on a voice channel we are on, add to voice ui
			const [type] = data.channel ? data.channel.split(":") : [null];
			if (type === "voice" && this.mediaChannel == data.channel) {
				const pc = this.peerConnections[newPeer];
				if (this.ring) {
					//joining during ring... stop ring
					this.voiceRingEnd();
				}
				// Add local audio tracks to the existing connection (if not already present)
				if (this.localAudioStream) {
					const senders = pc.getSenders();
					this.localAudioStream.getTracks().forEach((track) => {
						const alreadyAdded = senders.some((sender) => sender.track && sender.track.id === track.id);
						if (!alreadyAdded) {
							pc.addTrack(track, this.localAudioStream);
							console.log("Added local track to peer connection");
						}
					});
				} else {
					console.warn("No local audio when peer joined our vc");
				}
				addVoiceUser(newPeer);
			}
		});

		this.socket.on("peerLeave", (data) => {
			//ran when a peer on a channel leaves

			//remove channel from this peer
			const peerId = data.peer;
			if (this.peerChannels[peerId]) {
				this.peerChannels[peerId] = this.peerChannels[peerId].filter((ch) => ch !== data.channel);
			}
			//if voice channel, remove from ui

			const [type] = data.channel ? data.channel.split(":") : [null];
			if (type === "voice") {
				if (this.mediaChannel == data.channel) {
					// Remove local audio tracks from the peer connection when leaving voice we area on
					const pc = this.peerConnections[data.from];
					if (pc && this.localAudioStream) {
						const localTrackIds = this.localAudioStream.getTracks().map((t) => t.id);
						pc.getSenders().forEach((sender) => {
							if (sender.track && localTrackIds.includes(sender.track.id)) {
								pc.removeTrack(sender);
							}
						});
					}
				}
				//remove from voice ui regardless of what vc were on
				removeVoiceUser(data.from);
			}
		});

		this.socket.on("message", (data) => {
			if (data.session) {
				//we got a session! lets store it!
				this.socket.auth.session = data.session;
				try {
					localStorage.setItem("session", data.session);
				} catch (e) {
					console.error("Failed to store session in localStorage:", e);
				}
			}
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
			this.voiceJoin(setChannelType(this.ring.channel, "voice"));
			return;
		} else {
			// Not in a call, not ringing, start/join voice channel
			if (channel && !this.ring && !this.mediaChannel) {
				//stop any existing ring
				this.voiceRingEnd();
				//now we wait for a peer response from server, which calls voiceRing if we are alone
				this.voiceJoin(setChannelType(channel, "voice"));
			} else {
				console.warn("No current channel to join for voice call.");
			}
		}
	}

	voiceMute() {
		let e = document.getElementById("voice-mute").querySelector("i");
		e.classList.toggle("fa-microphone");
		e.classList.toggle("fa-microphone-slash");
		e.classList.toggle("has-text-primary");
		e.classList.toggle("has-text-danger");
		if (window.rtc.localAudioStream) {
			window.rtc._inputGainNode.gain.value = e.classList.contains("fa-microphone-slash")
				? 0
				: window.rtc.inputGainValue;
		}
	}

	stopLocalVoice() {
		if (this.localAudioStream) {
			this.localAudioStream.getTracks().forEach((track) => {
				track.stop();
			});
			this.localAudioStream = null;
		}
		if (this.unProcessedLocalAudio) {
			this.unProcessedLocalAudio.getTracks().forEach((track) => {
				track.stop();
			});
			this.unProcessedLocalAudio = null;
		}
	}
	VoiceHangup() {
		this.stopLocalVoice();
		if (this.mediaChannel) {
			this.leaveChannel(this.mediaChannel);
		} else {
			console.warn("attempted to hang up vc with no set mediaChannel");
			return;
		}

		if (this.ring) {
			this.voiceRingEnd(); //stop ring if we are ending it early
			this.ring = null;
		}
		removeVoiceUser(selfId);
		setVoiceUIState("idle");
		//send courtesy dataChannel message to remove yourself for any chat only peers

		//check if currentChat != our chat converted mediachannel (viewing diff channel then on vc with)
		if (currentChat != setChannelType(this.mediaChannel, "chat")) {
			//if so we should clear vc and see if anyone is in the currentchats vc
			// Clear all .voice-prof elements in #voice-list
			const voiceList = document.getElementById("voice-list");
			if (voiceList) {
				voiceList.querySelectorAll(".voice-prof").forEach((el) => el.remove());
			}
			socket.emit("channelQuery", setChannelType(currentChat, "voice"), (res) => {
				//check if anyone is in new channels vc
				console.log(res);
				if (res.length > 0) {
					//for each peer in res, add to vc ui
				}
			});
		}
		this.mediaChannel = null;
	}

	voiceRingEnd() {
		if (!this.mediaChannel) {
			//if not in channel, go back to idle
			setVoiceUIState("idle");
		} else {
			//move state to in inCall
			setVoiceUIState("inCall", this.ring.channel);
		}
		if (this.ring) {
			this.ring.audio.pause();
			this.ring.audio.currentTime = 0;
			this.ring.audio = null;
			clearTimeout(this.ring.timeout);
			if (this.ring.type == "incoming voice" && setChannelType(currentChat, "voice") != this.ring.channel) {
				//ring to us is ending and we are not in the channel it was on
				removeVoiceUser(this.ring.from);
			}
			this.ring = null;
		}
	}

	async voiceJoin(channel) {
		if (channel == this.mediaChannel) {
			//already in this channel, do nothing
			console.warn("Attempted to join voice channel we are already in");
			return;
		}
		if (!this.localAudioStream) {
			await this._initLocalAudio();
			if (!this.localAudioStream) {
				console.warn("failed to start local audio");
				return;
			}
		}
		if (this.ring && this.ring.type == "incoming voice") {
			//stop any existing incoming ring
			this.voiceRingEnd();
			//switch ui to view the channel we are joining
			if (setChannelType(currentChat, "voice") != channel) {
				//if we are not in the channel we are joining, switch to it
				const server = (localPrefs.servers || []).find((s) => s.secret === channel.split(":")[1]);
				const friend = (localPrefs.friends || []).find((f) => f.chat === channel.split(":")[1]);
				if (server) {
					const serverElem = document.querySelector(`.server-item[name="${server.id}"]`);
					if (serverElem) {
						serverElem.click();
					} else {
						console.error("Could not find server that user is being called on", server);
					}
				} else if (friend) {
					const friendElem = document.querySelector(`.friend-item[name="${friend.id}"]`);
					if (friendElem) {
						FriendsManager.selectFriend(friendElem);
					} else {
						console.error("Could not find friend that is calling user", friend.id);
					}
				} else {
					this.VoiceHangup();
					console.error("Could not find server or friend for channel", channel);
				}
			}
		}
		//change color of call button and stop anims
		setVoiceUIState("inCall", channel);
		//add ourselves to ui
		addVoiceUser(selfId);
		this.joinChannel(channel);
	}

	voiceRing(channel) {
		//ran if we joined a voice channel and got no peers
		//Use established chat: channel passed to send a vc request
		if (this.mediaChannel != channel) {
			//ringing on a channel that were not in SHOULD NOT HAPPEN
			console.error("Attempted to ring on channel we are not in. Was preRing called?");
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
		this.ring.audio.volume = localPrefs.audio.ringVolume ? localPrefs.audio.ringVolume : 0.7;
		this.ring.audio.play();
		//add ourselves to the ui and play anims
		setVoiceUIState("ringing");
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
		if (this.mediaChannel && this.mediaChannel == this.ring.channel) {
			//already in the call that is being rung... race cond maybe?
			this.voiceJoin(this.mediaChannel);
			return;
		} else if (this.mediaChannel) {
			//ALREADY IN VC
			const server = localPrefs.servers.find((s) => s.secret === msg.channel.split(":")[1]);
			const user = userLookup(msg.user);

			if (server) {
				showToast(`${user.nick ? user.nick : user.name} calling on ${server.name}`, () => {
					this.VoiceHangup();
					const serverElem = document.querySelector(`.server-item[name="${server.id}"]`);
					if (serverElem) {
						serverElem.click();
					} else {
						console.error("Could not find server that user is being called on", server);
					}
					this.voiceJoin(this.ring.channel);
				});
			} else {
				showToast(`Incoming call from ${user.nick ? user.nick : user.name}`, () => {
					this.VoiceHangup();
					const friendElem = document.querySelector(`.friend-item[name="${msg.user}"]`);
					if (friendElem) {
						FriendsManager.selectFriend(friendElem);
					} else {
						console.error("Could not find friend that is calling user", msg.user);
					}
					this.voiceJoin(this.ring.channel);
				});
			}
			return;
		}
		this.ring.audio.loop = true;
		this.ring.audio.volume = localPrefs.audio.ringVolume ? localPrefs.audio.ringVolume : 0.7;
		this.ring.audio.play();
		//add our caller to the ui and play anims
		setVoiceUIState("ringing");
		addVoiceUser(msg.user);
		const server = localPrefs.servers.find((s) => s.id === msg.channel.split(":")[1]);
		const user = userLookup(msg.user);
		if (server) {
			showToast(`${user.nick ? user.nick : user.name} calling on ${server.name}`, () => {
				const serverElem = document.querySelector(`.server-item[name="${server.id}"]`);
				if (serverElem) {
					serverElem.click();
				} else {
					console.error("Could not find server that user is being called on", server);
				}
				this.voiceJoin(this.ring.channel);
			});
		} else {
			showToast(`Incoming call from ${user.nick ? user.nick : user.name}`, () => {
				const friendElem = document.querySelector(`.friend-item[name="${msg.user}"]`);
				if (friendElem) {
					FriendsManager.selectFriend(friendElem);
				} else {
					console.error("Could not find friend that is calling user", msg.user);
				}
				this.voiceJoin(this.ring.channel);
			});
		}
		//set timeout for ring end
		this.ring.timeout = setTimeout(() => {
			if (this.ring && this.mediaChannel != this.ring.channel) {
				this.voiceRingEnd();
			}
		}, this.ringTimeout);
	}

	joinChannel(newChannel) {
		// Validate newChannel (format: type:base)
		if (newChannel === null || newChannel === undefined || typeof newChannel !== "string") {
			console.error("bad channel");
			console.error("Channel must be a string");
			return;
		}
		const [type, base] = newChannel.split(":");
		if (!type || !base || base.length === 0) {
			console.error("Invalid channel format. Must be type:base with non-empty base.", newChannel);
			return;
		}
		if (type !== "chat" && type !== "voice" && type !== "video") {
			console.error(`Client attempted to join channel ${newChannel} with invalid type ${type}`);
			return;
		}
		if (newChannel == this.mediaChannel) {
			//joining same channel, do nothing.
			console.warn("attempted to join channel again");
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
		if (type == "voice" && this.mediaChannel == channel) {
			if (this.localAudioStream) {
				//stop local audio
				this.localAudioStream.getTracks().forEach((track) => {
					track.stop();
				});
				this.localAudioStream = null;
			}
			if (this.remoteAudioStreams) {
				//remove all remoteaudio streams
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
			}

			const msg = {
				timestamp: Date.now(),
				user: selfId,
				content: "",
				channel: this.mediaChannel,
				type: "voiceLeave",
			};

			removeVoiceUser(selfId);
			setVoiceUIState("idle");
			console.log(`Sending voiceLeave on ${this.mediaChannel}`);
			this.sendMessage(msg, setChannelType(this.mediaChannel, "chat"));
		}

		this.socket.emit("leaveChannel", channel);
		console.log("broadcast leaveChannel on ", channel);
	}

	startVoiceConnection(peerId) {
		const pc = this.peerConnections[peerId];
		if (!pc) {
			console.error("No existing peer connection to start voice from...");
			return;
		}
		this.peerChannels[peerId] = this.peerChannels[peerId] || [];
		if (!this.peerChannels[peerId].includes(this.signalingChannel)) {
			this.peerChannels[peerId].push(this.signalingChannel);
		}
		// If we already have a remote audio stream for this peer, don't add again
		if (this.remoteAudioStreams[peerId]) {
			console.log("Voice - Attempted to connect to existing peer");
			return;
		}
		// Add local audio tracks to the existing connection (if not already present)
		if (this.localAudioStream) {
			const senders = pc.getSenders();
			this.localAudioStream.getTracks().forEach((track) => {
				const alreadyAdded = senders.some((sender) => sender.track && sender.track.id === track.id);
				if (!alreadyAdded) {
					pc.addTrack(track, this.localAudioStream);
					console.log("Added local track to peer connection");
				}
			});
		} else {
			console.warn("No local audio when joining voice connection");
		}

		pc.ontrack = (event) => {
			console.log("recieved remote track", event);
			this.remoteAudioStreams[peerId] = event.streams[0];
			this._playRemoteAudio(peerId, event);
		};

		pc.onnegotiationneeded = async () => {
			try {
				const offer = await pc.createOffer({ offerToReceiveAudio: true });
				await pc.setLocalDescription(offer);
				this.sendSignalingMessage(this.signalingChannel, peerId, {
					type: "offer",
					offer: pc.localDescription,
				});
			} catch (err) {
				console.error("Negotiation error:", err);
			}
		};
	}

	startChatConnection(peerId) {
		if (this.dataChannels[peerId]) {
			//already have dataChannel connection... return
			console.log("Chat - Attempted to connect to existing peer");
			return;
		}

		const pc = this.peerConnections[peerId] ? this.peerConnections[peerId] : new RTCPeerConnection(this.rtcConfig);
		this.peerChannels[peerId] = this.peerChannels[peerId] || [];
		if (!this.peerChannels[peerId].includes(this.signalingChannel)) {
			this.peerChannels[peerId].push(this.signalingChannel);
		}

		if (!this.peerConnections[peerId]) {
			this.peerConnections[peerId] = pc;
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
			if (peerId !== selfId && this.peerChannels[peerId] && this.peerChannels[peerId].includes(channel)) {
				const dc = this.dataChannels[peerId];
				if (dc && dc.readyState === "open") {
					dc.send(JSON.stringify(msg));
				} else {
					console.log(`message not sent to ${peerId}`);
					showToast("Error sending msg...");
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
			if (this.peerChannels[peerId]) {
				this.peerChannels[peerId] = this.peerChannels[peerId].filter((ch) => ch !== dcChannel);
			}
			if (this.dataChannels[peerId]) {
				delete this.dataChannels[peerId];
			}
		};
		dc.onmessage = (event) => {
			event = JSON.parse(event.data);
			//bad overhead using parse for a log
			console.log(`Received message from ${peerId} on channel ${event.channel}:`, event.content);
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
						removeVoiceUser(event.user);
						if (this.peerChannels[peerId]) {
							this.peerChannels[peerId] = this.peerChannels[peerId].filter((ch) => ch !== event.channel);
						}
					}
				case "videoRing":
					//special param for starting vc, display ring/video ui
					break;
				default:
					chatManager.rcvChat(event, peerId);
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
		const pc = this.peerConnections[peerId] ? this.peerConnections[peerId] : new RTCPeerConnection(this.rtcConfig);
		this.peerChannels[peerId] = this.peerChannels[peerId] || [];
		if (!this.peerChannels[peerId].includes(this.signalingChannel)) {
			this.peerChannels[peerId].push(this.signalingChannel);
		}
		if (!this.peerConnections[peerId]) {
			this.peerConnections[peerId] = pc;
		}

		// If the offer is for audio (voice), add local audio tracks
		if (offer.sdp && offer.sdp.includes("m=audio")) {
			if (this.localAudioStream) {
				const senders = pc.getSenders();
				this.localAudioStream.getTracks().forEach((track) => {
					const alreadyAdded = senders.some((sender) => sender.track && sender.track.id === track.id);
					if (!alreadyAdded) {
						pc.addTrack(track, this.localAudioStream);
						console.log("Added local track to peer connection");
					}
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
			console.log("recieved remote track", event);
			this.remoteAudioStreams[peerId] = event.streams[0];
			this._playRemoteAudio(peerId, event);
		};

		pc.onicecandidate = (event) => {
			if (event.candidate) {
				this.sendSignalingMessage(this.signalingChannel, peerId, {
					type: "candidate",
					candidate: event.candidate,
				});
			}
		};

		// --- Add state check before setRemoteDescription ---
		if (
			pc.signalingState === "stable" ||
			pc.signalingState === "have-local-offer" ||
			pc.signalingState === "have-remote-offer"
		) {
			pc.setRemoteDescription(new RTCSessionDescription(offer))
				.then(() => pc.createAnswer())
				.then((answer) => pc.setLocalDescription(answer))
				.then(() => {
					this.sendSignalingMessage(this.signalingChannel, peerId, {
						type: "answer",
						answer: pc.localDescription,
					});
				});
		} else {
			console.warn(`handleOffer: Skipping setRemoteDescription due to signalingState=${pc.signalingState}`);
		}
	}

	handleAnswer(peerId, answer) {
		const pc = this.peerConnections[peerId];
		if (pc) {
			// --- Add state check before setRemoteDescription ---
			if (pc.signalingState === "have-local-offer" || pc.signalingState === "have-remote-offer") {
				pc.setRemoteDescription(new RTCSessionDescription(answer));
			} else {
				console.warn(`handleAnswer: Skipping setRemoteDescription due to signalingState=${pc.signalingState}`);
			}
		}
	}

	handleCandidate(peerId, candidate) {
		const pc = this.peerConnections[peerId];
		if (pc) {
			pc.addIceCandidate(new RTCIceCandidate(candidate));
		}
	}

	_playRemoteAudio(peerId, trackEvent) {
		// Create or reuse an <audio> element for this peer
		let audioElem = document.getElementById(`remote-audio-${peerId}`);
		if (!audioElem) {
			audioElem = document.createElement("audio");
			audioElem.id = `remote-audio-${peerId}`;
			audioElem.autoplay = true;
			audioElem.style.display = "none";
			document.body.appendChild(audioElem);
		}
		let stream = trackEvent.streams[0];
		// --- Add controllable GainNode for remote audio ---
		if (!this._audioContext) {
			this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
		}
		// Disconnect previous gain node if exists
		if (this.remoteAudioGainNodes[peerId]) {
			this.remoteAudioGainNodes[peerId].disconnect();
		}

		const remoteSource = this._audioContext.createMediaStreamSource(stream);
		const remoteGainNode = this._audioContext.createGain();
		// Set gain to friend volume or 1
		const friendPref = localPrefs.friends.filter((f) => f.id == peerId)[0];
		remoteGainNode.gain.value = friendPref && typeof friendPref.volume === "number" ? friendPref.volume : 1;

		const remoteDestination = this._audioContext.createMediaStreamDestination();
		remoteSource.connect(remoteGainNode);
		remoteGainNode.connect(remoteDestination);

		// Save gain node for later control
		this.remoteAudioGainNodes[peerId] = remoteGainNode;

		//CHROME BUG THAT TOOK ME 5 HOURS TO FIND
		let dummy = new Audio();
		dummy.srcObject = stream;
		dummy.muted = true;
		//YAY I <3 CHROMIUM

		audioElem.srcObject = remoteDestination.stream;

		// attachAudioVisualizer(remoteDestination.stream);
		visualizeBorderWithAudio(remoteDestination.stream, peerId);
	}

	setUserVolume(userID, volume) {
		// Clamp volume between 0.0 and 1
		const vol = Math.max(0, Math.min(2, volume));
		if (this.remoteAudioGainNodes && this.remoteAudioGainNodes[userID]) {
			this.remoteAudioGainNodes[userID].gain.value = vol;
		}
	}

	async _initLocalAudio() {
		try {
			// Try to get the preferred audio input device from prefs.json (if available)
			let deviceId = null;

			const audioInputDevices = localPrefs.devices.audioInputDevices;
			const preferredDevice = localPrefs.devices.audioInputDevice
				? localPrefs.devices.audioInputDevice.deviceId
				: audioInputDevices[0].deviceId; // Use the first device as preferred
			deviceId = preferredDevice;
			if (!preferredDevice) {
				//no device in prefs, alert user
				alert("Could not get audio input, please double check your settings.");
				return;
			}
			const constraints = {
				audio: deviceId ? { deviceId: { exact: deviceId } } : true,
				video: false,
			};
			this.localAudioStream = await navigator.mediaDevices.getUserMedia(constraints);
			this.unProcessedLocalAudio = this.localAudioStream;

			// Add input gain control
			if (!this._audioContext) {
				this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
			}
			const source = this._audioContext.createMediaStreamSource(this.localAudioStream);

			this._inputGainNode = this._audioContext.createGain();
			this._inputGainNode.gain.value = this.inputGainValue;
			source.connect(this._inputGainNode);

			// Create a destination node and connect gain node to it
			this._inputDestination = this._audioContext.createMediaStreamDestination();
			this._inputGainNode.connect(this._inputDestination);

			// Replace localAudioStream with the processed stream
			this.localAudioStream = this._inputDestination.stream;

			const getAmplitude = getAudioAmplitude(this.unProcessedLocalAudio);

			//debug
			// attachAudioVisualizer(this.unProcessedLocalAudio, "unpcs");
			// attachAudioVisualizer(this.localAudioStream, "local");
			// Add hot mic gating system
			const updateGainBasedOnAmplitude = () => {
				const amp = getAmplitude();
				if (amp < this.hotMicThresh) {
					this._inputGainNode.gain.value = 0;
				} else if (
					!document.getElementById("voice-mute").querySelector("i").classList.contains("fa-microphone-slash")
				) {
					this._inputGainNode.gain.value = this.inputGainValue;
				}
				requestAnimationFrame(updateGainBasedOnAmplitude);
			};
			updateGainBasedOnAmplitude();
		} catch (err) {
			console.warn("Could not get local audio:", err);
			showToast("Missing Audio Input Device");
		}
	}
}

// Utility function to set UI state for voice call controls
function setVoiceUIState(state, id = "") {
	const mute = document.getElementById("voice-mute");
	const vcEl = document.getElementById("voice-call");
	const list = document.getElementById("voice-list");
	const friends = document.querySelectorAll(".friend-item:not(#friends-header)");
	const servers = document.querySelectorAll(".server-item");
	if (!mute || !vcEl || !list || !servers || !friends) return;

	// Helper to find a friend or server id from a chat/channel string
	function findIdFromChannel(channel) {
		if (!channel || typeof channel !== "string") return null;
		var base;
		if (channel.startsWith("chat:") || channel.startsWith("voice:") || channel.startsWith("video:")) {
			// If channel is in format "type:base", we can extract the base
			base = channel.split(":")[1];
		} else {
			base = channel; // If no colon, assume the whole string is the base
		}
		if (!base) return null;
		// Try to find friend by chat
		const friend = (localPrefs.friends || []).find((f) => f.chat === channel || f.chat === base);
		if (friend) return friend.id;
		// Try to find server by secret
		const server = (localPrefs.servers || []).find((s) => s.secret === base);
		if (server) return server.id;
		return null;
	}
	var idEl = null;
	if (id) {
		idEl = document.querySelector(`[name="${id}"]`);
		if (!idEl) {
			id = findIdFromChannel(id);
			if (id) {
				idEl = document.querySelector(`[name="${id}"]`);
			} else {
				console.error("Could not find element to style from ", id);
			}
		}
	}
	// Reset all relevant classes
	mute.classList.add("is-hidden");
	vcEl.classList.remove("ringing", "pickup", "has-text-primary", "has-text-danger", "danger");
	list.classList.remove("ringing");

	switch (state) {
		case "ringing":
			mute.classList.remove("is-hidden");
			vcEl.classList.add("ringing");
			if (rtc.ring.type == "incoming voice") {
				// If incoming ring, add pickup hover
				vcEl.classList.add("pickup");
			}

			list.classList.add("ringing");
			if (idEl) {
				if (idEl) {
					if (idEl.classList.contains("server-item")) {
						// Server ringing
						servers.forEach((s) => {
							if (s.getAttribute("name") == id) {
								s.classList.add("ringing");
							} else {
								s.classList.remove("ringing");
							}
						});
					} else if (idEl.classList.contains("friend-item")) {
						// Friend ringing
						document.querySelector(`.server-item[name="HARMONY-FRIENDS-LIST"]`).classList.add("ringing");
						friends.forEach((f) => {
							if (f.getAttribute("name") == id) {
								f.classList.add("ringing");
							} else {
								f.classList.remove("ringing");
							}
						});
					}
				}
			}
			break;
		case "inCall":
			mute.classList.remove("is-hidden");
			vcEl.classList.remove("pickup", "ringing", "has-text-primary");
			vcEl.classList.add("has-text-danger", "danger");
			list.classList.remove("ringing");
			friends.forEach((f) => {
				f.classList.remove("ringing");
				f.classList.remove("call");
			});
			servers.forEach((s) => {
				s.classList.remove("ringing");
				s.classList.remove("call");
			});
			if (idEl) {
				vcEl.classList.add("call");
			}
			if (vcEl.classList.contains("friend-item")) {
				//if were on call w/friend highlight friend server icon
				document.querySelector(`.server-item[name="HARMONY-FRIENDS-LIST"]`).classList.add("call");
			}
			break;
		case "idle":
		default:
			mute.classList.add("is-hidden");
			vcEl.classList.remove("pickup", "danger", "has-text-danger", "ringing");
			vcEl.classList.add("has-text-primary");
			list.classList.remove("ringing");
			friends.forEach((f) => {
				f.classList.remove("ringing");
				f.classList.remove("call");
			});
			servers.forEach((s) => {
				s.classList.remove("ringing");
				s.classList.remove("call");
			});
			break;
	}
}

function setChannelType(channel, type) {
	if (type != "chat" && type != "voice" && type != "video") {
		console.error(`Attempted to set channel ${channel} with invalid type ${type}`);
	}
	let base = channel.split(":")[1];
	if (base) {
		return `${type}:${base}`;
	} else {
		console.error("Attempted to set type on invalid channel: ", channel);
	}
}

function addVoiceUser(userId) {
	//check if user already Added
	if (document.getElementById(userId)) {
		console.warn(`User ${userId} already added to voice UI`);
		return;
	}
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
	voiceUser.innerHTML = DOMPurify.sanitize(name);
	voiceUser.id = userId;
	voiceUser.addEventListener("click", (e) => {
		manageVoiceUser(e);
	});
	if (userColors[userId]) {
		voiceUser.style.backgroundColor = userColors[userId];
		voiceUser.style.color = HarmonyUtils.getBestTextColor(userColors[userId]);
	}
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

function checkUserCache(userId) {
	if (!userCache[userId] || (userCache[userId] && userCache[userId].timestamp < Date.now() - userCacheTTL)) {
		userCache[userId] = "";
		this.socket.emit("getUsername", userId, (username) => {
			if (username) {
				userCache[userId] = { name: username, timestamp: Date.now() };
				// Save the updated cache to local storage
				saveUserCache();
				console.log(`Cached username for ${userId}: ${username}`);
			} else {
				console.warn(`Server did not have username for: ${userId}`);
				userCache[userId] = null;
			}
		});
	}
}
