import test from "node:test";
import assert from "node:assert/strict";

import { createMutationWaitController, resetFormPending, setFormPending } from "../public/interaction-state.js";

function fakeForm(inert = false) {
  const attributes = new Map(inert ? [["inert", ""]] : []);
  return {
    dataset: {},
    inert,
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    hasAttribute(name) { return attributes.has(name); },
  };
}

test("restores a pending form after an operation fails", () => {
  const form = fakeForm();
  setFormPending(form, true);
  assert.equal(form.inert, true);
  assert.equal(form.hasAttribute("aria-busy"), true);

  setFormPending(form, false);
  assert.equal(form.inert, false);
  assert.equal(form.hasAttribute("inert"), false);
  assert.equal(form.hasAttribute("aria-busy"), false);
  assert.equal("pendingInert" in form.dataset, false);
});

test("keeps nested operations pending until every operation finishes", () => {
  const form = fakeForm();
  setFormPending(form, true);
  setFormPending(form, true);
  setFormPending(form, false);
  assert.equal(form.inert, true);
  setFormPending(form, false);
  assert.equal(form.inert, false);
});

test("force-resets state left by an interrupted resource edit", () => {
  const form = fakeForm(true);
  form.dataset.pendingInert = "false";
  form.setAttribute("aria-busy", "true");
  resetFormPending(form);
  assert.equal(form.inert, false);
  assert.equal(form.hasAttribute("inert"), false);
  assert.equal(form.hasAttribute("aria-busy"), false);
});

test("can start a new operation after a pending form is reset for reopening", () => {
  const form = fakeForm();
  setFormPending(form, true);
  resetFormPending(form);
  setFormPending(form, true);
  setFormPending(form, false);
  assert.equal(form.inert, false);
  assert.equal(form.hasAttribute("inert"), false);
  assert.equal(form.hasAttribute("aria-busy"), false);
});

test("keeps the latest mutation wait message visible until all operations finish", () => {
  const dialog = {
    open: false,
    showCount: 0,
    closeCount: 0,
    showModal() { this.open = true; this.showCount += 1; },
    close() { this.open = false; this.closeCount += 1; },
  };
  const title = { textContent: "" };
  const detail = { textContent: "" };
  const controller = createMutationWaitController(dialog, title, detail);
  const first = controller.begin({ title: "正在应用会话变更", detail: "请等待" });
  assert.equal(dialog.open, true);
  assert.equal(dialog.showCount, 1);
  assert.equal(title.textContent, "正在应用会话变更");

  const second = controller.begin({ title: "正在更新状态", detail: "仍在处理" });
  assert.equal(dialog.showCount, 1);
  assert.equal(title.textContent, "正在更新状态");
  controller.end(second);
  assert.equal(dialog.open, true);
  assert.equal(title.textContent, "正在应用会话变更");
  assert.equal(detail.textContent, "请等待");
  controller.end(first);
  assert.equal(dialog.open, false);
  assert.equal(dialog.closeCount, 1);
});
