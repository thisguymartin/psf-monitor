import type { AgentId } from "../domain.ts";
import type { ActionResponse, MessageState, PromptMode } from "../wire.ts";
import { postJson } from "./commands.ts";
import { h } from "./dom.ts";

export class MessageComposer {
  readonly element: HTMLElement;
  private readonly recipient = h("p", { class: "message-recipient" });
  private readonly help = h("p", { class: "message-help" });
  private readonly text = h("textarea", { attrs: { rows: "3", maxlength: "2000", placeholder: "Tell the agent what to change…", "aria-label": "Message to agent" } });
  private readonly mode = h("select", { attrs: { "aria-label": "When to deliver" } },
    h("option", { text: "Steer at next step", attrs: { value: "steer" } }),
    h("option", { text: "Follow up after this work", attrs: { value: "follow-up" } }));
  private readonly send = h("button", { class: "quiet-action", text: "Send message", attrs: { type: "submit" } });
  private readonly feedback = h("p", { class: "message-feedback", attrs: { role: "status" } });
  private readonly history = h("ul", { class: "message-history" });
  private readonly drafts = new Map<AgentId, { text: string; mode: string }>();
  private agent: AgentId | null = null;
  private timer: number | null = null;
  private pending = false;
  private renderedHistory = "";
  constructor() {
    const form = h("form", {}, this.recipient, this.text,
      h("div", { class: "message-controls" }, this.mode, this.send), this.help, this.feedback, this.history);
    form.addEventListener("submit", (event) => { event.preventDefault(); void this.submit(); });
    this.text.addEventListener("input", () => this.saveDraft());
    this.mode.addEventListener("change", () => this.saveDraft());
    this.element = h("details", { class: "message-composer" }, h("summary", { text: "Send a message" }), form);
  }
  open(agent: AgentId): void {
    if (this.agent === agent) return;
    this.close();
    this.agent = agent;
    const draft = this.drafts.get(agent);
    this.text.value = draft?.text ?? "";
    this.mode.value = draft?.mode ?? "steer";
    this.feedback.textContent = "";
    this.recipient.textContent = "Checking recipient…";
    this.history.replaceChildren();
    this.renderedHistory = "";
    this.send.disabled = true;
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), 2000);
  }
  close(): void {
    this.saveDraft();
    this.agent = null;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
  private saveDraft(): void {
    if (this.agent !== null) this.drafts.set(this.agent, { text: this.text.value, mode: this.mode.value });
  }
  private async refresh(): Promise<void> {
    const agent = this.agent;
    if (agent === null) return;
    try {
      const response = await fetch(`/api/messages?agent=${encodeURIComponent(agent)}`);
      if (!response.ok) throw new Error("Message inbox unavailable. Restart the monitor to enable messaging.");
      const data = await response.json() as MessageState;
      if (this.agent !== agent) return;
      this.recipient.textContent = data.target === null ? "This agent has no supported recipient." : `To: ${data.target.title}${data.target.id !== agent ? " (owning agent)" : ""}`;
      this.send.disabled = data.target === null || this.pending;
      this.text.disabled = data.target === null;
      this.mode.disabled = data.target === null;
      this.help.textContent = data.target === null
        ? "Messages are not supported for this harness. Resume the session in its terminal to send a prompt."
        : data.connected
        ? "Steering arrives at the next tool boundary. Follow-ups arrive when work finishes. Idle agents need to be resumed."
        : "Hooks have not connected for this agent. Enable/trust this plugin’s hooks and resume the session. Messages wait here for up to 24 hours.";
      const historyKey = JSON.stringify(data.messages);
      if (historyKey === this.renderedHistory) return;
      this.renderedHistory = historyKey;
      this.history.replaceChildren(...data.messages.slice(0, 5).map((message) => {
        const queued = message.deliveredAt === null;
        const row = h("li", {}, h("span", { text: `${queued ? "Queued" : "Delivered to hook"} · ${message.mode === "steer" ? "Steer" : "Follow-up"}` }),
          h("p", { text: message.text }));
        if (queued) {
          const cancel = h("button", { class: "link", text: "Remove", attrs: { type: "button", "aria-label": "Remove queued message" } });
          cancel.addEventListener("click", () => {
            cancel.disabled = true;
            void postJson<ActionResponse>("/api/messages", { agent, cancel: message.id }).then(() => this.refresh()).catch(() => { cancel.disabled = false; });
          });
          row.append(cancel);
        }
        return row;
      }));
    } catch (error) {
      if (this.agent !== agent) return;
      this.send.disabled = true;
      this.help.textContent = error instanceof Error ? error.message : "Message inbox unavailable.";
    }
  }
  private async submit(): Promise<void> {
    const agent = this.agent;
    if (agent === null || this.pending) return;
    if (this.text.value.trim().length === 0) { this.text.focus(); return; }
    this.pending = true;
    this.send.disabled = true;
    const text = this.text.value;
    try {
      const result = await postJson<ActionResponse>("/api/messages", { agent, text, mode: this.mode.value as PromptMode });
      if (this.agent !== agent) return;
      this.feedback.textContent = result.data.message;
      if (result.data.ok && this.text.value === text) { this.text.value = ""; this.saveDraft(); }
    } catch { if (this.agent === agent) this.feedback.textContent = "Could not send message. Try again."; }
    finally { this.pending = false; await this.refresh(); }
  }
}
