interface PendingForm {
  dataset: Record<string, string | undefined>;
  inert: boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface PendingState {
  depth: number;
  wasInert: boolean;
}

interface MutationWaitDialog {
  open: boolean;
  showModal(): void;
  close(): void;
}

interface TextTarget {
  textContent: string | null;
}

export interface MutationWaitPresentation {
  title: string;
  detail: string;
}

export interface MutationWaitController {
  begin(presentation: MutationWaitPresentation): number;
  end(token: number | null | undefined): void;
  reset(): void;
}

const pendingForms = new WeakMap<PendingForm, PendingState>();

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function restoreForm(form: PendingForm, wasInert: boolean): void {
  delete form.dataset.pendingInert;
  form.inert = wasInert;
  if (!wasInert) form.removeAttribute("inert");
  form.removeAttribute("aria-busy");
}

export function setFormPending(form: PendingForm | null | undefined, next: boolean): void {
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
  if (hasOwn(form.dataset, "pendingInert")) restoreForm(form, form.dataset.pendingInert === "true");
}

export function resetFormPending(form: PendingForm | null | undefined): void {
  if (!form) return;
  pendingForms.delete(form);
  restoreForm(form, false);
}

export function createMutationWaitController(
  dialog: MutationWaitDialog,
  titleElement: TextTarget,
  detailElement: TextTarget,
): MutationWaitController {
  const active = new Map<number, MutationWaitPresentation>();
  let sequence = 0;

  const render = (): void => {
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
