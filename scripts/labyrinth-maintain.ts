#!/usr/bin/env -S node --experimental-strip-types
import { maintainLabyrinth } from "../packages/lbrnth/src/operator.ts";
const [action, source, destination, ...extra] = process.argv.slice(2);
if (!action || !source || extra.length || !["verify", "backup", "rotate"].includes(action) || (action !== "verify" && !destination) || (action === "verify" && destination)) {
  console.error("Usage: node scripts/labyrinth-maintain.ts verify SNAPSHOT | backup SNAPSHOT NEW_FILE | rotate SNAPSHOT NEW_FILE");
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(maintainLabyrinth(action, source, destination, process.env))); }
  catch { console.error("Maintenance failed. Check the key configuration, snapshot integrity, destination and writer lock. No keys or source content are logged. Stop the host before maintenance; never remove a lock until no writer is running."); process.exitCode = 1; }
}
