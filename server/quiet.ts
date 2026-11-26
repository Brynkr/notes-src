// node:sqlite prints an "experimental" warning on load. It's stable enough for
// a disposable search index, so hide just that one warning. Imported first by
// main.ts; search.ts loads node:sqlite lazily so this runs before it.
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (typeof text === "string" && text.includes("SQLite is an experimental")) return;
  return (original as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
