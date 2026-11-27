using System.Text.Encodings.Web;

namespace Shop;

/// <summary>Small helpers for the pages that are built as strings (the product page is a Razor page).</summary>
public static class Html
{
    public static string Enc(string? text) => HtmlEncoder.Default.Encode(text ?? "");

    public static string Doc(string title, string body) => $"""
        <!doctype html>
        <html lang="en">
        <head><meta charset="utf-8"><title>{Enc(title)} · Lamp Shop</title><link rel="stylesheet" href="/site.css"></head>
        <body>
        <nav><a href="/">Lamp Shop</a> <a href="/account">Account</a> <a href="/login">Sign in</a> <a href="/logout">Sign out</a></nav>
        <main>
        {body}
        </main>
        </body>
        </html>
        """;

    public static IResult Page(string title, string body) => Results.Content(Doc(title, body), "text/html");
}

public static class Home
{
    public static void MapHome(this WebApplication app)
    {
        app.MapGet("/", (HttpContext ctx) =>
        {
            var user = Auth.User(ctx);
            var products = Db.Query("SELECT id, name, price_cents FROM products WHERE hidden = 0 ORDER BY id");
            var list = string.Concat(products.Select(p =>
                $"<li><a href=\"/products/{p["id"]}\">{Html.Enc((string)p["name"]!)}</a> <span class=\"price\">{(long)p["price_cents"]! / 100.0:0.00} EUR</span></li>"));
            var hello = user is null ? "<p><a href=\"/login\">Sign in</a> to order and review.</p>" : $"<p>Signed in as <b>{Html.Enc(user.Username)}</b>.</p>";
            return Html.Page("Home", $"<h1>Lamp Shop</h1>{hello}<ul class=\"products\">{list}</ul>");
        });
    }
}
