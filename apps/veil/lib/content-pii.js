/**
 * VEIL personal-data form check (content script, classic).
 *
 * Runs before content.js in the extension's isolated world. It is not a
 * web-accessible resource, so pages cannot detect or call it.
 *
 * It looks at the fields in a form being submitted. Pattern rules spot
 * personal data: email, phone, payment card (Luhn-checked), national ID
 * numbers, street address, date of birth, password. The form is held for a
 * one-tap confirmation when that data would leave without encryption, or
 * would go to a different site than the page. Everything runs on the page;
 * nothing is sent anywhere. Unit tests load it with node:vm.
 */
(function (root) {
  "use strict";

  function luhn(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  const NAME_RULES = [
    ["email", /e-?mail/i],
    ["phone", /(^|[^a-z])(phone|tel|mobile|cell)([^a-z]|$)/i],
    ["card", /(card.?num|cc.?num|cardnumber|credit.?card|^pan$)/i],
    ["national-id", /(ssn|social.?security|national.?id|nin$|passport|tax.?id|^sin$)/i],
    ["address", /(street|address.?line|addr1|postcode|zip.?code|postal)/i],
    ["birthdate", /(birth|dob|bday)/i],
  ];
  const AUTOCOMPLETE = {
    email: "email", tel: "phone", "tel-national": "phone", "cc-number": "card", "cc-csc": "card",
    "street-address": "address", "address-line1": "address", "postal-code": "address", bday: "birthdate",
    "current-password": "password", "new-password": "password",
  };

  /** Kinds of personal data in one field, from its type, name and value. */
  function fieldKinds(field) {
    const kinds = new Set();
    const type = String(field.type || "").toLowerCase();
    const value = String(field.value || "").trim();
    if (!value || type === "hidden" || type === "submit" || type === "button" || type === "checkbox" || type === "radio") return kinds;
    if (type === "password") kinds.add("password");
    if (type === "email") kinds.add("email");
    if (type === "tel") kinds.add("phone");
    const ac = String(field.autocomplete || "").toLowerCase().split(/\s+/).pop();
    if (AUTOCOMPLETE[ac]) kinds.add(AUTOCOMPLETE[ac]);
    const label = `${field.name || ""} ${field.id || ""}`;
    for (const [kind, re] of NAME_RULES) if (re.test(label)) kinds.add(kind);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) kinds.add("email");
    const digits = value.replace(/[\s-]/g, "");
    if (/^\d{13,19}$/.test(digits) && luhn(digits)) kinds.add("card");
    if (/^\d{3}-\d{2}-\d{4}$/.test(value)) kinds.add("national-id");
    return kinds;
  }

  function formKinds(fields) {
    const all = new Set();
    for (const f of fields) for (const k of fieldKinds(f)) all.add(k);
    return [...all];
  }

  function site(host) {
    const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
    return parts.slice(-2).join(".");
  }

  const onion = (host) => /(^|\.)onion$/i.test(String(host || ""));
  const local = (host) => /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(String(host || ""));

  /**
   * @param {string} pageUrl
   * @param {string} actionUrl where the form submits (resolved)
   * @param {string[]} kinds from formKinds
   * @returns {string[]} reasons to confirm first; empty when it is fine to send
   */
  function reasons(pageUrl, actionUrl, kinds) {
    if (!kinds.length) return [];
    let page, action;
    try { page = new URL(pageUrl); action = new URL(actionUrl, pageUrl); } catch { return []; }
    if (action.protocol !== "http:" && action.protocol !== "https:") return [];
    if (onion(action.hostname)) return [];
    const out = [];
    if (action.protocol === "http:" && !local(action.hostname)) out.push("insecure");
    if (site(action.hostname) !== site(page.hostname)) out.push("other-site");
    return out;
  }

  const KIND_LABEL = {
    email: "your email", phone: "a phone number", card: "a payment card number", "national-id": "an ID number",
    address: "an address", birthdate: "a date of birth", password: "a password",
  };

  function message(kinds, why, actionHost) {
    const what = kinds.map((k) => KIND_LABEL[k] ?? k).join(", ");
    const parts = [];
    if (why.includes("insecure")) parts.push("without encryption (plain HTTP)");
    if (why.includes("other-site")) parts.push(`to a different site (${actionHost})`);
    return `VEIL: this form is about to send ${what} ${parts.join(" and ")}. Send it anyway?`;
  }

  root.VeilPII = Object.freeze({ luhn, fieldKinds: (f) => [...fieldKinds(f)], formKinds, reasons, message });
})(globalThis);
