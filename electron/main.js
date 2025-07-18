// Modules to control application life and create native browser window
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
var userDataPath = app.getPath("userData"); // e.g. ~/Library/Application Support/Harmony

//if dev
if (!app.isPackaged) {
	userDataPath = __dirname;
	try {
		require("electron-reload")(__dirname, {
			electron: require(`${__dirname}/node_modules/electron`),
			ignored: /(^[\/\\]\.|[\/\\]prefs.*\.json$|[\/\\]node_modules[\/\\]|[\/\\]dist[\/\\]|[\/\\]src[\/\\]$)/,
		});
	} catch (err) {
		console.warn("electron-reload failed:", err);
	}
}
console.log("using userData path of", userDataPath);

function createWindow() {
	// Create the browser window.
	const mainWindow = new BrowserWindow({
		width: 800,
		height: 600,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
		},
	});

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("hrmny::") || url.startsWith("HRMNY::")) {
			return { action: "allow" };
		}
		// open url in a browser and prevent default
		shell.openExternal(url);
		return { action: "deny" };
	});

	// and load the index.html of the app.
	mainWindow.loadFile("index.html");
	// Open the DevTools.
	// mainWindow.webContents.openDevTools();
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
	ipcMain.on("update-prefs", updatePrefs);
	ipcMain.handle("get-prefs", getPrefs);

	createWindow();
	createWindow();

	app.on("activate", function () {
		// On macOS it's common to re-create a window in the app when the
		// dock icon is clicked and there are no other windows open.
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", function () {
	if (process.platform !== "darwin") app.quit(); //win32 for windows
});

function getPrefs(event, accountId) {
	try {
		// Use accountId to determine prefs path
		const id = accountId || (event && event.sender && event.sender.id);

		const prefsPath = path.join(userDataPath, `prefs-${id}.json`);
		if (fs.existsSync(prefsPath)) {
			const prefs = fs.readFileSync(prefsPath);
			return JSON.parse(prefs);
		} else {
			return "";
		}
	} catch (err) {
		console.log("Error loading prefs.json", err);
		return "";
	}
}

function updatePrefs(event, prefs, accountId) {
	// Validate that prefs is an object
	if (prefs === "" || typeof prefs !== "object" || prefs === undefined) {
		console.error("Invalid preferences format");
		return;
	}

	// Remove any undefined or function values
	prefs = JSON.parse(JSON.stringify(prefs));

	// Use windowId to determine prefs path if no accountId
	const id = accountId || (event && event.sender && event.sender.id);
	const prefsPath = path.join(userDataPath, `prefs-${id}.json`);

	fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
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
