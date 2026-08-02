const pendingForms = new WeakMap();

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function restoreForm(form, wasInert) {
  delete form.dataset.pendingInert;
  form.inert = wasInert;
  if (!wasInert) form.removeAttribute("inert");
  form.removeAttribute("aria-busy");
}

export function setFormPending(form, next) {
  if (!form) return;
  if (next) {
    const current = pendingForms.get(form);
    if (current) {
      current.depth += 1;
    } else {
      const wasInert = form.inert === true;
      pendingForms.set(form, { depth: 1, wasInert });
      form.dataset.pendingInert = String(wasInert);
    }
    form.inert = true;
    form.setAttribute("aria-busy", "true");
    return;
  }

  const current = pendingForms.get(form);
  if (current && current.depth > 1) {
    current.depth -= 1;
    return;
  }
  if (current) {
    pendingForms.delete(form);
    restoreForm(form, current.wasInert);
    return;
  }
  if (hasOwn(form.dataset, "pendingInert")) {
    restoreForm(form, form.dataset.pendingInert === "true");
  }
}

export function resetFormPending(form) {
  if (!form) return;
  pendingForms.delete(form);
  restoreForm(form, false);
}

export function createMutationWaitController(dialog, titleElement, detailElement) {
  const active = new Map();
  let sequence = 0;

  const render = () => {
    const latest = [...active.values()].at(-1);
    if (!latest) {
      if (dialog.open) dialog.close();
      return;
    }
    titleElement.textContent = latest.title;
    detailElement.textContent = latest.detail;
    if (!dialog.open) dialog.showModal();
  };

  return {
    begin(presentation) {
      const token = ++sequence;
      active.set(token, presentation);
      render();
      return token;
    },
    end(token) {
      if (token === null || token === undefined) return;
      active.delete(token);
      render();
    },
    reset() {
      active.clear();
      render();
    },
  };
}
