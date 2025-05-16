// Modules to control application life and create native browser window
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
// Enable live reload for all the files inside your project directory
require("electron-reload")(__dirname);

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

function getPrefs(event, windowId) {
	try {
		// Use windowId to determine prefs path
		const id = windowId || (event && event.sender && event.sender.id);
		const prefsPath = path.join(__dirname, `prefs-${id}.json`);
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

function updatePrefs(event, prefs, windowId) {
	// Validate that prefs is an object
	if (prefs === "" || typeof prefs !== "object" || prefs === undefined) {
		console.error("Invalid preferences format");
		return;
	}

	// Remove any undefined or function values
	prefs = JSON.parse(JSON.stringify(prefs));

	// Use windowId to determine prefs path
	const id = windowId || (event && event.sender && event.sender.id);
	const prefsPath = path.join(__dirname, `prefs-${id}.json`);
	fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
}
