// allowed URI schemes
const allowlist = ["http", "https", "tel", "mailto", "hrmny"];

// build fitting regex for uri
const regex = RegExp("^(" + allowlist.join("|") + "):", "i");
const MDconfig = {
	ALLOWED_TAGS: [
		"p",
		"#text",
		"a",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"br",
		"u",
		"b",
		"i",
		"img",
		"ol",
		"ul",
		"li",
		"hr",
		"blockquote",
		"pre",
		"code",
	],
	ALLOWED_ATTR: ["href", "src", "color"],
	KEEP_CONTENT: false,
};

DOMPurify.setConfig(MDconfig);

// Map to store original content for <code> nodes
const codeContents = new WeakMap();

DOMPurify.addHook("beforeSanitizeElements", (node) => {
	if (node.nodeName === "CODE") {
		codeContents.set(node, node.innerHTML);
		console.log(node.innerHTML);
	}
});

// Step 2: After DOMPurify finishes, restore raw content as plain text (not HTML!)
DOMPurify.addHook("afterSanitizeElements", (node) => {
	if (node.nodeName === "CODE" && codeContents.has(node)) {
		const original = codeContents.get(node);
		node.textContent = original;
		
		codeContents.delete(node); // Clean up
	}
});

DOMPurify.addHook("afterSanitizeAttributes", function (node) {
	//LINK TARGET SANITIZAITON
	// set all elements owning target to target=_blank
	if ("target" in node) {
		node.setAttribute("target", "_blank");
	}

	//stop referrers
	if (node.hasAttribute("target")) {
		node.setAttribute("rel", "noopener noreferrer");
	}

	// set non-HTML/MathML links to xlink:show=new
	if (!node.hasAttribute("target") && (node.hasAttribute("xlink:href") || node.hasAttribute("href"))) {
		node.setAttribute("xlink:show", "new");
	}

	//PROTOCOL SANITIZATION
	// build an anchor to map URLs to
	const anchor = document.createElement("a");

	// check all href attributes for validity
	if (node.hasAttribute("href")) {
		let href = node.getAttribute("href");
		// default to https:// if no protocol is present
		if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href)) {
			href = "https://" + href;
			node.setAttribute("href", href);
		}
		anchor.href = href;
		if (anchor.protocol && !anchor.protocol.match(regex)) {
			node.removeAttribute("href");
		}
	}
	// check all action attributes for validity
	if (node.hasAttribute("action")) {
		anchor.href = node.getAttribute("action");
		if (anchor.protocol && !anchor.protocol.match(regex)) {
			node.removeAttribute("action");
		}
	}
	// check all xlink:href attributes for validity
	if (node.hasAttribute("xlink:href")) {
		anchor.href = node.getAttribute("xlink:href");
		if (anchor.protocol && !anchor.protocol.match(regex)) {
			node.removeAttribute("xlink:href");
		}
	}
});

console.log("DOMPurify configured");
