// Note files under a notes folder, as "/"-separated paths ("Home/…", "Work/…"),
// skipping hidden folders such as .git and .trash.
import fs from "node:fs";

export function noteFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => f.split("\\").join("/"))
    .filter((f) => f.endsWith(".md") && !f.split("/").some((s) => s.startsWith(".")))
    .sort();
}
