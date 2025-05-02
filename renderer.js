/**
 * This file is loaded via the <script> tag in the index.html file and will
 * be executed in the renderer process for that window. No Node.js APIs are
 * available in this process because `nodeIntegration` is turned off and
 * `contextIsolation` is turned on. Use the contextBridge API in `preload.js`
 * to expose Node.js functionality from the main process.
 */

var selectedServer = "HARMONY-FRIENDS-LIST";
var selectedFriend;
var currentChat;
var localPrefs;
main();

async function main() {
	//set local prefs
	localPrefs = await window.electronAPI.getPrefs();
	//atatch listeners
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
}

function sendChat(content) {
	const msg = {
		timestamp: Date.now(),
		user: localPrefs.user.userid,
		content: content,
	};
	updateChat(msg);
	storeChat(msg, currentChat);
}

function displayChat(chatId) {
	//get messages from browser
	const key = `chat_${chatId}`;
	var messages = [];
	try {
		const existing = localStorage.getItem(key);
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
		let el = document.createElement("p");
		let un = document.createElement("span");
		un.className = "tag is-primary is-medium";
		un.innerHTML = DOMPurify.sanitize(userLookup(msg.user));
		el.innerHTML = "";
		el.appendChild(un);
		el.innerHTML += ": " + DOMPurify.sanitize(msg.content);
		document.getElementById("chat-messages").appendChild(el);
	});
}

function updateChat(message) {
	//add message to chat, store it to browser
	if (!message || !message.user || !message.content) return;
	const sanitizedContent = DOMPurify.sanitize(message.content);
	let el = document.createElement("p");
	let un = document.createElement("span");
	un.className = "tag is-primary is-medium";
	un.innerHTML = userLookup(message.user);
	el.innerHTML = "";
	el.appendChild(un);
	el.innerHTML += ": " + sanitizedContent;
	document.getElementById("chat-messages").appendChild(el);
}

function storeChat(msg, chatId) {
	//adds message to respective chat and stores it
	const key = `chat_${chatId}`;
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
	localStorage.setItem(key, JSON.stringify(messages));
}

function updatePage() {
	if (selectedServer == "HARMONY-FRIENDS-LIST") {
		document.getElementById("friends").style.display = "block";
		document.getElementById("friends").style.borderWidth = "8px";
		document.getElementById("friends").style.width = "calc-size(auto, size)";
		document.getElementById("chat").style.width = "calc-size(auto, size)";
		document.getElementById("friends-header").style.display = "block";
		document.querySelectorAll(".friend-item").forEach((el) => {
			el.style.display = "block";
		});
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
	}
}

function selectFriend(e) {
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
	updatePage();
}

function selectServerItem(e) {
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
	selectedFriend = "";
	updatePage();
}

function userLookup(userId) {
	if (!localPrefs || !localPrefs.friends)
		return { name: psuedoUser(userId), nick: "" };
	if (userId === localPrefs.user.userid) {
		return { name: localPrefs.user.username, nick: "" };
	}
	const friend = localPrefs.friends.find((f) => f.id === userId);
	if (friend) {
		return { name: friend.name, nick: friend.nick || "" };
	}
	return { name: psuedoUser(userId), nick: "" };
}

function psuedoUser(userId) {
	//if we cant find a username, we give a unique readable one based on uuuid
	var prefixes = [
		"Cool",
		"Epic",
		"Funky",
		"Sneaky",
		"Wobbly",
		"Spicy",
		"Quantum",
		"Fluffy",
		"Turbo",
		"Mega",
		"Ultra",
		"Dank",
		"Silly",
		"Chill",
		"Radical",
		"Bizarre",
		"Cosmic",
		"Tiny",
		"Giga",
		"Sleepy",
		"Noisy",
		"Silent",
		"Cheesy",
		"Cranky",
		"Jumpy",
		"Loopy",
		"Wonky",
		"Zippy",
		"Groovy",
		"Moist",
		"Chunky",
		"Soggy",
		"Yeet",
		"Boaty",
		"Saucy",
		"Snazzy",
		"Lumpy",
		"Derpy",
		"Swole",
		"Toasty",
		"Spooky",
		"Bouncy",
		"Goofy",
		"Lazy",
		"Nerdy",
		"Feral",
		"Crusty",
		"Frosty",
		"Salty",
		"Sweaty",
		"Thicc",
		"Sussy",
		"Drippy",
		"Wacky",
		"Borked",
		"Dopey",
		"Zonky",
		"Yolo",
		"Vibey",
		"Breezy",
		"Dizzy",
		"Meme",
		"Pog",
		"Blep",
		"Snek",
	];
	var suffixes = [
		"Cat",
		"Dog",
		"Monkey",
		"Fox",
		"Bear",
		"Otter",
		"Penguin",
		"Bunny",
		"Lion",
		"Tiger",
		"Wolf",
		"Duck",
		"Goose",
		"Moose",
		"Horse",
		"Ferret",
		"Whale",
		"Mouse",
		"Elephant",
		"Koala",
		"Parrot",
		"Hawk",
		"Sheep",
		"Goat",
		"Frog",
		"Lizard",
		"Snake",
		"Zebra",
		"Giraffe",
		"Moose",
		"Rhino",
		"Hippo",
		"Fish",
		"Boat",
		"Crab",
		"Bee",
		"Bat",
		"Goose",
		"Ox",
		"Goat",
		"Ghost",
		"Kangaroo",
		"Cow",
		"Moose",
		"Owl",
		"Rat",
		"Cat",
		"Penguin",
		"Seal",
		"Shark",
		"Duck",
		"Imp",
		"Crow",
		"Worm",
		"Dog",
		"Sloth",
		"Yak",
		"Mole",
		"Vole",
		"Ant",
		"Dove",
		"Moth",
		"Pug",
		"Snake",
	];
	// Simple hash to pick a prefix and suffix based on userId
	function hashCode(str) {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			hash = (hash << prefixes.length) - hash + str.charCodeAt(i);
			hash |= 0;
		}
		return Math.abs(hash);
	}
	const hash = hashCode(userId);
	const prefix = prefixes[hash % prefixes.length];
	const suffix = suffixes[hash % suffixes.length];
	return `${prefix} ${suffix}`;
}

async function storePrefs() {
	//get prefs from HTML, then store, and load them to our ui

	// Settings
	localPrefs.settings.accentColor =
		document.getElementById("accentColor").value;
	localPrefs.settings.theme = document.getElementById("theme").value;
	localPrefs.settings.notifications =
		document.getElementById("notifications").checked;

	// Username
	localPrefs.user.username = document.getElementById("username").value;

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
	localPrefs.audio.enableNoiseSuppression = document.getElementById(
		"enableNoiseSuppression"
	).checked;

	// Save and reload
	window.electronAPI.updatePrefs(localPrefs);
}
