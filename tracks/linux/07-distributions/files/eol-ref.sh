# Reference answer for the boss's support report (used by its check): hosts past their support end on 2026-11-26.
asof=2026-11-26
for d in ~/fleet/*/; do
  h=$(basename "$d")
  read -r id v < <(ID= VERSION_ID=; . "$d/os-release"; echo "${ID:-} ${VERSION_ID:-}")
  awk -F, -v id="$id" -v v="$v" -v h="$h" -v asof="$asof" \
    'NR > 1 && $1 == id && (v == $2 || index(v, $2 ".") == 1) && $3 < asof { print h, id, v, $3 }' ~/fleet/support.csv
done
