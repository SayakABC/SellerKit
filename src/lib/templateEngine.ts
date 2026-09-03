export function renderTemplate(template: string, fields: Record<string, string>): string {
  return template.replace(/\{\{(.+?)\}\}/g, (match, key) => {
    const trimmedKey = key.trim();
    return fields[trimmedKey] ?? `[字段缺失: ${trimmedKey}]`;
  });
}

export function previewTemplate(
  template: string,
  fields: Record<string, string>
): { html: string; hasMissing: boolean } {
  let hasMissing = false;
  // Escape HTML first
  const escapeHtml = (str: string) =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = escapeHtml(template).replace(
    /\{\{(.+?)\}\}/g,
    (match, key: string) => {
      const trimmedKey = key.trim();
      const value = fields[trimmedKey];
      if (value === undefined || value === null) {
        hasMissing = true;
        return `<span class="text-[var(--wb-danger)] font-semibold">[字段缺失: ${escapeHtml(trimmedKey)}]</span>`;
      }
      return `<span class="text-[var(--wb-primary)] font-medium">${escapeHtml(value)}</span>`;
    }
  );

  return { html, hasMissing };
}

export function extractPlaceholders(template: string): string[] {
  const matches = template.match(/\{\{(.+?)\}\}/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, '').trim()))];
}
