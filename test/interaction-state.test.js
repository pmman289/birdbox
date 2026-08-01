import test from "node:test";
import assert from "node:assert/strict";

import { resetFormPending, setFormPending } from "../public/interaction-state.js";

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
