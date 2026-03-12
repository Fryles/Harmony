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
	dev: true,
};
//for dev rn
window.harmony = harmony;
const dev = harmony.dev;
if (dev) {
	harmony.host = "http://localhost:3000";
} else {
	harmony.host = "https://harmony-minv.onrender.com";
}

init();

async function init() {
	userUtils.loadUserCache();

	//set local prefs from disk
	harmony.localPrefs = await window.electronAPI.getPrefs();

	if (
		!harmony.localPrefs ||
		!harmony.localPrefs.user ||
		!harmony.localPrefs.user.userId ||
		!harmony.localPrefs.user.secret
	) {
		console.log("missing harmony.localprefs info");

		//We rly cant do much without an account, open sign up modal
		uiManager.openModal("register-modal");
		if (harmony.localPrefs.user) {
			document.getElementById("registerUsername").value = harmony.localPrefs.user.username;
		}

		// Hide settings-delete and settings-close elements
		const del = document.getElementById("register-delete");
		if (del) del.style.display = "none";
		const close = document.getElementById("register-close");
		if (close) close.style.display = "none";
		document.getElementById("register-submit").addEventListener("click", async () => {
			//attempt to register in storePrefs, which will validate inputs and post to server, then if successful, close modal and load prefs.
			if (await storePrefs(true)) {
				uiManager.closeModals(); //close register modal and unhide close/delete buttons
				if (close) {
					close.style.display = "block";
				}
				if (del) {
					del.style.display = "block";
				}
				// recurse into init, to try loading registered prefs + session
				init();
				uiManager.showToast("Registered account");
			} else {
				console.warn("saving prefs failed in storePrefs()");
			}
		});
		return;
	} else {
		console.log("Loaded local preferences:", harmony.localPrefs);
	}

	harmony.selfId = harmony.localPrefs.user.userId;

	//init socket connection, this will ensure sessions is set
	await webSocketInit();

	// fetch turn credenials to pass to rtc interface
	try {
		const response = await fetch(`${harmony.host}/turn-credentials`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${localStorage.getItem("session")}`,
			},
			body: JSON.stringify({ userId: harmony.selfId }),
		});
		console.log(response);

		const data = await response.json();
		if (response.ok) {
			// TODO handle TTL
			console.log("got turn creds: ", data);
			if (typeof data.iceservers == "object") {
				data.iceServers = [data.iceservers]; // when sending one item from server, sometimes array is stripped
			}
			harmony.rtc = new rtcInterface(data.iceServers);
		} else {
			throw new Error(data.error || "Failed to fetch TURN credentials");
		}
	} catch (error) {
		console.error("Failed to fetch TURN credentials:", error);

		// Initialize RTC interface with empty ICE servers to allow local connections, but warn user that remote connections may fail
		harmony.rtc = new rtcInterface();
		uiManager.showToast("Warning: Failed to fetch TURN credentials, remote connections may fail", null, "is-warning");
	}

	if (!harmony.localPrefs.user.secret) {
		//bro what
		alert("idk how but u never set a password.");
	}

	// ====== Initialization Functions ======

	const initServerList = () => {
		const updateServerItems = () => {
			document.querySelectorAll(".server-item").forEach((div) => {
				// left click
				div.removeEventListener("click", uiManager.selectServerItem, true);
				div.addEventListener("click", uiManager.selectServerItem, true);
				// right click (contextmenu)
				div.removeEventListener("contextmenu", uiManager.manageServerItem, true);
				div.addEventListener("contextmenu", uiManager.manageServerItem, true);
				// select selected server...
				div.classList.toggle("selected", div.getAttribute("name") === harmony.selectedServer);
			});
		};
		updateServerItems(); // run once for existing elements
		const serverListEl = document.getElementById("server-list");
		if (serverListEl) {
			const observer = new MutationObserver(updateServerItems);
			observer.observe(serverListEl, { subtree: true, childList: true });
		}
	};

	const setupFriendManageButton = (div, friend) => {
		if (div.querySelector(".icon")) return; // already has manage btn
		let manageBtn = document.createElement("span");
		manageBtn.className = "icon mx-1";
		manageBtn.innerHTML = "<i class='fas fa-xl fa-cog'></i>";
		manageBtn.onclick = (e) => {
			e.stopPropagation();
			document.getElementById("friendManageIdInput").value = friend.id;
			document.getElementById("friendNickInput").value = friend.nick || "";
			document.getElementById("friendNameInput").value = friend.name || "";
			uiManager.openModal("manage-friend-modal");
			document.getElementById("manage-friend-remove").onclick = () => {
				FriendsManager.removeFriend(friend.id, () => {
					uiManager.showToast(`Removed ${friend.name} from friends`);
				});
				div.remove();
				uiManager.closeModals();
			};
			document.getElementById("manage-friend-save").onclick = () => {
				friend.nick = document.getElementById("friendNickInput").value;
				friend.name = document.getElementById("friendNameInput").value;
				window.electronAPI.updatePrefs(harmony.localPrefs);

				div.innerHTML = DOMPurify.sanitize(friend.nick ? `${friend.nick} (${friend.name})` : friend.name);
				div.appendChild(manageBtn);
				div.setAttribute("name", friend.id);
				div.addEventListener("click", FriendsManager.selectFriend, true);

				uiManager.closeModals();
			};
		};

		div.appendChild(manageBtn);
	};

	const initFriendList = () => {
		const updateFriendItems = () => {
			if (!harmony.localPrefs.friends) return;

			// select first friend if none selected
			if (!harmony.selectedFriend && harmony.localPrefs.friends.length > 0) {
				const firstFriendDiv = document.getElementsByName(harmony.localPrefs.friends[0].id)[0];
				if (firstFriendDiv) FriendsManager.selectFriend(firstFriendDiv);
			}

			document.querySelectorAll(".friend-item").forEach((div) => {
				div.removeEventListener("click", FriendsManager.selectFriend, true);
				div.addEventListener("click", FriendsManager.selectFriend, true);

				const friend = harmony.localPrefs.friends.find((f) => f.id === div.getAttribute("name"));
				if (friend) setupFriendManageButton(div, friend);
			});
		};

		updateFriendItems();

		const friendsEl = document.getElementById("friends");
		if (friendsEl) {
			const observer = new MutationObserver(updateFriendItems);
			observer.observe(friendsEl, { subtree: true, childList: true });
		}
	};

	const initSettingsAndModals = () => {
		chatManager.chatInit();
		uiManager.attachGlobalHandlers();

		document.getElementById("settings-save").addEventListener("click", async () => {
			if (await storePrefs()) {
				uiManager.closeModals();
				uiManager.showToast("Saved Preferences");
			} else console.warn("saving prefs failed in storePrefs()");
		});

		document.getElementById("add-server").addEventListener("click", registerServer);
		document.getElementById("join-server").addEventListener("click", () => {
			const name = document.getElementById("joinServerNameInput").value;
			const pwd = document.getElementById("joinServerPasswordInput").value;
			addServer(name, pwd);
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
	};

	// ====== Run Initialization ======
	initSettingsAndModals();
	initServerList();
	initFriendList();

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
	}, 30 * 1000); // 30 seconds

	//check friend reqs
	FriendsManager.showFriends();
	FriendsManager.checkFriendReqs();
}

async function webSocketInit() {
	//get session
	const session = localStorage.getItem("session");
	if (session === "undefined" || session === "null" || session === "") {
		localStorage.removeItem("session");
		console.log("Removing invalid session from localStorage");
	}
	const sessionExpiresOn = localStorage.getItem("sessionExpiresOn");
	if (session && sessionExpiresOn && Date.now() > parseInt(sessionExpiresOn)) {
		// Session expired, remove it
		localStorage.removeItem("session");
		localStorage.removeItem("sessionExpiresOn");
		console.log("Session expired, will attempt to log in again.");
	}
	// no session but have user creds, try to log in and get session
	if (!session && harmony.localPrefs.user.secret) {
		//post to login endpoint to get session, then store in localStorage
		console.log("No session found, logging in with server...");
		const response = await fetch(`${harmony.host}/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				id: harmony.selfId || harmony.localPrefs.user.userId,
				name: harmony.localPrefs.user.username,
				secret: harmony.localPrefs.user.secret,
			}),
		});
		if (!response.ok) {
			const err = await response.json();
			throw new Error(err.error || "Login failed");
		}
		const data = await response.json();
		console.log("Logged in, session:", data);
		localStorage.setItem("session", data.session);
		localStorage.setItem("sessionExpiresOn", data.sessionExpiresOn);
	}
	const auth = {
		userId: harmony.selfId,
		userName: harmony.localPrefs.user.username,
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

	if ((pwd === "" || !pwd || pwd.trim() === "") && !options.serverOpen) {
		//empty pwd with non-open server
		uiManager.showToast("A Closed Server Must Have a Password");
		return;
	}
	let options = {
		serverOpen: document.getElementById("serverOpen").checked,
		serverUnlisted: document.getElementById("serverUnlisted").checked,
		serverStoredMessaging: document.getElementById("serverStoredMessaging").checked,
	};
	// Password complexity check for closed servers
	if (!options.serverOpen && !HarmonyUtils.isPasswordComplex(pwd)) {
		uiManager.showToast("Password must be at least 8 characters.");
		return;
	}

	const secret = await hashbrown(`${id}:${pwd}`);

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

			// Add server to prefs and update

			uiManager.closeModals();
			//clear add server modal inputs
			document.getElementById("serverNameInput").value = "";
			document.getElementById("serverPasswordInput").value = "";

			uiManager.showToast(`Created Server: ${res.server.name}`);
			window.electronAPI.updatePrefs(harmony.localPrefs);
			//now try to auth with the new server and join it
			addServer(name, pwd, false);
		} else {
			if (res.error) {
				uiManager.showToast(res.error);
				console.error("Failed to register server:", res.error);
				return;
			}
		}
	});
}

//called in join/add server modal to attempt to find id from server name, then authenticate with the server and add to ui
function addServer(name, pwd, showNotif = true) {
	if (!name || name.trim() === "") {
		name = document.getElementById("joinServerNameInput").value;
		if (!name || name.trim() === "") {
			uiManager.showToast("Server name cannot be empty.");
			return;
		}
	}

	//query server exact to get id (could be real or fake)
	window.socket.emit("serverQuery", name, true, async (res) => {
		res = res[0];
		if (!res.id) {
			uiManager.showToast(`Failed to join ${name}`, null, "is-danger");
		}

		const secret = await hashbrown(`${res.id}:${pwd}`);
		window.socket.emit("serverAuth", name, res.id, secret, (res) => {
			if (res) {
				// good auth, add server to prefs and connect
				if (!harmony.localPrefs.servers) harmony.localPrefs.servers = [];
				//if we already have this server, delete before re-adding

				let existing = harmony.localPrefs.servers.find((f) => f.id == res.id);
				if (existing) {
					harmony.localPrefs.servers = harmony.localPrefs.servers.filter((s) => s.id !== res.id);
				}
				harmony.localPrefs.servers.push(res);
				harmony.rtc.joinChannel(`chat:${res.secret}`);
				// Add server to UI before the "Add Server" button
				uiManager.insertServerToUI(res);
				// Show joined toast with click to switch to server
				if (showNotif) {
					uiManager.showToast(`Joined ${DOMPurify.sanitize(res.name)}`, () => {
						const serverItem = document.querySelector(`.server-item[name="${res.id}"]`);
						if (serverItem) {
							serverItem.dispatchEvent(new Event("click", { bubbles: true }));
						}
					});
				}
				// Update prefs and close modal
				uiManager.closeModals();
				window.electronAPI.updatePrefs(harmony.localPrefs);
			} else {
				console.error(`Failed to authenticate with server`, res);
				uiManager.showToast(`Failed to join ${name}`, null, "is-danger");
			}
		});
	});
}

// Validates then saves preferences to local and server for user/pass
async function storePrefs(registering = false) {
	// ensure localPrefs is up to date before saving
	harmony.localPrefs = await window.electronAPI.getPrefs();
	harmony.selfId = harmony.localPrefs.user.userId; //update selfId in case it changed with new prefs, which is used for hashing password and server auth, so important to be up to date. Mostly breaks when we first register and this isnt set initially
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
	const usernameEl = registering ? document.getElementById("registerUsername") : document.getElementById("username");
	if (!usernameEl.value) {
		validateField(usernameEl);
		uiManager.showToast("Username can't be empty dingus");
		return false;
	}
	if (usernameEl.value.length > 32) {
		validateField(usernameEl);
		uiManager.showToast("Username can't be longer than 32 chars");
		return false;
	}

	// validate password
	const passwordEl = registering ? document.getElementById("registerPassword") : document.getElementById("password");
	if (passwordEl.value && !HarmonyUtils.isPasswordComplex(passwordEl.value)) {
		validateField(passwordEl);
		uiManager.showToast("Password must be at least 8 characters.");
		return false;
	} else if (!passwordEl.value && !harmony.localPrefs.user.secret) {
		validateField(passwordEl);
		uiManager.showToast("You need to set a password to create an account");
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
	const newSecret =
		passwordEl.value ? await hashbrown(`${harmony.selfId}:${passwordEl.value}`) : harmony.localPrefs.user.secret;

	// flag var to see if we need to tell server about changes
	const userChanged =
		(newSecret && harmony.localPrefs.user.secret !== newSecret) ||
		harmony.localPrefs.user.username !== usernameEl.value;

	if (userChanged && !registering) {
		// try to reach server with new info
		if (harmony.rtc) {
			// wrap socket emit in a promise so storePrefs can await it
			return new Promise((resolve) => {
				window.socket.emit(
					"setUser",
					{
						id: harmony.selfId,
						name: usernameEl.value,
						oldSecret: harmony.localPrefs.user.secret,
						newSecret: newSecret,
					},
					(res) => {
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
					},
				);
			});
		} else {
			// no server connection, reject updates
			uiManager.showToast("Can't update username or password without server connection");
			return false;
		}
	} else if (registering) {
		// post to server
		try {
			const response = await fetch(`${harmony.host}/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: harmony.selfId,
					name: usernameEl.value,
					secret: newSecret,
				}),
			});

			if (!response.ok) {
				const err = await response.json();
				throw new Error(err.error || "Registration failed");
			} else {
				harmony.localPrefs.user.username = usernameEl.value;
				harmony.localPrefs.user.secret = newSecret;
				window.electronAPI.updatePrefs(harmony.localPrefs);
				window.electronAPI.loadPrefs(harmony.localPrefs);
				const data = await response.json();
				console.log("Registered:", data);
				localStorage.setItem("session", data.session);
				localStorage.setItem("sessionExpiresOn", data.sessionExpiresOn);
				uiManager.closeModals();
				return true;
			}
		} catch (err) {
			console.error(err);
			uiManager.showToast(err.message || "Registration failed");
			return false;
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

//hash password to hex str, this is stored in plaintext on server, but hashed on server with argon2 and a pepper, so this is just to avoid sending plaintext pw over the wire and to add some obfuscation
async function hashbrown(pwd) {
	const msgUint8 = new TextEncoder().encode(pwd); // encode as (utf-8) Uint8Array
	const hashBuffer = await window.crypto.subtle.digest("SHA-256", msgUint8); // hash the message
	const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join(""); // convert bytes to hex string
	return hashHex;
}
