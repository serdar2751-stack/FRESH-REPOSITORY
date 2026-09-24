import { randomBytes } from "node:crypto";

let lastTime = 0;
let counter = 0;

/** Time-sortable unique id, e.g. `ses_0mf3k2a1b000a1b2c3d4`. */
export function newId(prefix: string): string {
  const now = Date.now();
  if (now === lastTime) counter++;
  else {
    lastTime = now;
    counter = 0;
  }
  const time = now.toString(36).padStart(9, "0");
  const seq = counter.toString(36).padStart(3, "0");
  return `${prefix}_${time}${seq}${randomBytes(4).toString("hex")}`;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
