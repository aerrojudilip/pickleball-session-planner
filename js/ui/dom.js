// ui/dom.js — tiny DOM helpers shared by all views. No framework.

/**
 * Create an element with props and children.
 * @param {string} tag
 * @param {object} [props] - attributes, `class`, `dataset`, `on*` handlers, `style` object
 * @param {...(Node|string|null|undefined|Array)} children
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === "class" || key === "className") {
      node.className = value;
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (key === "style" && typeof value === "object") {
      Object.assign(node.style, value);
    } else if (key === "html") {
      node.innerHTML = value;
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "for") {
      node.htmlFor = value;
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, value);
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
    } else if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
}

/** Clear all children of a node. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replace all children of a node with new content. */
export function mount(node, ...children) {
  clear(node);
  appendChildren(node, children);
  return node;
}

/** querySelector shorthand. */
export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/** Player initials from a name, up to 2 chars. */
export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Deterministic avatar color derived from a stable id, so a player's color
 * never changes even if renamed.
 * @param {string} id
 * @returns {string} an HSL color
 */
export function avatarColor(id) {
  let h = 0;
  const str = String(id || "");
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue}, 55%, 42%)`;
}

/** Build an avatar chip element for a player. */
export function avatar(player, { size = "md" } = {}) {
  return el(
    "span",
    {
      class: `avatar avatar--${size}`,
      style: { backgroundColor: avatarColor(player.id) },
      title: player.name,
      "aria-hidden": "true",
    },
    initials(player.name),
  );
}

/** Escape text for safe insertion where needed (defensive). */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
