using System.Text.Json.Nodes;

namespace CodeDojo;

/// <summary>
/// `dojo validate` for the Terraform topic's plan review cards (<c>"tfplan"</c>, drawn by ui/tfplan.js). The card holds the
/// JSON of a real <c>terraform show -json plan.tfplan</c> (trimmed to the parts the card reads). This checks that it still
/// looks like one: a format version, resource changes with addresses and known actions, replace paths that point at
/// attributes, a focus that exists, and no unmasked secrets (values Terraform marked sensitive must be blanked).
/// </summary>
public static class TfPlan
{
    static readonly HashSet<string> Actions = ["no-op", "create", "read", "update", "delete", "forget"];

    public static IEnumerable<string> Check(JsonObject step)
    {
        if (step["tfplan"] is not { } node) yield break;
        if ((string?)step["type"] != "learn") yield return "\"tfplan\" only works on learn cards";
        if (node is not JsonObject card) { yield return "\"tfplan\" must be an object"; yield break; }
        if (card["plan"] is not JsonObject plan) { yield return "\"tfplan\" needs \"plan\": the JSON of `terraform show -json plan.tfplan`"; yield break; }
        if ((string?)plan["format_version"] is not { Length: > 0 }) yield return "tfplan plan has no \"format_version\" (is it really `terraform show -json` output?)";
        if (plan["resource_changes"] is not JsonArray changes || changes.Count == 0) { yield return "tfplan plan has no \"resource_changes\""; yield break; }
        var addresses = new HashSet<string>();
        foreach (var rc in changes.OfType<JsonObject>())
        {
            var addr = (string?)rc["address"];
            if (addr is not { Length: > 0 }) { yield return "every tfplan resource change has an \"address\""; continue; }
            if (!addresses.Add(addr)) yield return $"tfplan: {addr} appears twice in resource_changes";
            if (rc["change"] is not JsonObject change || change["actions"] is not JsonArray acts || acts.Count is 0 or > 2) { yield return $"tfplan: {addr} needs change.actions"; continue; }
            foreach (var a in acts) if (!Actions.Contains((string?)a ?? "")) yield return $"tfplan: {addr} has an unknown action \"{a}\"";
            if (acts.Count == 2 && !acts.Select(a => (string?)a).OrderBy(a => a).SequenceEqual(["create", "delete"])) yield return $"tfplan: {addr}: two actions must be create and delete (a replacement)";
            foreach (var p in change["replace_paths"] as JsonArray ?? [])
                if (p is not JsonArray { Count: > 0 }) yield return $"tfplan: {addr}: every replace path is an array of attribute names and indexes";
            if (Leaked(change["before"], change["before_sensitive"]) || Leaked(change["after"], change["after_sensitive"]))
                yield return $"tfplan: {addr} shows a value Terraform marked sensitive: blank it (set it to null) before putting the plan in a lesson";
        }
        if ((string?)card["focus"] is { } focus && !addresses.Contains(focus)) yield return $"tfplan \"focus\": {focus} is not in resource_changes";
    }

    /// <summary>Is there a non-null value where the sensitivity marks say true?</summary>
    static bool Leaked(JsonNode? value, JsonNode? marks) => (value, marks) switch
    {
        (null, _) => false,
        (_, JsonValue m) when m.TryGetValue<bool>(out var b) => b,
        (JsonObject o, JsonObject mo) => mo.Any(kv => Leaked(o[kv.Key], kv.Value)),
        (JsonArray a, JsonArray ma) => ma.Select((m, i) => i < a.Count && Leaked(a[i], m)).Any(x => x),
        _ => false,
    };
}
