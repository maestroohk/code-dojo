namespace Shop;

public static class Account
{
    public static void AddAccount(this WebApplicationBuilder builder)
    {
    }

    public static void MapAccount(this WebApplication app)
    {
        app.MapGet("/account", (HttpContext ctx, string? saved) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Redirect("/login?next=/account");
            var email = (string)Db.Query("SELECT email FROM users WHERE id = $id", ("$id", user.Id))[0]["email"]!;
            return Html.Page("Account", $"""
                <h1>Your account</h1>
                {(saved is null ? "" : "<p class=\"ok\">Saved.</p>")}
                <p>Signed in as <b>{Html.Enc(user.Username)}</b>. Password resets are sent to your email address.</p>
                <form method="post" action="/account/email">
                  <label>Email <input name="email" type="email" value="{Html.Enc(email)}"></label>
                  <button>Save</button>
                </form>
                """);
        });

        // The form above posts here. Version 1 of the mobile app still calls GET /account/email?email=...,
        // so both methods are accepted.
        app.MapMethods("/account/email", ["GET", "POST"], async (HttpContext ctx) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Redirect("/login?next=/account");
            string email = ctx.Request.Query["email"].ToString();
            if (HttpMethods.IsPost(ctx.Request.Method)) email = (await ctx.Request.ReadFormAsync())["email"].ToString();
            if (!email.Contains('@')) return Results.BadRequest(new { error = "That is not an email address." });
            Db.Exec("UPDATE users SET email = $e WHERE id = $id", ("$e", email), ("$id", user.Id));
            return Results.Redirect("/account?saved=1");
        });
    }
}
