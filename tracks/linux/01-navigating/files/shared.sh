# Lesson 2: a messy shared drive. Reports to sort with a glob, old temp files for find, names with spaces for xargs -0.
set -e -o pipefail
s=~/shared
mkdir -p "$s/reports" "$s/tmp" "$s/Team Notes" "$s/archive/2030"
for m in 01 02 03 04 05 06; do
  for d in 05 20; do echo "date,total" > "$s/reports/report-2031-$m-$d.csv"; done
done
echo "date,total" > "$s/reports/report-2031-02-05.csv.bak"
echo "summary" > "$s/reports/report-2031-q1-summary.txt"
for i in 1 2 3 4 5; do echo tmp > "$s/tmp/build-$i.tmp"; touch -d '45 days ago' "$s/tmp/build-$i.tmp"; done
for i in 1 2 3; do echo tmp > "$s/tmp/session-$i.tmp"; touch -d '2 days ago' "$s/tmp/session-$i.tmp"; done
echo log > "$s/tmp/old-but-keep.log"; touch -d '90 days ago' "$s/tmp/old-but-keep.log"
printf '# Plan for Q2\n- TODO: book the training room\n' > "$s/Team Notes/plan q2.md"
printf '# Retro\nWent well: deploys.\nTODO: fix the flaky test\n' > "$s/Team Notes/retro notes.md"
printf '# Done\nEverything shipped.\n' > "$s/Team Notes/done list.md"
printf 'TODO: archive the 2030 invoices\n' > "$s/archive/2030/read me.txt"
printf 'nothing to do\n' > "$s/archive/2030/invoices.txt"
