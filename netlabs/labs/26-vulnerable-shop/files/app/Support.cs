namespace Shop;

public record NewTicket(string Message, string? Url);

public static class Support
{
    public static void MapSupport(this WebApplication app)
    {
        // Customers report problems; a member of staff opens every link in a ticket to look at it.
        app.MapPost("/api/support", (NewTicket t, HttpContext ctx) =>
        {
            var user = Auth.User(ctx);
            if (user is null) return Results.Unauthorized();
            Db.Exec("INSERT INTO tickets (user_id, message, url, done, created_at) VALUES ($u, $m, $l, 0, datetime('now'))",
                ("$u", user.Id), ("$m", t.Message), ("$l", t.Url));
            return Results.Accepted(value: new { status = "A member of staff will look at it shortly." });
        });

        app.MapGet("/api/support/pending", (HttpContext ctx) =>
        {
            if (Auth.User(ctx) is not { IsAdmin: true }) return Results.StatusCode(403);
            return Results.Ok(Db.Query("SELECT id, message, url FROM tickets WHERE done = 0 ORDER BY id"));
        });

        app.MapPost("/api/support/{id:int}/done", (int id, HttpContext ctx) =>
        {
            if (Auth.User(ctx) is not { IsAdmin: true }) return Results.StatusCode(403);
            Db.Exec("UPDATE tickets SET done = 1 WHERE id = $id", ("$id", id));
            return Results.NoContent();
        });
    }
}
