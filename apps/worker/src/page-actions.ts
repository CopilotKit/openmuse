import type { Page } from "playwright";
import { WorkerError } from "./errors.ts";

export const MAX_ELEMENTS = 250;

/**
 * Element names that mean an outward or irreversible step (buying, sending, deleting,
 * booking, signing up). Clicking one, or submitting a form that contains one, needs the
 * person's explicit confirmation.
 */
export const CONSEQUENTIAL =
  /\b(?:buy|purchase|pay|checkout|check out|place order|order now|subscribe|donate|send|submit|post|publish|delete|remove|confirm|book|reserve|sign up|register|transfer|accept|agree|apply(?!\s+(?:filters?|search)))\b|kaufen|bestellen|bezahlen|absenden|senden|löschen|bestätigen|buchen|registrieren|bewerben|abonnieren|akzeptieren|zustimmen/i;

const KEYS =
  /^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)$/;

export type PageElement = {
  ref: number;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  sensitive?: boolean;
  needsConfirmation?: boolean;
  href?: string;
  options?: string[];
  inView: boolean;
};
export type PageElements = {
  url: string;
  title: string;
  elements: PageElement[];
  truncated: boolean;
  scroll: { y: number; height: number; viewport: number };
};
export type PageAction =
  | { action: "click"; ref: number; confirmed: boolean }
  | { action: "type"; ref: number; text: string; submit: boolean; confirmed: boolean }
  | { action: "select"; ref: number; option: string }
  | { action: "check"; ref: number; checked: boolean }
  | { action: "press"; key: string; confirmed: boolean }
  | { action: "scroll"; direction: "up" | "down" };

// Page scripts are plain JavaScript strings so no build tool can wrap them with helpers
// that do not exist inside the page. Callers cannot inject code: only validated integers
// and a fixed regular expression are interpolated.
const COLLECT = String.raw`(limit, riskySource) => {
  const risky = new RegExp(riskySource, "i");
  const clip = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const selector = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]",
    "[role=menuitem]", "[role=option]", "[role=combobox]", "[role=textbox]", "[role=searchbox]",
    "[role=switch]", "[contenteditable=''], [contenteditable=true]",
  ].join(",");
  for (const old of document.querySelectorAll("[data-openmuse-ref]")) {
    old.removeAttribute("data-openmuse-ref");
    old.removeAttribute("data-openmuse-name");
  }
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (clip(aria)) return clip(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (clip(text)) return clip(text);
    }
    if (el.labels && el.labels.length) {
      const text = [...el.labels].map((label) => label.textContent).join(" ");
      if (clip(text)) return clip(text);
    }
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLTextAreaElement) && clip(el.innerText))
      return clip(el.innerText);
    const button = el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type) ? el.value : "";
    return clip(el.getAttribute("placeholder") || button || el.getAttribute("title") || el.getAttribute("alt") || el.querySelector("img[alt]")?.getAttribute("alt") || el.getAttribute("name") || "");
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (el instanceof HTMLAnchorElement) return "link";
    if (el instanceof HTMLSelectElement) return "combobox";
    if (el instanceof HTMLTextAreaElement || el.isContentEditable) return "textbox";
    if (el instanceof HTMLInputElement) {
      if (el.type === "checkbox" || el.type === "radio") return el.type;
      if (["button", "submit", "reset", "image"].includes(el.type)) return "button";
      if (el.type === "search") return "searchbox";
      if (el.type === "range") return "slider";
      return "textbox";
    }
    return "button";
  };
  const sensitiveOf = (el) =>
    el instanceof HTMLInputElement &&
    (el.type === "password" || /cc-|one-time-code|current-password|new-password/.test(el.autocomplete || ""));
  const elements = [];
  let matched = 0;
  for (const el of document.querySelectorAll(selector)) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!rect.width || !rect.height || style.visibility === "hidden" || style.display === "none") continue;
    if (el.closest("[aria-hidden=true], [inert]")) continue;
    matched++;
    if (elements.length >= limit) continue;
    const ref = elements.length + 1;
    const name = nameOf(el);
    el.setAttribute("data-openmuse-ref", String(ref));
    el.setAttribute("data-openmuse-name", name);
    const entry = { ref, role: roleOf(el), name, inView: rect.bottom > 0 && rect.top < innerHeight };
    const sensitive = sensitiveOf(el);
    if (sensitive) entry.sensitive = true;
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) entry.checked = el.checked;
    else if (el.getAttribute("aria-checked")) entry.checked = el.getAttribute("aria-checked") === "true";
    else if (!sensitive && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && clip(el.value))
      entry.value = clip(el.value);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") entry.disabled = true;
    if (risky.test(name)) entry.needsConfirmation = true;
    if (el instanceof HTMLAnchorElement) entry.href = el.href.slice(0, 300);
    if (el instanceof HTMLSelectElement) entry.options = [...el.options].slice(0, 25).map((option) => clip(option.label));
    elements.push(entry);
  }
  return {
    url: location.href,
    title: document.title.slice(0, 300),
    elements,
    truncated: matched > elements.length,
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight },
  };
}`;

const INSPECT = String.raw`(ref, riskySource) => {
  const risky = new RegExp(riskySource, "i");
  const el = ref > 0 ? document.querySelector('[data-openmuse-ref="' + ref + '"]') : document.activeElement;
  if (!el || el === document.body) return null;
  const name = el.getAttribute("data-openmuse-name") || "";
  const sensitive =
    el instanceof HTMLInputElement &&
    (el.type === "password" || /cc-|one-time-code|current-password|new-password/.test(el.autocomplete || ""));
  const form = el.form || el.closest("form");
  const formRisky =
    !!form &&
    [...form.querySelectorAll("button, input[type=submit], input[type=button]")].some((button) =>
      risky.test(String(button.getAttribute("aria-label") || button.innerText || button.value || "").trim()),
    );
  return { name, sensitive, risky: risky.test(name), formRisky };
}`;

type Inspection = { name: string; sensitive: boolean; risky: boolean; formRisky: boolean };

const invalid = (message: string) => new WorkerError("INVALID_INPUT", message, 400);
const ref = (value: unknown) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10_000)
    throw invalid("Use a ref number from the latest element list.");
  return value;
};

export function parseAction(input: Record<string, unknown>): PageAction {
  const confirmed = input.confirmed === true;
  switch (input.action) {
    case "click":
      return { action: "click", ref: ref(input.ref), confirmed };
    case "type":
      if (typeof input.text !== "string" || input.text.length > 10_000)
        throw invalid("Provide the text to type, up to 10000 characters.");
      return {
        action: "type",
        ref: ref(input.ref),
        text: input.text,
        submit: input.submit === true,
        confirmed,
      };
    case "select":
      if (typeof input.option !== "string" || !input.option || input.option.length > 500)
        throw invalid("Provide the option to choose.");
      return { action: "select", ref: ref(input.ref), option: input.option };
    case "check":
      if (typeof input.checked !== "boolean") throw invalid("Say whether to check or uncheck.");
      return { action: "check", ref: ref(input.ref), checked: input.checked };
    case "press":
      if (typeof input.key !== "string" || !KEYS.test(input.key))
        throw invalid("Unsupported key. Use Enter, Tab, Escape, arrows, Page keys or Space.");
      return { action: "press", key: input.key, confirmed };
    case "scroll":
      if (input.direction !== "up" && input.direction !== "down")
        throw invalid("Scroll up or down.");
      return { action: "scroll", direction: input.direction };
    default:
      throw invalid("Unsupported page action.");
  }
}

export function listElements(page: Page): Promise<PageElements> {
  return page.evaluate(`(${COLLECT})(${MAX_ELEMENTS}, ${JSON.stringify(CONSEQUENTIAL.source)})`);
}

async function inspect(page: Page, target: number) {
  const found = (await page.evaluate(
    `(${INSPECT})(${target}, ${JSON.stringify(CONSEQUENTIAL.source)})`,
  )) as Inspection | null;
  return found;
}

function needsConfirmation(step: string) {
  return new WorkerError(
    "CONFIRMATION_REQUIRED",
    `${step} may buy, send, submit, delete, book or sign up for something. Ask the person to confirm this exact step in chat, then repeat it with confirmedByUser set to true.`,
    409,
  );
}

/** Performs one validated action and returns the name of the element it used. */
export async function performAction(page: Page, action: PageAction): Promise<string | undefined> {
  if (action.action === "scroll") {
    await page.mouse.wheel(0, action.direction === "down" ? 700 : -700);
    return undefined;
  }
  const target = action.action === "press" ? 0 : action.ref;
  const element = await inspect(page, target);
  if (action.action === "press") {
    if (action.key === "Enter" && element?.formRisky && !action.confirmed)
      throw needsConfirmation("Pressing Enter here submits a form that");
    await page.keyboard.press(action.key);
    return element?.name || undefined;
  }
  if (!element)
    throw new WorkerError(
      "ELEMENT_NOT_FOUND",
      "That element is no longer on the page. List the elements again.",
      404,
    );
  const locator = page.locator(`[data-openmuse-ref="${action.ref}"]`);
  try {
    if (action.action === "click") {
      if (element.risky && !action.confirmed) throw needsConfirmation(`Clicking “${element.name}”`);
      await locator.click({ timeout: 10_000 });
    } else if (action.action === "type") {
      if (element.sensitive)
        throw new WorkerError(
          "SENSITIVE_FIELD",
          "Passwords, payment details and one-time codes must be entered by the person with Take control.",
          403,
        );
      if (action.submit && element.formRisky && !action.confirmed)
        throw needsConfirmation("Submitting this form");
      await locator.fill(action.text, { timeout: 10_000 });
      if (action.submit) await locator.press("Enter", { timeout: 10_000 });
    } else if (action.action === "select") {
      await locator
        .selectOption({ label: action.option }, { timeout: 10_000 })
        .catch(() => locator.selectOption(action.option, { timeout: 10_000 }));
    } else {
      await locator.setChecked(action.checked, { timeout: 10_000 });
    }
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError(
      "ACTION_FAILED",
      "The page did not accept that action. List the elements again, or ask the person to take control.",
      422,
    );
  }
  return element.name || undefined;
}
