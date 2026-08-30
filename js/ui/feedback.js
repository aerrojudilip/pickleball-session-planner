// ui/feedback.js — toasts (with optional Undo) and modal dialogs.

import { el, mount, clear } from "./dom.js";

let toastRoot = null;
let dialogRoot = null;

export function initFeedback({ toast, dialog }) {
  toastRoot = toast;
  dialogRoot = dialog;
}

/**
 * Show a transient toast. Optionally include an action button (e.g. Undo).
 * @param {string} message
 * @param {{ actionLabel?: string, onAction?: () => void, duration?: number, tone?: string }} [opts]
 */
export function showToast(message, opts = {}) {
  if (!toastRoot) return;
  const { actionLabel, onAction, duration = 8000, tone = "info" } = opts;
  const node = el("div", { class: `toast toast--${tone}`, role: "status", "aria-live": "polite" });
  node.appendChild(el("span", { class: "toast__msg" }, message));

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    if (node.parentNode) node.parentNode.removeChild(node);
  };

  if (actionLabel && onAction) {
    node.appendChild(
      el(
        "button",
        {
          class: "toast__action",
          type: "button",
          onClick: () => {
            dismiss();
            onAction();
          },
        },
        actionLabel,
      ),
    );
  }
  node.appendChild(
    el("button", { class: "toast__close", type: "button", "aria-label": "Dismiss", onClick: dismiss }, "\u00d7"),
  );

  toastRoot.appendChild(node);
  timer = setTimeout(dismiss, duration);
  return dismiss;
}

/**
 * Open a modal dialog. Returns a controller with `close`.
 * @param {{ title: string, body: Node|Node[], actions?: Node[], onClose?: () => void, size?: string }} opts
 */
export function openDialog({ title, body, actions = [], onClose, size = "md" }) {
  if (!dialogRoot) return { close() {} };

  const previouslyFocused = document.activeElement;

  const closeBtn = el(
    "button",
    { class: "dialog__close", type: "button", "aria-label": "Close", onClick: () => close() },
    "\u00d7",
  );

  const panel = el(
    "div",
    { class: `dialog__panel dialog__panel--${size}`, role: "dialog", "aria-modal": "true", "aria-label": title },
    el("header", { class: "dialog__header" }, el("h2", { class: "dialog__title" }, title), closeBtn),
    el("div", { class: "dialog__body" }, ...(Array.isArray(body) ? body : [body])),
    actions.length ? el("footer", { class: "dialog__footer" }, ...actions) : null,
  );

  const overlay = el(
    "div",
    {
      class: "dialog__overlay",
      onClick: (e) => {
        if (e.target === overlay) close();
      },
    },
    panel,
  );

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      trapFocus(e, panel);
    }
  }

  function close() {
    document.removeEventListener("keydown", onKey, true);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    if (onClose) onClose();
  }

  document.addEventListener("keydown", onKey, true);
  mount(dialogRoot, overlay);

  // Focus the first focusable control.
  const focusable = panel.querySelector(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusable) focusable.focus();

  return { close, panel };
}

/**
 * Confirmation dialog. Resolves true if confirmed.
 * @param {{ title: string, message: string, confirmLabel?: string, cancelLabel?: string, tone?: string }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", tone = "danger" }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      controller.close();
      resolve(val);
    };
    const controller = openDialog({
      title,
      body: el("p", { class: "dialog__message" }, message),
      actions: [
        el("button", { class: "btn btn--ghost", type: "button", onClick: () => done(false) }, cancelLabel),
        el("button", { class: `btn btn--${tone}`, type: "button", onClick: () => done(true) }, confirmLabel),
      ],
      onClose: () => done(false),
    });
  });
}

function trapFocus(e, panel) {
  const focusables = panel.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
