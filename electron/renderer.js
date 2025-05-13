// Globals for app
var selectedServer = "HARMONY-FRIENDS-LIST";
var selectedFriend;
var currentChat;
var localPrefs;
var selfId;
var userSecret;

//TODO move secret out of frontend probably
main();

async function main() {
	//set local prefs
	localPrefs = await window.electronAPI.getPrefs();
	selfId = crypto.randomUUID(); //localPrefs.user.userId
	// Hash userId with password to create a secret
	userSecret = await hashbrown(`${selfId}:${localPrefs.user.password}`);
	console.log("Secret: ", userSecret);

	//init websocket
	window.socket = io("ws://localhost:3030", {
		auth: { token: "SIGNALING123", userId: selfId, secret: userSecret },
	});
	this.socket.emit("ready", selfId);
	//init chat and voice interfaces
	rtc = new rtcInterface();
	// VoiceInterface = new rtcVoice();

	// attach listeners
	document.getElementById("settings-save").onclick = () => storePrefs();

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
		document.querySelectorAll(".friend-item").forEach((div) => {
			div.addEventListener("click", selectFriend, true);
		});
	});
	friendsListObserver.observe(document.getElementById("friends"), {
		subtree: true,
		childList: true,
	});

	document.querySelectorAll(".server-item").forEach((div) => {
		div.addEventListener("click", selectServerItem, true);
	});
	document.querySelectorAll(".friend-item").forEach((div) => {
		div.addEventListener("click", selectFriend, true);
	});

	document
		.getElementById("voice-mute")
		.addEventListener("click", rtc.voiceMute);
	document
		.getElementById("voice-call")
		.addEventListener("click", () => rtc.callVoice(currentChat));
}

function sendFriendReq(userId) {}

function sendChat(content) {
	content = DOMPurify.sanitize(content);
	//BIG ASSUMPTION THAT WE ONLY SEND CHAT FROM CURRENTCHAT
	const msg = {
		timestamp: Date.now(),
		user: selfId,
		content: content,
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
		console.log("bad msg");
		return;
	}
	const sanitizedContent = DOMPurify.sanitize(msg.content);
	let el = document.createElement("p");
	let un = document.createElement("span");
	un.className = "tag";
	if (msg.user == selfId) {
		un.classList.add("is-primary");
		el.style = "text-align: end;";
	}
	let sender = userLookup(msg.user);
	un.innerHTML =
		sender.nick != "" && sender.nick != undefined
			? `${sender.nick} (${sender.name})`
			: sender.name;
	el.innerHTML = "";
	el.appendChild(un);
	el.innerHTML += "<br>" + sanitizedContent;
	document.getElementById("chat-messages").appendChild(el);
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
	if (
		localPrefs &&
		localPrefs.settings &&
		typeof localPrefs.settings.maxMsgHistory === "number" &&
		messages.length > localPrefs.settings.maxMsgHistory
	) {
		messages = messages.slice(-localPrefs.settings.maxMsgHistory);
	}

	localStorage.setItem(key, JSON.stringify(messages));
}

function selectFriend(e) {
	if (e.target.id == "friends-header" || e.target.id == "addFriendBtn") {
		return;
	}
	//stop icons from tweaking out
	if (e.target.tagName.toLowerCase() != "div") {
		if (e.target.parentElement) {
			e.target.parentElement.dispatchEvent(
				new Event("click", { bubbles: true })
			);
		}
		return;
	}
	// Remove 'selected' class from all server items except the clicked one
	document.querySelectorAll(".friend-item.selected").forEach((item) => {
		if (item !== e.target) {
			item.classList.remove("selected");
		}
	});
	// Add 'selected' class to the clicked server item
	e.target.classList.add("selected");
	selectedFriend = e.target.getAttribute("name");
	let privFriend = localPrefs.friends.find((f) => f.id == selectedFriend);
	if (privFriend && privFriend.chatId) {
		displayChat(privFriend.chatId);
	} else {
		console.log("Error finding friend chat for ", selectedFriend);
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
	// Remove 'selected' class from all server items except the clicked one
	document.querySelectorAll(".server-item.selected").forEach((item) => {
		if (item !== e.target) {
			item.classList.remove("selected");
		}
	});
	// Add 'selected' class to the clicked server item
	e.target.classList.add("selected");
	selectedServer = e.target.getAttribute("name");

	//update friends tab and chat respectively
	if (selectedServer == "HARMONY-FRIENDS-LIST") {
		document.getElementById("friends").style.display = "block";
		document.getElementById("friends").style.borderWidth = "8px";
		document.getElementById("friends").style.width = "calc-size(auto, size)";
		document.getElementById("chat").style.width = "calc-size(auto, size)";
		document.getElementById("friends-header").style.display = "block";
		document.querySelectorAll(".friend-item").forEach((el) => {
			el.style.display = "block";
		});
		let privFriend = localPrefs.friends.find((f) => f.id == selectedFriend);
		if (privFriend && privFriend.chatId) {
			displayChat(privFriend.chatId);
		} else {
			console.log("Error finding friend chat for ", selectedFriend);
		}
	} else {
		document.getElementById("friends").style.width = "0 !important";
		document.getElementById("friends").style.borderWidth = "2px";
		document.querySelectorAll(".friend-item").forEach((el) => {
			el.style.display = "none";
		});
		document.getElementById("friends-header").style.display = "none";
		document.getElementById("chat").style.width = "100%";
		setTimeout(() => {
			document.getElementById("friends").style.display = "none";
		}, 300);

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

async function settingsInit() {
	if (!rtc.localAudioStream) {
		await rtc._initLocalAudio();
	}
	colorSliderWithAudio(rtc.localAudioStream, "hotMicThresh");
}

async function storePrefs() {
	//get prefs from HTML, then store, and load them to our ui

	localPrefs = await window.electronAPI.getPrefs();
	// Settings
	localPrefs.settings.accentColor =
		document.getElementById("accentColor").value;
	localPrefs.settings.theme = document.getElementById("theme").value;
	localPrefs.settings.notifications =
		document.getElementById("notifications").checked;

	// Username
	localPrefs.user.username = document.getElementById("username").value;
	if (!localPrefs.user.username) {
		alert("Username cannot be empty retard.");
		return;
	}
	localPrefs.user.password = document.getElementById("password").value;
	if (!localPrefs.user.password) {
		alert("Password cannot be empty retard.");
		return;
	}

	// Devices
	const getSelectedDevice = (selectId, devices) => {
		const select = document.getElementById(selectId);
		const deviceId = select.value;
		return devices.find((d) => d.deviceId === deviceId) || null;
	};
	localPrefs.devices.videoInputDevice = getSelectedDevice(
		"videoInputDevice",
		localPrefs.devices.videoInputDevices
	);
	localPrefs.devices.audioInputDevice = getSelectedDevice(
		"audioInputDevice",
		localPrefs.devices.audioInputDevices
	);
	localPrefs.devices.audioOutputDevice = getSelectedDevice(
		"audioOutputDevice",
		localPrefs.devices.audioOutputDevices
	);

	// Audio
	localPrefs.audio.inputGain = parseFloat(
		document.getElementById("inputGain").value
	);
	localPrefs.audio.outputVolume = parseFloat(
		document.getElementById("outputVolume").value
	);
	localPrefs.audio.hotMicThresh = parseFloat(
		document.getElementById("hotMicThresh").value
	);
	localPrefs.audio.ringVolume = parseFloat(
		document.getElementById("ringVolume").value
	);
	localPrefs.audio.enableNoiseSuppression = document.getElementById(
		"enableNoiseSuppression"
	).checked;

	// Save and reload
	window.electronAPI.updatePrefs(localPrefs);
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
