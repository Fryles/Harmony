/**
 * The preload script runs before `index.html` is loaded
 * in the renderer. It has access to web APIs as well as
 * Electron's renderer process modules and some polyfilled
 * Node.js functions.
 *
 * https://www.electronjs.org/docs/latest/tutorial/sandbox
 */
const { contextBridge, ipcRenderer } = require("electron");
var prefs;
var accId = false;
contextBridge.exposeInMainWorld("electronAPI", {
	updatePrefs: (prefs, accId) => ipcRenderer.send("update-prefs", prefs, accId),
	getPrefs: (accId) => ipcRenderer.invoke("get-prefs", accId),
	loadPrefs: (prefs) => loadPrefs(prefs),
	getPsuedoUser: (userId) => psuedoUser(userId),
});

// load prefs here
window.addEventListener("DOMContentLoaded", async () => {
	prefs = await ipcRenderer.invoke("get-prefs", accId);
	if (prefs == "") {
		//no prefs.json
		prefs = defaultPrefs();
		prefs = await autoUpdateDevices(prefs);
		console.log("Created default prefs with : ", prefs);
		ipcRenderer.send("update-prefs", prefs, accId);
		loadPrefs(prefs);
		openModal("settings-modal");
		// Hide settings-delete and settings-close elements

		return;
	} else {
		//we already have prefs, attempt to update w/ connected devices

		prefs = await autoUpdateDevices(prefs);
		loadPrefs(prefs);
	}
});

function loadServers(prefs) {
	// Only keep the friends button in the server list
	const serverList = document.getElementById("server-list");
	if (serverList) {
		// Remove all children except the one with name == "HARMONY-FRIENDS-LIST"
		Array.from(serverList.children).forEach((child) => {
			if (child.getAttribute("name") !== "HARMONY-FRIENDS-LIST") {
				serverList.removeChild(child);
			}
		});
	}

	let servers = prefs.servers;
	servers.forEach((server) => {
		let el = document.createElement("div");
		el.classList.add("server-item");
		el.setAttribute("name", server.id);
		let name = server.name;
		if (name.includes(" ") && name.length > 5) {
			//split two part name into two 2 char initials
			name = name.split(" ");
			name = name[0].substring(0, 2) + " " + name[1].substring(0, 2);
		} else if (name.length > 5) {
			name = name.substring(0, 5);
		}
		el.innerText = name;
		serverList.appendChild(el);
	});

	//add add server button
	let el = "<div class='server-item' name='HARMONY-ADD-SERVER'><i class='fas fa-lg fa-plus-circle'></i></div>";
	serverList.innerHTML += el;
}

//bulma js
function openModal(target) {
	const rootEl = document.documentElement;
	var $target = document.getElementById(target);
	rootEl.classList.add("is-clipped");
	$target.classList.add("is-active");
}

function defaultPrefs() {
	let uid = crypto.randomUUID();
	let prefs = {
		user: {
			username: psuedoUser(uid),
			userId: uid,
			password: "",
		},
		servers: [],
		settings: {
			theme: "dark",
			accentColor: "#3bdbcd",
			language: "en-US",
			notifications: true,
			checkUpdate: true,
			maxMsgHistory: 50,
		},
		friends: [],
		devices: {
			videoInputDevices: [],
			audioInputDevices: [],
			audioOutputDevices: [],
			videoInputDevice: "",
			audioInputDevice: "",
			audioOutputDevice: "",
		},
		audio: {
			inputGain: 1.0,
			outputVolume: 0.8,
			hotMicThresh: 0.1,
			enableNoiseSuppression: true,
			ringVolume: 0.5,
		},
	};
	return prefs;
}

function loadPrefs(prefs) {
	//load accent
	let accent = hexToHsl(prefs.settings.accentColor);
	let styles = ` :root {
            --bulma-primary-h: ${accent[0]};
						--bulma-primary-s: ${accent[1]}%;
						--bulma-primary-l: ${accent[2]}%;
						--bulma-focus-h: ${accent[0]};
						--bulma-focus-s: ${accent[1]}%;
						--bulma-focus-l: ${accent[2]}%;
	}`;
	var customStyles = document.createElement("style");
	customStyles.textContent = styles;
	document.head.appendChild(customStyles);
	loadSettings(prefs);
	loadServers(prefs);
}

function loadSettings(prefs) {
	document.getElementById("accentColor").value = prefs.settings.accentColor;

	// Username
	document.getElementById("username").value = prefs.user.username;
	document.getElementById("userid").value = prefs.user.userId;

	// Devices - populate dropdowns
	populateDeviceDropdown("videoInputDevice", prefs.devices.videoInputDevices || [], prefs.devices.videoInputDevice);
	populateDeviceDropdown("audioInputDevice", prefs.devices.audioInputDevices || [], prefs.devices.audioInputDevice);
	populateDeviceDropdown("audioOutputDevice", prefs.devices.audioOutputDevices || [], prefs.devices.audioOutputDevice);

	// Audio
	document.getElementById("inputGain").value = prefs.audio.inputGain;
	document.getElementById("hotMicThresh").value = prefs.audio.hotMicThresh;
	document.getElementById("outputVolume").value = prefs.audio.outputVolume;
	document.getElementById("ringVolume").value = prefs.audio.ringVolume;
	document.getElementById("enableNoiseSuppression").checked = prefs.audio.enableNoiseSuppression;

	// Settings
	document.getElementById("accentColor").value = prefs.settings.accentColor;
	document.getElementById("theme").value = prefs.settings.theme;
	document.getElementById("notifications").checked = prefs.settings.notifications;
}

async function autoUpdateDevices(prefs) {
	//enum media devices
	return navigator.mediaDevices.enumerateDevices().then((devices) => {
		// serialize all devices to regular objects (not MediaDeviceInfo)
		devices = devices.map((device) => {
			return {
				deviceId: device.deviceId,
				kind: device.kind,
				label: device.label,
			};
		});
		var videoInputDevices = devices.filter((device) => device.kind === "videoinput");
		var audioInputDevices = devices.filter((device) => device.kind === "audioinput");
		var audioOutputDevices = devices.filter((device) => device.kind === "audiooutput");

		var videoInputDevice = videoInputDevices[0];
		var audioInputDevice = audioInputDevices[0];
		var audioOutputDevice = audioOutputDevices[0];

		//store the devices in prefs.json
		prefs.devices = {
			videoInputDevices: videoInputDevices,
			audioInputDevices: audioInputDevices,
			audioOutputDevices: audioOutputDevices,
			videoInputDevice: videoInputDevice,
			audioInputDevice: audioInputDevice,
			audioOutputDevice: audioOutputDevice,
		};
		return prefs;
	});
}

function hexToHsl(hex) {
	let r = parseInt(hex.slice(1, 3), 16);
	let g = parseInt(hex.slice(3, 5), 16);
	let b = parseInt(hex.slice(5, 7), 16);
	r /= 255;
	g /= 255;
	b /= 255;
	let max = Math.max(r, g, b);
	let min = Math.min(r, g, b);
	let h,
		s,
		l = (max + min) / 2;

	if (max === min) {
		h = s = 0;
	} else {
		let d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case r:
				h = (g - b) / d + (g < b ? 6 : 0);
				break;
			case g:
				h = (b - r) / d + 2;
				break;
			case b:
				h = (r - g) / d + 4;
				break;
		}
		h /= 6;
	}

	h = Math.round(h * 360);
	s = Math.round(s * 100);
	l = Math.round(l * 100);

	return [h, s, l];
}

function populateDeviceDropdown(selectId, devices, selectedDevice) {
	const select = document.getElementById(selectId);
	if (!select) return;
	// Remove all options
	select.innerHTML = "";

	// Add a default option (either select device or currently selected)
	const defaultOption = document.createElement("option");
	if (selectedDevice == {} || selectedDevice == undefined) {
		defaultOption.value = "";
		defaultOption.textContent = "Select device";
	} else {
		//filter devices out so we dont include this twice
		devices = devices.filter((device) => device.deviceId != selectedDevice.deviceId);
		defaultOption.value = selectedDevice.deviceId;
		defaultOption.textContent = selectedDevice.label;
	}
	select.value = defaultOption.value;
	select.appendChild(defaultOption);

	// Add device options
	devices.forEach((device) => {
		const option = document.createElement("option");
		option.value = device.deviceId || device; // fallback for string
		option.textContent = device.label || device.deviceId || device;
		select.appendChild(option);
	});
}

function psuedoUser(userId) {
	//if we cant find a username, we give a unique readable one based on uuuid
	var prefixes = [
		"Bigbacked",
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
		"Sleepy",
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
