// Dump every labrequest PB returns for Leila to confirm whether the items
// Alex saw on the /labs view are present-but-mismatched or genuinely
// returned from a different endpoint.

import { loadEnvLocal } from "../src/lib/load-env.js";
import {
  pbLogin,
  findPbPatient,
  listAllConsultantLabRequests,
} from "../src/uploaders/practicebetter.js";

loadEnvLocal();

async function main() {
  const session = await pbLogin(process.env.PB_USERNAME!, process.env.PB_PASSWORD!);
  const p = await findPbPatient(session, "Leila Centner", "1976-12-28");
  if (!p) throw new Error("not found");
  const all = await listAllConsultantLabRequests(session, { limit: 2000 });
  const leila = all.filter((lr) => lr.clientRecord?.id === p.id);
  console.log(`Leila labrequests: ${leila.length}`);
  leila
    .sort((a, b) => (a.dateOrdered ?? "").localeCompare(b.dateOrdered ?? ""))
    .forEach((lr) => {
      console.log(
        `${(lr.dateOrdered ?? "       ").slice(0, 10)}  status=${(lr.status ?? "").padEnd(12)}  ${lr.id}  "${lr.name}"`,
      );
    });
}

main().catch((err) => { console.error(err); process.exit(1); });
