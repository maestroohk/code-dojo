# Lesson 3: staged and unstaged changes, a whitespace-only change, and a file staged by mistake.
. "$DOJO_FILES/lib.sh"
fresh_repo ~/shop
write src/Cart.cs "class Cart" "{" "    decimal Total(decimal sum) => sum;" "    int Count() => 0;" "}"
write src/Config.cs "class Config" "{" "    public int Port = 8080;" "    public string Host = \"localhost\";" "}"
write src/Api.cs "class Api" "{" "}"
commit "Start the shop"
# Staged: the rounding fix. Then an unstaged edit on top of it.
write src/Cart.cs "class Cart" "{" "    decimal Total(decimal sum) => Math.Round(sum, 2);" "    int Count() => 0;" "}"
git add src/Cart.cs
write src/Cart.cs "class Cart" "{" "    decimal Total(decimal sum) => Math.Round(sum, 2);" "    int Count() => items.Count;" "}"
# Only the indentation changed (an editor re-indented with tabs).
printf 'class Config\n{\n\tpublic int Port = 8080;\n\tpublic string Host = "localhost";\n}\n' > src/Config.cs
# Staged by mistake: a half-done endpoint.
write src/Api.cs "class Api" "{" "    // TODO: GET /orders" "}"
git add src/Api.cs
note staged-at-start "$(git diff --staged --name-only)"
