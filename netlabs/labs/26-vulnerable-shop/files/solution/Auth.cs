using System.Security.Cryptography;
using System.Threading.RateLimiting;

namespace Shop;

public record SessionUser(long Id, string Username, bool IsAdmin);

public static class Auth
{
    /// <summary>The signed-in user for this request, or null.</summary>
    public static SessionUser? User(HttpContext ctx)
    {
        var sid = ctx.Request.Cookies[Session.CookieName];
        if (string.IsNullOrEmpty(sid)) return null;
        var row = Db.Query(
            "SELECT u.id, u.username, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $t",
            ("$t", sid)).FirstOrDefault();
        return row is null ? null : new SessionUser((long)row["id"]!, (string)row["username"]!, (long)row["is_admin"]! == 1);
    }

    public static void AddAuth(this WebApplicationBuilder builder)
    {
        // At most 5 sign-in attempts per minute from one address; the 6th gets 429 Too Many Requests.
        // (Behind a reverse proxy, use the forwarded client address: UseForwardedHeaders with KnownProxies.)
        builder.Services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.AddPolicy("login", ctx => RateLimitPartition.GetFixedWindowLimiter(
                ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions { PermitLimit = 5, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
        });
    }

    public static void MapAuth(this WebApplication app)
    {
        app.UseRateLimiter();

        app.MapGet("/login", (string? next, string? error) => Html.Page("Sign in", $"""
            <h1>Sign in</h1>
            {(error is null ? "" : "<p class=\"error\">Wrong username or password.</p>")}
            <form method="post" action="/login">
              <input type="hidden" name="next" value="{Html.Enc(next ?? "/")}">
              <label>Username <input name="username" autocomplete="username"></label>
              <label>Password <input name="password" type="password" autocomplete="current-password"></label>
              <button>Sign in</button>
            </form>
            <p>New here? <a href="/register">Create an account</a></p>
            """));

        app.MapPost("/login", async (HttpContext ctx) =>
        {
            var form = await ctx.Request.ReadFormAsync();
            var username = form["username"].ToString();
            var password = form["password"].ToString();
            var row = Db.Query("SELECT id, password_hash FROM users WHERE username = $u", ("$u", username)).FirstOrDefault();
            if (row is null || (string)row["password_hash"]! != Db.Sha256(password))
                return Results.Content(Html.Doc("Sign in", "<h1>Sign in</h1><p class=\"error\">Wrong username or password.</p><p><a href=\"/login\">Try again</a></p>"),
                    "text/html");
            StartSession(ctx, (long)row["id"]!);
            var next = form["next"].ToString();
            return Results.Redirect(next.StartsWith('/') && !next.StartsWith("//") ? next : "/");
        }).RequireRateLimiting("login");

        app.MapGet("/register", () => Html.Page("Create an account", """
            <h1>Create an account</h1>
            <form method="post" action="/register">
              <label>Username <input name="username"></label>
              <label>Password <input name="password" type="password"></label>
              <button>Create account</button>
            </form>
            """));

        app.MapPost("/register", async (HttpContext ctx) =>
        {
            var form = await ctx.Request.ReadFormAsync();
            var username = form["username"].ToString().Trim();
            var password = form["password"].ToString();
            if (username.Length is < 3 or > 32 || password.Length < 8)
                return Results.BadRequest(new { error = "Username 3-32 characters, password at least 8." });
            if (Db.Query("SELECT 1 FROM users WHERE username = $u", ("$u", username)).Count > 0)
                return Results.Conflict(new { error = "That username is taken." });
            Db.Exec("INSERT INTO users (username, display_name, email, password_hash, is_admin, support_pin) VALUES ($u, $u, $e, $h, 0, '')",
                ("$u", username), ("$e", username + "@customer.example"), ("$h", Db.Sha256(password)));
            var id = (long)Db.Query("SELECT id FROM users WHERE username = $u", ("$u", username))[0]["id"]!;
            StartSession(ctx, id);
            return Results.Redirect("/");
        });

        app.MapGet("/logout", (HttpContext ctx) =>
        {
            var sid = ctx.Request.Cookies[Session.CookieName];
            if (sid is not null) Db.Exec("DELETE FROM sessions WHERE token = $t", ("$t", sid));
            ctx.Response.Cookies.Delete(Session.CookieName);
            return Results.Redirect("/");
        });
    }

    static void StartSession(HttpContext ctx, long userId)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        Db.Exec("INSERT INTO sessions (token, user_id, created_at) VALUES ($t, $u, datetime('now'))", ("$t", token), ("$u", userId));
        ctx.Response.Cookies.Append(Session.CookieName, token, Session.CookieOptions());
    }
}
