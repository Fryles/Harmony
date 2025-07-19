import { harmony } from "./harmony.js";
import { colorSliderWithAudio } from "./audiovis.js";

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

	static getRandomHexColor() {
		const hex = Math.floor(Math.random() * 0xffffff).toString(16);
		return `#${hex.padStart(6, "0")}`;
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
		// If harmony.selectedServer is not "HARMONY-FRIENDS-LIST", select it first
		if (harmony.selectedServer !== "HARMONY-FRIENDS-LIST") {
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
		harmony.selectedFriend = el.getAttribute("name");
		let privFriend = harmony.localPrefs.friends.find((f) => f.id == harmony.selectedFriend);
		if (privFriend && privFriend.chat) {
			chatManager.displayChat(privFriend.chat);
		} else {
			console.log("Error finding friend chat for ", harmony.selectedFriend);
		}
	}

	static showFriendRequests() {
		//if harmony.selectedServer is not "HARMONY-FRIENDS-LIST", select it first
		if (harmony.selectedServer !== "HARMONY-FRIENDS-LIST") {
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

		var requests = Array.isArray(harmony.friendReqs.incoming) ? harmony.friendReqs.incoming : [];
		//filter removal requests
		requests = requests.filter((r) => r.status !== "remove");
		if (requests.length === 0) {
			const noReq = document.createElement("div");
			noReq.className = "friend-request-item";
			noReq.textContent = "No pending friend requests.";
			friendsContainer.appendChild(noReq);
		}

		requests.forEach((req) => {
			if (req.from == harmony.selfId) return;
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
				harmony.friendReqs.incoming = harmony.friendReqs.incoming.filter((r) => r.id !== req.id);
				//add friend to local prefs
				harmony.localPrefs.friends.push({
					name: req.fromName,
					id: req.from,
					chat: req.chat,
				});
				uiManager.showToast(`${DOMPurify.sanitize(req.fromName)} Is Now Your Friend!`, FriendsManager.showFriends);
				window.electronAPI.updatePrefs(harmony.localPrefs);
			};
			reqDiv.querySelector(".reject-friend-request").onclick = () => {
				req.status = "rejected";
				socket.emit("friendRequestResponse", req);
				reqDiv.remove();
				harmony.friendReqs.incoming = harmony.friendReqs.incoming.filter((r) => r.id !== req.id);
				uiManager.showToast(`Removed Friend Request`);
			};
			friendsContainer.appendChild(reqDiv);
		});

		var outgoingReqs = Array.isArray(harmony.friendReqs.outgoing) ? harmony.friendReqs.outgoing : [];

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
				harmony.friendReqs.outgoing = harmony.friendReqs.outgoing.filter((r) => r.to !== req.to);
				uiManager.showToast(`Cancelled Friend Request`);
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

		if (harmony.localPrefs && Array.isArray(harmony.localPrefs.friends)) {
			HarmonyUtils.populateFriendsList(friendsContainer, harmony.localPrefs.friends, FriendsManager.selectFriend);
			//add selected class to the first friend or harmony.selectedFriend

			const selectedDiv = friendsContainer.querySelector(`.friend-item[name="${harmony.selectedFriend}"]`);
			if (harmony.selectedFriend && selectedDiv) {
				selectedDiv.dispatchEvent(new Event("click", { bubbles: true }));
			} else if (friendsContainer.firstChild) {
				friendsContainer.firstChild.dispatchEvent(new Event("click", { bubbles: true }));
			}
		}
	}

	static sendFriendReq(userId) {
		if (harmony.localPrefs.friends.filter((f) => f.id == userId).length > 0) {
			//already friends
			uiManager.showToast("Already Friends With This User");
			return;
		}
		if (harmony.friendReqs.outgoing.filter((r) => r.to == userId).length > 0) {
			//already sent req
			uiManager.showToast("Already Sent Request");
			return;
		}
		if (userId == harmony.selfId) {
			//can't send friend request to self
			uiManager.showToast("You ur own best fran og");
			return;
		}
		const uuidv4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
		if (!uuidv4Regex.test(userId)) {
			uiManager.showToast("Invalid User ID (must be UUIDv4)");
			return;
		}

		console.log("sending fr for ", userId);
		//update ui for loading
		socket.emit("friendRequest", userId, (data) => {
			if (data.status == "add") {
				console.log(data);
				//check if we already have this request
				let existingReq = harmony.friendReqs.outgoing.filter((r) => r.to == userId);
				if (existingReq.length == 0) {
					harmony.friendReqs.outgoing.push(data);
				} else {
					console.warn("Already have this request");
				}
			}
		});
		uiManager.closeModals();
		uiManager.showToast("Sent Friend Request");
		document.getElementById("friendIdInput").value = "";
	}

	//ran once on startup to check for friend requests, also registers socket listeners
	static checkFriendReqs() {
		socket.on("friendRequestResponse", (request) => {
			if (request.from != harmony.selfId) {
				//got a response from a request we did not send, probably a cancellation
				if (request.status == "cancelled" && request.to == harmony.selfId) {
					//remove from incoming
					harmony.friendReqs.incoming = harmony.friendReqs.incoming.filter(
						(r) => r.chat != request.chat && r.from != request.from
					);
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
				harmony.localPrefs.friends.push({
					name: request.toName,
					id: request.to,
					chat: request.chat,
				});
				window.electronAPI.updatePrefs(harmony.localPrefs);
				uiManager.showToast(`${DOMPurify.sanitize(request.toName)} Is Now Your Friend!`);
			} else {
			}
			//update friend requests
			let reqDiv = document.querySelector(`.friend-request-item[reqTo="${request.to}"]`);
			if (reqDiv) {
				reqDiv.remove();
			}
			//remove our acked friend request from harmony.friendReqs.outgoing
			if (harmony.friendReqs.outgoing) {
				harmony.friendReqs.outgoing = harmony.friendReqs.outgoing.filter((r) => r.to != request.to);
			}
		});

		socket.on("friendRequest", (request) => {
			//got a friend request
			console.log("got friend request", request);
			if (request.from != harmony.selfId && request.to == harmony.selfId) {
				// check if status = remove
				if (request.status === "remove") {
					// Remove from local friends and ack removal
					this.removeFriend(request.from);
					// Remove from incoming requests
					harmony.friendReqs.incoming = harmony.friendReqs.incoming.filter((r) => r.from != request.from);
					return;
				}

				//add to global harmony.friendReqs.incoming
				if (!harmony.friendReqs.incoming) harmony.friendReqs.incoming = [];
				//check if we already have this request
				let existingReq = harmony.friendReqs.incoming.filter((r) => r.from == request.from);
				if (existingReq.length == 0) {
					harmony.friendReqs.incoming.push(request);
				} else {
					console.warn("Already have this request");
					return;
				}
				uiManager.showToast(
					`${DOMPurify.sanitize(request.fromName)} Sent You a Friend Request`,
					this.showFriendRequests
				);
			}
		});

		socket.on("friendRemove", (request) => {
			//got a friend removal request
			console.log("got friend removal request", request);
			if (request.from != harmony.selfId && request.to == harmony.selfId) {
				// Remove from local friends and ack removal
				this.removeFriend(request.from);
				// Remove from incoming requests
				harmony.friendReqs.incoming = harmony.friendReqs.incoming.filter((r) => r.from != request.from);
			}
		});

		socket.emit("checkharmony.FriendReqs", ({ incoming, outgoing }) => {
			console.log(incoming, outgoing);

			// if any accepted outgoing requests are not in harmony.localPrefs.friends, add them
			outgoing.forEach((req) => {
				if (req.status === "accepted") {
					const existingFriend = harmony.localPrefs.friends.find((f) => f.id === req.to);
					if (!existingFriend) {
						harmony.localPrefs.friends.push({
							name: req.toName,
							id: req.to,
							chat: req.chat,
						});
					}
				} else if (req.status === "rejected") {
					// Remove from local friends if rejected (shouldnt happen)
					harmony.localPrefs.friends = harmony.localPrefs.friends.filter((f) => f.id !== req.to);
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
			window.electronAPI.updatePrefs(harmony.localPrefs);
			//store to global harmony.friendReqs
			harmony.friendReqs.incoming = incoming;
			harmony.friendReqs.outgoing = outgoing;
		});
	}

	//removes friend from local and emits to server to either ack or send removal
	static removeFriend(userId, callback = null) {
		if (!userId || userId === harmony.selfId) {
			console.warn("Failed to remove friend: Invalid user ID to remove.");
			return;
		}
		// Remove from harmony.localPrefs.friends
		const friendIndex = harmony.localPrefs.friends.findIndex((f) => f.id === userId);
		//update ui
		const friendDiv = document.querySelector(`.friend-item[name="${userId}"]`);
		if (friendDiv) {
			friendDiv.remove();
		} else {
			console.warn(`Failed to remove friend: Friend not found in UI. ${userId}`);
		}

		// If not found, log a warning before acking the removal
		if (friendIndex === -1) {
			console.warn("Failed to remove friend from harmony.localprefs: Friend not found.");
		} else {
			harmony.localPrefs.friends.splice(friendIndex, 1);
			window.electronAPI.updatePrefs(harmony.localPrefs);
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
			uiManager.showToast("Invalid message content. Must be non-empty and less than 1000 characters.");
			return;
		}
		//BIG ASSUMPTION THAT WE ONLY SEND CHAT FROM harmony.CURRENTCHAT
		const msg = {
			timestamp: Date.now(),
			user: harmony.selfId,
			username: harmony.localPrefs.user.username,
			content: content,
			channel: harmony.currentChat,
			type: "text",
			color: harmony.localPrefs.settings.accentColor,
		};
		if (!msg || !msg.user || !msg.content) {
			// showToast("Bad message!");
			return;
		}
		this.updateChat(msg);
		this.storeChat(msg);
		harmony.rtc.sendMessage(msg, harmony.currentChat);

		// Check if harmony.currentChat is a server chat and if serverStoredMessaging is enabled
		let server = null;
		if (harmony.currentChat) {
			const secret = harmony.currentChat.split(":")[1];
			server = harmony.localPrefs.servers && harmony.localPrefs.servers.find((s) => s.secret === secret);
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
			if (userUtils.userCache) {
				userUtils.updateUserCache(msg.user, { name: msg.username, color: msg.color });
			}
			// If msg.user is in our friends, update prefs with new user name
			if (harmony.localPrefs.friends) {
				const friend = harmony.localPrefs.friends.find((f) => f.id === msg.user);
				if (friend && msg.username && friend.name !== msg.username) {
					friend.name = msg.username;
					window.electronAPI.updatePrefs(harmony.localPrefs);
				}
			}
		}

		if (channel == harmony.currentChat) {
			this.updateChat(msg);
		} else {
			const server = harmony.localPrefs.servers.find((s) => s.secret === channel.split(":")[1]);
			const user = userUtils.userLookup(msg.user);
			if (server) {
				uiManager.showToast(
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
				uiManager.showToast(
					`${user.nick ? user.nick : user.name} sent you a message`,
					() => {
						if (harmony.selectedServer != "HARMONY-FRIENDS-LIST") {
							//select friends server, then friend itself
							const friendsListBtn = document.querySelector('.server-item[name="HARMONY-FRIENDS-LIST"]');
							if (friendsListBtn) {
								friendsListBtn.dispatchEvent(new Event("click", { bubbles: true }));
							}
							// Find the friend and select them
							const friend = harmony.localPrefs.friends.find((f) => f.id === msg.user);
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
		if (harmony.currentChat == chatId) {
			return;
		}
		//get serverId from chatId
		//get messages from browser
		if (!chatId.startsWith("chat:")) {
			harmony.currentChat = `chat:${chatId}`;
		} else {
			harmony.currentChat = chatId;
		}
		var messages = [];
		try {
			const existing = localStorage.getItem(harmony.currentChat);
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
		//connect to chat harmony.rtc
		// harmony.rtc.joinChannel(harmony.currentChat);
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
		} else if (msg.user == harmony.selfId) {
			un.classList.add("is-primary");
		}
		if (msg.user == harmony.selfId) {
			el.style = "text-align: end;";
		}

		let sender = userUtils.userLookup(msg.user);
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

		if (msg.user != harmony.selfId) {
			// Add click handler to open user popup
			un.classList.add("is-clickable");
			un.addEventListener("click", function (e) {
				e.stopPropagation();
				uiManager.manageChatUser(un);
			});
			//right click listener
			un.addEventListener("contextmenu", function (e) {
				e.stopPropagation();
				uiManager.manageChatUser(un);
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

		//constrain to less than harmony.localprefs maxMsgHistory
		if (harmony.localPrefs && messages.length > harmony.localPrefs.settings.maxMsgHistory) {
			messages = messages.slice(-harmony.localPrefs.settings.maxMsgHistory);
		}

		localStorage.setItem(key, JSON.stringify(messages));
	}
}

class userUtils {
	static userCache = {}; // stores id-username pairs
	static userCacheTTL = 1000 * 60 * 30; // 30 minutes

	// Returns user object with name and nick for given userId
	static userLookup(userId) {
		if (userId === harmony.selfId) {
			return { name: harmony.localPrefs.user.username, nick: "" };
		}

		if (!harmony.localPrefs.friends && !userCache[userId])
			return { name: window.electronAPI.getPsuedoUser(userId), nick: "" };
		if (harmony.localPrefs.friends) {
			const friend = harmony.localPrefs.friends.find((f) => f.id === userId);

			if (friend) {
				return { name: friend.name, nick: friend.nick || "" };
			}
		}
		if (this.userCache[userId]) {
			return { name: this.userCache[userId].name, nick: "" };
		}

		return { name: window.electronAPI.getPsuedoUser(userId), nick: "" };
	}

	static updateUserCache(userId, data) {
		data.timestamp = Date.now();
		if (!this.userCache[userId]) {
			this.userCache[userId] = data;
		} else {
			Object.assign(this.userCache[userId], data);
		}
	}

	// Load userCache from localStorage on startup
	static loadUserCache() {
		try {
			const stored = localStorage.getItem("userCache");
			this.userCache = stored ? JSON.parse(stored) : {};
		} catch (e) {
			if ((Object.keys(this.userCache).length = 0)) {
				this.userCache = {};
			}
		}
	}

	// Save userCache to localStorage only if dirty
	static saveUserCache() {
		localStorage.setItem("userCache", JSON.stringify(this.userCache));
	}

	//gets username preemptively or if cache is to old
	static checkUsernameCache(userId) {
		if (
			!this.userCache[userId] ||
			(this.userCache[userId] && this.userCache[userId].timestamp < Date.now() - this.userCacheTTL)
		) {
			this.userCache[userId] = "";
			window.socket.emit("getUsername", userId, (username) => {
				if (username) {
					this.userCache[userId] = { name: username, timestamp: Date.now() };
					// Save the updated cache to local storage
					if (!this.userCache[userId].color) {
						this.userCache[userId].color = HarmonyUtils.getRandomHexColor();
					}
					this.saveUserCache();
					console.log(`Cached username for ${userId}: ${username}`);
				} else {
					console.warn(`Server did not have username for: ${userId}`);
					this.userCache[userId] = null;
				}
			});
		}
	}
}

class uiManager {
	static rootEl = document.documentElement;
	static toastStackHeight = 0; // Global for stacking toasts
	static lastLoopingToast = 0; // Global to stop spamming toasts

	static getAll(selector) {
		return Array.prototype.slice.call(document.querySelectorAll(selector), 0);
	}

	static openModal(target) {
		var $target = document.getElementById(target);
		this.rootEl.classList.add("is-clipped");
		$target.classList.add("is-active");
	}

	static attatchModalHandlers() {
		//opens
		var $modalButtons = this.getAll(".modal-button");
		if ($modalButtons.length > 0) {
			$modalButtons.forEach(function ($el) {
				$el.addEventListener("click", async function () {
					var target = $el.dataset.target;
					uiManager.openModal(target);
					if (target == "settings-modal") {
						if (!harmony.rtc.localAudioStream) {
							await harmony.rtc._initLocalAudio();
						}
						if (harmony.rtc.localAudioStream) {
							colorSliderWithAudio(harmony.rtc.unProcessedLocalAudio, "hotMicThresh");
						}
					}
				});
			});
		}

		//closes
		let $modalCloses = this.getAll(".modal-background, .modal-close, .modal-card-head .delete, .close");
		if ($modalCloses.length > 0) {
			$modalCloses.forEach(function ($el) {
				$el.addEventListener("click", function () {
					uiManager.closeModals();
				});
			});
		}
	}

	static closeModals() {
		//modal control

		let $modals = this.getAll(".modal");

		this.rootEl.classList.remove("is-clipped");
		$modals.forEach(function ($el) {
			$el.classList.remove("is-active");
		});
		if (harmony.rtc && !harmony.rtc.mediaChannel) {
			harmony.rtc.stopLocalVoice();
		}
	}

	static showToast(msg, onclick, color = "is-primary", timeout = 5000) {
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
		const stackOffset = this.toastStackHeight * 3; // 4rem per toast
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
				uiManager.toastStackHeight = Math.max(0, uiManager.toastStackHeight - 1);
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

		this.toastStackHeight++;

		setTimeout(() => {
			//check if toast already gone
			if (!toast || toast.style.opacity == 0) {
				return;
			}
			closeToast();
		}, timeout);
	}

	static manageVoiceUser(e) {
		//make sure were not clicking ourselves
		if (e.target.id == harmony.selfId) {
			uiManager.showToast("Thats You!");
			return;
		}

		//event handler for voice user onclick
		const userDiv = e.target.closest(".voice-prof");
		if (!userDiv) return;

		// Remove any existing popup
		const existingPopup = document.getElementById("voice-user-popup");
		if (existingPopup) existingPopup.remove();

		const userId = userDiv.id;
		let friend = userUtils.userLookup(userId);
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
		let friendObj = harmony.localPrefs.friends.find((f) => f.id == userId);
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
			harmony.rtc.setUserVolume(userId, vol);
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
				let friend = harmony.localPrefs.friends.find((f) => f.id == userId);
				if (friend && friend.volume != vol) {
					friend.volume = vol;
					//avoid writing to json if no change
					window.electronAPI.updatePrefs(harmony.localPrefs);
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

	static manageChatUser(msgEl) {
		if (!msgEl) return;

		// Try to extract userId and timestamp from the message element or event
		let userId = msgEl.getAttribute("data-user-id");
		let timestamp = msgEl.getAttribute("data-timestamp");

		if (!userId || !timestamp) {
			// Not enough info to show popup
			uiManager.showToast("User info not available for this message.");
			return;
		}

		// Remove any existing popup
		const existingPopup = document.getElementById("chat-user-popup");
		if (existingPopup) existingPopup.remove();

		let friend = userUtils.userLookup(userId);
		let username = DOMPurify.sanitize(
			friend.nick != "" && friend.nick != undefined ? `${friend.nick} (${friend.name})` : friend.name
		);

		// Format timestamp
		let ts = new Date(Number(timestamp));
		let tsStr = ts.toLocaleString();

		// Determine if already a friend
		let isFriend = harmony.localPrefs.friends.some((f) => f.id === userId);

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
		if (userId == harmony.selfId) {
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
					uiManager.showToast(`Removed ${username} from friends`);
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
}

export { HarmonyUtils, FriendsManager, chatManager, userUtils, uiManager };
