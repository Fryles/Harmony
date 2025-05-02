/**
 * The preload script runs before `index.html` is loaded
 * in the renderer. It has access to web APIs as well as
 * Electron's renderer process modules and some polyfilled
 * Node.js functions.
 *
 * https://www.electronjs.org/docs/latest/tutorial/sandbox
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
	updatePrefs: (prefs) => ipcRenderer.send("update-prefs", prefs),
	getPrefs: () => ipcRenderer.invoke("get-prefs"),
	loadPrefs: (prefs) => loadPrefs(prefs),
});

// load prefs here
window.addEventListener("DOMContentLoaded", async () => {
	let prefs = await ipcRenderer.invoke("get-prefs");
	if (prefs == "") {
		//no prefs.json
		prefs = defaultPrefs();
		prefs = await autoUpdateDevices(prefs);
		console.log("Updating prefs with : ", prefs);
		ipcRenderer.send("update-prefs", prefs);
		loadPrefs(prefs);
		promptDevices();
	} else {
		//we already have prefs
		loadPrefs(prefs);
	}
});

function loadFriends(prefs) {
	let friends = prefs.friends;
	friends.forEach((friend) => {
		let el = document.createElement("div");
		el.classList.add("friend-item");
		el.setAttribute("name", friend.id);
		el.innerHTML =
			friend.nick != "" && friend.nick != undefined
				? `${friend.nick} (${friend.name})`
				: friend.name;
		document.getElementById("friends").appendChild(el);
	});
}

function loadServers(prefs) {
	let servers = prefs.servers;
	servers.forEach((server) => {
		let el = document.createElement("div");
		el.classList.add("server-item");
		el.setAttribute("name", server.name);
		el.innerHTML = server.name;
		document.getElementById("server-list").appendChild(el);
	});

	//add add server button
	let el =
		"<div class='server-item' name='HARMONY-ADD-SERVER'><i class='fas fa-lg fa-plus-circle'></i></div>";
	document.getElementById("server-list").innerHTML += el;
}

function promptDevices() {
	//open settings modal, make sure document is loaded
	openModal("settings-modal");
}

//bulma js
function openModal(target) {
	const rootEl = document.documentElement;
	var $target = document.getElementById(target);
	rootEl.classList.add("is-clipped");
	$target.classList.add("is-active");
}

function closeModals() {
	const rootEl = document.documentElement;
	rootEl.classList.remove("is-clipped");
	$modals.forEach(function ($el) {
		$el.classList.remove("is-active");
	});
}

function defaultPrefs() {
	let prefs = {
		user: {
			username: "user",
			userid: crypto.randomUUID(),
		},
		servers: [
			{
				name: "pub",
				id: 123,
				password: "",
			},
		],
		settings: {
			theme: "dark",
			accentColor: "#856bf9",
			language: "en-US",
			notifications: true,
			checkUpdate: true,
		},
		friends: [
			{
				name: "toof",
				nick: "buh",
				id: crypto.randomUUID(),
			},
			{
				name: "ulltra",
				nick: "",
				id: crypto.randomUUID(),
			},
		],
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
			enableNoiseSuppression: true,
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
	}`;
	var customStyles = document.createElement("style");
	customStyles.textContent = styles;
	document.head.appendChild(customStyles);
	loadSettings(prefs);
	loadServers(prefs);
	loadFriends(prefs);
}

function loadSettings(prefs) {
	document.getElementById("accentColor").value = prefs.settings.accentColor;

	// Username
	document.getElementById("username").value = prefs.user.username;
	document.getElementById("userid").value = prefs.user.userid;

	// Devices - populate dropdowns
	populateDeviceDropdown(
		"videoInputDevice",
		prefs.devices.videoInputDevices || [],
		prefs.devices.videoInputDevice
	);
	populateDeviceDropdown(
		"audioInputDevice",
		prefs.devices.audioInputDevices || [],
		prefs.devices.audioInputDevice
	);
	populateDeviceDropdown(
		"audioOutputDevice",
		prefs.devices.audioOutputDevices || [],
		prefs.devices.audioOutputDevice
	);

	// Audio
	document.getElementById("inputGain").value = prefs.audio.inputGain;
	document.getElementById("outputVolume").value = prefs.audio.outputVolume;
	document.getElementById("enableNoiseSuppression").checked =
		prefs.audio.enableNoiseSuppression;

	// Settings
	document.getElementById("accentColor").value = prefs.settings.accentColor;
	document.getElementById("theme").value = prefs.settings.theme;
	document.getElementById("notifications").checked =
		prefs.settings.notifications;
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
		var videoInputDevices = devices.filter(
			(device) => device.kind === "videoinput"
		);
		var audioInputDevices = devices.filter(
			(device) => device.kind === "audioinput"
		);
		var audioOutputDevices = devices.filter(
			(device) => device.kind === "audiooutput"
		);

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
		devices = devices.filter(
			(device) => device.deviceId != selectedDevice.deviceId
		);
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
