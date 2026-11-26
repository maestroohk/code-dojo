# Reference answer for the boss's upgrade report: "name installed -> newest" for every installed package
# that has a newer version in ~/available.txt, sorted by name. Versions are compared by dpkg itself.
sort -k1,1 ~/available.txt | awk '{print $1}' | uniq | while read -r name; do
  have=$(dpkg-query -W -f='${Version}' "$name" 2>/dev/null) || continue
  [ -n "$have" ] || continue
  best=
  while read -r n v; do
    [ "$n" = "$name" ] || continue
    if [ -z "$best" ] || dpkg --compare-versions "$v" gt "$best"; then best=$v; fi
  done < ~/available.txt
  if dpkg --compare-versions "$best" gt "$have"; then echo "$name $have -> $best"; fi
done
