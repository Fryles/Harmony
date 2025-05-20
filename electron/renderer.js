// Globals for app
var selectedServer = "HARMONY-FRIENDS-LIST";
var selectedFriend;
var currentChat;
var localPrefs;
var friendReqs = { incoming: [], outgoing: [] };
var selfId;
const dev = 1;

// Global for stacking toasts
let toastStackHeight = 0;

main();

async function main() {
	//set local prefs
	localPrefs = await window.electronAPI.getPrefs();

	selfId = localPrefs.user.userId;

	await webSocketInit();
	rtc = new rtcInterface();
	checkFriendReqs();
	if (!localPrefs.user.password) {
		//get user to set password
	}
	//init chat and voice interfaces

	// VoiceInterface = new rtcVoice();

	//TODO start rtc chat with all possible peers

	// attach listeners
	document
		.getElementById("settings-save")
		.addEventListener("click", storePrefs);
	document.getElementById("add-friend").addEventListener("click", () => {
		sendFriendReq(document.getElementById("friendIdInput").value);
	});

	document.getElementById("hotMicThresh").onchange = () => {
		rtc.hotMicThresh = parseFloat(
			document.getElementById("hotMicThresh").value
		);
	};
	var $modalButtons = getAll(".modal-button");
	if ($modalButtons.length > 0) {
		$modalButtons.forEach(function ($el) {
			$el.addEventListener("click", async function () {
				var target = $el.dataset.target;
				openModal(target);
				if (target == "settings-modal") {
					if (!rtc.localAudioStream) {
						await rtc._initLocalAudio();
					}
					if (rtc.localAudioStream) {
						colorSliderWithAudio(rtc.unProcessedLocalAudio, "hotMicThresh");
					}
				}
			});
		});
	}

	const serverListObserver = new MutationObserver(() => {
		document.querySelectorAll(".server-item").forEach((div) => {
			div.addEventListener("click", selectServerItem, true);
		});
	});
	serverListObserver.observe(document.getElementById("server-list"), {
		subtree: true,
		childList: true,
	});

	const friendsListObserver = new MutationObserver(() => {
		if (localPrefs.friends) {
			let firstFriend = document.getElementsByName(localPrefs.friends[0].id)[0];
			if (firstFriend) {
				selectFriend(firstFriend);
			}
		}
		document.querySelectorAll(".friend-item").forEach((div) => {
			div.addEventListener("click", selectFriend, true);
			//add manage friend button if not already present
			if (div.querySelector(".icon")) {
				return;
			}
			let manageBtn = document.createElement("span");
			manageBtn.className = "icon mx-1";
			manageBtn.innerHTML = "<i class='fas fa-xl fa-cog'></i>";
			manageBtn.onclick = (e) => {
				e.stopPropagation();
				let friendId = div.getAttribute("name");
				let friend = localPrefs.friends.find((f) => f.id == friendId);
				if (friend) {
					document.getElementById("friendManageIdInput").value = friendId;
					document.getElementById("friendNickInput").value = friend.nick || "";
					document.getElementById("friendNameInput").value = friend.name || "";
					//open modal
					openModal("manage-friend-modal");
					document.getElementById("manage-friend-remove").onclick = () => {
						//remove friend from local prefs
						localPrefs.friends = localPrefs.friends.filter(
							(f) => f.id != friendId
						);
						window.electronAPI.updatePrefs(localPrefs);
						//remove from ui
						div.remove();
						closeModals();
					};
					document.getElementById("manage-friend-save").onclick = () => {
						friend.nick = document.getElementById("friendNickInput").value;
						friend.name = document.getElementById("friendNameInput").value;
						window.electronAPI.updatePrefs(localPrefs);
						//update friend list
						div.innerHTML = "";
						div.innerHTML = DOMPurify.sanitize(
							friend.nick != "" && friend.nick != undefined
								? `${friend.nick} (${friend.name})`
								: friend.name
						);
						div.appendChild(manageBtn);
						div.setAttribute("name", friend.id);
						div.onclick = selectFriend;
						div.addEventListener("click", selectFriend, true);
						//close modal
						closeModals();
					};
				} else {
					//no friend found??
					console.error("Friend not found when adding manage friend button");
				}
			};
			div.appendChild(manageBtn);
		});
	});
	friendsListObserver.observe(document.getElementById("friends"), {
		subtree: true,
		childList: true,
	});

	document
		.getElementById("voice-mute")
		.addEventListener("click", rtc.voiceMute);
	document
		.getElementById("voice-call")
		.addEventListener("click", () => rtc.callVoice(currentChat));

	document.getElementById("serverOpen").addEventListener("change", (e) => {
		const pwdInput = document.getElementById("serverPasswordInput");
		pwdInput.value = e.target.checked ? "" : pwdInput.value;
		pwdInput.disabled = e.target.checked;
	});
}

async function webSocketInit() {
	//get session
	const session = localStorage.getItem("session");
	let s = await hashbrown(`${selfId}:${localPrefs.user.password}`);
	// localStorage.setItem("secret", s);
	const auth = {
		userId: selfId,
		userName: localPrefs.user.username,
		secret: s,
		session: session,
	};
	//init websocket
	if (dev) {
		window.socket = io("ws://localhost:3000", {
			auth: auth,
		});
	} else {
		window.socket = io("https://harmony-server.glitch.me/", {
			auth: auth,
		});
	}
	this.socket.emit("ready");
}

function sendFriendReq(userId) {
	if (localPrefs.friends.filter((f) => f.id == userId).length > 0) {
		//already friends
		showToast("Already Friends With This User");
		return;
	}
	if (friendReqs.outgoing.filter((r) => r.to == userId).length > 0) {
		//already sent req
		showToast("Already Sent Request");
		return;
	}
	if (userId == selfId) {
		//can't send friend request to self
		showToast("You ur own best fran og");
		return;
	}
	const uuidv4Regex =
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	if (!uuidv4Regex.test(userId)) {
		showToast("Invalid User ID (must be UUIDv4)");
		return;
	}

	console.log("sending fr for ", userId);
	//update ui for loading
	socket.emit("friendRequest", userId, (data) => {
		if (data.status == "awaiting") {
			console.log(data);
			//check if we already have this request
			let existingReq = friendReqs.outgoing.filter((r) => r.to == userId);
			if (existingReq.length == 0) {
				friendReqs.outgoing.push(data);
			} else {
				console.warn("Already have this request");
			}
		}
	});
	closeModals();
	showToast("Sent Friend Request");
	document.getElementById("friendIdInput").value = "";
}

function checkFriendReqs() {
	socket.on("friendRequestResponse", (request) => {
		if (request.from != selfId) {
			//got a response from a request we did not send, probably a cancellation
			if (request.status == "cancelled" && request.to == selfId) {
				//remove from incoming
				friendReqs.incoming = friendReqs.incoming.filter(
					(r) => r.chat != request.chat && r.from != request.from
				);
				//update ui
				let reqDiv = document.querySelector(
					`.friend-request-item[reqFrom="${request.from}"]`
				);
				if (reqDiv) {
					reqDiv.remove();
				}
			}
		}
		//add friend
		if (request.status == "accepted") {
			localPrefs.friends.push({
				name: request.toName,
				id: request.to,
				chat: request.chat,
			});
			window.electronAPI.updatePrefs(localPrefs);
			showToast(`${DOMPurify(request.toName)} Is Now Your Friend!`);
		} else {
			//rejected :(
		}
		//update friend requests
		//remove our acked friend request from friendReqs.outgoing
		if (friendReqs.outgoing) {
			friendReqs.outgoing = friendReqs.outgoing.filter(
				(r) => r.to != request.to
			);
		}
	});

	socket.on("friendRequest", (request) => {
		//got a friend request
		console.log("got friend request", request);
		if (request.from != selfId && request.to == selfId) {
			//add to global friendReqs.incoming
			if (!friendReqs.incoming) friendReqs.incoming = [];
			//check if we already have this request
			let existingReq = friendReqs.incoming.filter(
				(r) => r.from == request.from
			);
			if (existingReq.length == 0) {
				friendReqs.incoming.push(request);
			} else {
				console.warn("Already have this request");
				return;
			}
			showToast(`${DOMPurify(request.fromName)} Sent You a Friend Request`);
		}
	});

	socket.emit("checkFriendReqs", ({ incoming, outgoing }) => {
		console.log(incoming, outgoing);
		//store to global friendReqs
		friendReqs.incoming = incoming;
		friendReqs.outgoing = outgoing;
	});
}

function sendChat(content) {
	const sanitizedContent = DOMPurify.sanitize(
		content.replace(/\s*id\s*=\s*(['"])[^'"]*\1/gi, "")
	);
	//BIG ASSUMPTION THAT WE ONLY SEND CHAT FROM CURRENTCHAT
	const msg = {
		timestamp: Date.now(),
		user: selfId,
		username: localPrefs.user.username,
		content: sanitizedContent,
		channel: currentChat,
	};
	updateChat(msg);
	storeChat(msg, currentChat);
	rtc.sendMessage(msg, currentChat);
}

function rcvChat(msg) {
	channel = msg.channel;
	if (channel == currentChat) {
		updateChat(msg);
	} else {
		//TODO add notif for chat we are not viewing
	}
	storeChat(msg, channel);
}

function displayChat(chatId) {
	//get messages from browser
	currentChat = `chat:${chatId}`;
	var messages = [];
	try {
		const existing = localStorage.getItem(currentChat);
		if (existing) {
			messages = JSON.parse(existing);
		}
	} catch (e) {
		console.error("Failed to parse chat history:", e);
		messages = [];
	}
	//clear chat and set all messages
	document.getElementById("chat-messages").innerHTML = "";
	messages.forEach((msg) => {
		updateChat(msg);
	});
	//connect to chat rtc (it will prepend type to chatID for us)
	rtc.joinChannel(currentChat);
}

function updateChat(msg) {
	//add msg to chat
	if (!msg || !msg.user || !msg.content) {
		showToast("I'm Not Sending That!");
		return;
	}
	// Remove all id attributes and sanitize from msg.content
	const sanitizedContent = DOMPurify.sanitize(
		msg.content.replace(/\s*id\s*=\s*(['"])[^'"]*\1/gi, "")
	);
	let el = document.createElement("p");
	let un = document.createElement("span");
	un.className = "tag";
	if (msg.user == selfId) {
		un.classList.add("is-primary");
		el.style = "text-align: end;";
	}

	let username = msg.username;
	let sender = userLookup(msg.user);
	if (username) {
		sender.name = username;
	}
	un.innerHTML = DOMPurify.sanitize(
		sender.nick != "" && sender.nick != undefined
			? `${sender.nick} (${sender.name})`
			: sender.name
	);
	el.innerHTML = "";
	el.appendChild(un);
	el.innerHTML += "<br>" + sanitizedContent;
	document.getElementById("chat-messages").appendChild(el);
	// Auto-scroll to bottom
	const chatMessages = document.getElementById("chat-messages");
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

function storeChat(msg, chatId) {
	//TODO THIS IS KINDA BLOATED

	//adds message to respective chat and stores it
	const key = chatId;
	let messages = [];
	try {
		const existing = localStorage.getItem(key);
		if (existing) {
			messages = JSON.parse(existing);
		}
	} catch (e) {
		console.error("Failed to parse chat history:", e);
		messages = [];
	}
	messages.push(msg);
	//sort by timestamp
	messages.sort((a, b) => a.timestamp - b.timestamp);

	//filter dups (can occur with multiple windows/instances)
	messages = messages.filter(
		(m, i, arr) =>
			arr.findIndex(
				(x) =>
					x.timestamp === m.timestamp &&
					x.user === m.user &&
					x.content === m.content
			) === i
	);

	//constrain to less than localprefs maxMsgHistory
	if (localPrefs && messages.length > localPrefs.settings.maxMsgHistory) {
		messages = messages.slice(-localPrefs.settings.maxMsgHistory);
	}

	localStorage.setItem(key, JSON.stringify(messages));
}

async function changePass(newPass) {
	let newSecret = await hashbrown(`${selfId}:${newPass}`);
	rtc.socket.emit("changePass", newSecret, (e) => {
		if (e.success) {
			localPrefs.user.password = newPass;
			window.electronAPI.updatePrefs(localPrefs);
		} else {
			//notify failure
		}
	});
}

function selectFriend(e) {
	let el = e.target || e;
	if (
		el.id == "friends-header" ||
		el.classList.contains("friends-menu-item") ||
		el.classList.contains("no-fire")
	) {
		return;
	}
	//stop icons from tweaking out
	if (el.tagName.toLowerCase() != "div") {
		if (el.parentElement) {
			el.parentElement.dispatchEvent(new Event("click", { bubbles: true }));
		}
		return;
	}
	// Remove 'selected' class from all server items except the clicked one
	document.querySelectorAll(".friend-item.selected").forEach((item) => {
		if (item !== el) {
			item.classList.remove("selected");
		}
	});
	// Add 'selected' class to the clicked server item
	el.classList.add("selected");
	selectedFriend = el.getAttribute("name");
	let privFriend = localPrefs.friends.find((f) => f.id == selectedFriend);
	if (privFriend && privFriend.chat) {
		displayChat(privFriend.chat);
	} else {
		console.log("Error finding friend chat for ", selectedFriend);
	}
}

function showFriendRequests(e) {
	removeClassFromAll(".friends-menu-item > i", "active");
	document.getElementById("friendRequestsViewBtn").classList.add("active");
	const friendsContainer = document.getElementById("friends");
	removeAllChildren(friendsContainer, ".friend-item", "friends-header");
	removeAllChildren(friendsContainer, ".friend-request-item");

	const requests = friendReqs.incoming || [];
	if (requests.length === 0) {
		const noReq = document.createElement("div");
		noReq.className = "friend-request-item";
		noReq.textContent = "No pending friend requests.";
		friendsContainer.appendChild(noReq);
	}

	requests.forEach((req) => {
		if (req.from == selfId) return;
		const reqDiv = document.createElement("div");
		reqDiv.className = "friend-request-item";
		reqDiv.innerHTML = `
			<span>${DOMPurify.sanitize(req.fromName || req.from)}</span>
			<span>
			<span class="icon mx-1"><i class="accept-friend-request fas fa-xl fa-check-circle"></i></span>
			<span class="icon ml-1"><i class="reject-friend-request fas fa-xl fa-circle-xmark"></i></span>
			</span>
		`;
		reqDiv.setAttribute("reqFrom", DOMPurify.sanitize(req.from));
		reqDiv.querySelector(".accept-friend-request").onclick = () => {
			req.status = "accepted";
			socket.emit("friendRequestResponse", req);
			reqDiv.remove();
			friendReqs.incoming = friendReqs.incoming.filter((r) => r.id !== req.id);
			//add friend to local prefs
			localPrefs.friends.push({
				name: req.from,
				id: req.from,
				chat: req.chat,
			});
			window.electronAPI.updatePrefs(localPrefs);
			//display toast/notif
		};
		reqDiv.querySelector(".reject-friend-request").onclick = () => {
			req.status = "rejected";
			socket.emit("friendRequestResponse", req);
			reqDiv.remove();
			friendReqs.incoming = friendReqs.incoming.filter((r) => r.id !== req.id);
		};
		friendsContainer.appendChild(reqDiv);
	});

	const outgoingReqs = friendReqs.outgoing || [];
	if (outgoingReqs.length > 0) {
		const outgoingDiv = document.createElement("div");
		outgoingDiv.className =
			"friend-request-item has-background-grey-dark has-text-white";
		outgoingDiv.textContent = "Outgoing Friend Requests";
		friendsContainer.appendChild(outgoingDiv);
	}

	outgoingReqs.forEach((req) => {
		const reqDiv = document.createElement("div");
		reqDiv.className = "friend-request-item";
		reqDiv.innerHTML = `
			<span>${DOMPurify.sanitize(req.toName || req.to)}</span>
			<span class="icon mx-1"><i class="reject-friend-request fas fa-xl fa-circle-xmark"></i></span>
		`;
		reqDiv.querySelector(".reject-friend-request").onclick = () => {
			socket.emit("cancelFriendRequest", req);
			reqDiv.remove();
			friendReqs.outgoing = friendReqs.outgoing.filter((r) => r.to !== req.to);
		};
		friendsContainer.appendChild(reqDiv);
	});
}

function showFriends(e) {
	removeClassFromAll(".friends-menu-item > i", "active");
	document.getElementById("friendsViewBtn").classList.add("active");

	const friendsContainer = document.getElementById("friends");
	removeAllChildren(friendsContainer, ".friend-request-item");
	removeAllChildren(friendsContainer, ".friend-item", "friends-header");

	if (localPrefs && Array.isArray(localPrefs.friends)) {
		populateFriendsList(friendsContainer, localPrefs.friends, selectFriend);
	}
}

async function selectServerItem(e) {
	//stop icons from tweaking out
	if (e.target.tagName.toLowerCase() != "div") {
		if (e.target.parentElement) {
			e.target.parentElement.dispatchEvent(
				new Event("click", { bubbles: true })
			);
		}
		return;
	}
	selectedServer = e.target.getAttribute("name");
	if (selectedServer == "HARMONY-ADD-SERVER") {
		//open add server modal
		openModal("add-server-modal");
		return;
	}
	// Remove 'selected' class from all server items except the clicked one
	document.querySelectorAll(".server-item.selected").forEach((item) => {
		if (item !== e.target) {
			item.classList.remove("selected");
		}
	});
	// Add 'selected' class to the clicked server item
	e.target.classList.add("selected");

	const friendsEl = document.getElementById("friends");
	const chatEl = document.getElementById("chat");

	if (selectedServer == "HARMONY-FRIENDS-LIST") {
		friendsEl.classList.remove("slide-away");
		chatEl.classList.remove("expand");

		let privFriend = localPrefs.friends.find((f) => f.id == selectedFriend);
		if (privFriend && privFriend.chatId) {
			displayChat(privFriend.chatId);
		} else {
			console.log("Error finding friend chat for ", selectedFriend);
		}
	} else {
		friendsEl.classList.add("slide-away");
		chatEl.classList.add("expand");

		let privServer = localPrefs.servers.find((f) => f.id == selectedServer);
		if (
			privServer &&
			privServer.password !== null &&
			privServer.password !== undefined
		) {
			let hash = await hashbrown(`${privServer}:${privServer.password}`);
			displayChat(hash);
		} else {
			console.log("Error finding Server password for ", selectedServer);
		}
	}
}

function userLookup(userId) {
	if (!localPrefs || !localPrefs.friends)
		return { name: window.electronAPI.getPsuedoUser(userId), nick: "" };
	if (userId === localPrefs.user.userId) {
		return { name: localPrefs.user.username, nick: "" };
	}
	const friend = localPrefs.friends.find((f) => f.id === userId);
	if (friend) {
		return { name: friend.name, nick: friend.nick || "" };
	}
	return { name: window.electronAPI.getPsuedoUser(userId), nick: "" };
}

async function storePrefs() {
	localPrefs = await window.electronAPI.getPrefs();
	const getVal = (id) => document.getElementById(id).value;
	const getChk = (id) => document.getElementById(id).checked;

	const accentColorEl = document.getElementById("accentColor");
	if (!/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(accentColorEl.value)) {
		validateField(accentColorEl);
		return;
	}
	localPrefs.settings.accentColor = accentColorEl.value;
	localPrefs.settings.theme = getVal("theme");
	localPrefs.settings.notifications = getChk("notifications");

	const usernameEl = document.getElementById("username");
	if (!usernameEl.value) {
		validateField(usernameEl);
		return;
	}
	localPrefs.user.username = usernameEl.value;

	const passwordEl = document.getElementById("password");
	if (!passwordEl.value) {
		validateField(passwordEl);
		return;
	}
	if (passwordEl.value !== localPrefs.user.password)
		changePass(passwordEl.value);

	["videoInputDevice", "audioInputDevice", "audioOutputDevice"].forEach(
		(id) => {
			localPrefs.devices[id] = getSelectedDevice(
				id,
				localPrefs.devices[id + "s"]
			);
		}
	);

	["inputGain", "outputVolume", "hotMicThresh", "ringVolume"].forEach((id) => {
		localPrefs.audio[id] = parseFloat(getVal(id));
	});
	localPrefs.audio.enableNoiseSuppression = getChk("enableNoiseSuppression");

	window.electronAPI.updatePrefs(localPrefs);
}

function manageVoiceUser(e) {
	//make sure were not clicking ourselves
	if (e.target.id == selfId) {
		return;
	}
	console.log("gerr");

	//event handler for voice user onclick
	const userDiv = e.target.closest(".voice-prof");
	if (!userDiv) return;

	// Remove any existing popup
	const existingPopup = document.getElementById("voice-user-popup");
	if (existingPopup) existingPopup.remove();

	const userId = userDiv.id;
	let friend = userLookup(userId);
	let username = DOMPurify.sanitize(
		friend.nick != "" && friend.nick != undefined
			? `${friend.nick} (${friend.name})`
			: friend.name
	);

	// Create popup
	const popup = document.createElement("div");
	popup.id = "voice-user-popup";
	popup.style.position = "absolute";
	popup.style.zIndex = 10000;
	popup.style.background = "#23272a";
	popup.style.border = "1px solid #444";
	popup.style.borderRadius = "10px";
	popup.style.padding = "1rem";
	popup.style.boxShadow = "0 2px 10px rgba(0,0,0,0.4)";
	popup.style.width = "250px";
	popup.style.color = "#fff";
	popup.innerHTML = `
		<div style="margin-bottom: 0.5rem; font-weight: bold;">${DOMPurify.sanitize(
			username
		)}</div>
		<div style="margin-bottom: 0.5rem;">
			<label style="font-size: 0.9em;">Voice Volume</label>
			<input type="range" min="0" max="2" step="0.01" value="1" style="width: 100%;" id="voice-volume-slider">
		</div>
		<button class="button is-small is-link" id="addFriendVoiceBtn" style="width:100%;margin-bottom:0.3rem;">
			<i class="fas fa-user-plus"></i> Add Friend
		</button>
	`;

	// Position popup to the left of the userDiv
	const rect = userDiv.getBoundingClientRect();
	popup.style.top = `${rect.top + window.scrollY - 50}px`;
	popup.style.left = `${rect.left + window.scrollX - 260}px`;

	document.body.appendChild(popup);

	// Voice volume slider
	const slider = popup.querySelector("#voice-volume-slider");
	let initialVol = 1;
	let friendObj = localPrefs.friends.find((f) => f.id == userId);
	if (friendObj && typeof friendObj.volume === "number") {
		initialVol = friendObj.volume;
	} else {
		let voiceUserVolumes = {};
		try {
			voiceUserVolumes =
				JSON.parse(localStorage.getItem("voiceUserVolumes")) || {};
		} catch (e) {
			voiceUserVolumes = {};
		}
		if (typeof voiceUserVolumes[userId] === "number") {
			initialVol = voiceUserVolumes[userId];
		}
	}
	slider.value = initialVol;
	slider.oninput = (ev) => {
		const vol = parseFloat(ev.target.value);
		rtc.setUserVolume(userId, vol);
	};

	// Add friend logic
	const addBtn = popup.querySelector("#addFriendVoiceBtn");
	addBtn.onclick = () => {
		sendFriendReq(userId);
		popup.remove();
	};

	// Close popup on outside click
	const closePopup = (evt) => {
		if (!popup.contains(evt.target)) {
			popup.remove();
			document.removeEventListener("mousedown", closePopup, true);
			//save volume to prefs
			const vol = parseFloat(slider.value);
			let friend = localPrefs.friends.find((f) => f.id == userId);
			if (friend && friend.volume != vol) {
				friend.volume = vol;
				//avoid writing to json if no change
				window.electronAPI.updatePrefs(localPrefs);
			} else {
				// Store in voiceUserVolumes in localStorage
				let voiceUserVolumes = {};
				try {
					voiceUserVolumes =
						JSON.parse(localStorage.getItem("voiceUserVolumes")) || {};
				} catch (e) {
					voiceUserVolumes = {};
				}
				voiceUserVolumes[userId] = vol;
				localStorage.setItem(
					"voiceUserVolumes",
					JSON.stringify(voiceUserVolumes)
				);
			}
		}
	};
	setTimeout(() => {
		document.addEventListener("mousedown", closePopup, true);
	}, 10);
}

function validateField(element) {
	element.classList.add("is-danger");
	element.focus();
	setTimeout(element.classList.remove("is-danger"), 5000);
}

//hash password to hex str
async function hashbrown(pwd) {
	const msgUint8 = new TextEncoder().encode(pwd); // encode as (utf-8) Uint8Array
	const hashBuffer = await window.crypto.subtle.digest("SHA-256", msgUint8); // hash the message
	const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
	const hashHex = hashArray
		.map((b) => b.toString(16).padStart(2, "0"))
		.join(""); // convert bytes to hex string
	return hashHex;
}

//modal control
var rootEl = document.documentElement;
var $modals = getAll(".modal");
var $modalCloses = getAll(
	".modal-background, .modal-close, .modal-card-head .delete, .close"
);

if ($modalCloses.length > 0) {
	$modalCloses.forEach(function ($el) {
		$el.addEventListener("click", function () {
			closeModals();
		});
	});
}

function getAll(selector) {
	return Array.prototype.slice.call(document.querySelectorAll(selector), 0);
}
function openModal(target) {
	var $target = document.getElementById(target);
	rootEl.classList.add("is-clipped");
	$target.classList.add("is-active");
}

function closeModals() {
	rootEl.classList.remove("is-clipped");
	$modals.forEach(function ($el) {
		$el.classList.remove("is-active");
	});
	if (!rtc.mediaChannel) {
		rtc.stopLocalVoice();
	}
}

// Utility: Remove a class from all elements matching selector
function removeClassFromAll(selector, className) {
	document
		.querySelectorAll(selector)
		.forEach((el) => el.classList.remove(className));
}

// Utility: Remove all children matching selector from parent
function removeAllChildren(parent, selector, exceptId) {
	parent.querySelectorAll(selector).forEach((item) => {
		if (!exceptId || item.id !== exceptId) item.remove();
	});
}

// Utility: Repopulate friends list
function populateFriendsList(container, friends, clickHandler) {
	friends.forEach((friend) => {
		const friendDiv = document.createElement("div");
		friendDiv.className = "friend-item";
		friendDiv.setAttribute("name", DOMPurify.sanitize(friend.id));
		friendDiv.textContent = DOMPurify.sanitize(
			friend.nick ? `${friend.nick} (${friend.name})` : friend.name
		);
		friendDiv.addEventListener("click", clickHandler, true);
		container.appendChild(friendDiv);
	});
}

// Utility: Get selected device from select element
function getSelectedDevice(selectId, devices) {
	const select = document.getElementById(selectId);
	const deviceId = select.value;
	return devices.find((d) => d.deviceId === deviceId) || null;
}

function showToast(msg, onclick, color = "is-primary", timeout = 5000) {
	const toast = document.createElement("div");
	toast.className = `notification ${color}`;
	const baseTop = 0.5; // rem
	const stackOffset = toastStackHeight * 3; // 4rem per toast
	toast.style.position = "absolute";
	toast.style.left = "50%";
	toast.style.top = `calc(${baseTop}rem + ${stackOffset}rem)`;
	toast.style.transform = "translate(-50%, -100%)";
	toast.style.transition =
		"transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s";
	toast.style.zIndex = 9999;
	toast.style.minWidth = "20px";
	toast.innerHTML = `
		${DOMPurify.sanitize(
			msg
		)}<button class="toastClose ml-2 mr-1"><span class="icon is-small">
      <i class="fas fa-xmark"></i>
    </span></button>
	`;
	toast.querySelector(".toastClose").onclick = () => {
		// Animate stow
		toast.style.transform = "translate(-50%, -100%)";
		toast.style.opacity = "0";
		setTimeout(() => {
			toast.remove();
			toastStackHeight = Math.max(0, toastStackHeight - 1);
			// Re-stack remaining toasts
			document.querySelectorAll(".notification").forEach((el, idx) => {
				// Animate top property for smooth re-stack
				el.style.transition =
					"top 0.4s cubic-bezier(0.4, 0, 0.2, 1), transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s";
				el.style.top = `calc(${baseTop}rem + ${idx * 3}rem)`;
			});
		}, 300);
	};

	if (typeof onclick == "function") {
		toast.classList.add("is-clickable");
		toast.addEventListener("click", function (e) {
			// Prevent click on close button from triggering onclick
			if (e.target.closest(".toastClose")) return;
			onclick(e);
		});
	}
	// Instead of document.body, append to #chat
	const chatDiv = document.getElementById("chat");
	const activemodal = document.querySelector(".modal.is-active");
	if (activemodal) {
		activemodal.appendChild(toast);
	} else if (chatDiv) {
		chatDiv.appendChild(toast);
		chatDiv.style.position = "relative"; // Ensure #chat is positioned
	} else {
		document.body.appendChild(toast); // fallback
	}

	// Animate drop down
	setTimeout(() => {
		toast.style.transform = "translate(-50%, 0)";
		toast.style.opacity = "0.8";
	}, 10);

	toastStackHeight++;

	setTimeout(() => {
		// Animate stow
		toast.style.transform = "translate(-50%, -100%)";
		toast.style.opacity = "0";
		setTimeout(() => {
			toast.remove();
			toastStackHeight = Math.max(0, toastStackHeight - 1);
			// Re-stack remaining toasts
			document.querySelectorAll(".notification").forEach((el, idx) => {
				// Animate top property for smooth re-stack
				el.style.transition =
					"top 0.4s cubic-bezier(0.4, 0, 0.2, 1), transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s";
				el.style.top = `calc(${baseTop}rem + ${idx * 3}rem)`;
			});
		}, 300);
	}, timeout);
}
