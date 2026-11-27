// Puts the real plans in this folder into the lessons' "tfplan" cards (ui/tfplan.js). A card names its plan with
// "source" and must end its line with the plan, which this script rewrites:
//
//   "tfplan": { "title": "...", "focus": "...", "source": "plans/web-review.json", "plan": {} }
//
// Each plans/*.json is `terraform show -json plan.tfplan | jq -c -f plans/trim.jq` (sensitive values blanked), made in
// the terraform image from the scenario script named in the lesson (or from plans/aws-pr/make.sh for the AWS plans).
// Run from the repository root:  node tracks/terraform/plans/inline.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const track = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(track).filter(d => statSync(join(track, d)).isDirectory())
  .flatMap(d => readdirSync(join(track, d)).filter(f => f.endsWith('.json') && f !== 'module.json').map(f => join(track, d, f)));
let n = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const out = text.replace(/("source": "(plans\/[^"]+\.json)", "plan": ).*$/gm, (_, head, src) => {
    n++;
    return `${head}${JSON.stringify(JSON.parse(readFileSync(join(track, src), 'utf8')))} }`;
  });
  if (out !== text) { JSON.parse(out); writeFileSync(file, out); console.log(`${file.slice(track.length + 1)}: plans inlined`); }
}
console.log(`${n} plan card(s)`);
