// Globals for app
var selectedServer = "HARMONY-FRIENDS-LIST";
var selectedFriend; //global to reference what friend we are in chat with
var currentChat; //global to reference what channel we are in
var localPrefs; //preferences object in mem to avoid multiple file reads
var userCache = {}; //stores id username pairs
var userCacheTTL = 1000 * 60 * 30; // 30 minute
var friendReqs = { incoming: [], outgoing: [] }; //synced with server on start, then updated with socket
var selfId; //clients userId
const dev = 1; //controls what server websockets talks to
let toastStackHeight = 0; // Global for stacking toasts
let lastLoopingToast = 0; // Global to stop spamming toasts

init();

async function init() {
	loadUserCache();

	//set local prefs
	localPrefs = await window.electronAPI.getPrefs();

	if (!localPrefs || !localPrefs.user || !localPrefs.user.userId || !localPrefs.user.password) {
		//We rly cant do much without local prefs, just wait until user saves for first time then reload
		return;
	}
	selfId = localPrefs.user.userId;

	await webSocketInit();
	rtc = new rtcInterface();
	if (!localPrefs.user.password) {
		//bro what
		alert("idk how but u never set a password. please set one");
	}

	chatManager.chatInit(); //attathces input listeners for formatting and box expand

	document.getElementById("settings-save").addEventListener("click", async () => {
		if (await storePrefs()) {
			closeModals();
		}
	});
	document.getElementById("add-server").addEventListener("click", () => {
		registerServer();
	});
	document.getElementById("join-server").addEventListener("click", () => {
		addServer();
	});
	document.getElementById("add-friend").addEventListener("click", () => {
		FriendsManager.sendFriendReq(document.getElementById("friendIdInput").value);
	});

	document.getElementById("hotMicThresh").onchange = () => {
		rtc.hotMicThresh = parseFloat(document.getElementById("hotMicThresh").value);
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
		if (localPrefs.friends.length > 0) {
			let firstFriend = document.getElementsByName(localPrefs.friends[0].id)[0];
			if (firstFriend && !selectedFriend) {
				FriendsManager.selectFriend(firstFriend);
			}
		}
		document.querySelectorAll(".friend-item").forEach((div) => {
			div.addEventListener("click", FriendsManager.selectFriend, true);
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
						FriendsManager.removeFriend(friendId, () => {
							showToast(`Removed ${friend.name} from friends`);
						});
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
							friend.nick != "" && friend.nick != undefined ? `${friend.nick} (${friend.name})` : friend.name
						);
						div.appendChild(manageBtn);
						div.setAttribute("name", friend.id);
						div.onclick = FriendsManager.selectFriend;
						div.addEventListener("click", FriendsManager.selectFriend, true);
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

	document.getElementById("voice-mute").addEventListener("click", rtc.voiceMute);
	document.getElementById("voice-call").addEventListener("click", () => rtc.callVoice(currentChat));

	document.getElementById("serverOpen").addEventListener("change", (e) => {
		const pwdInput = document.getElementById("serverPasswordInput");
		pwdInput.value = e.target.checked ? "" : pwdInput.value;
		pwdInput.disabled = e.target.checked;
	});

	// Join all server and friend chats on startup
	if (localPrefs && rtc) {
		// Join all server chats
		if (Array.isArray(localPrefs.servers)) {
			localPrefs.servers.forEach((server) => {
				if (server.secret) {
					rtc.joinChannel(`chat:${server.secret}`);
				}
			});
		}
		// Join all friend chats
		if (Array.isArray(localPrefs.friends)) {
			localPrefs.friends.forEach((friend) => {
				if (friend.chat) {
					rtc.joinChannel(`chat:${friend.chat}`);
				}
			});
		}
	}

	// retrieve any stored messages on server for all chats that support it
	let since = localStorage.getItem("lastOnline") || Date.now() - 24 * 60 * 60 * 1000; // default to 24 hours ago if not set
	if (localPrefs && localPrefs.servers) {
		localPrefs.servers.forEach((server) => {
			if (server.options && server.options.serverStoredMessaging) {
				socket.emit("getServerMessages", server.id, since, (serverResponse) => {
					if (!serverResponse.success) {
						console.error(`Failed to retrieve messages for server ${server.name}:`, serverResponse.error);
						return;
					}
					if (dev) {
						console.log(`Retrieved ${serverResponse.messages.length} msgs for server ${server.name}`);
					}
					serverResponse.messages.forEach((msg) => {
						msg.channel = `chat:${server.secret}`;
						chatManager.storeChat(msg);
					});
				});
			}
		});
	}

	// setInterval to update local storage "lastOnline" every 30s
	setInterval(() => {
		localStorage.setItem("lastOnline", Date.now());
	}, 20 * 1000); // 20 seconds

	//check friend reqs
	FriendsManager.showFriends();
	FriendsManager.checkFriendReqs();
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
	this.socket.on("connect_error", (err) => {
		if (err.message == "xhr poll error") {
			const now = Date.now();
			if (now - lastLoopingToast > 7000) {
				showToast("Disconnected from server");
				lastLoopingToast = now;
			}
			return;
		}
		showToast(err.message);
	});
	this.socket.emit("ready");
}

async function registerServer() {
	let name = DOMPurify.sanitize(document.getElementById("serverNameInput").value);
	let pwd = document.getElementById("serverPasswordInput").value;
	let id = crypto.randomUUID();

	const secret = await hashbrown(`server:${id}:${pwd}`);
	console.log(secret);

	let options = {
		serverOpen: document.getElementById("serverOpen").checked,
		serverUnlisted: document.getElementById("serverUnlisted").checked,
		serverStoredMessaging: document.getElementById("serverStoredMessaging").checked,
	};
	if ((pwd === "" || !pwd || pwd.trim() === "") && !options.serverOpen) {
		//empty pwd with non-open server
		showToast("A Closed Server Must Have a Password");
		return;
	}
	// Password complexity check for closed servers
	if (!options.serverOpen && !HarmonyUtils.isPasswordComplex(pwd)) {
		showToast("Password must be at least 8 characters.");
		return;
	}

	if (name.length > 32 || name.length < 3) {
		showToast("Server name is too long or too short.");
		return;
	}

	let sovo = {
		name: name,
		id: id,
		secret: secret,
		options: options,
	};
	socket.emit("registerServer", sovo, (res) => {
		if (res.success) {
			console.log(res);

			showToast(`Created Server: ${res.server.name}`);
			// Add server to prefs and update
			if (!localPrefs.servers) localPrefs.servers = [];
			localPrefs.servers.push(res.server);
			// Add server to UI before the "Add Server" button
			const serverList = document.getElementById("server-list");
			if (serverList) {
				const addServerBtn = serverList.querySelector('.server-item[name="HARMONY-ADD-SERVER"]');
				const serverDiv = document.createElement("div");
				serverDiv.className = "server-item";
				serverDiv.setAttribute("name", res.server.id);
				let name = res.server.name;
				if (name.includes(" ") && name.length > 5) {
					//split two part name into two 2 char initials
					name = name.split(" ");
					name = name[0].substring(0, 2) + " " + name[1].substring(0, 2);
				} else if (name.length > 5) {
					name = name.substring(0, 5);
				}
				serverDiv.textContent = DOMPurify.sanitize(name);
				serverDiv.addEventListener("click", selectServerItem, true);
				if (addServerBtn) {
					serverList.insertBefore(serverDiv, addServerBtn);
				} else {
					serverList.appendChild(serverDiv);
				}
			}
			closeModals();
			window.electronAPI.updatePrefs(localPrefs);
		} else {
			if (res.error) {
				showToast(res.error);
			}
		}
	});
}

//called in add server modal to attempt to find id from server name, then authenticate with the server and add to ui
function addServer() {
	const name = document.getElementById("joinServerNameInput").value;
	const pwd = document.getElementById("joinServerPasswordInput").value;
	if (!name || name.trim() === "") {
		showToast("Server name cannot be empty.");
		return;
	}

	//query server exact to get id (could be real or fake)
	socket.emit("serverQuery", name, true, async (res) => {
		res = res[0];
		if (!res.id) {
			showToast(`Failed to join ${name}`, null, "is-danger");
		}
		const secret = await hashbrown(`server:${res.id}:${pwd}`);
		socket.emit("serverAuth", name, res.id, secret, (res) => {
			if (res) {
				// good auth, add server to prefs
				if (!localPrefs.servers) localPrefs.servers = [];
				localPrefs.servers.push(res);
				// Add server to UI before the "Add Server" button
				const serverList = document.getElementById("server-list");
				if (serverList) {
					const addServerBtn = serverList.querySelector('.server-item[name="HARMONY-ADD-SERVER"]');
					const serverDiv = document.createElement("div");
					serverDiv.className = "server-item";
					serverDiv.setAttribute("name", res.id);
					let name = res.name;
					if (name.includes(" ") && name.length > 5) {
						//split two part name into two 2 char initials
						name = name.split(" ");
						name = name[0].substring(0, 2) + " " + name[1].substring(0, 2);
					} else if (name.length > 5) {
						name = name.substring(0, 5);
					}
					serverDiv.textContent = DOMPurify.sanitize(name);
					serverDiv.addEventListener("click", selectServerItem, true);
					if (addServerBtn) {
						serverList.insertBefore(serverDiv, addServerBtn);
					} else {
						serverList.appendChild(serverDiv);
					}
				}
				showToast(`Joined ${DOMPurify.sanitize(res.name)}`, () => {
					const serverItem = document.querySelector(`.server-item[name="${res.id}"]`);
					if (serverItem) {
						serverItem.dispatchEvent(new Event("click", { bubbles: true }));
					}
				});
				// Update prefs and close modal
				closeModals();
				window.electronAPI.updatePrefs(localPrefs);
			} else {
				showToast(`Failed to join ${name}`, null, "is-danger");
			}
		});
	});
}

// Handles clicks on server icons
async function selectServerItem(e) {
	//stop icons from tweaking out
	if (e.target.tagName.toLowerCase() != "div") {
		if (e.target.parentElement) {
			e.target.parentElement.dispatchEvent(new Event("click", { bubbles: true }));
		}
		return;
	}
	if (selectedServer == e.target.getAttribute("name")) {
		//same server we already selected...
		showToast("Already viewing this server");
		return;
	}
	if (e.target.getAttribute("name") == "HARMONY-ADD-SERVER") {
		//open add server modal
		openModal("add-server-modal");
		return;
	}

	selectedServer = e.target.getAttribute("name");
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
	var chat;
	if (selectedServer == "HARMONY-FRIENDS-LIST") {
		FriendsManager.showFriends();
		friendsEl.classList.remove("slide-away");
		chatEl.classList.remove("expand");

		let privFriend = localPrefs.friends.find((f) => f.id == selectedFriend);
		if (privFriend && privFriend.chat) {
			chat = privFriend.chat;
			chatManager.displayChat(chat);
		} else {
			//no friend chat to display, show empty chat
			chatManager.displayChat(null);
			console.log("Error finding friend chat for ", selectedFriend);
		}
	} else {
		friendsEl.classList.add("slide-away");
		chatEl.classList.add("expand");

		let privServer = localPrefs.servers.find((f) => f.id == selectedServer);
		if (privServer && privServer.secret !== null && privServer.secret !== undefined) {
			chat = privServer.secret;
			chatManager.displayChat(chat);
		} else {
			//no server chat to display, show empty chat
			chatManager.displayChat(null);
			console.log("Error finding server chat for ", selectedServer);
		}
	}
	//if we are not in a mediaChannel and not getting a ring, clear voice and update to new server when switching
	if (!rtc.mediaChannel && !rtc.ring) {
		// Clear all .voice-prof elements in #voice-list
		const voiceList = document.getElementById("voice-list");
		if (voiceList) {
			voiceList.querySelectorAll(".voice-prof").forEach((el) => el.remove());
		}
		socket.emit("channelQuery", `voice:${chat}`, (res) => {
			//check if anyone is in new channels vc
			if (res.length > 0) {
				//add to vc ui and maybe update rtc channels?? shouldnt be needed i thinks
				res.forEach((user) => {
					addVoiceUser(user);
				});
			}
		});
	}
}

// Returns user object with name and nick for given userId
function userLookup(userId) {
	if (userId === selfId) {
		return { name: localPrefs.user.username, nick: "" };
	}

	if (!localPrefs.friends && !userCache[userId]) return { name: window.electronAPI.getPsuedoUser(userId), nick: "" };
	if (localPrefs.friends) {
		const friend = localPrefs.friends.find((f) => f.id === userId);

		if (friend) {
			return { name: friend.name, nick: friend.nick || "" };
		}
	}
	if (userCache[userId]) {
		return { name: userCache[userId].name, nick: "" };
	}

	return { name: window.electronAPI.getPsuedoUser(userId), nick: "" };
}

// Validates then saves preferences to local and server for user/pass
async function storePrefs() {
	localPrefs = await window.electronAPI.getPrefs();
	const getVal = (id) => document.getElementById(id).value;
	const getChk = (id) => document.getElementById(id).checked;

	const accentColorEl = document.getElementById("accentColor");
	if (!/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(accentColorEl.value)) {
		validateField(accentColorEl);
		showToast(`${accentColorEl.value} is not a valid hex color code`);
		return false;
	}
	localPrefs.settings.accentColor = accentColorEl.value;
	localPrefs.settings.theme = getVal("theme");
	localPrefs.settings.notifications = getChk("notifications");

	const usernameEl = document.getElementById("username");
	if (!usernameEl.value) {
		validateField(usernameEl);
		showToast("Username can't be empty dingus");
		return false;
	}
	if (usernameEl.length > 15) {
		validateField(usernameEl);
		showToast("Username can't be longer than 15 chars");
		return false;
	}

	const passwordEl = document.getElementById("password");
	// Password complexity check for user password
	if (
		!passwordEl.value ||
		(passwordEl.value !== localPrefs.user.password && !HarmonyUtils.isPasswordComplex(passwordEl.value))
	) {
		validateField(passwordEl);
		showToast("Password must be at least 8 characters.");
		return false;
	}

	["videoInputDevice", "audioInputDevice", "audioOutputDevice"].forEach((id) => {
		localPrefs.devices[id] = HarmonyUtils.getSelectedDevice(id, localPrefs.devices[id + "s"]);
	});

	["inputGain", "outputVolume", "hotMicThresh", "ringVolume"].forEach((id) => {
		localPrefs.audio[id] = parseFloat(getVal(id));
	});
	localPrefs.audio.enableNoiseSuppression = getChk("enableNoiseSuppression");

	//if user or pass changed, let server know
	if (localPrefs.user.password != passwordEl.value || localPrefs.user.username != usernameEl.value) {
		let newPass = passwordEl.value;
		if (newPass === "" || newPass === null || newPass === undefined) {
			//if no new pass, use old one
			if (HarmonyUtils.isPasswordComplex(localPrefs.user.password)) {
				newPass = localPrefs.user.password;
			} else {
				//localprefs pass is somehow invalid, probably bug or user being a dingus
				showToast("Current password is invalid, please set a new one");
				return;
			}
		}
		let newSecret = await hashbrown(`${selfId}:${newPass}`);
		rtc.socket.emit(
			"setUser",
			{
				id: selfId,
				name: usernameEl.value,
				secret: newSecret,
			},
			(res) => {
				if (res.success) {
					localPrefs.user.username = usernameEl.value;
					localPrefs.user.password = newPass;
					window.electronAPI.updatePrefs(localPrefs);
					window.electronAPI.loadPrefs(localPrefs);
					return true;
				} else {
					showToast("Failed to update: " + res.error);
					return false;
				}
			}
		);
	} else {
		//no user or pass change, just update local prefs
		window.electronAPI.updatePrefs(localPrefs);
		window.electronAPI.loadPrefs(localPrefs);
		return true;
	}
}

function manageVoiceUser(e) {
	//make sure were not clicking ourselves
	if (e.target.id == selfId) {
		showToast("Thats You!");
		return;
	}

	//event handler for voice user onclick
	const userDiv = e.target.closest(".voice-prof");
	if (!userDiv) return;

	// Remove any existing popup
	const existingPopup = document.getElementById("voice-user-popup");
	if (existingPopup) existingPopup.remove();

	const userId = userDiv.id;
	let friend = userLookup(userId);
	let username = DOMPurify.sanitize(
		friend.nick != "" && friend.nick != undefined ? `${friend.nick} (${friend.name})` : friend.name
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
		)}<br><span class="is-clickable" style="font-weight: normal;font-size:0.9em;color: var(--bulma-grey-light)" onclick="navigator.clipboard.writeText(this.innerText);showToast('Copied User ID');">${userId}</span></div>
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
			voiceUserVolumes = JSON.parse(localStorage.getItem("voiceUserVolumes")) || {};
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
		FriendsManager.sendFriendReq(userId);
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
					voiceUserVolumes = JSON.parse(localStorage.getItem("voiceUserVolumes")) || {};
				} catch (e) {
					voiceUserVolumes = {};
				}
				voiceUserVolumes[userId] = vol;
				localStorage.setItem("voiceUserVolumes", JSON.stringify(voiceUserVolumes));
			}
		}
	};
	setTimeout(() => {
		document.addEventListener("mousedown", closePopup, true);
	}, 10);
}

function manageChatUser(msgEl) {
	if (!msgEl) return;

	// Try to extract userId and timestamp from the message element or event
	let userId = msgEl.getAttribute("data-user-id");
	let timestamp = msgEl.getAttribute("data-timestamp");

	if (!userId || !timestamp) {
		// Not enough info to show popup
		showToast("User info not available for this message.");
		return;
	}

	// Remove any existing popup
	const existingPopup = document.getElementById("chat-user-popup");
	if (existingPopup) existingPopup.remove();

	let friend = userLookup(userId);
	let username = DOMPurify.sanitize(
		friend.nick != "" && friend.nick != undefined ? `${friend.nick} (${friend.name})` : friend.name
	);

	// Format timestamp
	let ts = new Date(Number(timestamp));
	let tsStr = ts.toLocaleString();

	// Determine if already a friend
	let isFriend = localPrefs.friends.some((f) => f.id === userId);

	// Create popup
	const popup = document.createElement("div");
	popup.id = "chat-user-popup";
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
		<div style="margin-bottom: 0.5rem; font-weight: bold;">${username}</div>
		<div style="font-size:0.9em;margin-bottom:0.5rem;">
			<span class="is-clickable" style="color: var(--bulma-grey-light)" onclick="navigator.clipboard.writeText('${userId}');showToast('Copied User ID');">${userId}</span>
		</div>
		<div style="font-size:0.9em;margin-bottom:0.5rem;">
			<span>Sent: ${DOMPurify.sanitize(tsStr)}</span>
		</div>
		${
			isFriend
				? `<button class="button is-small is-danger" id="removeFriendChatBtn" style="width:100%;margin-bottom:0.3rem;">
					<i class="fas fa-user-minus"></i> Remove Friend
				</button>`
				: `<button class="button is-small is-link" id="addFriendChatBtn" style="width:100%;margin-bottom:0.3rem;">
					<i class="fas fa-user-plus"></i> Add Friend
				</button>`
		}
	`;

	// Position popup near the message element, depending on if self or not
	const rect = msgEl.getBoundingClientRect();
	if (userId == selfId) {
		popup.style.top = `${rect.top + window.scrollY - 50}px`;
		popup.style.left = `${rect.left + window.scrollX - 260}px`;
	} else {
		popup.style.top = `${rect.top + window.scrollY - 50}px`;
		popup.style.left = `${rect.left + window.scrollX + 100}px`;
	}
	document.body.appendChild(popup);

	// Add friend/remove friend logic
	if (isFriend) {
		const removeBtn = popup.querySelector("#removeFriendChatBtn");
		removeBtn.onclick = () => {
			FriendsManager.removeFriend(userId, () => {
				showToast(`Removed ${username} from friends`);
			});
			// Remove the popup and refresh friends list
			popup.remove();
			FriendsManager.showFriends();
		};
	} else {
		const addBtn = popup.querySelector("#addFriendChatBtn");
		addBtn.onclick = () => {
			FriendsManager.sendFriendReq(userId);
			popup.remove();
		};
	}

	// Close popup on outside click
	const closePopup = (evt) => {
		if (!popup.contains(evt.target)) {
			popup.remove();
			document.removeEventListener("mousedown", closePopup, true);
		}
	};
	setTimeout(() => {
		document.addEventListener("mousedown", closePopup, true);
	}, 10);
}

function validateField(element) {
	element.classList.add("is-danger");
	element.focus();
	setTimeout(() => {
		element.classList.remove("is-danger");
	}, 3000);
}

//hash password to hex str
async function hashbrown(pwd) {
	const msgUint8 = new TextEncoder().encode(pwd); // encode as (utf-8) Uint8Array
	const hashBuffer = await window.crypto.subtle.digest("SHA-256", msgUint8); // hash the message
	const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join(""); // convert bytes to hex string
	return hashHex;
}

//modal control
var rootEl = document.documentElement;
var $modals = getAll(".modal");
var $modalCloses = getAll(".modal-background, .modal-close, .modal-card-head .delete, .close");

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

function showToast(msg, onclick, color = "is-primary", timeout = 5000) {
	const toast = document.createElement("div");
	// If color is a hex code, set background color directly, else add as class
	if (/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color)) {
		toast.className = "notification";
		toast.style.backgroundColor = color;
		toast.style.color = HarmonyUtils.getBestTextColor(color);
	} else {
		toast.className = `notification ${color}`;
	}
	const baseTop = 0.5; // rem
	const stackOffset = toastStackHeight * 3; // 4rem per toast
	toast.style.position = "absolute";
	toast.style.left = "50%";
	toast.style.top = `calc(${baseTop}rem + ${stackOffset}rem)`;
	toast.style.transform = "translate(-50%, -100%)";
	toast.style.transition = "transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s";
	toast.style.zIndex = 9999;
	toast.style.minWidth = "20px";

	// Helper function for closing and animating toast
	function closeToast() {
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
	}

	toast.innerHTML = `
		${DOMPurify.sanitize(msg)}<button class="toastClose ml-2 mr-1"><span class="icon is-small">
      <i class="fas fa-xmark"></i>
    </span></button>
	`;
	toast.querySelector(".toastClose").onclick = () => {
		closeToast();
	};

	if (typeof onclick == "function") {
		toast.classList.add("is-clickable");
		toast.addEventListener("click", function (e) {
			// Prevent click on close button from triggering onclick
			if (e.target.closest(".toastClose")) return;
			onclick(e);
			closeToast();
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
		//check if toast already gone
		if (!toast || toast.style.opacity == 0) {
			return;
		}
		closeToast();
	}, timeout);
}

// Utility class for helper functions
class HarmonyUtils {
	static isPasswordComplex(pwd) {
		// At least 8 chars
		return typeof pwd === "string" && pwd.length >= 8;
	}

	static removeClassFromAll(selector, className) {
		document.querySelectorAll(selector).forEach((el) => el.classList.remove(className));
	}

	static removeAllChildren(parent, selector, exceptId) {
		parent.querySelectorAll(selector).forEach((item) => {
			if (!exceptId || item.id !== exceptId) item.remove();
		});
	}

	static populateFriendsList(container, friends, clickHandler) {
		friends.forEach((friend) => {
			const friendDiv = document.createElement("div");
			friendDiv.className = "friend-item";
			friendDiv.setAttribute("name", DOMPurify.sanitize(friend.id));
			friendDiv.textContent = DOMPurify.sanitize(friend.nick ? `${friend.nick} (${friend.name})` : friend.name);
			friendDiv.addEventListener("click", FriendsManager.selectFriend, true);
			container.appendChild(friendDiv);
		});
	}

	static getSelectedDevice(selectId, devices) {
		const select = document.getElementById(selectId);
		const deviceId = select.value;
		return devices.find((d) => d.deviceId === deviceId) || null;
	}

	static getBestTextColor(hexColor) {
		const hex = hexColor.replace(/^#/, "");
		let r, g, b;
		if (hex.length === 3) {
			r = parseInt(hex[0] + hex[0], 16);
			g = parseInt(hex[1] + hex[1], 16);
			b = parseInt(hex[2] + hex[2], 16);
		} else if (hex.length === 6) {
			r = parseInt(hex.substring(0, 2), 16);
			g = parseInt(hex.substring(2, 4), 16);
			b = parseInt(hex.substring(4, 6), 16);
		} else {
			return "#000000";
		}
		const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
		return luminance > 0.5 ? "#000000" : "#ffffff";
	}
}

// FriendsManager class for all friends-related logic
class FriendsManager {
	static selectFriend(e) {
		let el = e.target || e;
		if (el.id == "friends-header" || el.classList.contains("friends-menu-item") || el.classList.contains("no-fire")) {
			return;
		}
		//stop icons from tweaking out
		if (el.tagName.toLowerCase() != "div") {
			if (el.parentElement) {
				el.parentElement.dispatchEvent(new Event("click", { bubbles: true }));
			}
			return;
		}
		// If selectedServer is not "HARMONY-FRIENDS-LIST", select it first
		if (selectedServer !== "HARMONY-FRIENDS-LIST") {
			const friendsListBtn = document.querySelector('.server-item[name="HARMONY-FRIENDS-LIST"]');
			if (friendsListBtn) {
				friendsListBtn.dispatchEvent(new Event("click", { bubbles: true }));
			}
		}
		// Remove 'selected' class from all friend items except the clicked one
		document.querySelectorAll(".friend-item.selected").forEach((item) => {
			if (item !== el) {
				item.classList.remove("selected");
			}
		});
		// Add 'selected' class to the clicked friend item
		el.classList.add("selected");
		selectedFriend = el.getAttribute("name");
		let privFriend = localPrefs.friends.find((f) => f.id == selectedFriend);
		if (privFriend && privFriend.chat) {
			chatManager.displayChat(privFriend.chat);
		} else {
			console.log("Error finding friend chat for ", selectedFriend);
		}
	}

	static showFriendRequests() {
		//if selectedServer is not "HARMONY-FRIENDS-LIST", select it first
		if (selectedServer !== "HARMONY-FRIENDS-LIST") {
			const friendsListBtn = document.querySelector('.server-item[name="HARMONY-FRIENDS-LIST"]');
			if (friendsListBtn) {
				friendsListBtn.dispatchEvent(new Event("click", { bubbles: true }));
			}
		}
		// Remove 'selected' class from all friend items except the clicked one
		document.querySelectorAll(".friend-item.selected").forEach((item) => {
			item.classList.remove("selected");
		});
		HarmonyUtils.removeClassFromAll(".friends-menu-item > i", "active");
		document.getElementById("friendRequestsViewBtn").classList.add("active");
		const friendsContainer = document.getElementById("friends");
		HarmonyUtils.removeAllChildren(friendsContainer, ".friend-item", "friends-header");
		HarmonyUtils.removeAllChildren(friendsContainer, ".friend-request-item");

		var requests = Array.isArray(friendReqs.incoming) ? friendReqs.incoming : [];
		//filter removal requests
		requests = requests.filter((r) => r.status !== "remove");
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
					name: req.fromName,
					id: req.from,
					chat: req.chat,
				});
				showToast(`${DOMPurify.sanitize(req.fromName)} Is Now Your Friend!`, FriendsManager.showFriends);
				window.electronAPI.updatePrefs(localPrefs);
			};
			reqDiv.querySelector(".reject-friend-request").onclick = () => {
				req.status = "rejected";
				socket.emit("friendRequestResponse", req);
				reqDiv.remove();
				friendReqs.incoming = friendReqs.incoming.filter((r) => r.id !== req.id);
				showToast(`Removed Friend Request`);
			};
			friendsContainer.appendChild(reqDiv);
		});

		var outgoingReqs = Array.isArray(friendReqs.outgoing) ? friendReqs.outgoing : [];

		outgoingReqs = outgoingReqs.filter((r) => r.status !== "remove");
		if (outgoingReqs.length > 0) {
			const outgoingDiv = document.createElement("div");
			outgoingDiv.className = "friend-request-item has-background-grey-dark has-text-white";
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
			reqDiv.setAttribute("reqTo", DOMPurify.sanitize(req.to));
			reqDiv.querySelector(".reject-friend-request").onclick = () => {
				socket.emit("cancelFriendRequest", req);
				reqDiv.remove();
				friendReqs.outgoing = friendReqs.outgoing.filter((r) => r.to !== req.to);
				showToast(`Cancelled Friend Request`);
			};
			friendsContainer.appendChild(reqDiv);
		});
	}

	static showFriends(e) {
		HarmonyUtils.removeClassFromAll(".friends-menu-item > i", "active");
		document.getElementById("friendsViewBtn").classList.add("active");

		const friendsContainer = document.getElementById("friends");
		HarmonyUtils.removeAllChildren(friendsContainer, ".friend-request-item");
		HarmonyUtils.removeAllChildren(friendsContainer, ".friend-item", "friends-header");

		if (localPrefs && Array.isArray(localPrefs.friends)) {
			HarmonyUtils.populateFriendsList(friendsContainer, localPrefs.friends, FriendsManager.selectFriend);
			//add selected class to the first friend or selectedFriend

			const selectedDiv = friendsContainer.querySelector(`.friend-item[name="${selectedFriend}"]`);
			if (selectedFriend && selectedDiv) {
				selectedDiv.dispatchEvent(new Event("click", { bubbles: true }));
			} else if (friendsContainer.firstChild) {
				friendsContainer.firstChild.dispatchEvent(new Event("click", { bubbles: true }));
			}
		}
	}

	static sendFriendReq(userId) {
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
		const uuidv4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		if (!uuidv4Regex.test(userId)) {
			showToast("Invalid User ID (must be UUIDv4)");
			return;
		}

		console.log("sending fr for ", userId);
		//update ui for loading
		socket.emit("friendRequest", userId, (data) => {
			if (data.status == "add") {
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

	//ran once on startup to check for friend requests, also registers socket listeners
	static checkFriendReqs() {
		socket.on("friendRequestResponse", (request) => {
			if (request.from != selfId) {
				//got a response from a request we did not send, probably a cancellation
				if (request.status == "cancelled" && request.to == selfId) {
					//remove from incoming
					friendReqs.incoming = friendReqs.incoming.filter((r) => r.chat != request.chat && r.from != request.from);
					//update ui
					let reqDiv = document.querySelector(`.friend-request-item[reqFrom="${request.from}"]`);
					if (reqDiv) {
						reqDiv.remove();
					}
				}
				return;
			}
			//else outgoing req
			if (request.status == "accepted") {
				localPrefs.friends.push({
					name: request.toName,
					id: request.to,
					chat: request.chat,
				});
				window.electronAPI.updatePrefs(localPrefs);
				showToast(`${DOMPurify.sanitize(request.toName)} Is Now Your Friend!`);
			} else {
			}
			//update friend requests
			let reqDiv = document.querySelector(`.friend-request-item[reqTo="${request.to}"]`);
			if (reqDiv) {
				reqDiv.remove();
			}
			//remove our acked friend request from friendReqs.outgoing
			if (friendReqs.outgoing) {
				friendReqs.outgoing = friendReqs.outgoing.filter((r) => r.to != request.to);
			}
		});

		socket.on("friendRequest", (request) => {
			//got a friend request
			console.log("got friend request", request);
			if (request.from != selfId && request.to == selfId) {
				// check if status = remove
				if (request.status === "remove") {
					// Remove from local friends and ack removal
					this.removeFriend(request.from);
					// Remove from incoming requests
					friendReqs.incoming = friendReqs.incoming.filter((r) => r.from != request.from);
					return;
				}

				//add to global friendReqs.incoming
				if (!friendReqs.incoming) friendReqs.incoming = [];
				//check if we already have this request
				let existingReq = friendReqs.incoming.filter((r) => r.from == request.from);
				if (existingReq.length == 0) {
					friendReqs.incoming.push(request);
				} else {
					console.warn("Already have this request");
					return;
				}
				showToast(`${DOMPurify.sanitize(request.fromName)} Sent You a Friend Request`, this.showFriendRequests);
			}
		});

		socket.on("friendRemove", (request) => {
			//got a friend removal request
			console.log("got friend removal request", request);
			if (request.from != selfId && request.to == selfId) {
				// Remove from local friends and ack removal
				this.removeFriend(request.from);
				// Remove from incoming requests
				friendReqs.incoming = friendReqs.incoming.filter((r) => r.from != request.from);
			}
		});

		socket.emit("checkFriendReqs", ({ incoming, outgoing }) => {
			console.log(incoming, outgoing);

			// if any accepted outgoing requests are not in localPrefs.friends, add them
			outgoing.forEach((req) => {
				if (req.status === "accepted") {
					const existingFriend = localPrefs.friends.find((f) => f.id === req.to);
					if (!existingFriend) {
						localPrefs.friends.push({
							name: req.toName,
							id: req.to,
							chat: req.chat,
						});
					}
				} else if (req.status === "rejected") {
					// Remove from local friends if rejected (shouldnt happen)
					localPrefs.friends = localPrefs.friends.filter((f) => f.id !== req.to);
				}
			});
			//remove all reqs that were just accepted/rejected from outgoing
			outgoing = outgoing.filter((r) => {
				return r.status !== "accepted" && r.status !== "rejected";
			});

			//if any incoming request is a removal, run removeFriend on it
			incoming = incoming.filter((r) => {
				if (r.status === "remove") {
					this.removeFriend(r.from);
					return false; // filter out removal requests
				}
				return true; // keep other requests
			});
			outgoing = outgoing.filter((r) => {
				return r.status !== "remove";
			});

			//update local prefs
			window.electronAPI.updatePrefs(localPrefs);
			//store to global friendReqs
			friendReqs.incoming = incoming;
			friendReqs.outgoing = outgoing;
		});
	}

	//removes friend from local and emits to server to either ack or send removal
	static removeFriend(userId, callback = null) {
		if (!userId || userId === selfId) {
			console.warn("Failed to remove friend: Invalid user ID to remove.");
			return;
		}
		// Remove from localPrefs.friends
		const friendIndex = localPrefs.friends.findIndex((f) => f.id === userId);
		//update ui
		const friendDiv = document.querySelector(`.friend-item[name="${userId}"]`);
		if (friendDiv) {
			friendDiv.remove();
		} else {
			console.warn(`Failed to remove friend: Friend not found in UI. ${userId}`);
		}

		// If not found, log a warning before acking the removal
		if (friendIndex === -1) {
			console.warn("Failed to remove friend from localprefs: Friend not found.");
		} else {
			localPrefs.friends.splice(friendIndex, 1);
			window.electronAPI.updatePrefs(localPrefs);
		}

		socket.emit("removeFriend", userId, (res) => {
			if (res.success) {
				if (typeof callback === "function") callback();
			} else {
				console.warn(`Failed to remove friend: ${res.error}`);
			}
		});
	}
}
// Contains all methods for interacting with or managing chat functionality
class chatManager {
	static MAXMSGCHARS = 999;
	// attatch event listeners for text input
	static chatInit() {
		let textarea = document.getElementById("chat-input");
		textarea.style.height = textarea.scrollHeight + "px";
		textarea.style.overflowY = "hidden";
		textarea.value = "";

		textarea.addEventListener("input", function () {
			//set height according to text input
			this.style.height = "auto";
			this.style.height = this.scrollHeight + "px";
			if (this.scrollHeight > 300) {
				textarea.style.overflowY = "auto";
			} else {
				textarea.style.overflowY = "hidden";
			}
			if (this.value.length > this.MAXMSGCHARS) {
				//TODO show warning that this message will not be stored on server
			}
		});
	}

	// Sanitizes chat content and sends to peers, server (if enabled), and stores in local storage
	static sendChat(content) {
		if (!content || content.trim() === "" || content.length > 1000) {
			showToast("Invalid message content. Must be non-empty and less than 1000 characters.");
			return;
		}
		//BIG ASSUMPTION THAT WE ONLY SEND CHAT FROM CURRENTCHAT
		const msg = {
			timestamp: Date.now(),
			user: selfId,
			username: localPrefs.user.username,
			content: content,
			channel: currentChat,
			type: "text",
			color: localPrefs.settings.accentColor,
		};
		if (!msg || !msg.user || !msg.content) {
			// showToast("Bad message!");
			return;
		}
		this.updateChat(msg);
		this.storeChat(msg);
		rtc.sendMessage(msg, currentChat);

		// Check if currentChat is a server chat and if serverStoredMessaging is enabled
		let server = null;
		if (currentChat) {
			const secret = currentChat.split(":")[1];
			server = localPrefs.servers && localPrefs.servers.find((s) => s.secret === secret);
		}
		if (server && server.options && server.options.serverStoredMessaging) {
			socket.emit("serverMessage", server.id, msg, (serverResponse) => {
				if (serverResponse.success) {
					console.log("Message stored on server:", serverResponse);
				} else {
					console.error("Failed to store message on server:", serverResponse.error);
				}
			});
		}
	}

	// Handles incoming chat messages: updates userCache if dirty, appends to UI, stores to localStorage, and shows toast if needed
	static rcvChat(msg) {
		let channel = msg.channel;

		// Track user data
		if (msg.user && msg.username) {
			if (userCache[msg.user].name !== msg.username) {
				userCache[msg.user].name = msg.username;
				saveUserCache();
			}
			// If msg.user is in our friends, update prefs with new user name
			if (localPrefs.friends) {
				const friend = localPrefs.friends.find((f) => f.id === msg.user);
				if (friend && msg.username && friend.name !== msg.username) {
					friend.name = msg.username;
					window.electronAPI.updatePrefs(localPrefs);
				}
			}
		}

		if (channel == currentChat) {
			this.updateChat(msg);
		} else {
			const server = localPrefs.servers.find((s) => s.secret === channel.split(":")[1]);
			const user = userLookup(msg.user);
			if (server) {
				showToast(
					`${user.nick ? user.nick : user.name} sent you a message on ${server.name}`,
					() => {
						const sovoBtn = document.querySelector(`.server-item[name="${server.id}"]`);
						if (sovoBtn) {
							sovoBtn.dispatchEvent(new Event("click", { bubbles: true }));
						}
					},
					msg.color ? msg.color : "is-primary"
				);
			} else {
				showToast(
					`${user.nick ? user.nick : user.name} sent you a message`,
					() => {
						if (selectedServer != "HARMONY-FRIENDS-LIST") {
							//select friends server, then friend itself
							const friendsListBtn = document.querySelector('.server-item[name="HARMONY-FRIENDS-LIST"]');
							if (friendsListBtn) {
								friendsListBtn.dispatchEvent(new Event("click", { bubbles: true }));
							}
							// Find the friend and select them
							const friend = localPrefs.friends.find((f) => f.id === msg.user);
							if (friend) {
								const friendDiv = document.getElementsByName(friend.id)[0];
								if (friendDiv) {
									friendDiv.dispatchEvent(new Event("click", { bubbles: true }));
								}
							}
						}
					},
					msg.color ? msg.color : "is-primary"
				);
			}
		}
		this.storeChat(msg);
	}

	// Updates main chat display with the given chatId
	static displayChat(chatId) {
		if (!chatId) {
			document.getElementById("chat-messages").innerHTML = "";
			return;
		}
		if (currentChat == chatId) {
			return;
		}
		//get serverId from chatId
		//get messages from browser
		if (!chatId.startsWith("chat:")) {
			currentChat = `chat:${chatId}`;
		} else {
			currentChat = chatId;
		}
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
		//clear chat and set all messages (horrible TODO)
		document.getElementById("chat-messages").innerHTML = "";
		messages.forEach((msg) => {
			this.updateChat(msg);
		});
		//connect to chat rtc
		// rtc.joinChannel(currentChat);
	}

	// Adds a message to the chat UI after sanitizing it
	static updateChat(msg) {
		//add msg to chat
		if (!msg || !msg.user || !msg.content) {
			// showToast("Bad message!");
			return;
		}
		// Remove all id attributes and sanitize from msg.content
		const content = DOMPurify.sanitize(msg.content);

		let el = document.createElement("div");
		let un = document.createElement("span");
		un.className = "tag";
		el.classList.add("chatLine");
		if (msg.color) {
			un.style.backgroundColor = msg.color;
			un.style.color = HarmonyUtils.getBestTextColor(msg.color);
		} else if (msg.user == selfId) {
			un.classList.add("is-primary");
		}
		if (msg.user == selfId) {
			el.style = "text-align: end;";
		}

		let sender = userLookup(msg.user);
		un.innerText = DOMPurify.sanitize(
			sender.nick != "" && sender.nick != undefined ? `${sender.nick} (${sender.name})` : sender.name
		);
		un.setAttribute("data-user-id", msg.user);
		un.setAttribute("data-timestamp", msg.timestamp);
		el.appendChild(un);
		el.appendChild(document.createElement("br"));
		let contentDiv = document.createElement("div");
		contentDiv.classList.add("selectable", "chatContent");
		contentDiv.innerHTML = content;
		const codeBlocks = contentDiv.querySelectorAll("pre code");
		codeBlocks.forEach((block) => {
			hljs.highlightElement(block);
		});
		el.appendChild(contentDiv);

		if (msg.user != selfId) {
			// Add click handler to open user popup
			un.classList.add("is-clickable");
			un.addEventListener("click", function (e) {
				e.stopPropagation();
				manageChatUser(un);
			});
			//right click listener
			un.addEventListener("contextmenu", function (e) {
				e.stopPropagation();
				manageChatUser(un);
			});
		}

		document.getElementById("chat-messages").appendChild(el);
		// Auto-scroll to bottom
		const chatMessages = document.getElementById("chat-messages");
		chatMessages.scrollTop = chatMessages.scrollHeight;
	}

	// Stores a chat message in local storage
	static storeChat(msg) {
		//TODO THIS IS KINDA BLOATED
		//adds message to respective chat and stores it
		const key = msg.channel;
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
				arr.findIndex((x) => x.timestamp === m.timestamp && x.user === m.user && x.content === m.content) === i
		);

		//constrain to less than localprefs maxMsgHistory
		if (localPrefs && messages.length > localPrefs.settings.maxMsgHistory) {
			messages = messages.slice(-localPrefs.settings.maxMsgHistory);
		}

		localStorage.setItem(key, JSON.stringify(messages));
	}
}

// Load userCache from localStorage on startup
function loadUserCache() {
	try {
		const stored = localStorage.getItem("userCache");
		userCache = stored ? JSON.parse(stored) : {};
	} catch (e) {
		if ((Object.keys(userCache).length = 0)) {
			userCache = {};
		}
	}
}

// Save userCache to localStorage only if dirty
function saveUserCache() {
	localStorage.setItem("userCache", JSON.stringify(userCache));
}
