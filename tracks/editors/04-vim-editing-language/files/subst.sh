# Lesson 4: a whole-word rename and a URL change, with slashes in the pattern.
set -e -o pipefail
mkdir -p /opt/dojo/state
cat > ~/Orders.cs <<'EOF'
var userId = token.Claims["sub"];
var userIdentity = await identity.Load(userId);
log.Info($"order for {userId} via http://api.example.com");
return new Order(userId, "http://shop.example.com/receipt");
EOF
cat > /opt/dojo/state/Orders.expected <<'EOF'
var customerId = token.Claims["sub"];
var userIdentity = await identity.Load(customerId);
log.Info($"order for {customerId} via https://api.example.com");
return new Order(customerId, "https://shop.example.com/receipt");
EOF
chmod 644 /opt/dojo/state/Orders.expected
