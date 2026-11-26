# Lesson 2: rename a class across a small C# project, and nowhere else.
. "$DOJO_FILES/lib.sh"
mkdir -p ~/proj/src/Billing ~/proj/tests
cd ~/proj
cat > src/OldClient.cs <<'EOF'
namespace Shop;

public class OldClient(HttpClient http)
{
    public Task<string> Ping() => http.GetStringAsync("/ping");
}
EOF
cat > src/Billing/Invoices.cs <<'EOF'
namespace Shop.Billing;

public class Invoices(OldClient client)
{
    // OldClient retries twice; see OldClientOptions
    public Task<string> Check() => client.Ping();
}
EOF
cat > tests/OldClientTests.cs <<'EOF'
public class OldClientTests
{
    [Fact] public void Builds() => Assert.NotNull(new OldClient(new HttpClient()));
}
EOF
cat > README.md <<'EOF'
# Shop
OldClient is being renamed; keep this note until the release.
EOF
sha256sum README.md | cut -d' ' -f1 > /opt/dojo/state/readme.sha
rg -w -o --no-filename OldClient -g '*.cs' . | wc -l > /opt/dojo/state/old.count
chmod 644 /opt/dojo/state/*
