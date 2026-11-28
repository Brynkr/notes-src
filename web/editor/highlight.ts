// Code colours from the theme, used by code files and by code fences in notes.
// Kept apart from the (large, lazily loaded) language parsers.

import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** Code colours from the theme: accent keywords, string colour for literals, quiet comments. */
export const codeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: "var(--accent)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "var(--ok)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--warn)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], fontWeight: "600" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "var(--muted)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--accent)" },
  { tag: t.attributeName, color: "var(--warn)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--muted)" },
  { tag: t.invalid, color: "var(--bad)" },
]);
