// Audio Visualizer for rtc.localAudioStream
function attachAudioVisualizer(stream, canvasId = "audio-visualizer") {
	// Remove existing canvas if present
	let oldCanvas = document.getElementById(canvasId);
	if (oldCanvas) oldCanvas.remove();

	// Create and insert canvas
	const canvas = document.createElement("canvas");
	canvas.id = canvasId;
	canvas.width = 300;
	canvas.height = 60;
	canvas.style.display = "block";
	canvas.style.margin = "0 auto";
	canvas.style.background = "#181825";
	canvas.style.borderRadius = "8px";
	canvas.style.position = "relative";
	canvas.style.top = "8px";
	document.getElementById("friends").appendChild(canvas);

	const ctx = canvas.getContext("2d");

	const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
	const source = audioCtx.createMediaStreamSource(stream);
	const analyser = audioCtx.createAnalyser();
	analyser.fftSize = 128;
	const bufferLength = analyser.frequencyBinCount;
	const dataArray = new Uint8Array(bufferLength);

	source.connect(analyser);

	function draw() {
		requestAnimationFrame(draw);

		analyser.getByteFrequencyData(dataArray);

		ctx.clearRect(0, 0, canvas.width, canvas.height);

		const barWidth = (canvas.width / bufferLength) * 1.5;
		let x = 0;
		for (let i = 0; i < bufferLength; i++) {
			const barHeight = dataArray[i] / 2;
			ctx.fillStyle = "#856bf9";
			ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
			x += barWidth + 1;
		}
	}

	draw();

	// Return a cleanup function
	return () => {
		audioCtx.close();
		canvas.remove();
	};
}

function getAudioAmplitude(stream) {
	const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
	const source = audioCtx.createMediaStreamSource(stream);
	const analyser = audioCtx.createAnalyser();
	analyser.fftSize = 128;
	const bufferLength = analyser.frequencyBinCount;
	const dataArray = new Uint8Array(bufferLength);

	source.connect(analyser);

	// Add smoothing using exponential moving average with decay
	let lastValue = 0;
	const smoothing = 0.7; // 0 = no smoothing, 0.9 = very smooth
	const decaySmoothing = 0.92; // higher = slower decay
	const decayThreshold = localPrefs.audio.hotMicThresh; // amplitude threshold for decay

	function amplitude() {
		analyser.getByteFrequencyData(dataArray);
		let sum = 0;
		for (let i = 0; i < bufferLength; i++) {
			sum += dataArray[i];
		}
		const raw = sum / bufferLength / 255;
		// Use slower smoothing (decay) if lastValue is above threshold and decreasing
		if (lastValue > decayThreshold && raw < lastValue) {
			lastValue = lastValue * decaySmoothing + raw * (1 - decaySmoothing);
		} else {
			lastValue = lastValue * smoothing + raw * (1 - smoothing);
		}
		return lastValue;
	}

	return amplitude;
}

//get rgb from css var
function getRGB(str) {
	var elem = document.createElement("div");
	elem.style.display = "none";
	elem.style.color = str;
	document.body.appendChild(elem);
	let clr = window.getComputedStyle(elem, null).getPropertyValue("color");
	document.body.removeChild(elem);
	// clr is in format "rgb(r, g, b)" or "rgba(r, g, b, a)"
	const match = clr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
	if (match) {
		return `${match[1]}, ${match[2]}, ${match[3]}`;
	}
	return "0, 0, 0";
}

// Utility: Convert hex color string to rgb string
function hexToRgb(hex) {
	hex = hex.replace(/^#/, "");
	if (hex.length === 3) {
		hex = hex
			.split("")
			.map((x) => x + x)
			.join("");
	}
	const num = parseInt(hex, 16);
	const r = (num >> 16) & 255;
	const g = (num >> 8) & 255;
	const b = num & 255;
	return `${r}, ${g}, ${b}`;
}

// Continuously update border opacity and width based on audio amplitude
function visualizeBorderWithAudio(
	stream,
	elementId,
	color = getRGB("var(--bulma-primary)")
) {
	const getAmplitude = getAudioAmplitude(stream);
	const el = document.getElementById(elementId);

	if (!el) return;

	function update() {
		const amp = getAmplitude(); // 0..1
		const opacity = amp * 3;
		const width = 2 + amp * 6;
		if (el) {
			el.style.outline = `${width}px solid rgba(${color}, ${opacity})`;
			requestAnimationFrame(update);
		}
	}
	update();
}

// Set slider background to fill with color based on audio amplitude
function colorSliderWithAudio(
	stream,
	sliderId,
	color = getRGB("var(--bulma-primary)")
) {
	const getAmplitude = getAudioAmplitude(stream);
	const slider = document.getElementById(sliderId);
	if (!slider) return;

	// Create a <style> tag for dynamic slider track styling
	let styleTag = document.getElementById(`hotMicSlider-style-${sliderId}`);
	if (!styleTag) {
		styleTag = document.createElement("style");
		styleTag.id = `hotMicSlider-style-${sliderId}`;
		document.head.appendChild(styleTag);
	}
	//i hardcoded the icon whoops
	function update() {
		const amp = getAmplitude(); // 0..1
		const percent = Math.min(amp * 100, 100);
		// Update the ::-webkit-slider-runnable-track style
		styleTag.textContent = `
			#${sliderId}::-webkit-slider-runnable-track {
				background: linear-gradient(90deg, rgba(${color},1) ${percent}%, rgba(${color},0.2) ${
			percent + 1
		}%);
			}
		#hotMicThreshIcon{
		${amp > rtc.hotMicThresh ? "color: var(--bulma-success) !important" : ""}
		}
		`;
		requestAnimationFrame(update);
	}
	update();
}
