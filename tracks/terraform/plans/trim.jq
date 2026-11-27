def blank($m):
  if $m == true then null
  elif ($m | type) == "object" and type == "object" then with_entries(.key as $k | .value |= blank($m[$k]))
  elif ($m | type) == "array" and type == "array" then [to_entries[] | .key as $i | .value | blank($m[$i])]
  else . end;
def clean: .change as $c
  | .change.before = ($c.before | blank($c.before_sensitive))
  | .change.after = ($c.after | blank($c.after_sensitive))
  | del(.change.before_identity, .change.after_identity);
{format_version, terraform_version,
 resource_changes: [.resource_changes[] | clean],
 resource_drift: ([.resource_drift[]? | clean] | if length == 0 then null else . end),
 output_changes,
 configuration: (.configuration | del(.provider_config))}
| with_entries(select(.value != null))
