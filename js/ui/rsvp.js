// ui/rsvp.js — attendance for a booked court: pick your name, tap a reply.
//
// Anyone can open this, signed in or not. There is no per-player login, so the
// name picker is the identity: whoever is holding the phone chooses themselves
// from the roster, and the choice is remembered on that device.

import { el, mount, avatar } from "./dom.js";
import { openDialog, showToast } from "./feedback.js";
import { RSVP_LABELS, RSVP_RESPONSES, summarizeRsvps } from "../rsvp.js";
import { bookingEndTime, parseLocalDate } from "../bookings.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const GROUPS = [
  { key: "going", title: "Going", empty: "Nobody yet." },
  { key: "maybe", title: "Maybe", empty: "Nobody yet." },
  { key: "not_going", title: "Not going", empty: "Nobody yet." },
  { key: "pending", title: "No reply yet", empty: "Everyone has replied." },
];

/** Roster sorted for display: everyone, by name. */
function roster(ctx) {
  return ctx.store.getDb().players.slice().sort((a, b) => a.name.localeCompare(b.name));
}

/** Attendance summary for one booking, grouped and counted. */
export function bookingAttendance(ctx, booking) {
  return summarizeRsvps(roster(ctx), ctx.rsvps.forBooking(booking.id));
}

/**
 * A short attendance line, e.g. "4 going, 1 maybe, 2 out".
 * Returns "" when nobody has replied.
 */
export function attendanceLine(counts) {
  if (!counts || !counts.replied) return "";
  const parts = [];
  if (counts.going) parts.push(`${counts.going} going`);
  if (counts.maybe) parts.push(`${counts.maybe} maybe`);
  if (counts.not_going) parts.push(`${counts.not_going} out`);
  return parts.join(", ");
}

/**
 * Open the attendance dialog for a booking.
 * @param {object} ctx - view context
 * @param {object} booking
 */
export function openRsvpDialog(ctx, booking) {
  const { rsvps } = ctx;
  const players = roster(ctx);
  const remembered = rsvps.getIdentity();
  const state = {
    playerId: players.some((p) => p.id === remembered) ? remembered : "",
    busy: false,
    focusKey: null,
  };

  const body = el("div", { class: "stack" });
  const controller = openDialog({
    title: booking.name || "Who's coming?",
    size: "lg",
    body,
    actions: [el("button", { class: "btn btn--primary", type: "button", onClick: () => controller.close() }, "Done")],
    onClose: () => {
      unsubscribe();
      // The calendar behind the dialog now has stale counts.
      if (ctx.refresh) ctx.refresh();
    },
  });

  const unsubscribe = rsvps.subscribe(render);
  render();
  // Someone else may have replied since this device last looked.
  void rsvps.refresh({ force: true }).catch(() => {});

  function render() {
    const list = roster(ctx);
    const replies = rsvps.forBooking(booking.id);
    const summary = summarizeRsvps(list, replies);
    const me = list.find((p) => p.id === state.playerId) || null;
    const myReply = me ? replies.get(me.id) : null;

    mount(
      body,
      el("p", { class: "muted small" }, bookingWhen(booking)),
      booking.location ? el("p", { class: "small" }, booking.location) : null,

      list.length
        ? el(
            "div",
            { class: "card stack rsvp-reply" },
            el(
              "div",
              { class: "field" },
              el("label", { for: "rsvpPlayer" }, "Your name"),
              el(
                "select",
                {
                  id: "rsvpPlayer",
                  disabled: state.busy,
                  onChange: (e) => {
                    state.playerId = e.target.value;
                    rsvps.setIdentity(state.playerId);
                    state.focusKey = "player";
                    render();
                  },
                },
                el("option", { value: "" }, "Select your name…"),
                ...list.map((p) =>
                  el(
                    "option",
                    { value: p.id, selected: p.id === state.playerId },
                    p.active ? p.name : `${p.name} (benched)`,
                  ),
                ),
              ),
            ),
            el(
              "div",
              { class: "field" },
              el("label", {}, me ? `${me.name}, are you coming?` : "Are you coming?"),
              el(
                "div",
                { class: "chips rsvp-chips" },
                ...RSVP_RESPONSES.map((response) =>
                  el(
                    "button",
                    {
                      class: `chip rsvp-chip rsvp-chip--${response} ${myReply && myReply.response === response ? "chip--on" : ""}`,
                      type: "button",
                      dataset: { rsvp: response },
                      disabled: !me || state.busy,
                      "aria-pressed": String(Boolean(myReply) && myReply.response === response),
                      onClick: () => reply(response),
                    },
                    RSVP_LABELS[response],
                  ),
                ),
              ),
            ),
            me
              ? el(
                  "p",
                  { class: "muted small" },
                  myReply
                    ? `Saved as ${RSVP_LABELS[myReply.response]}. Tap another to change it.`
                    : "No reply from you yet.",
                )
              : el("p", { class: "muted small" }, "Pick your name to reply."),
          )
        : el("p", { class: "empty" }, "No players yet. An administrator adds the roster on the Players tab."),

      el(
        "div",
        { class: "stack rsvp-groups" },
        ...GROUPS.map((group) => renderGroup(group, summary[group.key], state.playerId)),
      ),
    );

    restoreFocus();
  }

  function restoreFocus() {
    if (!state.focusKey) return;
    const target =
      state.focusKey === "player"
        ? body.querySelector("#rsvpPlayer")
        : body.querySelector(`[data-rsvp="${state.focusKey}"]`);
    state.focusKey = null;
    if (target && !target.disabled) target.focus();
  }

  async function reply(response) {
    const me = roster(ctx).find((p) => p.id === state.playerId);
    if (!me) return;
    state.busy = true;
    state.focusKey = response;
    render();
    try {
      await rsvps.setResponse(booking.id, me.id, response);
      showToast(`${me.name}: ${RSVP_LABELS[response]}.`, { duration: 3000 });
    } catch (error) {
      showToast(error.message || "Your reply could not be saved. Try again.", {
        tone: "danger",
        duration: 8000,
      });
    } finally {
      state.busy = false;
      state.focusKey = response;
      render();
    }
  }
}

function renderGroup(group, players, mePlayerId) {
  return el(
    "div",
    { class: `rsvp-group rsvp-group--${group.key}` },
    el("div", { class: "rsvp-group__title" }, `${group.title} (${players.length})`),
    players.length
      ? el(
          "div",
          { class: "rsvp-people" },
          ...players.map((player) =>
            el(
              "span",
              { class: `rsvp-person ${player.id === mePlayerId ? "rsvp-person--me" : ""}` },
              avatar(player, { size: "sm" }),
              player.name,
            ),
          ),
        )
      : el("span", { class: "muted small" }, group.empty),
  );
}

function bookingWhen(booking) {
  const date = parseLocalDate(booking.date);
  const day = `${DAY_NAMES[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return `${day} · ${booking.startTime}–${bookingEndTime(booking)} · ${booking.courtCount} court(s)`;
}
