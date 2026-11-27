using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;

namespace Shop;

public static class Account
{
    public static void AddAccount(this WebApplicationBuilder builder)
    {
        builder.Services.AddAntiforgery();
    }

    public static void MapAccount(this WebApplication app)
    {
        // Checks the token on every endpoint that binds a form ([FromForm]); a missing or wrong token gets 400.
        app.UseAntiforgery();

        app.MapGet("/account", (HttpContext ctx, IAntiforgery antiforgery, string? saved) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Redirect("/login?next=/account");
            var email = (string)Db.Query("SELECT email FROM users WHERE id = $id", ("$id", user.Id))[0]["email"]!;
            // A secret per browser: another site can make the browser send the cookie, but it cannot read this page.
            var tokens = antiforgery.GetAndStoreTokens(ctx);
            return Html.Page("Account", $"""
                <h1>Your account</h1>
                {(saved is null ? "" : "<p class=\"ok\">Saved.</p>")}
                <p>Signed in as <b>{Html.Enc(user.Username)}</b>. Password resets are sent to your email address.</p>
                <form method="post" action="/account/email">
                  <input type="hidden" name="{tokens.FormFieldName}" value="{Html.Enc(tokens.RequestToken)}">
                  <label>Email <input name="email" type="email" value="{Html.Enc(email)}"></label>
                  <button>Save</button>
                </form>
                """);
        });

        // POST only: a state change must never happen on GET (SameSite=Lax still sends cookies on a top-level GET).
        app.MapPost("/account/email", ([FromForm] string email, HttpContext ctx) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Redirect("/login?next=/account");
            if (!email.Contains('@')) return Results.BadRequest(new { error = "That is not an email address." });
            Db.Exec("UPDATE users SET email = $e WHERE id = $id", ("$e", email), ("$id", user.Id));
            return Results.Redirect("/account?saved=1");
        });
    }
}
