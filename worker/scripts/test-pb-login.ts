// Isolated PB-login probe — no tracker, no portal. Just pbLogin() to see if the
// creds + source can authenticate RIGHT NOW. Prints the full error on failure.
import { loadEnvLocal } from "../src/lib/load-env.js";
loadEnvLocal();
const { pbLogin } = await import("../src/uploaders/practicebetter.js");
const u = process.env.PB_USERNAME, p = process.env.PB_PASSWORD;
console.log(`PB login as ${u} …`);
try {
  const s = await pbLogin(u!, p!);
  console.log(`✓ LOGIN OK — userId=${s.userId} companyId=${s.companyId}`);
} catch (e) {
  console.log(`✗ LOGIN FAILED: ${e instanceof Error ? e.message : e}`);
}
