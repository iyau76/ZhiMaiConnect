/**
 * Copy text with a desktop-safe fallback.
 *
 * The Electron shell only grants a narrow permission allowlist, so
 * `navigator.clipboard.writeText` can reject even though the API exists. The
 * legacy `document.execCommand("copy")` path still works there; both paths are
 * attempted and the real outcome is reported so the caller can show failure
 * instead of silently pretending the copy succeeded.
 */
export async function copyText(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}
