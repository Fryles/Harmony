// Simple WebRTC text messaging using DataChannels

let peerConnection = null;
let dataChannel = null;

// ICE servers for NAT traversal (use public STUN)
const rtcConfig = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

// Call this to start a connection as the initiator (caller)
function startConnection() {
    peerConnection = new RTCPeerConnection(rtcConfig);

    // Create data channel for text messages
    dataChannel = peerConnection.createDataChannel("chat");
    setupDataChannel();

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            // Send candidate to remote peer via your signaling server
            sendSignalingMessage({ type: "candidate", candidate: event.candidate });
        }
    };

    peerConnection.createOffer()
        .then(offer => peerConnection.setLocalDescription(offer))
        .then(() => {
            // Send offer to remote peer via your signaling server
            sendSignalingMessage({ type: "offer", offer: peerConnection.localDescription });
        });
}

// Call this to handle an incoming offer (callee)
function handleOffer(offer) {
    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.ondatachannel = (event) => {
        dataChannel = event.channel;
        setupDataChannel();
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignalingMessage({ type: "candidate", candidate: event.candidate });
        }
    };

    peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
        .then(() => peerConnection.createAnswer())
        .then(answer => peerConnection.setLocalDescription(answer))
        .then(() => {
            sendSignalingMessage({ type: "answer", answer: peerConnection.localDescription });
        });
}

// Call this to handle an incoming answer (initiator)
function handleAnswer(answer) {
    peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
}

// Call this to handle an incoming ICE candidate
function handleCandidate(candidate) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}

// Send a text message over the data channel
function sendMessage(text) {
    if (dataChannel && dataChannel.readyState === "open") {
        dataChannel.send(text);
    }
}

// Set up handlers for the data channel
function setupDataChannel() {
    dataChannel.onopen = () => {
        console.log("Data channel open");
    };
    dataChannel.onclose = () => {
        console.log("Data channel closed");
    };
    dataChannel.onmessage = (event) => {
        console.log("Received message:", event.data);
        // You can call a function here to display the message in your UI
        if (typeof window.onRTCMessage === "function") {
            window.onRTCMessage(event.data);
        }
    };
}

// Placeholder: Implement this to send signaling data to the remote peer
function sendSignalingMessage(msg) {

}

// Expose functions to window for use in renderer.js or console
window.RTC = {
    startConnection,
    handleOffer,
    handleAnswer,
    handleCandidate,
    sendMessage
};