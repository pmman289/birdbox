import { dispatchToast } from "./events";

function controlLabel(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string {
  const label = [...control.labels ?? []]
    .map((item) => item.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .find(Boolean);
  return label || control.getAttribute("aria-label") || control.name || control.id || "输入项";
}

export function clearFormValidation(form: HTMLFormElement): void {
  form.classList.remove("validation-attempted");
  form.querySelectorAll(".field-invalid").forEach((field) => field.classList.remove("field-invalid"));
  form.querySelectorAll('[aria-invalid="true"]').forEach((field) => field.removeAttribute("aria-invalid"));
}

export function revealAndFocus(control: HTMLElement): void {
  for (let details = control.closest("details"); details; details = details.parentElement?.closest("details") ?? null) {
    details.open = true;
  }
  requestAnimationFrame(() => {
    control.scrollIntoView({ behavior: "smooth", block: "center" });
    control.focus({ preventScroll: true });
  });
}

export function markFieldInvalid(form: HTMLFormElement, control: HTMLElement): void {
  form.classList.add("validation-attempted");
  control.setAttribute("aria-invalid", "true");
  control.closest(".field, .channel-enable-row, .toggle-row")?.classList.add("field-invalid");
  revealAndFocus(control);
}

export function validateForm(form: HTMLFormElement): boolean {
  if (form.checkValidity()) {
    clearFormValidation(form);
    return true;
  }
  clearFormValidation(form);
  form.classList.add("validation-attempted");
  const controls = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(":invalid")];
  for (const control of controls) {
    control.setAttribute("aria-invalid", "true");
    control.closest(".field, .channel-enable-row, .toggle-row")?.classList.add("field-invalid");
  }
  const first = controls[0];
  if (!first) return false;
  dispatchToast(`请检查“${controlLabel(first)}”：${first.validationMessage}`, "error");
  revealAndFocus(first);
  return false;
}

export function presentFormError(
  form: HTMLFormElement,
  error: unknown,
  mappings: ReadonlyArray<readonly [RegExp, string]>,
): void {
  const message = error instanceof Error ? error.message : "表单提交失败";
  const fieldId = mappings.find(([pattern]) => pattern.test(message))?.[1];
  const control = fieldId ? form.querySelector<HTMLElement>(`#${CSS.escape(fieldId)}`) : null;
  if (control) markFieldInvalid(form, control);
  dispatchToast(message, "error");
}
