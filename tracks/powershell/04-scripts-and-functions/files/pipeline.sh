# Lesson 2: an archive of logs with known ages (a pristine copy for the checks), new hires to onboard,
# and empty script files for the learner's functions.
set -e -o pipefail
mkdir -p ~/scripts ~/logs/archive ~/data ~/homes /opt/dojo/state
cd ~/logs/archive
for spec in "app-1.log 5" "app-2.log 20" "app-3.log 31" "app-4.log 45" "app-5.log 90"; do
  set -- $spec; echo "log $1" > "$1"; touch -d "$2 days ago" "$1"
done
rm -rf /opt/dojo/state/archive && cp -a ~/logs/archive /opt/dojo/state/archive && chmod -R a+rwX /opt/dojo/state
cat > ~/data/new-hires.csv <<'EOF'
UserName,Department,StartDate
asha.k,Engineering,2026-12-01
li.wen,Sales,2026-12-01
tom.b,Finance,2026-12-08
mira.s,Engineering,2026-12-08
joe.x,Marketing,2026-12-15
EOF
printf '# LogTools.ps1: log helpers. Write Remove-OldLog here.\n' > ~/scripts/LogTools.ps1
printf '# Onboarding.ps1: helpers for new starters. Write New-HomeFolder here.\n' > ~/scripts/Onboarding.ps1
