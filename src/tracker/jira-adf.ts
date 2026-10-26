/**
 * Jira rich text as usable text: an Atlassian Document Format
 * (ADF) description is rendered into readable plain text that preserves its
 * meaning — paragraphs, headings, lists, code, quotes, links, mentions and
 * media are named, not flattened into noise.
 *
 * ADF is neither HTML nor GitHub Markdown, so nothing here parses it as one:
 * the document tree is walked directly and the meaning is kept. The factory
 * supplies this text to a human or a worker; a later slice owns any richer
 * context.
 */

type AdfNode = {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown> | null;
  content?: unknown;
  marks?: unknown;
};

/** Render an ADF document (or a plain string from an older API) as text. */
export function renderAdf(description: unknown): string {
  if (description === null || description === undefined) return "";
  if (typeof description === "string") return description;
  const lines: string[] = [];
  renderBlock(description, 0, lines);
  return trimBlankLines(lines).join("\n");
}

/** One top-level or nested block, appended as one or more lines. */
function renderBlock(node: unknown, depth: number, lines: string[]): void {
  if (node === null || typeof node !== "object") return;
  const shape = node as AdfNode;
  switch (shape.type) {
    case "doc":
      for (const child of children(shape)) renderBlock(child, depth, lines);
      return;
    case "paragraph": {
      const text = inline(shape);
      if (text !== "") lines.push(text);
      lines.push("");
      return;
    }
    case "heading": {
      const text = inline(shape);
      if (text !== "") lines.push(text);
      lines.push("");
      return;
    }
    case "bulletList":
      for (const child of children(shape)) renderListItem(child, depth, lines, "- ");
      lines.push("");
      return;
    case "orderedList":
      for (const [index, child] of children(shape).entries()) {
        renderListItem(child, depth, lines, `${index + 1}. `);
      }
      lines.push("");
      return;
    case "codeBlock": {
      lines.push(`  ${String(shape.attrs?.["language"] ?? "code")} block:`);
      for (const line of inline(shape).split("\n")) lines.push(`    ${line}`);
      lines.push("");
      return;
    }
    case "blockquote":
      for (const child of children(shape)) {
        const quoted: string[] = [];
        renderBlock(child, depth, quoted);
        for (const line of quoted) {
          if (line !== "") lines.push(`> ${line}`);
        }
      }
      lines.push("");
      return;
    case "rule":
      lines.push("---", "");
      return;
    case "table": {
      for (const row of children(shape)) {
        const cells = children(row).map((cell) => inline(cell).replace(/\s+/g, " ").trim());
        lines.push(`| ${cells.join(" | ")} |`);
      }
      lines.push("");
      return;
    }
    case "mediaSingle":
    case "mediaGroup":
    case "mediaInline":
      lines.push(...children(shape).map(mediaText));
      lines.push("");
      return;
    case "panel":
    case "expand":
    case "nestedExpand": {
      for (const child of children(shape)) renderBlock(child, depth, lines);
      return;
    }
    case "text":
      lines.push(inline(shape));
      return;
    default:
      // An unknown block (task list, decision list, a future node) keeps its
      // children: an unfamiliar wrapper never erases the request's content.
      for (const child of children(shape)) renderBlock(child, depth, lines);
  }
}

/** A list item: nested blocks indent under its marker. */
function renderListItem(node: unknown, depth: number, lines: string[], marker: string): void {
  const nested: string[] = [];
  renderBlock(node, depth + 1, nested);
  const [first = "", ...rest] = trimBlankLines(nested);
  if (first === "") return;
  const indent = "  ".repeat(depth);
  lines.push(`${indent}${marker}${first}`);
  for (const line of rest) {
    lines.push(line === "" ? "" : `${indent}  ${line}`);
  }
}

/** The inline text of a block, with its marks rendered as text. */
function inline(node: unknown): string {
  if (node === null || typeof node !== "object") return "";
  const shape = node as AdfNode;
  if (shape.type === "text") {
    const text = typeof shape.text === "string" ? shape.text : "";
    return applyMarks(text, shape.marks);
  }
  if (shape.type === "hardBreak") return "\n";
  if (shape.type === "mention") return `@${String(shape.attrs?.["text"] ?? "someone")}`;
  if (shape.type === "emoji") return String(shape.attrs?.["text"] ?? shape.attrs?.["shortName"] ?? "");
  if (shape.type === "inlineCard" || shape.type === "blockCard") {
    return String(shape.attrs?.["url"] ?? "");
  }
  if (shape.type === "mediaInline" || shape.type === "media") return mediaText(shape);
  return children(shape).map(inline).join("");
}

function applyMarks(text: string, marks: unknown): string {
  if (!Array.isArray(marks)) return text;
  let rendered = text;
  for (const mark of marks) {
    if (mark === null || typeof mark !== "object") continue;
    const shape = mark as { type?: unknown; attrs?: Record<string, unknown> | null };
    if (shape.type === "link" && typeof shape.attrs?.["href"] === "string") {
      rendered = `${rendered} (${shape.attrs["href"]})`;
    }
    // Named marks (strong, em, code, strike, underline) add emphasis, not
    // different words: the text itself is the meaning the reader needs.
  }
  return rendered;
}

function mediaText(node: unknown): string {
  const attrs = (node as AdfNode).attrs ?? {};
  const alt = typeof attrs["alt"] === "string" ? attrs["alt"] : "";
  return alt === "" ? "[media]" : `[media: ${alt}]`;
}

function children(node: unknown): unknown[] {
  if (node === null || typeof node !== "object") return [];
  const content = (node as AdfNode).content;
  return Array.isArray(content) ? content : [];
}

function trimBlankLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[0] === "") trimmed.shift();
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
  return trimmed;
}
