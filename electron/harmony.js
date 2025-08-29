// Globals for app
import { HarmonyUtils, FriendsManager, chatManager, userUtils, uiManager } from "./harmony-lib.js";
window.chatManager = chatManager; //expose for by HTML elements
window.FriendsManager = FriendsManager;
import rtcInterface from "./rtc.js";
export const harmony = {
	// shared "globals"
	selectedServer: "HARMONY-FRIENDS-LIST",
	selectedFriend: null,
	currentChat: null,
	localPrefs: null,
	friendReqs: { incoming: [], outgoing: [] },
	selfId: null,
	rtc: null,
	dev: false,
};
//for dev rn
window.harmony = harmony;
const dev = harmony.dev;

init();

async function init() {
	userUtils.loadUserCache();

	//set local prefs
	harmony.localPrefs = await window.electronAPI.getPrefs();

	if (
		!harmony.localPrefs ||
		!harmony.localPrefs.user ||
		!harmony.localPrefs.user.userId ||
		!harmony.localPrefs.user.secret
	) {
		console.log("missing harmony.localprefs info, please enter");

		//We rly cant do much without local prefs, make sure settings is open and wait for now
		uiManager.openModal("settings-modal");
		// Hide settings-delete and settings-close elements
		const del = document.getElementById("settings-delete");
		if (del) del.style.display = "none";
		const close = document.getElementById("settings-close");
		if (close) close.style.display = "none";
		document.getElementById("settings-save").addEventListener("click", async () => {
			if (await storePrefs()) {
				uiManager.closeModals();
				location.reload();
			}
		});
		return;
	}
	harmony.selfId = harmony.localPrefs.user.userId;

	webSocketInit();
	harmony.rtc = new rtcInterface();
	if (!harmony.localPrefs.user.secret) {
		//bro what
		alert("idk how but u never set a password. please set one");
	}

	chatManager.chatInit(); //attathces input listeners for formatting and box expand
	uiManager.attachModalHandlers();
	document.getElementById("settings-save").addEventListener("click", async () => {
		if (await storePrefs()) {
			uiManager.closeModals();
			uiManager.showToast("Saved Preferences");
		} else {
			console.warn("saving prefs failed in storePrefs()");
		}
	});
	document.getElementById("add-server").addEventListener("click", () => {
		registerServer();
	});
	document.getElementById("join-server").addEventListener("click", () => {
		addServer();
	});
	document.getElementById("serverOpen").addEventListener("change", (e) => {
		const pwdInput = document.getElementById("serverPasswordInput");
		pwdInput.value = e.target.checked ? "" : pwdInput.value;
		pwdInput.disabled = e.target.checked;
	});
	document.getElementById("hotMicThresh").onchange = () => {
		harmony.rtc.hotMicThresh = parseFloat(document.getElementById("hotMicThresh").value);
	};
	document.getElementById("voice-mute").addEventListener("click", harmony.rtc.voiceMute);
	document.getElementById("voice-call").addEventListener("click", () => harmony.rtc.callVoice(harmony.currentChat));

	const serverListObserver = new MutationObserver(() => {
		document.querySelectorAll(".server-item").forEach((div) => {
			div.addEventListener("click", uiManager.selectServerItem, true);
			if (div.getAttribute("name") == harmony.selectedServer) {
				div.classList.add("selected");
			} else {
				div.classList.remove("selected");
			}
		});
	});
	serverListObserver.observe(document.getElementById("server-list"), {
		subtree: true,
		childList: true,
	});

	const friendsListObserver = new MutationObserver(() => {
		if (harmony.localPrefs.friends && harmony.localPrefs.friends.length > 0) {
			let firstFriend = document.getElementsByName(harmony.localPrefs.friends[0].id)[0];
			if (firstFriend && !harmony.selectedFriend) {
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
				let friend = harmony.localPrefs.friends.find((f) => f.id == friendId);
				if (friend) {
					document.getElementById("friendManageIdInput").value = friendId;
					document.getElementById("friendNickInput").value = friend.nick || "";
					document.getElementById("friendNameInput").value = friend.name || "";
					//open modal
					uiManager.openModal("manage-friend-modal");
					document.getElementById("manage-friend-remove").onclick = () => {
						FriendsManager.removeFriend(friendId, () => {
							uiManager.showToast(`Removed ${friend.name} from friends`);
						});
						//remove from ui
						div.remove();
						uiManager.closeModals();
					};
					document.getElementById("manage-friend-save").onclick = () => {
						friend.nick = document.getElementById("friendNickInput").value;
						friend.name = document.getElementById("friendNameInput").value;
						window.electronAPI.updatePrefs(harmony.localPrefs);
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
						uiManager.closeModals();
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

	// retrieve any stored messages on server for all chats that support it
	let since = localStorage.getItem("lastOnline") || Date.now() - 24 * 60 * 60 * 1000; // default to 24 hours ago if not set
	if (harmony.localPrefs && harmony.localPrefs.servers) {
		harmony.localPrefs.servers.forEach((server) => {
			if (server.options && server.options.serverStoredMessaging) {
				window.socket.emit("getServerMessages", server.id, since, (serverResponse) => {
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

function webSocketInit() {
	//get session
	const session = localStorage.getItem("session");
	const auth = {
		userId: harmony.selfId,
		userName: harmony.localPrefs.user.username,
		secret: harmony.localPrefs.user.secret,
		session: session,
	};
	//init websocket
	if (harmony.dev) {
		window.socket = io("ws://localhost:3000", {
			auth: auth,
		});
	} else {
		window.socket = io("https://harmony-minv.onrender.com/", {
			auth: auth,
		});
	}
	window.socket.on("connect_error", (err) => {
		if (err.message == "xhr poll error") {
			const now = Date.now();
			if (now - uiManager.lastLoopingToast > 5000) {
				uiManager.showToast("Disconnected from server");
				uiManager.lastLoopingToast = now;
			}
			return;
		} else if (err.message == "timeout") {
			const now = Date.now();
			if (now - uiManager.lastLoopingToast > 5000) {
				uiManager.showToast("Timeout when connecting to server");
				uiManager.lastLoopingToast = now;
			}
			return;
		} else {
			uiManager.showToast(err.message);
		}
	});
	window.socket.emit("ready");
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
		uiManager.showToast("A Closed Server Must Have a Password");
		return;
	}
	// Password complexity check for closed servers
	if (!options.serverOpen && !HarmonyUtils.isPasswordComplex(pwd)) {
		uiManager.showToast("Password must be at least 8 characters.");
		return;
	}

	if (name.length > 32 || name.length < 3) {
		uiManager.showToast("Server name is too long or too short.");
		return;
	}

	let sovo = {
		name: name,
		id: id,
		secret: secret,
		options: options,
	};
	window.socket.emit("registerServer", sovo, (res) => {
		if (res.success) {
			console.log(res);

			uiManager.showToast(`Created Server: ${res.server.name}`);
			// Add server to prefs and update
			if (!harmony.localPrefs.servers) harmony.localPrefs.servers = [];
			harmony.localPrefs.servers.push(res.server);
			// Add server to UI before the "Add Server" button
			uiManager.insertServerToUI(res.server);
			uiManager.closeModals();
			window.electronAPI.updatePrefs(harmony.localPrefs);
		} else {
			if (res.error) {
				uiManager.showToast(res.error);
			}
		}
	});
}

//called in add server modal to attempt to find id from server name, then authenticate with the server and add to ui
function addServer() {
	const name = document.getElementById("joinServerNameInput").value;
	const pwd = document.getElementById("joinServerPasswordInput").value;
	if (!name || name.trim() === "") {
		uiManager.showToast("Server name cannot be empty.");
		return;
	}

	//query server exact to get id (could be real or fake)
	window.socket.emit("serverQuery", name, true, async (res) => {
		res = res[0];
		if (!res.id) {
			uiManager.showToast(`Failed to join ${name}`, null, "is-danger");
		}
		const secret = await hashbrown(`server:${res.id}:${pwd}`);
		window.socket.emit("serverAuth", name, res.id, secret, (res) => {
			if (res) {
				// good auth, add server to prefs and connect
				if (!harmony.localPrefs.servers) harmony.localPrefs.servers = [];
				harmony.localPrefs.servers.push(res);
				harmony.rtc.joinChannel(`chat:${res.secret}`);
				// Add server to UI before the "Add Server" button
				uiManager.insertServerToUI(res);
				// Show joined toast with click to switch to server
				uiManager.showToast(`Joined ${DOMPurify.sanitize(res.name)}`, () => {
					const serverItem = document.querySelector(`.server-item[name="${res.id}"]`);
					if (serverItem) {
						serverItem.dispatchEvent(new Event("click", { bubbles: true }));
					}
				});
				// Update prefs and close modal
				uiManager.closeModals();
				window.electronAPI.updatePrefs(harmony.localPrefs);
			} else {
				uiManager.showToast(`Failed to join ${name}`, null, "is-danger");
			}
		});
	});
}

// Validates then saves preferences to local and server for user/pass
async function storePrefs() {
	harmony.localPrefs = await window.electronAPI.getPrefs();
	const getVal = (id) => document.getElementById(id).value;
	const getChk = (id) => document.getElementById(id).checked;

	// validate accent color
	const accentColorEl = document.getElementById("accentColor");
	if (!/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(accentColorEl.value)) {
		validateField(accentColorEl);
		uiManager.showToast(`${accentColorEl.value} is not a valid hex color code`);
		return false;
	}
	harmony.localPrefs.settings.accentColor = accentColorEl.value;
	harmony.localPrefs.settings.theme = getVal("theme");
	harmony.localPrefs.settings.notifications = getChk("notifications");

	// validate username
	const usernameEl = document.getElementById("username");
	if (!usernameEl.value) {
		validateField(usernameEl);
		uiManager.showToast("Username can't be empty dingus");
		return false;
	}
	if (usernameEl.value.length > 15) {
		validateField(usernameEl);
		uiManager.showToast("Username can't be longer than 15 chars");
		return false;
	}

	// validate password
	const passwordEl = document.getElementById("password");
	if (passwordEl.value && !HarmonyUtils.isPasswordComplex(passwordEl.value)) {
		validateField(passwordEl);
		uiManager.showToast("Password must be at least 8 characters.");
		return false;
	}

	// device + audio prefs
	["videoInputDevice", "audioInputDevice", "audioOutputDevice"].forEach((id) => {
		harmony.localPrefs.devices[id] = HarmonyUtils.getSelectedDevice(id, harmony.localPrefs.devices[id + "s"]);
	});
	["inputGain", "outputVolume", "hotMicThresh", "ringVolume"].forEach((id) => {
		harmony.localPrefs.audio[id] = parseFloat(getVal(id));
	});
	harmony.localPrefs.audio.enableNoiseSuppression = getChk("enableNoiseSuppression");

	// handle user/pass updates
	const newSecret = passwordEl.value
		? await hashbrown(`${harmony.selfId}:${passwordEl.value}`)
		: harmony.localPrefs.user.secret;

	const userChanged =
		(newSecret && harmony.localPrefs.user.secret !== newSecret) ||
		harmony.localPrefs.user.username !== usernameEl.value;

	if (userChanged) {
		if (harmony.rtc) {
			// wrap socket emit in a promise so storePrefs can await it
			return new Promise((resolve) => {
				window.socket.emit("setUser", { id: harmony.selfId, name: usernameEl.value, secret: newSecret }, (res) => {
					if (res.success) {
						harmony.localPrefs.user.username = usernameEl.value;
						harmony.localPrefs.user.secret = newSecret;
						window.electronAPI.updatePrefs(harmony.localPrefs);
						window.electronAPI.loadPrefs(harmony.localPrefs);
						resolve(true);
					} else {
						uiManager.showToast("Failed to update: " + res.error);
						resolve(false);
					}
				});
			});
		} else {
			// no server connection, update locally
			harmony.localPrefs.user.username = usernameEl.value;
			harmony.localPrefs.user.secret = newSecret;
			window.electronAPI.updatePrefs(harmony.localPrefs);
			window.electronAPI.loadPrefs(harmony.localPrefs);
			return true;
		}
	} else {
		// just update local prefs
		window.electronAPI.updatePrefs(harmony.localPrefs);
		window.electronAPI.loadPrefs(harmony.localPrefs);
		return true;
	}
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
