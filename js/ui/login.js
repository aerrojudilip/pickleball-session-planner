// ui/login.js — administrator sign-in view.

import { ADMIN_USERNAME } from "../auth.js";
import { el, mount } from "./dom.js";

export function renderAdminLogin(container, ctx, options = {}) {
  const activity = options.activity || "administrator tools";
  const usernameInput = el("input", {
    id: "admin-username",
    type: "text",
    value: ADMIN_USERNAME,
    autocomplete: "username",
    autocapitalize: "none",
    spellcheck: "false",
  });
  const passwordInput = el("input", {
    id: "admin-password",
    type: "password",
    autocomplete: "current-password",
  });
  const message = el("p", {
    class: "admin-login__message",
    role: "alert",
    "aria-live": "polite",
  });
  const submitButton = el("button", { class: "btn btn--primary btn--block", type: "submit" }, "Sign in");

  const form = el(
    "form",
    {
      class: "card admin-login__card",
      onSubmit: async (event) => {
        event.preventDefault();
        if (submitButton.disabled) return;
        submitButton.disabled = true;
        submitButton.textContent = "Signing in...";
        message.textContent = "";
        try {
          const authenticated = await ctx.auth.signIn(usernameInput.value, passwordInput.value);
          if (!authenticated) {
            passwordInput.value = "";
            message.textContent = "Incorrect administrator username or password.";
            passwordInput.focus();
            return;
          }
          if (ctx.afterAdminSignIn) await ctx.afterAdminSignIn();
          ctx.showToast("Signed in as administrator.");
          if (options.onAuthenticated) options.onAuthenticated();
          else ctx.refresh();
        } catch (error) {
          message.textContent = error.message || "Administrator sign-in failed.";
        } finally {
          submitButton.disabled = false;
          submitButton.textContent = "Sign in";
        }
      },
    },
    el("p", { class: "admin-login__eyebrow" }, "Restricted access"),
    el("h1", { class: "page-title", id: "admin-login-title" }, "Administrator sign in"),
    el("p", { class: "muted admin-login__intro", id: "admin-login-description" }, `Sign in to access ${activity}. This login lasts until the browser tab is closed.`),
    el("div", { class: "field" }, el("label", { for: "admin-username" }, "Username"), usernameInput),
    el("div", { class: "field" }, el("label", { for: "admin-password" }, "Password"), passwordInput),
    message,
    submitButton,
    el("button", { class: "btn btn--ghost btn--block", type: "button", onClick: () => ctx.navigate("stats") }, "View statistics"),
  );

  mount(
    container,
    el(
      "section",
      {
        class: "admin-login",
        "aria-labelledby": "admin-login-title",
        "aria-describedby": "admin-login-description",
      },
      form,
    ),
  );
  queueMicrotask(() => passwordInput.focus());
}